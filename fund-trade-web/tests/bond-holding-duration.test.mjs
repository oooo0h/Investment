// Synthetic remaining lots and public user-supplied fee settings only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BOND_FEE_RULES, calculateBondHoldingDuration, getBondRedemptionFeeRate, normalizeBondHoldingLots } from '../src/bond-holding-duration.js';

const now = '2026-10-19T07:00:00Z';
const lot = (confirmedDate, remainingShares, status = 'confirmed') => ({ confirmedDate, remainingShares, status });
const record = lots => ({ complete: true, lots });

test('ultrashort bond uses day seven at Beijing midnight while the other bond still uses day thirty', () => {
  const source = record([lot('2026-10-12', 1)]);
  const before = calculateBondHoldingDuration(source, { code: '006663', now: '2026-10-18T15:59:59.999Z' });
  const after = calculateBondHoldingDuration(source, { code: '006663', now: '2026-10-18T16:00:00.000Z' });
  assert.equal(before.recentRatio, 1);
  assert.equal(before.remainingDays, 1);
  assert.equal(after.recentRatio, 0);
  assert.equal(after.matureRatio, 1);
  assert.equal(after.remainingDays, 0);
  assert.equal(after.maturityDays, 7);
  const other = calculateBondHoldingDuration(source, { code: '006485', now });
  assert.equal(other.recentRatio, 1);
  assert.equal(other.maturityDays, 30);
  const mixed = calculateBondHoldingDuration(record([lot('2026-10-13', 1), lot('2026-10-12', 3)]), { code: '006663', now });
  assert.equal(mixed.recentRatio, .25);
  assert.equal(mixed.matureRatio, .75);
});

test('current remaining shares, not original invested amounts, weight the red and green portions', () => {
  const source = record([lot('2026-09-20', 3), lot('2026-09-19', 1)]);
  const before = structuredClone(source);
  const result = calculateBondHoldingDuration(source, { now });
  assert.equal(result.status, 'known');
  assert.equal(result.recentRatio, .75);
  assert.equal(result.matureRatio, .25);
  assert.equal(result.youngestDays, 29);
  assert.equal(result.oldestDays, 30);
  assert.equal(result.remainingDays, 1);
  assert.equal(result.maturityDays, 30);
  assert.equal(result.lotCount, 2);
  assert.deepEqual(source, before);
  assert.ok(!Object.keys(result).some(key => /amount|share|nav|cost|profit|value/i.test(key)));
});

test('the 30-day boundary includes exactly day 30 and uses Beijing midnight', () => {
  const source = record([lot('2026-09-19', 1)]);
  const before = calculateBondHoldingDuration(source, { now: '2026-10-18T15:59:59.999Z' });
  const after = calculateBondHoldingDuration(source, { now: '2026-10-18T16:00:00.000Z' });
  assert.equal(before.youngestDays, 29);
  assert.equal(before.recentRatio, 1);
  assert.equal(after.youngestDays, 30);
  assert.equal(after.matureRatio, 1);
  assert.equal(after.remainingDays, 0);
  assert.equal(calculateBondHoldingDuration(source, { now: '2026-10-19' }).matureRatio, 1);
});

test('pending, cancelled and zero remaining lots cannot change current holding weights', () => {
  const result = calculateBondHoldingDuration(record([
    lot('2026-09-20', 2), lot('2026-08-01', 2),
    lot(null, 9000, 'pending'), lot('not-a-date', 9000, 'cancelled'),
    lot('2026-10-19', 0), lot(null, null, 'failed'), lot(null, null, 'closed'),
  ]), { now });
  assert.equal(result.recentRatio, .5);
  assert.equal(result.matureRatio, .5);
  assert.equal(result.lotCount, 2);
});

test('missing or partial evidence never fabricates a proportion or a confirmed holding', () => {
  for (const source of [null, undefined, {}, { lots: [lot('2026-08-01', 1)] }, { complete: false, lots: [lot('2026-08-01', 1)] }]) {
    const result = calculateBondHoldingDuration(source, { now });
    assert.equal(result.status, 'unknown');
    assert.equal(result.recentRatio, null);
    assert.equal(result.matureRatio, null);
  }
  const empty = calculateBondHoldingDuration(record([]), { now });
  assert.equal(empty.status, 'empty');
  assert.equal(empty.recentRatio, 0);
  assert.equal(empty.matureRatio, 0);
});

test('calculated supplied history has a separate estimated status without claiming complete holdings', () => {
  const source = { complete: false, basis: 'calculated', lots: [lot('2026-09-20', 3), lot('2026-09-19', 1)] };
  const before = structuredClone(source);
  const result = calculateBondHoldingDuration(source, { now });
  assert.equal(result.status, 'calculated');
  assert.equal(result.reason, 'provided-history');
  assert.equal(result.recentRatio, .75);
  assert.equal(result.matureRatio, .25);
  assert.equal(result.remainingDays, 1);
  assert.deepEqual(source, before);
  assert.equal(source.complete, false);
  assert.equal(calculateBondHoldingDuration({ ...source, basis: 'reported' }, { now }).status, 'unknown');
  assert.equal(calculateBondHoldingDuration({ ...source, basis: undefined }, { now }).status, 'unknown');
  assert.equal(calculateBondHoldingDuration({ ...source, complete: true }, { now }).status, 'calculated');
});

test('calculated incomplete history without usable lots or with invalid evidence cannot claim a zero holding', () => {
  for (const lots of [[], [lot(null, 1)], [lot('2026-10-20', 1)], [lot('2026-09-01', -1)], [lot(null, 1, 'pending')]]) {
    const result = calculateBondHoldingDuration({ complete: false, basis: 'calculated', lots }, { now });
    assert.equal(result.status, 'unknown');
    assert.equal(result.recentRatio, null);
    assert.equal(result.matureRatio, null);
  }
});

test('invalid or future confirmations invalidate the complete summary instead of dropping an unknown batch', () => {
  for (const invalid of [lot('2026-02-30', 1), lot(null, 1), lot('2026-09-19', NaN), lot('2026-09-19', Infinity), lot('2026-09-19', -1), lot('2026-09-19', '1'), lot('2026-09-19', 1, 'estimated'), lot('2026-10-20', 1)]) {
    const result = calculateBondHoldingDuration(record([lot('2026-08-01', 1), invalid]), { now });
    assert.equal(result.status, 'unknown');
    assert.equal(result.recentRatio, null);
  }
  for (const clock of [null, '', {}, 'invalid', '2026-02-30', Infinity]) {
    assert.equal(calculateBondHoldingDuration(record([lot('2026-08-01', 1)]), { now: clock }).status, 'unknown');
  }
});

test('weight scaling avoids overflow and remaining days describe when every current lot reaches 30 days', () => {
  const result = calculateBondHoldingDuration(record([lot('2026-10-18', 1e308), lot('2026-10-10', 1e308), lot('2026-08-01', 1e308)]), { now });
  assert.equal(result.recentRatio, 2 / 3);
  assert.equal(result.recentRatio + result.matureRatio, 1);
  assert.equal(result.remainingDays, 29);
});

test('ordinary redemption rates use each fund’s explicit strict boundaries independently of the bar', () => {
  for (const [code, cases] of [
    ['006485', [[0, .015], [6, .015], [7, .001], [29, .001], [30, 0], [365, 0]]],
    ['006663', [[0, .015], [6, .015], [7, 0], [29, 0], [30, 0], [365, 0]]],
  ]) {
    assert.equal(BOND_FEE_RULES[code].purchaseRate, 0);
    for (const [days, expected] of cases) assert.equal(getBondRedemptionFeeRate(code, days), expected);
    for (const days of [null, undefined, '', '7', -1, 6.5, NaN, Infinity]) assert.equal(getBondRedemptionFeeRate(code, days), null);
  }
  for (const code of ['unknown', '270023', null, 6485, {}, '__proto__']) assert.equal(getBondRedemptionFeeRate(code, 7), null);
  assert.ok(Object.isFrozen(BOND_FEE_RULES));
  assert.ok(Object.values(BOND_FEE_RULES).every(rule => Object.isFrozen(rule) && Object.isFrozen(rule.redemption) && rule.redemption.every(Object.isFrozen)));
});

test('encrypted holding metadata normalizes only current supported lots and returns independent copies', () => {
  assert.equal(normalizeBondHoldingLots(undefined), undefined);
  const source = { '006485': record([lot('2026-09-20', 1), lot(null, 1, 'pending')]), '006663': { complete: false, lots: [] } };
  const result = normalizeBondHoldingLots(source);
  assert.equal(result['006485'].lots.length, 1);
  result['006485'].lots[0].remainingShares = 2;
  assert.equal(source['006485'].lots[0].remainingShares, 1);
  for (const invalid of [null, [], { unknown: record([]) }, { '006485': { complete: 'true', lots: [] } }, { '006485': { complete: true, lots: [], amount: 1 } }, { '006485': record([{ ...lot('2026-09-20', 1), cost: 1 }]) }]) {
    assert.throws(() => normalizeBondHoldingLots(invalid), /Invalid bond holding lots/);
  }
});

test('holding provenance is optional for older payloads and explicit calculated evidence survives normalization', () => {
  const source = { '006485': { complete: false, basis: 'calculated', lots: [lot('2026-09-20', 1)] }, '006663': record([]) };
  const normalized = normalizeBondHoldingLots(source);
  assert.equal(normalized['006485'].basis, 'calculated');
  assert.equal(normalized['006485'].complete, false);
  assert.deepEqual(normalized['006663'], { complete: true, lots: [] });
  assert.equal(Object.hasOwn(normalized['006663'], 'basis'), false);
  assert.equal(normalizeBondHoldingLots({ '006485': { ...source['006485'], basis: 'reported' } })['006485'].basis, 'reported');
  normalized['006485'].lots[0].remainingShares = 2;
  assert.equal(source['006485'].lots[0].remainingShares, 1);
  for (const basis of [null, '', 'estimated', 1]) {
    assert.throws(() => normalizeBondHoldingLots({ '006485': { ...source['006485'], basis } }), /Invalid bond holding lots/);
  }
});
