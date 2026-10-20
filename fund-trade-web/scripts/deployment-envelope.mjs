// Deployment plaintext is merged and re-encrypted only in memory.
import { webcrypto } from 'node:crypto';
import { FUND_CODES } from '../src/funds.js';
import { getDailyCode } from '../src/vault.js';
import { validateEncryptedEnvelope } from './publish-data.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const encode = value => Buffer.from(value).toString('base64');
const decode = value => Buffer.from(value, 'base64');
const clear = value => { if (value) new Uint8Array(value.buffer ?? value, value.byteOffset ?? 0, value.byteLength).fill(0); };

export async function createDeploymentEnvelope(liveVault, baseEnvelope, options = {}) {
  let passwordBytes, rawKey, previousBytes, nextBytes;
  try {
    const { dayCode = getDailyCode() } = options;
    const envelope = validateEncryptedEnvelope(structuredClone(baseEnvelope));
    const live = structuredClone(liveVault);
    if (typeof dayCode !== 'string' || !/^\d{4}$/.test(dayCode) || !Object.hasOwn(envelope.keys, dayCode)
      || !object(live) || live.demo !== false || !object(live.funds)) throw new Error();
    for (const code of FUND_CODES) {
      const fund = live.funds[code];
      if (!Object.hasOwn(live.funds, code) || !object(fund) || !Array.isArray(fund.transactions)
        || !['profit-first', 'principal-first'].includes(fund.mode)) throw new Error();
    }
    passwordBytes = new TextEncoder().encode(dayCode);
    const material = await webcrypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);
    const wrapped = envelope.keys[dayCode];
    const wrappingKey = await webcrypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: decode(wrapped.salt), iterations: envelope.iterations },
      material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
    rawKey = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(wrapped.iv) }, wrappingKey, decode(wrapped.ciphertext));
    if (rawKey.byteLength !== 32) throw new Error();
    const key = await webcrypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    previousBytes = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(envelope.iv) }, key, decode(envelope.ciphertext));
    const base = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(previousBytes));
    if (!object(base) || !object(base.funds)) throw new Error();
    const funds = { ...base.funds };
    for (const code of FUND_CODES) funds[code] = live.funds[code];
    const createdAt = live.createdAt ?? base.createdAt ?? null;
    if (createdAt !== null && typeof createdAt !== 'string') throw new Error();
    nextBytes = new TextEncoder().encode(JSON.stringify({ createdAt, funds }));
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, nextBytes);
    return validateEncryptedEnvelope({
      version: 2, kdf: envelope.kdf, iterations: envelope.iterations,
      iv: encode(iv), ciphertext: encode(ciphertext), keys: envelope.keys,
    });
  } catch {
    throw new Error('Deployment envelope unavailable.');
  } finally {
    for (const value of [passwordBytes, rawKey, previousBytes, nextBytes]) clear(value);
  }
}
