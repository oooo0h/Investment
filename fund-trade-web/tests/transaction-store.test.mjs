// Synthetic fixtures and ephemeral encryption only; no account file or real storage is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createTransactionStore, TRANSACTION_STORAGE_KEY } from '../src/transaction-store.js';
import { unlockVault, getDailyCode } from '../src/vault.js';
import { demoEnvelope } from '../scripts/demo-data.mjs';

const code = '016701', other = '270023';
const trade = (id = 'base-a', date = '2026-01-02') => ({ id, date, type: 'buy', nav: 1, shares: 10, amount: 10, fee: 0, sourceNote: 'synthetic metadata' });
const initial = () => ({
  [code]: { transactions: [trade()], mode: 'principal-first', incomplete: true, sourceNote: 'synthetic book', nested: { retained: true } },
  [other]: { transactions: [trade('other-a')], mode: 'profit-first', rate: .0015 },
});
const isCode = code => error => error?.code === code;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function memoryStorage() {
  const values = new Map();
  let failReads = false, failWrites = false, writes = 0;
  return {
    values, get writes() { return writes; },
    getItem(key) { if (failReads) throw new Error('synthetic blocked read'); return values.get(key) ?? null; },
    setItem(key, value) { if (failWrites) throw new Error('synthetic blocked write'); writes++; values.set(key, value); },
    failReads(value) { failReads = value; }, failWrites(value) { failWrites = value; },
  };
}

async function cryptoSession() {
  const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  let closed = false, closeCalls = 0;
  const b64 = value => Buffer.from(value).toString('base64');
  return {
    get closed() { return closed; }, get closeCalls() { return closeCalls; },
    close() { closed = true; closeCalls++; },
    async encryptLocal(value) {
      if (closed) throw Object.assign(new Error('synthetic closed session'), { code: 'SESSION_CLOSED' });
      const iv = webcrypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)));
      return { version: 1, iv: b64(iv), ciphertext: b64(ciphertext) };
    },
    async decryptLocal(record) {
      if (closed) throw Object.assign(new Error('synthetic closed session'), { code: 'SESSION_CLOSED' });
      const bytes = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(record.iv, 'base64') }, key, Buffer.from(record.ciphertext, 'base64'));
      return JSON.parse(new TextDecoder().decode(bytes));
    },
  };
}

async function fixture(options = {}) {
  const session = options.session || await cryptoSession(), storage = options.storage || memoryStorage();
  const store = await createTransactionStore(session, options.base || initial(), { storage, now: () => '2026-01-08T00:00:00Z' });
  const overlay = async () => session.decryptLocal(JSON.parse(storage.getItem(TRANSACTION_STORAGE_KEY)));
  return { store, session, storage, overlay };
}

test('opening does not write and returns independent books with all metadata preserved', async () => {
  const base = initial(), h = await fixture({ base });
  assert.deepEqual(h.store.getFunds(), base);
  assert.equal(h.storage.writes, 0);
  const copy = h.store.getFunds();
  copy[code].transactions[0].amount = 999;
  copy[code].nested.retained = false;
  base[code].transactions.length = 0;
  assert.equal(h.store.getFunds()[code].transactions.length, 1);
  assert.equal(h.store.getFunds()[code].nested.retained, true);
});

test('adding generates a stable local ID, sorts dates and preserves every other fund and book field', async () => {
  const h = await fixture(), next = trade(undefined, '2026-01-01');
  delete next.id;
  const result = await h.store.add(code, next);
  assert.match(result[code].transactions[0].id, /^local-/);
  assert.equal(result[code].transactions[0].date, '2026-01-01');
  assert.deepEqual(result[other], initial()[other]);
  assert.equal(result[code].mode, 'principal-first');
  assert.equal(result[code].incomplete, true);
  assert.equal(h.storage.writes, 1);
});

test('same-day transactions retain insertion order and source entries without IDs get deterministic IDs', async () => {
  const base = initial(); delete base[code].transactions[0].id;
  const h = await fixture({ base });
  await h.store.add(code, trade('local-a'));
  await h.store.add(code, trade('local-b'));
  assert.deepEqual(h.store.getFunds()[code].transactions.map(item => item.id), [`${code}-0`, 'local-a', 'local-b']);
});

test('empty source identities follow the app fallback convention', async () => {
  for (const id of [null, '', 0, false]) {
    const base = initial(); base[code].transactions[0].id = id;
    const h = await fixture({ base });
    assert.equal(h.store.getFunds()[code].transactions[0].id, `${code}-0`);
  }
});

test('updates patch the original transaction while keeping unknown fields and immutable identity', async () => {
  const h = await fixture();
  const result = await h.store.update(code, 'base-a', { fee: .1 });
  assert.equal(result[code].transactions[0].sourceNote, 'synthetic metadata');
  assert.equal(result[code].transactions[0].fee, .1);
  await assert.rejects(h.store.update(code, 'base-a', { id: 'changed-id' }), isCode('transaction-invalid'));
  assert.equal((await h.overlay()).funds[code].updated.length, 1);
});

test('an edited local addition remains an addition and a deleted local addition creates no remote tombstone', async () => {
  const h = await fixture();
  await h.store.add(code, trade('local-a'));
  await h.store.update(code, 'local-a', { fee: .2 });
  assert.equal((await h.overlay()).funds[code].added[0].fee, .2);
  assert.deepEqual((await h.overlay()).funds[code].updated, []);
  await h.store.remove(code, 'local-a');
  assert.deepEqual(h.store.getFunds(), initial());
  assert.deepEqual((await h.overlay()).funds[code].deletedIds, []);
});

test('removing a base transaction persists a tombstone across refresh and reopening', async () => {
  const h = await fixture();
  await h.store.update(code, 'base-a', { fee: .1 });
  await h.store.remove(code, 'base-a');
  assert.deepEqual((await h.overlay()).funds[code].deletedIds, ['base-a']);
  assert.deepEqual((await h.overlay()).funds[code].updated, []);
  const refreshed = initial(); refreshed[code].transactions.push(trade('remote-new', '2026-01-03'));
  h.store.replaceBase(refreshed);
  assert.deepEqual(h.store.getFunds()[code].transactions.map(item => item.id), ['remote-new']);
  h.store.close();
  const reopened = await createTransactionStore(h.session, refreshed, { storage: h.storage });
  assert.deepEqual(reopened.getFunds()[code].transactions.map(item => item.id), ['remote-new']);
  assert.equal(h.session.closeCalls, 0);
});

test('refresh merges new remote transactions and metadata without dropping local edits or additions', async () => {
  const h = await fixture();
  await h.store.update(code, 'base-a', { fee: .1 });
  await h.store.add(code, trade('local-a', '2026-01-04'));
  const writes = h.storage.writes, refreshed = initial();
  refreshed[code].mode = 'profit-first'; refreshed[code].sourceNote = 'refreshed synthetic book';
  refreshed[code].transactions.push(trade('remote-new', '2026-01-03'));
  const result = h.store.replaceBase(refreshed);
  assert.deepEqual(result[code].transactions.map(item => item.id), ['base-a', 'remote-new', 'local-a']);
  assert.equal(result[code].transactions[0].fee, .1);
  assert.equal(result[code].sourceNote, 'refreshed synthetic book');
  assert.equal(result[code].mode, 'profit-first');
  assert.equal(h.storage.writes, writes);
});

test('a locally modified remote transaction survives a later remote source removal', async () => {
  const h = await fixture(); await h.store.update(code, 'base-a', { fee: .1 });
  const refreshed = initial(); refreshed[code].transactions = [];
  assert.equal(h.store.replaceBase(refreshed)[code].transactions[0].id, 'base-a');
});

test('a local ID later present in remote data merges once and is tombstoned when deleted', async () => {
  const h = await fixture(); await h.store.add(code, trade('local-a'));
  const refreshed = initial(); refreshed[code].transactions.push(trade('local-a'));
  assert.equal(h.store.replaceBase(refreshed)[code].transactions.filter(item => item.id === 'local-a').length, 1);
  await h.store.remove(code, 'local-a');
  assert.deepEqual((await h.overlay()).funds[code].deletedIds, ['local-a']);
});

test('local persistence contains only authenticated ciphertext and reopens with the same session key', async () => {
  const h = await fixture(); await h.store.add(code, trade('local-a'));
  const serialized = h.storage.getItem(TRANSACTION_STORAGE_KEY), record = JSON.parse(serialized);
  assert.deepEqual(Object.keys(record).sort(), ['ciphertext', 'iv', 'version']);
  assert.doesNotMatch(serialized, /transactions|amount|shares|sourceNote|synthetic metadata|funds/);
  const reopened = await createTransactionStore(h.session, initial(), { storage: h.storage });
  assert.deepEqual(reopened.getFunds(), h.store.getFunds());
});

test('the production vault session encrypts and decrypts a synthetic transaction overlay without any real source access', async () => {
  const envelope = await demoEnvelope({ funds: initial() }), requests = [];
  let session;
  await unlockVault(getDailyCode(), {
    fetchFn: async url => { requests.push(url); return { ok: true, json: async () => envelope }; },
    onSession: value => { session = value; },
  });
  const storage = memoryStorage(), store = await createTransactionStore(session, initial(), { storage });
  await store.add(code, trade('real-crypto-synthetic'));
  const reopened = await createTransactionStore(session, initial(), { storage });
  assert.deepEqual(reopened.getFunds(), store.getFunds());
  assert.deepEqual(requests, ['./data/ledger.enc.json']);
  store.close(); reopened.close();
  assert.equal(session.closed, false);
  session.close();
});

test('malformed, tampered or unrelated local ciphertext is retained and does not close the vault', async () => {
  const h = await fixture();
  const unrelated = JSON.stringify(await h.session.encryptLocal({ bonds: [], updatedAt: '2026-01-01' }));
  for (const value of ['', '{', JSON.stringify({ funds: {} }), JSON.stringify({ version: 1, iv: 'AA==', ciphertext: 'AA==' }), unrelated]) {
    h.storage.values.set(TRANSACTION_STORAGE_KEY, value);
    await assert.rejects(createTransactionStore(h.session, initial(), { storage: h.storage }), isCode('transaction-storage-invalid'));
    assert.equal(h.storage.getItem(TRANSACTION_STORAGE_KEY), value);
    assert.equal(h.session.closeCalls, 0);
  }
});

test('a rotated session key cannot silently replace unreadable encrypted edits', async () => {
  const h = await fixture(); await h.store.add(code, trade('local-a'));
  const rotated = await cryptoSession(), previous = h.storage.getItem(TRANSACTION_STORAGE_KEY);
  await assert.rejects(createTransactionStore(rotated, initial(), { storage: h.storage }), isCode('transaction-storage-invalid'));
  assert.equal(h.storage.getItem(TRANSACTION_STORAGE_KEY), previous);
  assert.equal(rotated.closeCalls, 0);
});

test('storage opening failures disable editing without closing the shared vault session', async () => {
  const session = await cryptoSession(), storage = memoryStorage(); storage.failReads(true);
  await assert.rejects(createTransactionStore(session, initial(), { storage }), isCode('transaction-storage-unavailable'));
  assert.equal(session.closeCalls, 0);
  await assert.rejects(createTransactionStore(session, initial(), { storage: null }), isCode('transaction-storage-unavailable'));
});

test('a write failure preserves last accepted memory and ciphertext and permits a later retry', async () => {
  const h = await fixture(); await h.store.add(code, trade('local-a'));
  const before = h.store.getFunds(), ciphertext = h.storage.getItem(TRANSACTION_STORAGE_KEY);
  h.storage.failWrites(true);
  await assert.rejects(h.store.update(code, 'base-a', { fee: .2 }), isCode('transaction-storage-unavailable'));
  assert.deepEqual(h.store.getFunds(), before);
  assert.equal(h.storage.getItem(TRANSACTION_STORAGE_KEY), ciphertext);
  h.storage.failWrites(false);
  await h.store.update(code, 'base-a', { fee: .2 });
  assert.equal(h.store.getFunds()[code].transactions[0].fee, .2);
});

test('another tab changing storage is detected without overwriting that record', async () => {
  const h = await fixture(); await h.store.add(code, trade('local-a'));
  const second = await createTransactionStore(h.session, initial(), { storage: h.storage });
  await second.add(code, trade('second-tab'));
  const latest = h.storage.getItem(TRANSACTION_STORAGE_KEY), before = h.store.getFunds();
  await assert.rejects(h.store.remove(code, 'base-a'), isCode('transaction-storage-conflict'));
  assert.equal(h.storage.getItem(TRANSACTION_STORAGE_KEY), latest);
  assert.deepEqual(h.store.getFunds(), before);
});

test('concurrent mutations serialize and operate on the previous committed result', async () => {
  const h = await fixture();
  const operations = [h.store.add(code, trade('local-a')), h.store.update(code, 'local-a', { fee: .2 }), h.store.remove(code, 'base-a')];
  await Promise.all(operations);
  assert.deepEqual(h.store.getFunds()[code].transactions.map(item => item.id), ['local-a']);
  assert.equal(h.store.getFunds()[code].transactions[0].fee, .2);
  assert.equal(h.storage.writes, 3);
});

test('invalid operations do not poison the write queue or modify stored records', async () => {
  const h = await fixture();
  await assert.rejects(h.store.update(code, 'missing', {}), isCode('transaction-not-found'));
  await assert.rejects(h.store.remove(code, 'missing'), isCode('transaction-not-found'));
  await assert.rejects(h.store.add(code, trade()), isCode('transaction-duplicate'));
  assert.equal(h.storage.writes, 0);
  await h.store.add(code, trade('local-a'));
  assert.equal(h.storage.writes, 1);
});

test('input and returned object mutations cannot alter a queued or committed transaction', async () => {
  const h = await fixture(), input = trade('local-a');
  const pending = h.store.add(code, input); input.amount = 777;
  const result = await pending; result[code].transactions[1].amount = 888;
  assert.equal(h.store.getFunds()[code].transactions[1].amount, 10);
});

test('a refresh during encryption retains the refreshed base and queued local edit', async () => {
  const h = await fixture(), started = deferred(), waiting = deferred();
  const encrypt = h.session.encryptLocal.bind(h.session);
  h.session.encryptLocal = async value => { started.resolve(); await waiting.promise; return encrypt(value); };
  const pending = h.store.add(code, trade('local-a', '2026-01-04'));
  await started.promise;
  const refreshed = initial(); refreshed[code].transactions.push(trade('remote-new', '2026-01-03')); refreshed[code].nested.retained = 'refreshed';
  h.store.replaceBase(refreshed); waiting.resolve();
  const result = await pending;
  assert.deepEqual(result[code].transactions.map(item => item.id), ['base-a', 'remote-new', 'local-a']);
  assert.equal(result[code].nested.retained, 'refreshed');
});

test('close prevents asynchronous encryption completions and queued jobs from writing and leaves the vault open', async () => {
  const h = await fixture(), started = deferred(), waiting = deferred();
  const encrypt = h.session.encryptLocal.bind(h.session);
  h.session.encryptLocal = async value => { const record = await encrypt(value); started.resolve(); await waiting.promise; return record; };
  const pending = h.store.add(code, trade('local-a')), queued = h.store.add(other, trade('local-b'));
  const rejection = assert.rejects(pending, isCode('transaction-closed')), queuedRejection = assert.rejects(queued, isCode('transaction-closed'));
  await started.promise; h.store.close(); waiting.resolve();
  await Promise.all([rejection, queuedRejection]);
  assert.equal(h.storage.writes, 0); assert.equal(h.session.closeCalls, 0);
  assert.throws(() => h.store.getFunds(), isCode('transaction-closed'));
  assert.throws(() => h.store.replaceBase(initial()), isCode('transaction-closed'));
  await assert.rejects(h.store.add(code, trade('closed')), isCode('transaction-closed'));
  await assert.rejects(h.store.update(code, 'base-a', {}), isCode('transaction-closed'));
  await assert.rejects(h.store.remove(code, 'base-a'), isCode('transaction-closed'));
});

test('closing the vault during stored-record decryption preserves the ciphertext and rejects initialization', async () => {
  const h = await fixture(); await h.store.add(code, trade('local-a'));
  const decrypt = h.session.decryptLocal.bind(h.session), started = deferred(), waiting = deferred();
  h.session.decryptLocal = async value => { const decoded = await decrypt(value); started.resolve(); await waiting.promise; return decoded; };
  const previous = h.storage.getItem(TRANSACTION_STORAGE_KEY);
  const opening = createTransactionStore(h.session, initial(), { storage: h.storage });
  const rejection = assert.rejects(opening, isCode('transaction-closed'));
  await started.promise; h.session.close(); waiting.resolve(); await rejection;
  assert.equal(h.storage.getItem(TRANSACTION_STORAGE_KEY), previous);
  assert.equal(h.session.closeCalls, 1);
});

test('encryption failure or an invalid ciphertext result cannot accept edits', async () => {
  for (const encrypt of [async () => { throw new Error('synthetic crypto failure'); }, async () => ({ plaintext: 'synthetic' })]) {
    const h = await fixture(); h.session.encryptLocal = encrypt;
    await assert.rejects(h.store.add(code, trade('local-a')), isCode('transaction-save-failed'));
    assert.deepEqual(h.store.getFunds(), initial()); assert.equal(h.storage.writes, 0);
  }
});

test('invalid non-JSON data and invalid fund identities are rejected without leaking input values', async () => {
  const h = await fixture(), cyclic = {}; cyclic.self = cyclic;
  for (const value of [null, [], { ...trade('invalid'), amount: NaN }, { ...trade('invalid'), nested: cyclic }, { ...trade('invalid'), callback() {} }]) {
    await assert.rejects(h.store.add(code, value), isCode('transaction-invalid'));
  }
  for (const fund of ['__proto__', '123', '1234567', {}, null]) await assert.rejects(h.store.add(fund, trade('invalid')), isCode('transaction-invalid'));
  assert.equal(h.storage.writes, 0);
  const previous = h.store.getFunds();
  assert.throws(() => h.store.replaceBase({ [code]: { transactions: [trade(), trade()] } }), isCode('transaction-invalid'));
  assert.deepEqual(h.store.getFunds(), previous);
});

test('new funds can be added without altering existing books', async () => {
  const h = await fixture();
  const result = await h.store.add('006373', trade('new-fund'));
  assert.deepEqual(result[code], initial()[code]);
  assert.equal(result['006373'].transactions.length, 1);
});
