// All values below are synthetic. No account files, storage or network are read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BOND_RESERVE_RULE, evaluateBondReserve } from '../src/bond-reserve.js';

const check = (equityValue, bondValue, complete = true) => evaluateBondReserve({ equityValue, bondValue, complete });
const unknown = { status: 'unknown', ratio: null, reason: 'unavailable' };

test('the public rule exposes the inclusive share range and strict absolute threshold', () => {
  assert.deepEqual(BOND_RESERVE_RULE, { minRatio: 1 / 6, maxRatio: 1 / 3, absoluteThreshold: 50000 });
  assert.equal(Object.isFrozen(BOND_RESERVE_RULE), true);
});

test('lower, middle and upper share positions use both inclusive boundaries', () => {
  for (const [equity, bond, expected] of [[10, 2, 1 / 6], [9, 3, 1 / 4], [2, 1, 1 / 3]]) {
    const result = check(equity, bond);
    assert.equal(result.status, 'met');
    assert.equal(result.reason, 'share-range');
    assert.ok(Math.abs(result.ratio - expected) < Number.EPSILON);
  }
  assert.deepEqual(check(10, 1), { status: 'below', ratio: 1 / 11, reason: 'share-low' });
  assert.deepEqual(check(1, 1), { status: 'below', ratio: 1 / 2, reason: 'share-high' });
});

test('decimal share boundaries remain inclusive without hiding actual shortfalls', () => {
  for (const [equity, bond] of [[0.05, 0.01], [0.1, 0.02], [0.3, 0.06], [0.2, 0.1], [0.6, 0.3]]) {
    assert.equal(check(equity, bond).status, 'met');
  }
  assert.equal(check(100, 19.99).reason, 'share-low');
  assert.equal(check(100, 50.01).reason, 'share-high');
  assert.equal(check(0.1, 0.019999999999999997).reason, 'share-low');
  assert.equal(check(0.2, 0.10000000000000002).reason, 'share-high');
});

test('either route is enough, but equality at the absolute threshold is insufficient alone', () => {
  assert.equal(check(500000, 50000).reason, 'share-low');
  assert.equal(check(500000, 50000).status, 'below');
  assert.equal(check(1000, 50000).status, 'below');
  assert.equal(check(1000, 50000).reason, 'share-high');
  for (const equity of [1000, 500000]) {
    assert.equal(check(equity, 50000.01).status, 'met');
    assert.equal(check(equity, 50000.01).reason, 'absolute-threshold');
  }
  assert.equal(check(500000, 50000.000001).status, 'met');
  assert.equal(check(250000, 50000).reason, 'share-range');
  assert.equal(check(100000, 50000).reason, 'share-range');
});

test('verified zero values differ from missing values and a zero total is unknown', () => {
  assert.deepEqual(check(0, 0), unknown);
  assert.deepEqual(check(10, 0), { status: 'below', ratio: 0, reason: 'share-low' });
  assert.deepEqual(check(0, 1), { status: 'below', ratio: 1, reason: 'share-high' });
  assert.deepEqual(check(10, null), unknown);
  assert.deepEqual(check(null, 1), unknown);
  assert.equal(check(0, 50000.01).status, 'met');
});

test('unavailable or partial equities cannot establish a share, but known bonds can pass independently', () => {
  for (const equity of [null, undefined, NaN, Infinity, -Infinity, -1, '10', true, {}, []]) {
    assert.deepEqual(check(equity, 1), unknown);
    assert.deepEqual(check(equity, 50000.01), { status: 'met', ratio: null, reason: 'absolute-threshold' });
  }
  for (const complete of [false, null, 0, 'true']) {
    assert.deepEqual(check(10, 2, complete), unknown);
    assert.deepEqual(check(10, 50000, complete), unknown);
    assert.deepEqual(check(10, 50000.01, complete), { status: 'met', ratio: null, reason: 'absolute-threshold' });
  }
});

test('invalid or missing bonds are unknown and never default to zero', () => {
  for (const bond of [null, undefined, NaN, Infinity, -Infinity, -1, '50001', true, {}, []]) {
    assert.deepEqual(check(10, bond), unknown);
    assert.deepEqual(check(null, bond, false), unknown);
  }
  for (const input of [undefined, null, false, '', [], {}]) assert.deepEqual(evaluateBondReserve(input), unknown);
});

test('finite extreme inputs preserve bounded ratios without total overflow or tiny-value loss', () => {
  assert.deepEqual(check(Number.MAX_VALUE, Number.MAX_VALUE), { status: 'met', ratio: .5, reason: 'absolute-threshold' });
  assert.equal(check(Number.MAX_VALUE, 1).reason, 'share-low');
  assert.equal(check(1e-200, 2e-201).status, 'met');
  assert.equal(check(Number.MIN_VALUE, 0).reason, 'share-low');
  assert.equal(check(0, Number.MIN_VALUE).reason, 'share-high');
  for (const result of [check(Number.MAX_VALUE, 1), check(1, Number.MAX_VALUE), check(Number.MIN_VALUE, Number.MIN_VALUE)]) {
    assert.ok(result.ratio >= 0 && result.ratio <= 1 && Number.isFinite(result.ratio));
  }
});

test('results contain no amounts, never mutate inputs and are independent of prior calls', () => {
  const input = Object.freeze({ equityValue: 10, bondValue: 2, complete: true });
  const first = evaluateBondReserve(input);
  first.status = 'changed';
  assert.deepEqual(evaluateBondReserve(input), { status: 'met', ratio: 1 / 6, reason: 'share-range' });
  for (const result of [evaluateBondReserve(), check(10, 1), check(10, 2), check(null, 50000.01)]) {
    assert.deepEqual(Object.keys(result).sort(), ['ratio', 'reason', 'status']);
  }
});
