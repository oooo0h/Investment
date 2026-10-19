// Invented records and an in-memory AES-GCM session only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBondStore, BOND_STORAGE_KEY, CASH_FLOW_STORAGE_KEY } from '../src/bond-store.js';
import { normalizeBondTransactions } from '../src/bond-transactions.js';

const initial = () => ({ funds: {}, bonds: [{ code: '006485', marketValue: 100, holdingProfit: 10 }, { code: '006663', marketValue: 200, holdingProfit: 20 }], freeCashFlow: null, updatedAt: '2026-10-19T01:00:00Z', holdingLots: { '006485': { complete: false, lots: [] } }, transactions: { '006485': [{ id: 'source-buy', date: '2026-10-01', type: 'buy', amount: 100, nav: null, shares: null, status: 'pending', sourceStatus: 'unverified' }] } });
async function fixture({ values = new Map(), storage, byte = 7 } = {}) {
  let source = initial(), closed = false, pause = null;
  const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(byte), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const requireOpen = () => { if (closed) throw Object.assign(new Error('closed'), { code: 'SESSION_CLOSED' }); };
  const session = {
    get closed() { return closed; }, close() { closed = true; }, async refresh() { requireOpen(); return structuredClone(source); },
    async encryptLocal(value) { requireOpen(); if (pause) await pause; requireOpen(); const iv = crypto.getRandomValues(new Uint8Array(12)); const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value))); requireOpen(); return { version: 1, iv: Buffer.from(iv).toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64') }; },
    async decryptLocal(value) { requireOpen(); const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(value.iv, 'base64') }, key, Buffer.from(value.ciphertext, 'base64')); requireOpen(); return JSON.parse(new TextDecoder().decode(plain)); },
  };
  const accesses = [];
  const backing = storage || { getItem(key) { accesses.push(['read', key]); return values.get(key) ?? null; }, setItem(key, value) { accesses.push(['write', key]); values.set(key, value); } };
  const store = await createBondStore(session, source, { storage: backing, now: () => '2026-10-19T02:00:00Z' });
  return { store, session, values, accesses, setSource(value) { source = value; }, pause(value) { pause = value; } };
}

test('the table source is immutable and legacy local bond financial edits are never read or removed', async () => {
  const values = new Map([[BOND_STORAGE_KEY, 'legacy-opaque-record']]); const h = await fixture({ values });
  assert.equal(h.store.save, undefined);
  assert.ok(h.accesses.every(([, key]) => key !== BOND_STORAGE_KEY));
  assert.equal(values.get(BOND_STORAGE_KEY), 'legacy-opaque-record');
  const snapshot = h.store.getSnapshot(); snapshot.bonds[0].marketValue = 999; snapshot.transactions['006485'][0].amount = 999; snapshot.holdingLots['006485'].complete = true;
  assert.equal(h.store.getSnapshot().bonds[0].marketValue, 100);
  assert.equal(h.store.getSnapshot().transactions['006485'][0].amount, 100);
  assert.equal(h.store.getSnapshot().holdingLots['006485'].complete, false); h.store.close();
});

test('only free cash flow is sealed in the new storage key and survives reopening without changing source data', async () => {
  const values = new Map([[BOND_STORAGE_KEY, 'legacy']]), h = await fixture({ values });
  await h.store.saveFreeCashFlow(12.35);
  const raw = values.get(CASH_FLOW_STORAGE_KEY), payload = await h.session.decryptLocal(JSON.parse(raw));
  assert.deepEqual(Object.keys(payload).sort(), ['freeCashFlow', 'updatedAt']);
  assert.doesNotMatch(raw, /freeCashFlow|marketValue|holdingProfit|transactions|holdingLots/);
  assert.deepEqual(h.store.getSnapshot().bonds, initial().bonds); h.store.close();
  const reopened = await fixture({ values }); assert.equal(reopened.store.getSnapshot().freeCashFlow, 12.35);
  await reopened.store.saveFreeCashFlow(null); assert.equal(reopened.store.getSnapshot().freeCashFlow, null);
  assert.equal(values.get(BOND_STORAGE_KEY), 'legacy'); reopened.store.close();
});

test('source refresh replaces financial values, records and lot evidence while retaining independent cash flow', async () => {
  const h = await fixture(); await h.store.saveFreeCashFlow(-12.35);
  const next = initial(); next.bonds[0].marketValue = 150; next.transactions['006485'][0].amount = 125; next.holdingLots['006485'].complete = true;
  h.setSource(next); const refreshed = await h.store.refresh();
  assert.equal(refreshed.bonds[0].marketValue, 150); assert.equal(refreshed.transactions['006485'][0].amount, 125);
  assert.equal(refreshed.holdingLots['006485'].complete, true); assert.equal(refreshed.freeCashFlow, -12.35); h.store.close();
});

test('corrupt or blocked cash preferences do not hide the table source and are never overwritten', async () => {
  const values = new Map([[CASH_FLOW_STORAGE_KEY, 'corrupt'], [BOND_STORAGE_KEY, 'legacy']]); const h = await fixture({ values });
  assert.equal(h.store.getSnapshot().bonds.length, 2); assert.equal(h.store.getSnapshot().cashFlowUnavailable, true);
  await assert.rejects(h.store.saveFreeCashFlow(1), { code: 'bond-storage-invalid' }); assert.equal(values.get(CASH_FLOW_STORAGE_KEY), 'corrupt'); h.store.close();
  const blocked = await fixture({ storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });
  assert.equal(blocked.store.getSnapshot().bonds.length, 2); assert.equal(blocked.store.getSnapshot().cashFlowUnavailable, true);
  await assert.rejects(blocked.store.saveFreeCashFlow(1), { code: 'bond-storage-unavailable' }); blocked.store.close();
});

test('cash write failure preserves the previous encrypted record and a later attempt can retry', async () => {
  let fail = false; const values = new Map(); const h = await fixture({ values, storage: { getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { if (fail) throw new Error('blocked'); values.set(key, value); } } });
  await h.store.saveFreeCashFlow(1); const before = values.get(CASH_FLOW_STORAGE_KEY); fail = true;
  await assert.rejects(h.store.saveFreeCashFlow(2), { code: 'bond-storage-unavailable' });
  assert.equal(values.get(CASH_FLOW_STORAGE_KEY), before); assert.equal(h.store.getSnapshot().freeCashFlow, 1);
  fail = false; await h.store.saveFreeCashFlow(3); assert.equal(h.store.getSnapshot().freeCashFlow, 3); h.store.close();
});

test('locking during encryption prevents a pending cash write from persisting', async () => {
  const h = await fixture(); let release; h.pause(new Promise(resolve => { release = resolve; }));
  const pending = h.store.saveFreeCashFlow(1); await Promise.resolve(); h.store.close(); release();
  await assert.rejects(pending, { code: 'bond-closed' }); assert.equal(h.values.size, 0); assert.throws(h.store.getSnapshot, { code: 'bond-closed' });
});

test('transaction normalization keeps pending facts separate and removes cancelled applications before display', () => {
  const input = initial().transactions; input['006485'].push({ id: 'cancelled', status: 'cancelled' });
  input['006485'][0].requestedShares = 3; input['006485'][0].confirmedAmount = null; input['006485'][0].confirmedDate = null;
  const normalized = normalizeBondTransactions(input);
  assert.equal(normalized['006485'].length, 1); assert.equal(normalized['006485'][0].requestedShares, 3); assert.equal(normalized['006485'][0].shares, null); assert.equal(normalized['006485'][0].navDate, null);
  assert.throws(() => normalizeBondTransactions({ '006485': [{ ...input['006485'][0], status: 'confirmed' }] }), /Invalid bond transactions/);
  assert.throws(() => normalizeBondTransactions({ '006485': [{ ...input['006485'][0], date: '2026-02-30' }] }), /Invalid bond transactions/);
});

test('transaction provenance preserves calculated facts separately from reported confirmations and pending status', () => {
  const pending = initial().transactions['006485'][0];
  const calculated = { ...pending, id: 'calculated', shares: 10, nav: 1, confirmedDate: '2026-10-02', sharesBasis: 'calculated', sourceStatus: 'calculated' };
  const normalized = normalizeBondTransactions({ '006485': [pending, calculated, { ...calculated, id: 'calculated-complete', status: 'confirmed' }] });
  assert.equal(normalized['006485'][0].sharesBasis, 'reported');
  assert.equal(normalized['006485'][1].sharesBasis, 'calculated');
  assert.equal(normalized['006485'][1].sourceStatus, 'calculated');
  assert.equal(normalized['006485'][1].status, 'pending');
  assert.equal(normalized['006485'][2].status, 'confirmed');
  assert.equal(normalized['006485'][2].sharesBasis, 'calculated');
  for (const sharesBasis of ['', 'estimated', 1]) {
    assert.throws(() => normalizeBondTransactions({ '006485': [{ ...calculated, sharesBasis }] }), /Invalid bond transactions/);
  }
});

test('source refresh preserves estimated lot and transaction provenance without persisting financial overlays', async () => {
  const h = await fixture();
  const next = initial();
  next.holdingLots['006485'] = { complete: false, basis: 'calculated', lots: [{ confirmedDate: '2026-10-02', remainingShares: 10, status: 'confirmed' }] };
  next.transactions['006485'][0] = { ...next.transactions['006485'][0], shares: 10, nav: 1, sharesBasis: 'calculated', sourceStatus: 'calculated' };
  h.setSource(next);
  const refreshed = await h.store.refresh();
  assert.equal(refreshed.holdingLots['006485'].basis, 'calculated');
  assert.equal(refreshed.holdingLots['006485'].complete, false);
  assert.equal(refreshed.transactions['006485'][0].sharesBasis, 'calculated');
  assert.equal(refreshed.transactions['006485'][0].status, 'pending');
  assert.equal(h.values.size, 0);
  refreshed.holdingLots['006485'].lots[0].remainingShares = 999;
  assert.equal(h.store.getSnapshot().holdingLots['006485'].lots[0].remainingShares, 10);
  h.store.close();
});
