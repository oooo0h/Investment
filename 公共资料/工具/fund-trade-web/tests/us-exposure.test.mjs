// Public report percentages and synthetic rules only; no files or accounts read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateUsExposure } from '../us-exposure.js';
import { REGION_DATA } from '../region-data.js';

const rule = threshold => ({
  id: 'us-exposure', title: '基金持有量按美股含量确定。',
  detail: `如果美股含量低于${threshold}%，则【立刻】降低该基金持仓。`,
});
const disclosure = percent => ({
  basis: 'equity-region-percent-of-nav', asOf: '2026-06-30', publishedAt: '2026-08-31',
  source: { title: '基金中期报告', url: 'https://www.example.com/report.pdf' },
  regions: [{ name: '美国', percent }, { name: '中国香港', percent: 2.5 }],
});

test('below, equal and above use the raw percentage and a nonnegative shortfall', () => {
  const below = evaluateUsExposure(rule(40), disclosure(39.999999));
  assert.equal(below.status, 'below');
  assert.equal(below.usPercent, 39.999999);
  assert.equal(below.thresholdPercent, 40);
  assert.equal(below.gapPercent, 40 - 39.999999);
  for (const percent of [40, 40.000001, 100]) {
    const result = evaluateUsExposure(rule(40), disclosure(percent));
    assert.equal(result.status, 'met');
    assert.equal(result.gapPercent, 0);
  }
  const zero = evaluateUsExposure(rule(40), disclosure(0));
  assert.equal(zero.status, 'below');
  assert.equal(zero.usPercent, 0);
  assert.equal(zero.gapPercent, 40);
});

test('the current rule supplies the threshold, including whitespace and emphasis', () => {
  assert.equal(evaluateUsExposure(rule(30), disclosure(35)).status, 'met');
  assert.equal(evaluateUsExposure(rule(50), disclosure(35)).status, 'below');
  const formatted = { ...rule(40), detail: '如果 美股含量 低于 **【 37.5 】** ％，则降低持仓。' };
  assert.equal(evaluateUsExposure(formatted, disclosure(37.49)).thresholdPercent, 37.5);
  assert.equal(evaluateUsExposure(formatted, disclosure(37.5)).status, 'met');
});

test('missing, invalid and ambiguous rule thresholds remain unavailable without a default', () => {
  const invalid = [
    null, undefined, { ...rule(40), id: 'other' }, { ...rule(40), detail: null },
    rule(0), rule(-1), rule(101), rule('NaN'), rule('Infinity'),
    ...['美股含量低于约40%', '美股含量不高于40%', '美股含量低于40%左右',
      '美股含量低于40%到50%', '美股含量低于40%或50%', '美股含量低于40%且高于20%',
      '美股含量低于40%，或50%', '美股含量低于40%（约值）',
      '美股含量低于40%。美股含量低于50%。', '美股含量低于约30%。美股含量低于40%。', '继续长期持有。']
      .map(detail => ({ ...rule(40), detail })),
  ];
  for (const item of invalid) {
    const result = evaluateUsExposure(item, disclosure(35));
    assert.equal(result.status, 'unavailable');
    assert.equal(result.thresholdPercent, null);
    assert.equal(result.gapPercent, null);
  }
});

test('an absent, malformed or ambiguous disclosure is unknown rather than zero or met', () => {
  const invalid = [
    null, undefined, {}, { ...disclosure(50), basis: 'percent-of-equities' },
    ...[undefined, '', '2026-6-30', '2026-02-30', 'not-a-date'].map(asOf => ({ ...disclosure(50), asOf })),
    { ...disclosure(50), publishedAt: '2026-06-29' },
    { ...disclosure(50), publishedAt: '2026-02-30' },
    { ...disclosure(50), regions: [] },
    { ...disclosure(50), regions: [{ name: '中国香港', percent: 50 }] },
    { ...disclosure(50), regions: [{ name: '美国', percent: 30 }, { name: ' 美国 ', percent: 50 }] },
    ...[null, '40', NaN, Infinity, -1, 100.01].map(percent => disclosure(percent)),
    { ...disclosure(50), regions: [{ name: '美国', percent: 50 }, { name: '中国香港', percent: NaN }] },
  ];
  for (const item of invalid) {
    const result = evaluateUsExposure(rule(40), item);
    assert.deepEqual(result, { status: 'unavailable', thresholdPercent: 40, usPercent: null,
      gapPercent: null, asOf: null, publishedAt: null, source: null });
  }
});

test('a disclosure needs an absolute public report link and a title', () => {
  const invalidSources = [null, {}, { title: '', url: 'https://www.example.com/report.pdf' },
    ...['/report.pdf', 'javascript:alert(1)', 'file:///report.pdf', 'https://localhost/report.pdf',
      'http://127.0.0.1/report.pdf', 'https://10.0.0.1/report.pdf', 'https://[::1]/report.pdf',
      'https://report.local/report.pdf', 'https://user:password@www.example.com/report.pdf']
      .map(url => ({ title: '中期报告', url }))];
  for (const source of invalidSources) {
    assert.equal(evaluateUsExposure(rule(40), { ...disclosure(50), source }).status, 'unavailable');
  }
});

test('validated public metadata is returned without inputs being changed', () => {
  const inputRule = Object.freeze(rule(40));
  const inputReport = Object.freeze(disclosure(16.66));
  const result = evaluateUsExposure(inputRule, inputReport);
  assert.deepEqual(Object.keys(result).sort(), ['status', 'thresholdPercent', 'usPercent', 'gapPercent', 'asOf', 'publishedAt', 'source'].sort());
  assert.equal(result.asOf, '2026-06-30');
  assert.equal(result.publishedAt, '2026-08-31');
  assert.deepEqual(result.source, inputReport.source);
  assert.notEqual(result.source, inputReport.source);
  assert.equal(result.gapPercent, 40 - 16.66);
  const noPublicationDate = { ...disclosure(50), publishedAt: undefined };
  assert.equal(evaluateUsExposure(inputRule, noPublicationDate).status, 'met');
  assert.equal(evaluateUsExposure(inputRule, noPublicationDate).publishedAt, null);
});

test('the four real public reports identify only 华夏 005698 as below the current threshold', () => {
  const results = Object.entries(REGION_DATA).map(([code, report]) => [code, evaluateUsExposure(rule(40), report)]);
  assert.equal(results.length, 4);
  assert.deepEqual(results.filter(([, result]) => result.status === 'below').map(([code]) => code), ['005698']);
  assert.equal(results.find(([code]) => code === '005698')[1].usPercent, 16.66);
  assert.ok(results.filter(([code]) => code !== '005698').every(([, result]) => result.status === 'met'));
});
