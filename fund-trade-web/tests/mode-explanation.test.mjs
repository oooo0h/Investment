import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLedger, describeModeEffect } from '../src/engine.js';

// Entirely fictional records; no real account inputs or amounts are written here.
const buy = { type: 'buy', date: '2026-01-01', nav: 1, shares: 100, fee: 0 };
const compare = records => {
  const a = calculateLedger(records, { mode: 'profit-first' });
  const b = calculateLedger(records, { mode: 'principal-first' });
  return { a, b, note: describeModeEffect(a, b) };
};
test('no counted sale explains why the mode has no effect', () => {
  assert.equal(compare([buy]).note.kind, 'no-sells');
  assert.equal(compare([buy, { type: 'sell', status: 'pending' }]).note.kind, 'no-sells');
});
test('a sale without available profit explains the identical allocation', () => {
  const { a, b, note } = compare([buy, { type: 'sell', date: '2026-01-02', nav: .8, shares: 20, fee: 0 }]);
  assert.equal(note.kind, 'same-no-profit');
  assert.match(note.message, /没有可优先提取的利润/);
  assert.equal(a.summary.principal, b.summary.principal);
  assert.doesNotMatch(note.message, /\d/);
});
test('profitable partial redemption identifies a real allocation difference', () => {
  const { a, b, note } = compare([buy, { type: 'sell', date: '2026-01-02', nav: 1.5, shares: 20, fee: 0 }]);
  assert.equal(note.kind, 'different');
  assert.notEqual(a.summary.principal, b.summary.principal);
  assert.equal(a.summary.marketValue, b.summary.marketValue);
  assert.equal(a.summary.totalProfit, b.summary.totalProfit);
});
test('invalid or incomplete records do not claim the two modes are equivalent', () => {
  const { a, b } = compare([buy]);
  assert.equal(describeModeEffect(a, b, { incomplete: true }).kind, 'unavailable');
  assert.equal(compare([{ ...buy, nav: -1 }]).note.kind, 'unavailable');
});
