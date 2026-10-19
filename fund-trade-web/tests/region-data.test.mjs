// These fixtures contain public report percentages only; no account data is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { REGION_DATA } from '../src/region-data.js';
import { FUND_CODES } from '../src/funds.js';

const EXPECTED = {
  '005698': { regions: [['美国', 16.66], ['中国内地', 36.61], ['中国香港', 23.17]], total: 76.44, publishedAt: '2026-08-31' },
  '270023': { regions: [['美国', 46.65], ['中国', 17.43], ['中国香港', 12.81], ['日本', 7.56], ['韩国', 3.08]], total: 87.53, publishedAt: '2026-08-31' },
  '016701': { regions: [['美国', 87.89], ['中国香港', 2.55]], total: 90.45, publishedAt: '2026-08-29' },
  '006373': { regions: [['美国', 71.95], ['日本', 8.74], ['中国香港', 3.47], ['中国', 1.14]], total: 85.29, publishedAt: '2026-08-31' },
};

test('public regions cover exactly the four visible funds without filling absent regions', () => {
  assert.deepEqual(Object.keys(REGION_DATA).sort(), [...FUND_CODES].sort());
  assert.equal(REGION_DATA['000000'], undefined);
  assert.deepEqual(REGION_DATA['016701'].regions.map(region => region.name), ['美国', '中国香港']);
  assert.ok(Object.values(REGION_DATA).every(data => data.regions.every(region => region.percent > 0)));
});

test('each section 7.2 percentage and total retains the original midyear disclosure', () => {
  for (const [code, expected] of Object.entries(EXPECTED)) {
    const data = REGION_DATA[code];
    assert.deepEqual(data.regions.map(region => [region.name, region.percent]), expected.regions);
    assert.equal(data.totalPercent, expected.total);
    assert.equal(data.asOf, '2026-06-30');
    assert.equal(data.publishedAt, expected.publishedAt);
    assert.ok(data.publishedAt > data.asOf);
    assert.equal(data.basis, 'equity-region-percent-of-nav');
    assert.ok(Math.abs(data.regions.reduce((sum, region) => sum + region.percent, 0) - data.totalPercent) < 0.011);
    assert.ok(data.totalPercent < 100);
  }
  // Report rounding must not become a fabricated region or silently be normalized.
  assert.equal(Math.round(REGION_DATA['016701'].regions.reduce((sum, region) => sum + region.percent, 0) * 100), 9044);
  assert.equal(REGION_DATA['016701'].totalPercent, 90.45);
  assert.equal(Math.round(REGION_DATA['006373'].regions.reduce((sum, region) => sum + region.percent, 0) * 100), 8530);
  assert.equal(REGION_DATA['006373'].totalPercent, 85.29);
});

test('disclosures link the original report and explain the direct listing-market basis', () => {
  const allowedHosts = new Set(['www.chinaamc.com', 'www.gffunds.com.cn', 'pdf.dfcfw.com', 'www.ftsfund.com']);
  for (const data of Object.values(REGION_DATA)) {
    const source = new URL(data.source.url);
    assert.equal(source.protocol, 'https:');
    assert.ok(allowedHosts.has(source.hostname));
    assert.ok(source.pathname.endsWith('.pdf'));
    assert.match(data.source.title, /2026年中期报告$/);
    assert.match(data.note, /按上市交易市场统计/);
    assert.match(data.note, /存托凭证/);
  }
  for (const code of ['005698', '270023']) {
    assert.match(REGION_DATA[code].note, /直接股票口径，不含ETF与衍生品穿透/);
  }
});

test('public report data is immutable and carries no account positions or derived exposure', () => {
  assert.ok(Object.isFrozen(REGION_DATA));
  for (const data of Object.values(REGION_DATA)) {
    assert.ok(Object.isFrozen(data));
    assert.ok(Object.isFrozen(data.regions));
    assert.ok(Object.isFrozen(data.source));
    assert.ok(data.regions.every(Object.isFrozen));
    assert.deepEqual(Object.keys(data).sort(), ['asOf', 'basis', 'note', 'publishedAt', 'regions', 'source', 'totalPercent'].sort());
    assert.deepEqual(Object.keys(data.source).sort(), ['title', 'url']);
    assert.ok(data.regions.every(region => Object.keys(region).length === 2));
  }
  assert.throws(() => { REGION_DATA['005698'].regions[0].percent = 100; }, TypeError);
});
