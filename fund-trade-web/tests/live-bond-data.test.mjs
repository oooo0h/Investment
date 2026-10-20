// Synthetic accounts only. No source workbook, image or account file is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveBondDataStore, createBondWorkbookEnvelope, normalizeBondWorkbookPayload } from '../scripts/live-bond-data.mjs';
import { demoEnvelope } from '../scripts/demo-data.mjs';
import { unlockVault, getDailyCode } from '../src/vault.js';

const fixture = () => ({ funds: {}, bonds: [
  { code: '006485', marketValue: 120, holdingProfit: 2 },
  { code: '006663', marketValue: 240, holdingProfit: -1 },
], updatedAt: '2026-01-01T00:00:00.000Z', freeCashFlow: null,
holdingLots: { '006485': { complete: false, lots: [] }, '006663': { complete: false, lots: [] } },
transactions: { '006485': [{ id: 'synthetic-order', date: '2026-01-01', submittedAt: '2026-01-01 10:00:00', type: 'buy',
  amount: 120, shares: null, nav: null, navDate: null, fee: null, status: 'pending', sourceStatus: 'processing', note: null }], '006663': [] },
});

test('bond source rejects malformed records without leaking their contents', () => {
  const payload = fixture();
  payload.bonds[0].marketValue = 'synthetic-private-marker';
  assert.throws(() => normalizeBondWorkbookPayload(payload), error => error.message === 'Local bond data unavailable.');
  assert.throws(() => normalizeBondWorkbookPayload({ ...fixture(), funds: { unsupported: {} } }), /Local bond data unavailable/);
});

test('workbook snapshot coalesces reads and changes revision only after a source change', async () => {
  let stamp = 'first', reads = 0, encryptions = 0, payload = fixture();
  const store = createLiveBondDataStore({
    getFingerprint: async () => stamp,
    readPayload: async () => { reads++; return structuredClone(payload); },
    readBaseEnvelope: async () => ({}),
    encryptPayload: async () => ({ ciphertext: `synthetic-${++encryptions}` }),
  });
  const [a, b] = await Promise.all([store.snapshot(), store.snapshot()]);
  assert.equal(a.revision, b.revision);
  assert.equal(reads, 1);
  assert.equal((await store.snapshot()).revision, a.revision);
  payload.bonds[0].marketValue += 1; stamp = 'second';
  const changed = await store.snapshot();
  assert.notEqual(changed.revision, a.revision);
  assert.equal(reads, 2);
  assert.equal(encryptions, 2);
  assert.deepEqual(Object.keys(changed).sort(), ['envelope', 'revision', 'status']);
});

test('an edit during the private source read is rejected and a later stable read recovers', async () => {
  let stamp = 'before', race = true;
  const store = createLiveBondDataStore({
    getFingerprint: async () => stamp,
    readPayload: async () => { if (race) stamp = 'after'; return fixture(); },
    readBaseEnvelope: async () => ({}), encryptPayload: async () => ({ ciphertext: 'synthetic' }),
  });
  await assert.rejects(store.snapshot(), /Local bond data unavailable/);
  race = false;
  assert.equal((await store.snapshot()).status, 'live');
});

test('new workbook envelopes preserve the existing session key and never mutate the base envelope', async () => {
  const initial = fixture();
  const base = await demoEnvelope(initial);
  const todayWrapper = base.keys[getDailyCode()];
  // Production requires all daily wrappers; only today's synthetic key is used.
  base.keys = Object.fromEntries(Array.from({ length: 366 }, (_, i) => [
    new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(5, 10).replace('-', ''), structuredClone(todayWrapper),
  ]));
  const baseCopy = structuredClone(base);
  let current = base, session;
  const fetchFn = async () => ({ ok: true, json: async () => current });
  await unlockVault(getDailyCode(), { url: './data/bonds.enc.json', fetchFn, onSession: opened => { session = opened; } });
  const next = fixture(); next.bonds[0].marketValue += 7;
  current = await createBondWorkbookEnvelope(next, base);
  assert.deepEqual(current.keys, base.keys);
  assert.deepEqual(base, baseCopy);
  assert.notEqual(current.ciphertext, base.ciphertext);
  assert.deepEqual(await session.refresh(), normalizeBondWorkbookPayload(next));
  session.close();
});
