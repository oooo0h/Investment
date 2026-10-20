import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { createDemoTableStore } from '../scripts/demo-tables.mjs';
import { getDailyCode } from '../src/vault.js';
import { FUND_CODES } from '../src/funds.js';
import { demoNav, demoVault } from '../scripts/demo-data.mjs';

const code = FUND_CODES[0];
const EMPTY_CODE = '016701';
const txHeader = '\uFEFF交易编号,净值日期,交易类型,成交净值,确认份额,手续费,确认金额,确认状态,申请时间,备注\r\n';
const navHeader = '\uFEFF净值日期,单位净值\r\n';
const b64 = value => Buffer.from(value, 'base64');

async function fixture(t) {
  const prefix = path.join(path.resolve(tmpdir()), 'fund-demo-tables-');
  const directory = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(prefix));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, store: await createDemoTableStore({ directory }), file: name => path.join(directory, name) };
}

async function sessionKey(envelope) {
  const day = getDailyCode(), wrapped = envelope.keys[day];
  const material = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(day), 'PBKDF2', false, ['deriveKey']);
  const wrappingKey = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(wrapped.salt), iterations: envelope.iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const bytes = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(wrapped.iv) }, wrappingKey, b64(wrapped.ciphertext));
  return webcrypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['decrypt']);
}

async function decrypt(key, envelope) {
  const bytes = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(envelope.iv) }, key, b64(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(bytes));
}

test('creates every fund BOM CSV table and seeds missing files without overwriting later edits', async t => {
  const { directory, store, file } = await fixture(t);
  assert.equal(FUND_CODES.length, 4);
  assert.equal((await readdir(directory)).length, FUND_CODES.length * 2);
  assert.deepEqual((await readdir(directory)).sort(), FUND_CODES.flatMap(fundCode => [`${fundCode}_净值.csv`, `${fundCode}_交易.csv`]).sort());
  assert.equal((await readFile(file(`${code}_净值.csv`))).subarray(0, 3).toString('hex'), 'efbbbf');
  const edited = navHeader + '2026-01-01,2\r\n';
  await writeFile(file(`${code}_净值.csv`), edited);
  const addedCode = FUND_CODES.at(-1);
  await rm(file(`${addedCode}_净值.csv`));
  await rm(file(`${addedCode}_交易.csv`));
  const reopened = await createDemoTableStore({ directory });
  assert.equal(await readFile(file(`${code}_净值.csv`), 'utf8'), edited);
  assert.equal((await readdir(directory)).length, FUND_CODES.length * 2);
  assert.equal((await readFile(file(`${addedCode}_净值.csv`))).subarray(0, 3).toString('hex'), 'efbbbf');
  assert.equal((await reopened.snapshot()).status, 'valid');
  assert.equal((await store.snapshot()).status, 'valid');
});

test('the four active funds have synthetic public NAVs with an empty Yinhua ledger', async t => {
  const { store } = await fixture(t);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.status, 'valid');
  assert.deepEqual(Object.keys(snapshot.nav).sort(), [...FUND_CODES].sort());
  assert.deepEqual(Object.keys(snapshot.vault.funds).sort(), [...FUND_CODES].sort());
  for (const fundCode of FUND_CODES) {
    assert.equal(demoNav[fundCode].history.length, 60);
    assert.deepEqual(snapshot.nav[fundCode].history, demoNav[fundCode].history);
    assert.match(demoVault.funds[fundCode].sourceNote, /虚构/);
  }
  assert.deepEqual(snapshot.vault.funds[EMPTY_CODE].transactions, []);
  assert.equal(snapshot.vault.funds[EMPTY_CODE].incomplete, false);
  assert.ok(['005698', '270023', '006373'].every(fundCode => snapshot.vault.funds[fundCode].transactions.length > 0));
});

test('the empty active fund accepts synthetic table edits and preserves them on reopen', async t => {
  const { directory, file } = await fixture(t);
  const addedCode = EMPTY_CODE;
  const editedNav = navHeader + '2026-03-01,2\r\n';
  const editedTransactions = txHeader + 'extra,2026-03-01,买入,2,5,0,,已确认,,虚构测试交易\r\n';
  await writeFile(file(`${addedCode}_净值.csv`), editedNav);
  await writeFile(file(`${addedCode}_交易.csv`), editedTransactions);
  const reopened = await createDemoTableStore({ directory });
  assert.equal(await readFile(file(`${addedCode}_净值.csv`), 'utf8'), editedNav);
  assert.equal(await readFile(file(`${addedCode}_交易.csv`), 'utf8'), editedTransactions);
  const snapshot = await reopened.snapshot();
  assert.equal(snapshot.status, 'valid');
  assert.equal(snapshot.vault.funds[addedCode].transactions.length, 1);
  assert.equal(snapshot.nav[addedCode].history.length, 1);
});

test('inactive synthetic CSVs remain untouched and are not included in active snapshots', async t => {
  const { directory, store, file } = await fixture(t);
  const first = await store.snapshot();
  const archivedNav = navHeader + '2026-01-01,7\r\n';
  await writeFile(file('000216_净值.csv'), archivedNav);
  await writeFile(file('000216_交易.csv'), txHeader);
  const reopened = await createDemoTableStore({ directory });
  const snapshot = await reopened.snapshot();
  assert.equal(snapshot.revision, first.revision);
  assert.deepEqual(Object.keys(snapshot.nav).sort(), [...FUND_CODES].sort());
  assert.equal(await readFile(file('000216_净值.csv'), 'utf8'), archivedNav);
  assert.equal(await readFile(file('000216_交易.csv'), 'utf8'), txHeader);
});

test('NAV edits change the revision and unchanged or equivalent CSV does not', async t => {
  const { store, file } = await fixture(t);
  const first = await store.snapshot();
  assert.equal(first.status, 'valid');
  await writeFile(file(`${code}_净值.csv`), navHeader + '2026-03-01,3\r\n');
  const changed = await store.snapshot();
  assert.notEqual(changed.revision, first.revision);
  assert.equal(changed.nav[code].asOf, '2026-03-01');
  assert.equal(changed.nav[code].history[0].nav, 3);
  const same = await store.snapshot();
  assert.equal(same.revision, changed.revision);
  assert.equal(same.envelope, changed.envelope);
  await writeFile(file(`${code}_净值.csv`), 'date,nav\n2026/3/1,3.000\n');
  assert.equal((await store.snapshot()).revision, changed.revision);
});

test('new transactions refresh the vault and use the old in-memory session key', async t => {
  const { store, file } = await fixture(t);
  const first = await store.snapshot(), key = await sessionKey(first.envelope);
  const original = await readFile(file(`${code}_交易.csv`), 'utf8');
  await writeFile(file(`${code}_交易.csv`), original + 'new,2026-03-01,买入,2,5,0,,已确认,2026-03-01 10:00:00,"演示,备注"\r\n');
  const changed = await store.snapshot();
  assert.equal(changed.status, 'valid');
  assert.notEqual(changed.revision, first.revision);
  assert.equal(changed.vault.funds[code].transactions.length, first.vault.funds[code].transactions.length + 1);
  assert.equal(changed.vault.funds[code].transactions.at(-1).note, '演示,备注');
  assert.deepEqual(await decrypt(key, changed.envelope), changed.vault);
  assert.equal(changed.envelope.keys[getDailyCode()], first.envelope.keys[getDailyCode()]);
});

test('invalid and incomplete writes retain a complete last good snapshot then recover', async t => {
  const { store, file } = await fixture(t);
  const first = await store.snapshot();
  for (const contents of [navHeader + '2026-01-01,-1\r\n', navHeader + '"2026-01-01,2', navHeader + '2026-01-01,2\r\n2026-01-01,3\r\n']) {
    await writeFile(file(`${code}_净值.csv`), contents);
    const invalid = await store.snapshot();
    assert.equal(invalid.status, 'invalid');
    assert.equal(invalid.revision, first.revision);
    assert.equal(invalid.nav, first.nav);
    assert.equal(invalid.vault, first.vault);
    assert.equal(invalid.envelope, first.envelope);
  }
  await writeFile(file(`${code}_净值.csv`), navHeader + '2026-03-02,3\r\n');
  const restored = await store.snapshot();
  assert.equal(restored.status, 'valid');
  assert.notEqual(restored.revision, first.revision);
});

test('header-only trading and NAV tables are valid empty datasets', async t => {
  const { store, file } = await fixture(t);
  await writeFile(file(`${code}_交易.csv`), txHeader);
  await writeFile(file(`${code}_净值.csv`), navHeader);
  const empty = await store.snapshot();
  assert.equal(empty.status, 'valid');
  assert.deepEqual(empty.vault.funds[code].transactions, []);
  assert.deepEqual(empty.nav[code].history, []);
  assert.equal(empty.nav[code].asOf, null);
});

test('transaction validation rejects overselling and malformed numeric or date fields', async t => {
  const { store, file } = await fixture(t);
  const first = await store.snapshot();
  for (const row of [
    'bad,2026-03-01,卖出,2,5,0,,已确认,,',
    'bad,2026-02-30,买入,2,5,0,,已确认,,',
    'bad,2026-03-01,买入,Infinity,5,0,,已确认,,',
    'bad,2026-03-01,买入,2,5,,10,已确认,,',
  ]) {
    await writeFile(file(`${code}_交易.csv`), txHeader + row + '\r\n');
    const invalid = await store.snapshot();
    assert.equal(invalid.status, 'invalid');
    assert.equal(invalid.revision, first.revision);
  }
});

test('handles Excel serial dates, optional values, quoted newlines and double quotes', async t => {
  const { store, file } = await fixture(t);
  const serial = (Date.UTC(2026, 2, 1) - Date.UTC(1899, 11, 30)) / 86400000;
  await writeFile(file(`${code}_净值.csv`), navHeader + `${serial},2\r\n`);
  await writeFile(file(`${code}_交易.csv`), txHeader + `excel,${serial},buy,2,5,0,,confirmed,,"测试\r\n""引号"""\r\n`);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.status, 'valid');
  assert.equal(snapshot.vault.funds[code].transactions[0].date, '2026-03-01');
  assert.equal(snapshot.vault.funds[code].transactions[0].note, '测试\n"引号"');
});
