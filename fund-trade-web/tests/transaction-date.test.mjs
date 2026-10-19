import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTransactionDate } from '../src/transaction-date.js';
const options = { today: '2026-10-19' };

test('MMDD uses the current Beijing year with a slash display', () => {
  assert.deepEqual(parseTransactionDate('1019', options), { date: '2026-10-19', display: '2026/10/19', error: '' });
  assert.equal(parseTransactionDate('0102', options).date, '2026-01-02');
  assert.equal(parseTransactionDate('0102', { today: '2027-01-01' }).date, '2027-01-02');
});
test('common complete and short formats normalize to the same day', () => {
  for (const raw of ['20261019', '261019', '2026-10-19', '2026/10/19', '2026.10.19', '10/19', '10-19', '10.19', '2026年10月19日', '10月19日', '２０２６／１０／１９', ' 2026 / 10 / 19 ']) assert.equal(parseTransactionDate(raw, options).date, '2026-10-19');
});
test('padding and explicit leap years work without rolling invalid days forward', () => {
  assert.equal(parseTransactionDate('2024/2/29', options).display, '2024/02/29');
  assert.equal(parseTransactionDate('3/4', options).display, '2026/03/04');
  for (const raw of ['0229', '0230', '2026-02-29', '2026/4/31', '0019', '1301', '10100', '101', '2026/0/19']) assert.equal(parseTransactionDate(raw, options).date, null);
});
test('today shortcuts use the supplied day and empty input stays invalid', () => {
  for (const raw of ['今天', '今日', 'today', 'TODAY']) assert.equal(parseTransactionDate(raw, options).date, options.today);
  for (const raw of ['', ' ', null, undefined, '2026/10/19 12:00', '<img>', 'October 19']) assert.equal(parseTransactionDate(raw, options).date, null);
});
test('short historical years resolve and invalid context fails closed', () => {
  assert.equal(parseTransactionDate('991019', options).date, '1999-10-19');
  assert.equal(parseTransactionDate('1019', { today: '2026-02-30' }).date, null);
});
