import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLiveDataStore } from '../scripts/live-data.mjs';
import { FUND_CODES as CODES, FUND_CATALOG } from '../funds.js';

const RECORDED_CODES = ['005698', '270023', '006373'];
const EMPTY_CODE = '016701';
const PYTHON = process.env.FUND_TEST_PYTHON || (process.platform === 'win32'
  ? 'C:\\Users\\Administrator\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe' : 'python3');
const NAV_HEADER = '\uFEFF基金代码,基金名称,净值日期,单位净值,累计净值,日增长率(%),分红事件,数据来源\r\n';
// Synthetic source module replaces encryption and Excel dependencies in tests.
const STUB = `import json\nfrom pathlib import Path\nCODES=${JSON.stringify(FUND_CATALOG.map(fund => fund.code))}\ndef beijing_today_code():\n    return 'not-a-real-password'\ndef decrypt_payload(source, password):\n    counter=source.parents[2]/'synthetic-reader-calls.txt'\n    previous=int(counter.read_text()) if counter.exists() else 0\n    counter.write_text(str(previous+1))\n    document=json.loads(source.read_text(encoding='utf-8'))\n    for code in CODES: document['funds'].setdefault(code,{'transactions':[],'mode':'profit-first'})\n    return document\ndef read_fund(workspace, code):\n    candidates=list((workspace/'基金').glob(f'{code}*/*单笔交易自动计算_双模式_模板2026-09-28.xlsx'))\n    if len(candidates)!=1: raise ValueError('synthetic source error')\n    return json.loads(candidates[0].read_text(encoding='utf-8'))\n`;
const buy = (id, extra = {}) => ({ id, date: '2026-01-01', type: 'buy', nav: 2, shares: 10, fee: 0, status: 'confirmed', ...extra });

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
  await writeFile(ledgerFile, JSON.stringify({ createdAt: 'synthetic', funds }));
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
  return { workspace, root, directories, csvFiles, ledgerFile, funds, store };
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
  const { store, funds, ledgerFile } = await fixture(t);
  // The full encrypted archive may contain inactive records; the preview must
  // neither require their public directories nor rewrite their source records.
  funds['000216'] = { mode: 'profit-first', transactions: [buy('archived-only')] };
  await writeFile(ledgerFile, JSON.stringify({ createdAt: 'synthetic', funds }));
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
  const { store, ledgerFile, funds } = await fixture(t);
  funds['006373'] = { mode: 'profit-first', incomplete: true, sourceNote: 'synthetic pending source', transactions: [
    { id: 'application', date: '', type: 'buy', nav: null, shares: null, fee: null, amount: 10, status: 'pending', sourceStatus: 'unverified', submittedAt: '2026-01-01 10:00:00' },
  ] };
  await writeFile(ledgerFile, JSON.stringify({ createdAt: 'synthetic', funds }));
  const first = await store.snapshot();
  assert.equal(first.status, 'valid');
  assert.equal(first.vault.funds['006373'].transactions[0].shares, null);
  funds['005698'].transactions.push(buy('oversell', { type: 'sell', shares: 100, date: '2026-01-02' }));
  await writeFile(ledgerFile, JSON.stringify({ createdAt: 'synthetic', funds }));
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
