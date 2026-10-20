import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { unlockVault, getDailyCode } from '../src/vault.js';

test('encrypted ledger decrypts with the chosen password and rejects incorrect passwords', async () => {
  const password = 'synthetic-test-secret';
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const material = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const expected = { createdAt: '2026-10-15', funds: { '005698': { transactions: [], mode: 'profit-first' } } };
  const cipher = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(expected)));
  const b64 = data => Buffer.from(data).toString('base64');
  const envelope = { version: 1, kdf: 'PBKDF2-SHA256', iterations: 600000, salt: b64(salt), iv: b64(iv), ciphertext: b64(cipher) };
  const savedFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => envelope });
    assert.deepEqual(await unlockVault(password), expected);
    await assert.rejects(unlockVault('incorrect-synthetic-secret'), /密码不正确/);
    envelope.ciphertext = b64(new Uint8Array(24));
    await assert.rejects(unlockVault(password), /密码不正确/);
  } finally { globalThis.fetch = savedFetch; }
});

test('missing encrypted payload is a loading error, not an empty ledger', async () => {
  const savedFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false });
    await assert.rejects(unlockVault('synthetic'), /加载失败/);
  } finally { globalThis.fetch = savedFetch; }
});

test('daily code is zero-padded and changes at Shanghai midnight', () => {
  assert.equal(getDailyCode(new Date('2026-10-15T05:00:00Z')), '1015');
  assert.equal(getDailyCode(new Date('2026-11-01T05:00:00Z')), '1101');
  assert.equal(getDailyCode(new Date('2026-10-31T15:59:59Z')), '1031');
  assert.equal(getDailyCode(new Date('2026-10-31T16:00:00Z')), '1101');
  assert.equal(getDailyCode(new Date('2028-02-29T05:00:00Z')), '0229');
});

test('daily key envelope unlocks only with the current date code', async () => {
  const code = getDailyCode();
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const wrapIv = webcrypto.getRandomValues(new Uint8Array(12));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const rawKey = webcrypto.getRandomValues(new Uint8Array(32));
  const material = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
  const wrappingKey = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const dataKey = await webcrypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const wrapped = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, wrappingKey, rawKey);
  const expected = { funds: { '016701': { transactions: [], mode: 'profit-first' } } };
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, dataKey, new TextEncoder().encode(JSON.stringify(expected)));
  const b64 = data => Buffer.from(data).toString('base64');
  const envelope = { version: 2, kdf: 'PBKDF2-SHA256', iterations: 600000, iv: b64(iv), ciphertext: b64(ciphertext), keys: { [code]: { salt: b64(salt), iv: b64(wrapIv), ciphertext: b64(wrapped) } } };
  const savedFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => envelope });
    assert.deepEqual(await unlockVault(code), expected);
    await assert.rejects(unlockVault('wrong-date-code'), /密码不正确/);
  } finally { globalThis.fetch = savedFetch; }
});
