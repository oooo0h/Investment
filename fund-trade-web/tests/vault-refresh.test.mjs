import test from 'node:test';
import assert from 'node:assert/strict';
import { unlockVault, getDailyCode } from '../src/vault.js';
import { demoEnvelope } from '../scripts/demo-data.mjs';

test('a current session refreshes changed synthetic ciphertext without retaining a password', async () => {
  const first = { demo: true, funds: { '005698': { transactions: [], mode: 'profit-first' } } };
  const second = { demo: true, funds: { '005698': { transactions: [{ id: 'synthetic-new-row' }], mode: 'profit-first' } } };
  let envelope = await demoEnvelope(first);
  const previousFetch = globalThis.fetch;
  let session;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => envelope });
    assert.deepEqual(await unlockVault(getDailyCode(), { onSession: value => { session = value; } }), first);
    envelope = await demoEnvelope(second);
    assert.deepEqual(await session.refresh(), second);
    session.close();
    await assert.rejects(session.refresh(), /会话已结束/);
  } finally { session?.close(); globalThis.fetch = previousFetch; }
});

test('closing a session during a pending fetch prevents its result from being returned', async () => {
  const payload = { demo: true, funds: { '016701': { transactions: [], mode: 'profit-first' } } };
  const envelope = await demoEnvelope(payload);
  const previousFetch = globalThis.fetch;
  let session;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => envelope });
    await unlockVault(getDailyCode(), { onSession: value => { session = value; } });
    let release;
    globalThis.fetch = () => new Promise(resolve => { release = resolve; });
    const pending = session.refresh();
    session.close();
    release({ ok: true, json: async () => envelope });
    await assert.rejects(pending, /会话已结束/);
  } finally { session?.close(); globalThis.fetch = previousFetch; }
});
