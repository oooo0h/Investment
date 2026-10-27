import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { navDateForOrder, isLocalTradingDay } from '../src/trading-calendar.js';
import { applyTransferStates, transferCounts } from '../scripts/transfer-records.mjs';
import { readRegistrationRecords, writeRegistrationRecords, applyRegistrationStates } from '../scripts/registration-records.mjs';
import { buyFee, sellRate, redemptionFee, subscriptionDiffFee } from '../src/fee-rules.js';
import { renderTradeDialog, renderReviewDialog } from '../src/trade-dialog.js';

test('local trading calendar rolls after 15:00 and over weekends and closures', () => {
  assert.equal(navDateForOrder('2026-10-21', 'before'), '2026-10-21');
  assert.equal(navDateForOrder('2026-10-21', 'after'), '2026-10-22');
  assert.equal(navDateForOrder('2026-10-23', 'after'), '2026-10-26');
  assert.equal(navDateForOrder('2026-10-24', 'before'), '2026-10-26');
  assert.equal(navDateForOrder('2026-10-03', 'before'), '2026-10-08');
  assert.equal(navDateForOrder('2025-12-31', 'after'), '2026-01-05');
  assert.equal(isLocalTradingDay('2026-10-21'), true);
  assert.equal(isLocalTradingDay('2026-10-25'), false);
  assert.throws(() => navDateForOrder('2027-01-04', 'before'), /calendar unavailable/);
  assert.throws(() => navDateForOrder('2026-02-30', 'before'), /calendar unavailable/);
});

test('trade dialog infers buy, sell and transfer from the two selected cards', () => {
  const buy = renderTradeDialog({ draft: { mode: 'buy', code: 'CASH', targetCode: '005698', date: '2026/10/21', cutoff: 'before', amount: '1000', outShares: '', fee: '' }, navPreview: { date: '2026-10-21' }, currentShares: null });
  assert.match(buy, /data-trade-mode="buy"/);
  assert.doesNotMatch(buy, /data-action="trade-mode"/);
  assert.match(buy, /name="amount"/);
  assert.match(buy, /15:00 前/);
  assert.match(buy, /预计净值日/);
  assert.doesNotMatch(buy, /name="date"/);
  const calendar = renderTradeDialog({ draft: { mode: 'buy', code: 'CASH', targetCode: '005698', date: '2026/10/21', cutoff: 'before', amount: '', outShares: '', fee: '' }, navPreview: { date: '2026-10-21' }, calendar: { month: '2026-10' } });
  assert.match(calendar, /class="trade-calendar"/);
  assert.match(calendar, /data-action="trade-calendar-pick"/);
  assert.match(calendar, /2026-10-21/);
  const sell = renderTradeDialog({ draft: { mode: 'sell', code: '005698', targetCode: 'CASH', date: '2026/10/21', cutoff: 'before', amount: '', outShares: '100', fee: '' }, navPreview: { date: '2026-10-21' }, currentShares: 500 });
  assert.match(sell, /name="outShares"/);
  assert.match(sell, /卖出份额/);
  assert.match(sell, /FIFO/);
  assert.doesNotMatch(sell, /name="amount"/);
  const transfer = renderTradeDialog({ draft: { mode: 'transfer', code: '005698', targetCode: '016701', date: '2026/10/21', cutoff: 'after', amount: '', outShares: '100', fee: '' }, navPreview: { date: '2026-10-22', orderDate: '2026-10-21' }, currentShares: 1234.567891 });
  assert.match(transfer, /name="outShares"/);
  assert.match(transfer, /name="targetCode"/);
  assert.match(transfer, /全部/);
  assert.doesNotMatch(transfer, /name="amount"/);
});

test('review dialog shows the calculated difference and accepts actual amounts', () => {
  const record = { id: 'transfer-1', outCode: '005698', inCode: '016701', navDate: '2026-10-22', orderDate: '2026-10-21' };
  const markup = renderReviewDialog({ records: [record], rows: { 'transfer-1': { outAmount: 1200, inAmount: 1180 } }, reviewId: 'transfer-1', draft: { outAmount: '1200', inAmount: '1180', outFee: '0', inFee: '0', inShares: '' }, fundName: code => code });
  assert.match(markup, /name="outAmount"/);
  assert.match(markup, /name="inAmount"/);
  assert.match(markup, /data-review-difference/);
  const result = renderReviewDialog({ records: [], rows: {}, result: { difference: 20 } });
  assert.match(result, /核对已保存/);
  assert.match(result, /计入自由现金流/);
});

test('pending transfer rows stay processing and do not block the fund summary', () => {
  const records = [{ id: 'transfer-1', outCode: '005698', inCode: '016701', outRow: 112, inRow: 5, orderDate: '2026-10-21', navDate: '2026-10-22', cutoff: 'before', status: 'awaiting', createdAt: '2026-10-21T00:00:00.000Z' }];
  const rows = [{ id: '005698-workbook-112', status: 'pending', sourceStatus: 'incomplete' }];
  const applied = applyTransferStates(rows, '005698', records);
  assert.equal(applied[0].status, 'pending');
  assert.equal(applied[0].sourceStatus, 'processing');
  assert.equal(applied[0].transferStatus, 'awaiting');
  const filled = applyTransferStates(rows, '005698', [{ ...records[0], status: 'filled' }]);
  assert.equal(filled[0].transferStatus, 'review');
  const reviewed = applyTransferStates([{ ...rows[0], status: 'estimated', sourceStatus: 'formula-calculated' }], '005698', [{ ...records[0], status: 'reviewed' }]);
  assert.equal(reviewed[0].status, 'estimated');
  assert.equal(reviewed[0].transferStatus, 'reviewed');
  assert.deepEqual(transferCounts(records), { awaiting: 1, review: 0, reviewed: 0, total: 1 });
});

test('fee schedules follow each fund screenshot, including net subscription and FIFO redemption', () => {
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.011, `${actual} != ${expected}`);
  close(buyFee('005698', 1000).fee, 1.50);
  close(buyFee('270023', 1000).fee, 1.60);
  close(buyFee('006373', 2000000).fee, 1598.72);
  assert.equal(buyFee('016701', 1000000).fee, 1497.75);
  assert.equal(buyFee('005698', 5000000).fee, 1000);
  assert.equal(buyFee('270023', 10000000).fee, 1000);
  assert.equal(buyFee('006663', 1000).fee, 0);
  assert.equal(buyFee('006485', 1000).fee, 0);
  assert.equal(sellRate('005698', 6), 0.015);
  assert.equal(sellRate('005698', 7), 0.0075);
  assert.equal(sellRate('005698', 30), 0.005);
  assert.equal(sellRate('005698', 365), 0);
  assert.equal(sellRate('270023', 400), 0.003);
  assert.equal(sellRate('006663', 7), 0);
  assert.equal(sellRate('004103', 10), 0.001);
  const fifo = redemptionFee('005698', [
    { date: '2026-10-01', shares: 100 },
    { date: '2026-09-01', shares: 100 },
  ], 1.5, '2026-10-21', 150);
  assert.equal(fifo.ok, true);
  close(fifo.fee, 1.31);
  close(fifo.gross, 225);
  close(fifo.net, 223.69);
  const short = redemptionFee('005698', [{ date: '2026-10-01', shares: 100 }], 1.5, '2026-10-21', 150);
  assert.equal(short.ok, false);
  assert.equal(short.available, 100);
  const diff = subscriptionDiffFee('005698', '270023', 1000);
  assert.ok(diff.diff > 0.00009 && diff.diff < 0.00011);
  assert.equal(Math.round(diff.fee * 100), 10);
  assert.equal(subscriptionDiffFee('005698', '016701', 1000).fee, 0);
  assert.equal(subscriptionDiffFee('006663', '005698', 1000).diff, 0.0015);
});

test('registration metadata keeps the real order date and persists without amounts', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'registration-records-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = { id: 'registration-12345678', code: '005698', row: 113, mode: 'buy', orderDate: '2026-10-21', navDate: '2026-10-22', cutoff: 'after', status: 'filled', createdAt: '2026-10-21T14:00:00.000Z' };
  await writeRegistrationRecords({ root }, [record]);
  assert.deepEqual(await readRegistrationRecords({ root }), [record]);
  const rows = [{ id: '005698-workbook-113', date: '2026-10-22', type: 'buy' }];
  const applied = applyRegistrationStates(rows, '005698', [record]);
  assert.equal(applied[0].dateBasis, 'nav');
  assert.equal(applied[0].submittedAt, '2026-10-21');
  assert.equal(applied[0].orderDate, '2026-10-21');
  assert.equal(applied[0].navDate, '2026-10-22');
  assert.equal(applied[0].registrationId, 'registration-12345678');
  assert.equal(applied[0].registrationStatus, 'filled');
  const awaiting = applyRegistrationStates([{ id: '005698-workbook-114', status: 'pending', sourceStatus: 'incomplete' }], '005698', [{ ...record, row: 114, mode: 'sell', status: 'awaiting' }]);
  assert.equal(awaiting[0].status, 'pending');
  assert.equal(awaiting[0].sourceStatus, 'processing');
  assert.equal(awaiting[0].registrationStatus, 'awaiting');
});

test('sell dialog asks for shares and explains the FIFO fee basis', () => {
  const markup = renderTradeDialog({ draft: { mode: 'sell', code: '005698', targetCode: 'CASH', date: '2026/10/21', cutoff: 'before', amount: '', outShares: '50', fee: '' }, navPreview: { date: '2026-10-21' }, currentShares: 100 });
  assert.match(markup, /卖出份额/);
  assert.match(markup, /name="outShares"/);
  assert.doesNotMatch(markup, /name="amount"/);
  assert.match(markup, /FIFO/);
});
