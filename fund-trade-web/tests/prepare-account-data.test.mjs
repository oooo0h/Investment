import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareAccountData } from '../scripts/prepare-account-data.mjs';
import { FUND_CODES } from '../src/funds.js';
import { validateEncryptedEnvelope } from '../scripts/publish-data.mjs';

const encoded = (length, byte) => Buffer.alloc(length, byte).toString('base64');
const calendar = Array.from({ length: 366 }, (_, index) => new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(5, 10).replace('-', ''));
const envelope = byte => ({ version: 2, kdf: 'PBKDF2-SHA256', iterations: 600000,
  iv: encoded(12, byte), ciphertext: encoded(32, byte),
  keys: Object.fromEntries(calendar.map(day => [day, { salt: encoded(16, 1), iv: encoded(12, 1), ciphertext: encoded(48, 1) }])),
});

async function fixture(t, overrides = {}) {
  const prefix = path.join(tmpdir(), 'synthetic-account-prepare-');
  const root = await fs.mkdtemp(prefix);
  t.after(async () => { assert.ok(root.startsWith(prefix)); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, 'data'));
  const files = ['ledger.enc.json', 'bonds.enc.json'].map(file => path.join(root, 'data', file));
  const originals = [envelope(2), envelope(3)];
  for (let index = 0; index < files.length; index++) await fs.writeFile(files[index], JSON.stringify(originals[index]));
  const next = [envelope(4), envelope(5)];
  const output = [], factoryArgs = [];
  const ledger = { status: 'valid', envelope: next[0], sourceSummary: FUND_CODES.map(code => ({ code, transactions: { kind: 'workbook' } })) };
  const bonds = { status: 'live', envelope: next[1] };
  let serial = 0;
  const options = { root, workspace: path.join(root, 'synthetic-workspace'), pythonPath: 'synthetic-python',
    ledgerStoreFactory: async args => { factoryArgs.push(args); return { snapshot: async () => ledger }; },
    bondStoreFactory: async args => { factoryArgs.push(args); return { snapshot: async () => bonds }; },
    uniqueId: () => `synthetic-${++serial}`, output: line => output.push(line), ...overrides };
  const current = async () => Promise.all(files.map(file => fs.readFile(file, 'utf8')));
  const originalText = await current();
  return { root, files, originals, next, ledger, bonds, output, options, factoryArgs, current, originalText,
    assertNoTemporary: async () => assert.deepEqual((await fs.readdir(path.join(root, 'data'))).sort(), ['bonds.enc.json', 'ledger.enc.json']) };
}

test('refresh prepares both workbook envelopes before replacing either and preserves all stable key wrappers', async t => {
  const f = await fixture(t);
  const writes = [];
  const result = await prepareAccountData({ ...f.options, io: { ...fs, async writeFile(file, bytes, flags) {
    const document = JSON.parse(bytes.toString('utf8'));
    validateEncryptedEnvelope(document);
    assert.equal(Object.hasOwn(document, 'funds'), false);
    writes.push(file);
    return fs.writeFile(file, bytes, flags);
  } } });
  assert.deepEqual(result, { checkOnly: false, workbookCount: 6, encryptedFileCount: 2 });
  assert.equal(writes.length, 2);
  assert.equal(f.factoryArgs.length, 2);
  for (const args of f.factoryArgs) assert.deepEqual(args, { workspace: f.options.workspace, root: f.root, pythonPath: 'synthetic-python' });
  const saved = (await f.current()).map(JSON.parse);
  assert.deepEqual(saved, f.next);
  assert.deepEqual(saved.map(item => item.keys), f.originals.map(item => item.keys));
  assert.doesNotMatch(f.output.join('\n'), /ciphertext|salt|PRIVATE|funds|password/);
  assert.match(f.output.join('\n'), /Validated 6 workbook sources; encryptedFiles=2; mode=refresh/);
  await f.assertNoTemporary();
});

test('--check validates both workbook sources without writing any file', async t => {
  const f = await fixture(t);
  let writes = 0, renames = 0;
  const result = await prepareAccountData({ ...f.options, args: ['--check'], io: { ...fs,
    async writeFile() { writes++; throw new Error('unexpected write'); },
    async rename() { renames++; throw new Error('unexpected rename'); },
  } });
  assert.equal(result.checkOnly, true);
  assert.equal(writes, 0); assert.equal(renames, 0);
  assert.deepEqual(await f.current(), f.originalText);
  assert.match(f.output.join('\n'), /mode=check/);
  await f.assertNoTemporary();
});

test('source failures finish both private reads and keep prior ciphertext unchanged', async t => {
  const f = await fixture(t);
  let bondReadFinished = false;
  await assert.rejects(prepareAccountData({ ...f.options,
    ledgerStoreFactory: async () => ({ snapshot: async () => { throw new Error('PRIVATE_LEDGER_PAYLOAD'); } }),
    bondStoreFactory: async () => ({ snapshot: async () => { bondReadFinished = true; return f.bonds; } }),
  }), { message: 'Account data preparation failed.' });
  assert.equal(bondReadFinished, true);
  assert.deepEqual(await f.current(), f.originalText);
  assert.doesNotMatch(f.output.join('\n'), /PRIVATE_LEDGER_PAYLOAD/);
  await f.assertNoTemporary();
});

test('invalid preview states and encrypted fallback sources cannot become a fresh workbook publication', async t => {
  const f = await fixture(t);
  for (const mutation of [() => { f.ledger.status = 'invalid'; }, () => { f.ledger.status = 'valid'; f.ledger.sourceSummary[0].transactions.kind = 'encrypted'; }]) {
    mutation();
    await assert.rejects(prepareAccountData(f.options), { message: 'Account data preparation failed.' });
    assert.deepEqual(await f.current(), f.originalText);
  }
  await f.assertNoTemporary();
});

test('duplicate workbook source metadata fails closed', async t => {
  const f = await fixture(t);
  f.ledger.sourceSummary[1] = f.ledger.sourceSummary[0];
  await assert.rejects(prepareAccountData(f.options), { message: 'Account data preparation failed.' });
  assert.deepEqual(await f.current(), f.originalText);
});

test('changed key wrappers and malformed envelopes are refused before staging', async t => {
  const f = await fixture(t);
  f.next[0].keys['0101'].salt = encoded(16, 9);
  await assert.rejects(prepareAccountData(f.options), { message: 'Account data preparation failed.' });
  assert.deepEqual(await f.current(), f.originalText);
  f.next[0].keys = structuredClone(f.originals[0].keys);
  f.next[1].ciphertext = 'PRIVATE_NOT_AN_ENVELOPE';
  await assert.rejects(prepareAccountData(f.options), { message: 'Account data preparation failed.' });
  assert.deepEqual(await f.current(), f.originalText);
  await f.assertNoTemporary();
});

test('partial staging failure removes staged ciphertext and never changes the original files', async t => {
  const f = await fixture(t);
  let written = 0;
  await assert.rejects(prepareAccountData({ ...f.options, io: { ...fs, async writeFile(file, bytes, options) {
    await fs.writeFile(file, bytes, options);
    if (++written === 2) throw Object.assign(new Error('PRIVATE_FILESYSTEM_FAILURE'), { code: 'ENOSPC' });
  } } }), { message: 'Account data preparation failed.' });
  assert.deepEqual(await f.current(), f.originalText);
  assert.doesNotMatch(f.output.join('\n'), /PRIVATE_FILESYSTEM_FAILURE/);
  await f.assertNoTemporary();
});

test('failure replacing the second file restores the first encrypted original atomically', async t => {
  const f = await fixture(t);
  const renames = [];
  await assert.rejects(prepareAccountData({ ...f.options, io: { ...fs, async rename(from, to) {
    renames.push({ from, to });
    if (to === f.files[1] && from.includes('.prepare-')) throw Object.assign(new Error('PRIVATE_LOCK_ERROR'), { code: 'EACCES' });
    return fs.rename(from, to);
  } } }), { message: 'Account data preparation failed.' });
  assert.ok(renames.some(item => item.from.includes('.rollback-') && item.to === f.files[0]));
  assert.deepEqual(await f.current(), f.originalText);
  assert.match(f.output.join('\n'), /Stage rollback-envelopes: complete/);
  await f.assertNoTemporary();
});

test('rollback failure is reported with a fixed safe error and prevents false success', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareAccountData({ ...f.options, io: { ...fs, async rename(from, to) {
    if (from.includes('.rollback-') || to === f.files[1]) throw new Error('PRIVATE_FAILURE');
    return fs.rename(from, to);
  } } }), { message: 'Account data rollback failed.' });
  assert.match(f.output.join('\n'), /Stage rollback-envelopes: failed/);
  assert.doesNotMatch(f.output.join('\n'), /PRIVATE_FAILURE|snapshots refreshed/);
  await f.assertNoTemporary();
});

test('another process changing ciphertext during source reads is preserved instead of overwritten', async t => {
  const f = await fixture(t);
  const external = JSON.stringify(envelope(8));
  await assert.rejects(prepareAccountData({ ...f.options,
    ledgerStoreFactory: async () => ({ snapshot: async () => { await fs.writeFile(f.files[0], external); return f.ledger; } }),
  }), { message: 'Account data preparation failed.' });
  const current = await f.current();
  assert.equal(current[0], external);
  assert.equal(current[1], f.originalText[1]);
  await f.assertNoTemporary();
});

test('unknown options fail before any data read without echoing their contents', async () => {
  let touched = false;
  await assert.rejects(prepareAccountData({ args: ['PRIVATE_UNKNOWN_OPTION'], io: { readFile() { touched = true; } } }), { message: 'Unknown account preparation option.' });
  assert.equal(touched, false);
});
