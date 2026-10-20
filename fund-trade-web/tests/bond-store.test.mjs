// All values, payloads and storage below are synthetic. No account file is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createBondStore, openBondStore, BOND_STORAGE_KEY } from '../src/bond-store.js';
import { unlockVault, getDailyCode } from '../src/vault.js';
import { demoEnvelope } from '../scripts/demo-data.mjs';

const initial = () => ({ funds: {}, bonds: [
  { code: '006485', marketValue: 100, holdingProfit: -10 },
  { code: '006663', marketValue: 200, holdingProfit: 20 },
], freeCashFlow: null, updatedAt: '2026-01-01T00:00:00.000Z' });
const changed = () => [
  { code: '006485', marketValue: 120, holdingProfit: 5 },
  { code: '006663', marketValue: 180, holdingProfit: -5 },
];
const holdingLots = () => ({
  '006485': { complete: true, lots: [{ confirmedDate: '2025-12-15', remainingShares: 3, status: 'confirmed' }] },
  '006663': { complete: false, lots: [] },
});
const b64 = value => Buffer.from(value).toString('base64');
const isCode = code => error => error?.code === code;
const deferred = () => {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
};

function storageHarness() {
  const values = new Map();
  let failWrites = false;
  return { values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { if (failWrites) throw new Error('synthetic storage failure'); values.set(key, value); },
    failWrites(value) { failWrites = value; },
  };
}

async function sessionFor(payload = initial(), envelope = null, password = getDailyCode()) {
  const file = envelope || await demoEnvelope(payload);
  const requests = [];
  let session;
  const fetchFn = async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => file }; };
  const decoded = await unlockVault(password, { url: './data/bonds.enc.json', fetchFn, onSession: value => { session = value; } });
  return { session, file, decoded, requests, fetchFn };
}

async function legacyEnvelope(payload) {
  const password = 'synthetic-v1-secret';
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const material = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return { password, envelope: { version: 1, kdf: 'PBKDF2-SHA256', iterations: 600000, salt: b64(salt), iv: b64(iv), ciphertext: b64(ciphertext) } };
}

test('only the two explicit encrypted URLs are accepted and a bond session refreshes its own URL', async () => {
  let calls = 0;
  for (const url of ['https://example.invalid/bonds.enc.json', './data/../bonds.enc.json', './data/bonds.enc.json?x', '/data/bonds.enc.json', './data/other.enc.json']) {
    await assert.rejects(unlockVault('synthetic', { url, fetchFn: async () => { calls += 1; } }), /不支持/);
  }
  assert.equal(calls, 0);
  const h = await sessionFor();
  assert.deepEqual(await h.session.refresh(), initial());
  assert.ok(h.requests.every(request => request.url === './data/bonds.enc.json' && request.options.cache === 'no-store'));
  h.session.close();
});

test('session local encryption uses authenticated records, fresh IVs, and rejects public-envelope substitution', async () => {
  const h = await sessionFor();
  const value = { bonds: changed(), updatedAt: '2026-01-08T00:00:00.000Z' };
  const first = await h.session.encryptLocal(value);
  const second = await h.session.encryptLocal(value);
  assert.deepEqual(Object.keys(first).sort(), ['ciphertext', 'iv', 'version']);
  assert.equal(first.version, 1);
  assert.notEqual(first.iv, second.iv);
  assert.deepEqual(await h.session.decryptLocal(first), value);
  await assert.rejects(h.session.decryptLocal({ ...first, plaintext: 'must be rejected' }), /格式无效/);
  await assert.rejects(h.session.decryptLocal({ version: 1, iv: h.file.iv, ciphertext: h.file.ciphertext }));
  const tampered = { ...first, ciphertext: b64(new Uint8Array(32)) };
  await assert.rejects(h.session.decryptLocal(tampered));
  h.session.close();
});

test('session close blocks local reads and writes including pending cryptographic completions', async () => {
  const first = await sessionFor();
  const encrypting = first.session.encryptLocal(initial());
  first.session.close();
  await assert.rejects(encrypting, isCode('SESSION_CLOSED'));
  await assert.rejects(first.session.encryptLocal(initial()), isCode('SESSION_CLOSED'));
  const second = await sessionFor();
  const sealed = await second.session.encryptLocal(initial());
  const decrypting = second.session.decryptLocal(sealed);
  second.session.close();
  await assert.rejects(decrypting, isCode('SESSION_CLOSED'));
  await assert.rejects(second.session.decryptLocal(sealed), isCode('SESSION_CLOSED'));
});

test('the imported data key is nonextractable and can encrypt and decrypt while the wrapping key only decrypts', async () => {
  const file = await demoEnvelope(initial());
  const subtle = globalThis.crypto.subtle;
  const originalImport = subtle.importKey.bind(subtle);
  const originalDerive = subtle.deriveKey.bind(subtle);
  const importDescriptor = Object.getOwnPropertyDescriptor(subtle, 'importKey');
  const deriveDescriptor = Object.getOwnPropertyDescriptor(subtle, 'deriveKey');
  const imported = [], derived = [];
  let session;
  try {
    subtle.importKey = async (...args) => { const key = await originalImport(...args); imported.push(key); return key; };
    subtle.deriveKey = async (...args) => { const key = await originalDerive(...args); derived.push(key); return key; };
    ({ session } = await sessionFor(initial(), file));
    const dataKey = imported.find(key => key.algorithm.name === 'AES-GCM');
    assert.equal(dataKey.extractable, false);
    assert.deepEqual([...dataKey.usages].sort(), ['decrypt', 'encrypt']);
    assert.equal(derived[0].extractable, false);
    assert.deepEqual([...derived[0].usages], ['decrypt']);
    await assert.rejects(subtle.exportKey('raw', dataKey));
  } finally {
    session?.close();
    if (importDescriptor) Object.defineProperty(subtle, 'importKey', importDescriptor); else delete subtle.importKey;
    if (deriveDescriptor) Object.defineProperty(subtle, 'deriveKey', deriveDescriptor); else delete subtle.deriveKey;
  }
});

