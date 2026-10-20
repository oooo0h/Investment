import test from 'node:test';
import assert from 'node:assert/strict';
import { demoVault, demoNav, demoEnvelope } from '../scripts/demo-data.mjs';
import { calculateLedger } from '../src/engine.js';
import { unlockVault, getDailyCode } from '../src/vault.js';
import { FUND_CODES } from '../src/funds.js';
test('standalone demo is synthetic, covers the existing funds and unlocks without account files', async () => {
  assert.equal(demoVault.demo, true);
  assert.deepEqual(Object.keys(demoVault.funds).sort(), [...FUND_CODES].sort());
  for (const code of FUND_CODES) {
    assert.ok(demoNav[code].demo);
    assert.equal(calculateLedger(demoVault.funds[code].transactions).errors.length, 0);
  }
  const envelope = await demoEnvelope(demoVault);
  assert.deepEqual(await unlockVault(getDailyCode(), { fetchFn: async () => ({ ok: true, json: async () => envelope }) }), demoVault);
});
