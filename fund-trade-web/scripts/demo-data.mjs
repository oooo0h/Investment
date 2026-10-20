// Synthetic fixtures only. This module never reads any account or archive file.
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { FUND_CODES } from '../src/funds.js';
import { getDailyCode } from '../src/vault.js';

const day = new Date().toISOString().slice(0, 10);
const dates = Array.from({ length: 45 }, (_, index) => new Date(Date.parse(`${day}T00:00:00Z`) - (44 - index) * 86400000).toISOString().slice(0, 10));
export const demoNav = Object.fromEntries(FUND_CODES.map((code, fundIndex) => {
  const history = dates.map((date, index) => ({ date, nav: Number((1 + fundIndex * .1 + index * .002 + Math.sin(index / 4) * .018).toFixed(4)) }));
  return [code, { code, demo: true, source: '本地虚构数据', sourceLabel: '本地虚构数据',
    asOf: day, firstDate: dates[0], lastDate: day, count: history.length, history }];
}));
export const demoVault = { demo: true, createdAt: '本地虚构数据', funds: Object.fromEntries(FUND_CODES.map(code => {
  const nav = demoNav[code].history[0].nav;
  return [code, { mode: 'profit-first', rate: '0', transactions: [
    { id: `demo-${code}-buy`, date: dates[0], type: 'buy', status: 'confirmed', sourceStatus: 'confirmed', nav, shares: 100, amount: Number((nav * 100).toFixed(2)), fee: 0 },
  ] }];
})) };

const rawKey = randomBytes(32);
let cachedDay, cachedWrapping;
function seal(key, value) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  return { iv: iv.toString('base64'), ciphertext: Buffer.concat([cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString('base64') };
}
export async function demoEnvelope(payload) {
  const code = getDailyCode();
  if (cachedDay !== code) {
    const salt = randomBytes(16), wrappingKey = pbkdf2Sync(code, salt, 600000, 32, 'sha256');
    cachedWrapping = { salt: salt.toString('base64'), ...seal(wrappingKey, rawKey) };
    wrappingKey.fill(0); cachedDay = code;
  }
  const plaintext = Buffer.from(JSON.stringify(payload));
  try { return { version: 2, kdf: 'PBKDF2-SHA256', iterations: 600000, keys: { [code]: cachedWrapping }, ...seal(rawKey, plaintext) }; }
  finally { plaintext.fill(0); }
}
