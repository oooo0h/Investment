// Public catalogue only. This test never reads NAV archives or account sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FUNDS, FUND_CODES, FUND_CATALOG } from '../src/funds.js';

const ACTIVE_CODES = ['016701', '006373', '270023', '005698'];
const ARCHIVE_CODES = ['005698', '270023', '006373', '016701', '000216', '009608', '018124', '015789', '019454', '022459'];

test('the page exposes exactly Yinhua, Guofu, Guangfa and Huaxia in the requested order', () => {
  assert.deepEqual(FUND_CODES, ACTIVE_CODES);
  assert.deepEqual(FUNDS.map(fund => fund.code), ACTIVE_CODES);
  assert.deepEqual(FUNDS.map(fund => fund.navLabel), ['银华', '国富', '广发', '华夏']);
  assert.equal(new Set(FUND_CODES).size, ACTIVE_CODES.length);
  assert.ok(FUND_CODES.every(code => /^\d{6}$/.test(code)));
});

test('every fund has a distinct navigation label and a usable public identity', () => {
  const labels = FUNDS.map(fund => fund.navLabel);
  assert.equal(new Set(labels).size, FUNDS.length);
  assert.ok(FUNDS.every(fund => typeof fund.navLabel === 'string' && fund.navLabel.trim()
    && typeof fund.name === 'string' && fund.name.trim()
    && typeof fund.fullName === 'string' && fund.fullName.trim()
    && typeof fund.brand === 'string' && fund.brand.trim()));
});

test('the full archive catalogue remains intact and inactive funds keep unknown fee rates', () => {
  assert.equal(FUND_CATALOG.length, ARCHIVE_CODES.length);
  assert.deepEqual(FUND_CATALOG.map(fund => fund.code).sort(), [...ARCHIVE_CODES].sort());
  assert.equal(new Set(FUND_CATALOG.map(fund => fund.code)).size, ARCHIVE_CODES.length);
  const inactive = FUND_CATALOG.filter(fund => !ACTIVE_CODES.includes(fund.code));
  assert.equal(inactive.length, 6);
  assert.ok(inactive.every(fund => fund.rate === null));
  assert.deepEqual(FUNDS.map(fund => fund.rate), [null, '0.15', '0.16', '0.15']);
});
