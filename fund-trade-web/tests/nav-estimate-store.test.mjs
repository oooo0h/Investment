// Synthetic public fund codes, calendar dates and return ratios only; no real storage or accounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FUND_CODES } from '../src/funds.js';
import { NAV_ESTIMATE_STORAGE_KEY, MAX_NAV_ESTIMATES, loadNavEstimates, saveNavEstimates } from '../src/nav-estimate-store.js';

const now = new Date('2026-10-19T04:00:00Z');
const entry = (code = FUND_CODES[0], date = '2026-10-18', change = .0125) => ({ code, date, change });
const payload = entries => JSON.stringify({ version: 1, entries });
const unavailable = { entries: [], available: false };
const empty = { entries: [], available: true };
const fixedError = { name: 'Error', message: 'Unable to save NAV estimates.' };

function memoryStorage(initial = null) {
  let value = initial;
  const calls = [];
  return {
    calls,
    getItem(key) { calls.push(['get', key]); return value; },
    setItem(key, next) { calls.push(['set', key]); value = next; },
    readRaw() { return value; },
  };
}

test('saving and loading across independent reads preserve only public identities, dates and ratios', () => {
  const storage = memoryStorage();
  const rows = [entry(FUND_CODES[1], '2026-10-17', -.015), entry()];
  const before = structuredClone(rows);
  const saved = saveNavEstimates(rows, { storage, now });
  assert.deepEqual(rows, before);
  assert.deepEqual(saved, [entry(), entry(FUND_CODES[1], '2026-10-17', -.015)]);
  const persisted = JSON.parse(storage.readRaw());
  assert.deepEqual(persisted, { version: 1, entries: saved });
  assert.deepEqual(Object.keys(persisted).sort(), ['entries', 'version']);
  for (const row of persisted.entries) assert.deepEqual(Object.keys(row).sort(), ['change', 'code', 'date']);
  const reloaded = loadNavEstimates({ storage: memoryStorage(storage.readRaw()), now });
  assert.deepEqual(reloaded, { entries: saved, available: true });
  saved[0].change = 99;
  assert.deepEqual(loadNavEstimates({ storage, now }).entries[0], entry());
  assert.ok(storage.calls.every(call => call[1] === NAV_ESTIMATE_STORAGE_KEY));
});

test('loads filter invalid entries and keep the last valid duplicate for each fund/date', () => {
  const valid = entry();
  const storage = memoryStorage(payload([
    valid, { ...valid, change: .03 }, { ...valid, change: NaN },
    { ...valid, arbitrary: 'synthetic-untrusted' }, null, [],
    entry(FUND_CODES[1], '2026-10-17', 0), entry('000216'),
    entry(FUND_CODES[2], '2026-10-19'), entry(FUND_CODES[2], '2026-02-30'),
  ]));
  assert.deepEqual(loadNavEstimates({ storage, now }), {
    entries: [{ ...valid, change: .03 }, entry(FUND_CODES[1], '2026-10-17', 0)], available: true,
  });
});

test('bad JSON, wrong schemas and entirely invalid payloads remain available for replacement', () => {
  for (const raw of [null, '', 'not JSON', 'null', '[]', '{}', 'true', '1',
    JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: '1', entries: [] }),
    JSON.stringify({ version: 1, entries: {}, extra: true }),
    JSON.stringify({ version: 1, entries: [], arbitrary: 'synthetic-untrusted' }),
    payload([null, entry('000216'), entry(FUND_CODES[0], '2026-10-19')]),
  ]) {
    const storage = memoryStorage(raw);
    assert.deepEqual(loadNavEstimates({ storage, now }), empty);
    assert.deepEqual(saveNavEstimates([entry()], { storage, now }), [entry()]);
  }
});

test('storage read failure reports unavailable and never throws underlying details', () => {
  const storage = { getItem() { throw new Error('synthetic read details'); } };
  assert.deepEqual(loadNavEstimates({ storage, now }), unavailable);
  for (const target of [null, {}, { getItem: false }]) assert.deepEqual(loadNavEstimates({ storage: target, now }), unavailable);
});

test('writes fail with one fixed message when storage is inaccessible or quota is exhausted', () => {
  for (const storage of [null, {}, { setItem() { throw new Error('synthetic write details'); } }]) {
    assert.throws(() => saveNavEstimates([entry()], { storage, now }), fixedError);
  }
});

test('one invalid update row rejects the entire save before any write', () => {
  const invalidRows = [
    null, {}, [], { ...entry(), nav: 1 }, { ...entry(), arbitrary: 'synthetic-untrusted' },
    { code: FUND_CODES[0], date: '2026-10-18' }, { ...entry(), code: 5698 }, entry('000216'),
    entry(FUND_CODES[0], '2026-10-19'), entry(FUND_CODES[0], '2026-10-20'),
    ...['2026-02-30', '2025-02-29', '2026-13-01', '2026-2-01', ' 2026-10-18', '2026-10-18T00:00:00Z', null, ''].map(date => entry(FUND_CODES[0], date)),
    ...[NaN, Infinity, -Infinity, -1, -2, null, true, '.01'].map(change => entry(FUND_CODES[0], '2026-10-18', change)),
  ];
  for (const invalid of invalidRows) {
    const storage = memoryStorage(payload([entry()]));
    const before = storage.readRaw();
    assert.throws(() => saveNavEstimates([entry(), invalid], { storage, now }), fixedError);
    assert.equal(storage.readRaw(), before);
    assert.equal(storage.calls.length, 0, 'validation finishes before storage access');
  }
  for (const value of [null, {}, '[]']) assert.throws(() => saveNavEstimates(value, { storage: memoryStorage(), now }), fixedError);
});

test('save deduplicates valid rows, permits deliberate zero or large positive rates and supports clearing', () => {
  const storage = memoryStorage();
  const rows = [entry(), entry(FUND_CODES[0], '2026-10-18', -.01), entry(FUND_CODES[1], '2026-10-18', -0), entry(FUND_CODES[2], '2026-10-18', 12)];
  assert.deepEqual(saveNavEstimates(rows, { storage, now }), [
    entry(FUND_CODES[0], '2026-10-18', -.01), entry(FUND_CODES[1], '2026-10-18', 0), entry(FUND_CODES[2], '2026-10-18', 12),
  ]);
  assert.deepEqual(saveNavEstimates([], { storage, now }), []);
  assert.deepEqual(JSON.parse(storage.readRaw()), { version: 1, entries: [] });
});

test('the entry limit rejects oversized loads and saves without truncating or writing', () => {
  const rows = Array.from({ length: MAX_NAV_ESTIMATES + 1 }, () => entry());
  const storage = memoryStorage(payload(rows));
  assert.deepEqual(loadNavEstimates({ storage, now }), empty);
  assert.throws(() => saveNavEstimates(rows, { storage, now }), fixedError);
  assert.equal(storage.calls.filter(call => call[0] === 'set').length, 0);
  assert.deepEqual(saveNavEstimates(rows.slice(0, MAX_NAV_ESTIMATES), { storage, now }), [entry()]);
});

test('Beijing midnight changes eligible yesterday and invalid clocks never persist data', () => {
  const rows = [entry()];
  const storage = memoryStorage(payload(rows));
  const beforeMidnight = new Date('2026-10-18T15:59:59Z');
  assert.deepEqual(loadNavEstimates({ storage, now: beforeMidnight }), empty);
  assert.throws(() => saveNavEstimates(rows, { storage, now: beforeMidnight }), fixedError);
  assert.deepEqual(loadNavEstimates({ storage, now: new Date('2026-10-18T16:00:00Z') }).entries, rows);
  assert.deepEqual(loadNavEstimates({ storage, now: new Date('invalid') }), empty);
  assert.throws(() => saveNavEstimates(rows, { storage, now: new Date('invalid') }), fixedError);
});

test('a throwing browser localStorage getter is caught when no adapter is supplied', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('synthetic blocked origin'); } });
  try {
    assert.deepEqual(loadNavEstimates({ now }), unavailable);
    assert.throws(() => saveNavEstimates([entry()], { now }), fixedError);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});
