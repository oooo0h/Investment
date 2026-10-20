import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLiveDataStore } from '../scripts/live-data.mjs';
import { FUND_CODES as CODES, FUND_CATALOG } from '../src/funds.js';
import { unlockVault, getDailyCode } from '../src/vault.js';
import { createTransactionStore, TRANSACTION_STORAGE_KEY } from '../src/transaction-store.js';

const RECORDED_CODES = ['005698', '270023', '006373'];
const EMPTY_CODE = '016701';
const PYTHON = process.env.FUND_TEST_PYTHON || (process.platform === 'win32'
  ? 'C:\\Users\\Administrator\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe' : 'python3');
const NAV_HEADER = '\uFEFF基金代码,基金名称,净值日期,单位净值,累计净值,日增长率(%),分红事件,数据来源\r\n';
// Synthetic source module replaces encryption and Excel dependencies in tests.
const STUB = `import json\nfrom pathlib import Path\nCODES=${JSON.stringify(FUND_CATALOG.map(fund => fund.code))}\ndef beijing_today_code():\n    return 'not-a-real-password'\ndef decrypt_payload(source, password):\n    counter=source.parents[2]/'synthetic-reader-calls.txt'\n    previous=int(counter.read_text()) if counter.exists() else 0\n    counter.write_text(str(previous+1))\n    document=json.loads((source.parents[2]/'synthetic-vault.json').read_text(encoding='utf-8'))\n    for code in CODES: document['funds'].setdefault(code,{'transactions':[],'mode':'profit-first'})\n    return document\ndef read_fund(workspace, code):\n    candidates=list((workspace/'基金').glob(f'{code}*/*单笔交易自动计算_双模式_模板2026-09-28.xlsx'))\n    if len(candidates)!=1: raise ValueError('synthetic source error')\n    return json.loads(candidates[0].read_text(encoding='utf-8'))\n`;
const buy = (id, extra = {}) => ({ id, date: '2026-01-01', type: 'buy', nav: 2, shares: 10, fee: 0, status: 'confirmed', ...extra });

// Entirely synthetic keys/payloads. All calendar entries are structurally valid;
// only today's wrapper is used for cryptographic tests, so one PBKDF is sufficient.
async function syntheticSealer() {
  const b64 = bytes => Buffer.from(bytes).toString('base64');
  const raw = webcrypto.getRandomValues(new Uint8Array(32));
  const key = await webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const salt = webcrypto.getRandomValues(new Uint8Array(16)), iv = webcrypto.getRandomValues(new Uint8Array(12));
  const material = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(getDailyCode()), 'PBKDF2', false, ['deriveKey']);
  const wrappingKey = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const wrapped = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, raw);
  raw.fill(0);
  const wrapper = { salt: b64(salt), iv: b64(iv), ciphertext: b64(wrapped) };
  const keys = Object.fromEntries(Array.from({ length: 366 }, (_, index) => [new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(5, 10).replace('-', ''), wrapper]));
  return async payload => {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
    return { version: 2, kdf: 'PBKDF2-SHA256', iterations: 600000, iv: b64(iv), ciphertext: b64(ciphertext), keys };
  };
}

async function fixture(t) {
  const prefix = path.join(path.resolve(tmpdir()), 'fund-live-data-');
  const workspace = await mkdtemp(prefix), root = path.join(workspace, 'web');
  t.after(async () => {
    assert.ok(path.resolve(workspace).startsWith(prefix));
    await rm(workspace, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'data'));
  await writeFile(path.join(root, 'scripts', 'encrypt-workbooks.py'), STUB);
  const funds = Object.fromEntries(CODES.map(code => [code, { mode: 'profit-first', transactions: code === EMPTY_CODE ? [] : [buy(`encrypted-${code}`)] }]));
  const ledgerFile = path.join(root, 'data', 'ledger.enc.json');
  const seal = await syntheticSealer();
  const writeLedger = async () => {
    const payload = { createdAt: 'synthetic', funds };
    await writeFile(path.join(workspace, 'synthetic-vault.json'), JSON.stringify(payload));
    await writeFile(ledgerFile, JSON.stringify(await seal(payload)));
  };
  await writeLedger();
  const directories = {}, csvFiles = {};
  for (const code of CODES) {
    directories[code] = path.join(workspace, '基金', `${code}_虚构测试基金`);
    const archive = path.join(directories[code], '历史净值');
    await mkdir(archive, { recursive: true });
    csvFiles[code] = path.join(archive, `${code}_全部历史净值_截至2026-01-02.csv`);
    await writeFile(csvFiles[code], NAV_HEADER + `${code},虚构测试,2026-01-01,2,,,,公开合成数据\r\n${code},虚构测试,2026-01-02,3,,,,公开合成数据\r\n`);
    await writeFile(path.join(archive, `${code}_全部历史净值_截至2026-01-02.json`), JSON.stringify({ code, source: 'unused synthetic JSON', rows: [{ date: '2026-01-01', nav: 99 }] }));
  }
  const store = await createLiveDataStore({ workspace, root, pythonPath: PYTHON });
  return { workspace, root, directories, csvFiles, ledgerFile, funds, store, writeLedger };
}

test('uses latest public CSV and workbook overrides while preserving other encrypted funds', async t => {
  const { workspace, directories, csvFiles, root } = await fixture(t);
  const workbook = path.join(directories['005698'], '005698_单笔交易自动计算_双模式_模板2026-09-28.xlsx');
  await writeFile(workbook, JSON.stringify({ mode: 'principal-first', transactions: [buy('workbook-source', { shares: 5 })] }));
  await writeFile(path.join(directories['005698'], '~$005698_单笔交易自动计算_双模式_模板2026-09-28.xlsx'), 'synthetic lock file');
  const store = await createLiveDataStore({ workspace, root, pythonPath: PYTHON });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.status, 'valid');
  assert.equal(snapshot.vault.demo, false);
  assert.equal(snapshot.vault.funds['005698'].mode, 'principal-first');
  assert.equal(snapshot.vault.funds['005698'].transactions[0].id, 'workbook-source');
  assert.equal(snapshot.vault.funds['006373'].transactions[0].id, 'encrypted-006373');
  assert.equal(snapshot.nav['005698'].history.at(-1).nav, 3);
  assert.equal(snapshot.nav['005698'].asOf, '2026-01-02');
  const source = snapshot.sourceSummary.find(item => item.code === '005698');
  assert.equal(await realpath(source.nav.path), await realpath(csvFiles['005698']));
  assert.equal(source.transactions.kind, 'workbook');
});

test('returns only the four active funds while preserving three recorded ledgers and the empty Yinhua ledger', async t => {
  const { store, funds, ledgerFile, writeLedger } = await fixture(t);
  // The full encrypted archive may contain inactive records; the preview must
  // neither require their public directories nor rewrite their source records.
  funds['000216'] = { mode: 'profit-first', transactions: [buy('archived-only')] };
  await writeLedger();
  const originalLedger = await readFile(ledgerFile);
  const snapshot = await store.snapshot();
  assert.equal(CODES.length, 4);
  assert.deepEqual(Object.keys(snapshot.vault.funds).sort(), [...CODES].sort());
  assert.deepEqual(Object.keys(snapshot.nav).sort(), [...CODES].sort());
  assert.deepEqual(snapshot.vault.funds[EMPTY_CODE], { transactions: [], mode: 'profit-first' });
  assert.equal(snapshot.nav[EMPTY_CODE].asOf, '2026-01-02');
  assert.deepEqual(snapshot.sourceSummary.find(item => item.code === EMPTY_CODE).transactions, { kind: 'empty', path: null, recordCount: 0 });
  for (const code of RECORDED_CODES) {
    assert.equal(snapshot.vault.funds[code].transactions.length, 1);
    assert.equal(snapshot.vault.funds[code].transactions[0].id, `encrypted-${code}`);
    const source = snapshot.sourceSummary.find(item => item.code === code).transactions;
    assert.equal(source.kind, 'encrypted');
  }
  assert.ok((await readFile(ledgerFile)).equals(originalLedger));
});

test('reads a real source workbook when a previously empty active ledger receives records', async t => {
  const { store, directories } = await fixture(t);
  const code = EMPTY_CODE;
  assert.deepEqual((await store.snapshot()).vault.funds[code].transactions, []);
  const workbook = path.join(directories[code], `${code}_单笔交易自动计算_双模式_模板2026-09-28.xlsx`);
  await writeFile(workbook, JSON.stringify({ mode: 'principal-first', transactions: [buy('added-workbook-source')] }));
  const snapshot = await store.snapshot();
  assert.equal(snapshot.status, 'valid');
  assert.equal(snapshot.vault.funds[code].transactions[0].id, 'added-workbook-source');
  assert.equal(snapshot.vault.funds[code].mode, 'principal-first');
  assert.equal(snapshot.sourceSummary.find(item => item.code === code).transactions.kind, 'workbook');
});

test('watches the empty active fund NAV table and retains prior data on invalid edits', async t => {
  const { store, csvFiles } = await fixture(t);
  const code = EMPTY_CODE, first = await store.snapshot();
  await writeFile(csvFiles[code], NAV_HEADER + `${code},虚构测试,2026-01-03,4,,,,公开合成数据\r\n`);
  const changed = await store.snapshot();
  assert.notEqual(changed.revision, first.revision);
  assert.equal(changed.nav[code].asOf, '2026-01-03');
  await writeFile(csvFiles[code], NAV_HEADER + `${code},虚构测试,2026-01-03,-1,,,,公开合成数据\r\n`);
  const invalid = await store.snapshot();
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.revision, changed.revision);
  assert.deepEqual(invalid.vault.funds[code].transactions, []);
});

test('unchanged sources reuse cached snapshots without rerunning the Python reader', async t => {
  const { workspace, root, store } = await fixture(t);
  const first = await store.snapshot();
  const counter = path.join(workspace, 'synthetic-reader-calls.txt');
  assert.equal(await readFile(counter, 'utf8'), '1');
  // The second store uses a nonexistent runner; it has no last-good fallback.
  const noRunner = await createLiveDataStore({ workspace, root, pythonPath: path.join(root, 'missing-python') });
  await assert.rejects(noRunner.snapshot(), { message: 'Local data unavailable.' });
  const cached = await store.snapshot();
  assert.equal(cached.status, 'valid');
  assert.equal(cached.revision, first.revision);
  assert.equal(cached.vault, first.vault);
  assert.equal(cached.envelope, first.envelope);
  assert.equal(await readFile(counter, 'utf8'), '1');
});

test('public table edits refresh revisions, do not write account files, and recover after invalid edits', async t => {
  const { store, csvFiles, ledgerFile, root } = await fixture(t);
  const originalLedger = await readFile(ledgerFile), first = await store.snapshot();
  await writeFile(csvFiles['005698'], NAV_HEADER + '005698,虚构测试,2026-01-03,4,,,,公开合成数据\r\n');
  const changed = await store.snapshot();
  assert.equal(changed.status, 'valid');
  assert.notEqual(changed.revision, first.revision);
  assert.equal(changed.nav['005698'].asOf, '2026-01-03');
  await writeFile(csvFiles['005698'], NAV_HEADER + '005698,虚构测试,not-a-date,-1,,,,公开合成数据\r\n');
  const invalid = await store.snapshot();
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.vault, changed.vault);
  assert.equal(invalid.nav, changed.nav);
  assert.equal(invalid.envelope, changed.envelope);
  assert.equal((await store.snapshot()).status, 'invalid');
  await writeFile(csvFiles['005698'], NAV_HEADER + '005698,虚构测试,2026-01-04,5,,,,公开合成数据\r\n');
  assert.equal((await store.snapshot()).status, 'valid');
  assert.ok((await readFile(ledgerFile)).equals(originalLedger));
  assert.deepEqual((await readdir(path.join(root, 'data'))).sort(), ['ledger.enc.json']);
  assert.deepEqual((await readdir(path.join(root, 'scripts'))).sort(), ['encrypt-workbooks.py']);
});

test('invalid first reads fail closed and cannot fall back to synthetic data', async t => {
  const { store, csvFiles } = await fixture(t);
  await writeFile(csvFiles['005698'], 'invalid source');
  await assert.rejects(store.snapshot(), { message: 'Local data unavailable.' });
  await assert.rejects(store.snapshot(), { message: 'Local data unavailable.' });
});

test('confirmed invalid trades preserve prior snapshots while pending incomplete trades remain intact', async t => {
  const { store, funds, writeLedger } = await fixture(t);
  funds['006373'] = { mode: 'profit-first', incomplete: true, sourceNote: 'synthetic pending source', transactions: [
    { id: 'application', date: '', type: 'buy', nav: null, shares: null, fee: null, amount: 10, status: 'pending', sourceStatus: 'unverified', submittedAt: '2026-01-01 10:00:00' },
  ] };
  await writeLedger();
  const first = await store.snapshot();
  assert.equal(first.status, 'valid');
  assert.equal(first.vault.funds['006373'].transactions[0].shares, null);
  funds['005698'].transactions.push(buy('oversell', { type: 'sell', shares: 100, date: '2026-01-02' }));
  await writeLedger();
  const invalid = await store.snapshot();
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.revision, first.revision);
});

test('selects a genuinely newer JSON archive over an older CSV and normalizes slash dates', async t => {
  const { store, directories } = await fixture(t);
  await writeFile(path.join(directories['005698'], '历史净值', '005698_全部历史净值_截至2026-01-03.json'), JSON.stringify({ code: '005698', source: 'synthetic public JSON', rows: [{ date: '2026/1/3', nav: '4.0000', ignoredAccountField: 'must not enter NAV' }] }));
  const snapshot = await store.snapshot();
  assert.equal(snapshot.nav['005698'].asOf, '2026-01-03');
  assert.deepEqual(snapshot.nav['005698'].history[0], { date: '2026-01-03', nav: 4 });
  assert.equal(snapshot.sourceSummary.find(item => item.code === '005698').nav.path.endsWith('.json'), true);
});

test('the deployment key preserves encrypted transaction edits across independent preview stores and a fresh Node process', async t => {
  const { workspace, root, ledgerFile, store } = await fixture(t);
  const original = await readFile(ledgerFile), first = await store.snapshot();
  const baseEnvelope = JSON.parse(original.toString('utf8'));
  assert.deepEqual(first.envelope.keys, baseEnvelope.keys);
  const open = async envelope => {
    let session;
    await unlockVault(getDailyCode(), { fetchFn: async () => ({ ok: true, json: async () => envelope }), onSession: value => { session = value; } });
    return session;
  };
  const session = await open(first.envelope), values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const edits = await createTransactionStore(session, first.vault.funds, { storage });
  await edits.add(EMPTY_CODE, buy('synthetic-restart-persisted'));
  const record = JSON.parse(storage.getItem(TRANSACTION_STORAGE_KEY));
  const originalSession = await open(baseEnvelope);
  assert.equal((await originalSession.decryptLocal(record)).funds[EMPTY_CODE].added[0].id, 'synthetic-restart-persisted');
  originalSession.close(); edits.close(); session.close();

  const second = await (await createLiveDataStore({ workspace, root, pythonPath: PYTHON })).snapshot();
  const secondSession = await open(second.envelope);
  const reopened = await createTransactionStore(secondSession, second.vault.funds, { storage });
  assert.equal(reopened.getFunds()[EMPTY_CODE].transactions[0].id, 'synthetic-restart-persisted');
  reopened.close(); secondSession.close();

  // A separate Node process recreates the server module and all process-local state.
  const childScript = `const {createLiveDataStore}=await import(process.argv[4]);const snapshot=await(await createLiveDataStore({workspace:process.argv[1],root:process.argv[2],pythonPath:process.argv[3]})).snapshot();process.stdout.write(JSON.stringify(snapshot.envelope));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', childScript, workspace, root, PYTHON, new URL('../scripts/live-data.mjs', import.meta.url).href], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  const restartedSession = await open(JSON.parse(stdout));
  assert.equal((await restartedSession.decryptLocal(record)).funds[EMPTY_CODE].added[0].id, 'synthetic-restart-persisted');
  restartedSession.close();
  assert.ok((await readFile(ledgerFile)).equals(original));
});

test('public NAV refresh keeps an unlocked vault session and its encrypted local edits usable', async t => {
  const { store, csvFiles, ledgerFile } = await fixture(t);
  const original = await readFile(ledgerFile);
  let current = await store.snapshot(), session;
  const payload = await unlockVault(getDailyCode(), { fetchFn: async () => ({ ok: true, json: async () => current.envelope }), onSession: value => { session = value; } });
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const edits = await createTransactionStore(session, payload.funds, { storage });
  await edits.add(EMPTY_CODE, buy('synthetic-refresh-persisted'));
  const prior = current;
  await writeFile(csvFiles[EMPTY_CODE], NAV_HEADER + `${EMPTY_CODE},虚构测试,2026-01-03,4,,,,公开合成数据\r\n`);
  current = await store.snapshot();
  assert.notEqual(current.revision, prior.revision);
  assert.deepEqual(current.envelope.keys, prior.envelope.keys);
  const refreshed = await session.refresh();
  assert.equal(edits.replaceBase(refreshed.funds)[EMPTY_CODE].transactions[0].id, 'synthetic-refresh-persisted');
  assert.equal((await session.decryptLocal(JSON.parse(storage.getItem(TRANSACTION_STORAGE_KEY)))).funds[EMPTY_CODE].added[0].id, 'synthetic-refresh-persisted');
  assert.ok((await readFile(ledgerFile)).equals(original));
  edits.close(); session.close();
});

test('bad or unsupported static envelopes fail clearly even after a valid snapshot and never fall back to demo encryption', async t => {
  const { store, ledgerFile } = await fixture(t);
  const original = await readFile(ledgerFile), parsed = JSON.parse(original.toString('utf8'));
  assert.equal((await store.snapshot()).status, 'valid');
  const tampered = structuredClone(parsed);
  tampered.ciphertext = (tampered.ciphertext[0] === 'A' ? 'B' : 'A') + tampered.ciphertext.slice(1);
  const badWrapper = structuredClone(parsed), wrapper = badWrapper.keys[getDailyCode()];
  wrapper.ciphertext = (wrapper.ciphertext[0] === 'A' ? 'B' : 'A') + wrapper.ciphertext.slice(1);
  for (const content of ['{', JSON.stringify({ version: 1 }), JSON.stringify(tampered), JSON.stringify(badWrapper)]) {
    await writeFile(ledgerFile, content);
    await assert.rejects(store.snapshot(), { message: 'Local data unavailable.' });
    await assert.rejects(store.snapshot(), { message: 'Local data unavailable.' });
  }
  await writeFile(ledgerFile, original);
  assert.equal((await store.snapshot()).status, 'valid');
});
