// All monetary inputs in this suite are invented; no account data is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLedger } from '../src/engine.js';
import { estimateApplications } from '../src/application-estimates.js';
import { deriveTransactionDraft, validateTransactionMutation, transactionToday } from '../src/transaction-model.js';

const options = { today: '2026-10-19', id: 'synthetic-new' };
const draft = overrides => ({ type: 'buy', date: '2026-10-18', amount: '100.15', nav: '2', feeRate: '.15', ...overrides });
const derive = overrides => deriveTransactionDraft(draft(overrides), options);
const buy = { id: 'synthetic-buy', type: 'buy', date: '2026-10-01', amount: 100, nav: 2, shares: 50, fee: 0 };
const sell = { id: 'synthetic-sell', type: 'sell', date: '2026-10-18', amount: 40, nav: 2, shares: 20, fee: 0 };

test('Beijing today follows the midnight boundary', () => {
  assert.equal(transactionToday('2026-10-18T15:59:59Z'), '2026-10-18');
  assert.equal(transactionToday('2026-10-18T16:00:00Z'), '2026-10-19');
});
test('purchase fees use total expenditure and decimal rounding, with automatically confirmed NAV', () => {
  const result = derive({ status: 'pending' });
  assert.equal(result.error, '');
  assert.equal(result.transaction.status, 'confirmed');
  assert.equal(result.preview.fee, .15);
  assert.equal(result.preview.shares, 50);
  assert.equal(calculateLedger([result.transaction]).summary.valid, true);
});
test('net redemption proceeds and a percentage determine gross shares and fee', () => {
  const result = derive({ type: 'sell', amount: '99', feeRate: '1', nav: '2' });
  assert.equal(result.preview.fee, 1);
  assert.equal(result.preview.shares, 50);
  assert.equal(calculateLedger([buy, result.transaction]).summary.valid, true);
});
test('an empty NAV creates a pending record with no fabricated NAV, shares or fees', () => {
  const result = derive({ nav: '', feeRate: '' });
  assert.equal(result.error, '');
  assert.equal(result.transaction.status, 'pending');
  assert.equal(result.transaction.sourceStatus, 'processing');
  assert.equal(result.transaction.nav, null);
  assert.equal(result.transaction.shares, null);
  assert.equal(calculateLedger([result.transaction]).summary.includedCount, 0);
  const estimates = estimateApplications([result.transaction], [{ date: '2026-10-18', nav: 2 }], { tradingDates: ['2026-10-18'] });
  assert.equal(estimates[0].status, 'pending');
  assert.equal(estimates[0].nav, null);
});
test('supplying NAV confirms a pending transaction and preserves its identity', () => {
  const original = derive({ nav: '' }).transaction;
  const result = deriveTransactionDraft(draft({ nav: '2' }), { ...options, original });
  assert.equal(result.transaction.id, original.id);
  assert.equal(result.transaction.status, 'confirmed');
  assert.equal(result.transaction.sourceStatus, 'confirmed');
  assert.equal(calculateLedger([result.transaction]).summary.includedCount, 1);
});

test('editing dates or switching buy/SIP preserves independently rounded original confirmations', () => {
  const original = { id: 'synthetic-rounded', type: 'buy', date: '2026-10-01', amount: 10.02, nav: 2.3456, shares: 4.26, fee: .03, status: 'confirmed' };
  const feeRate = String(Number((original.fee / (original.nav * original.shares) * 100).toPrecision(12)));
  for (const type of ['buy', 'sip']) {
    const result = deriveTransactionDraft({ date: '2026-10-02', type, amount: String(original.amount), nav: String(original.nav), feeRate }, { ...options, original });
    assert.equal(result.error, '');
    assert.equal(result.transaction.shares, original.shares);
    assert.equal(result.transaction.fee, original.fee);
    assert.equal(result.transaction.amount, original.amount);
  }
  const changed = deriveTransactionDraft({ date: '2026-10-02', type: 'buy', amount: String(original.amount), nav: String(original.nav), feeRate: '0' }, { ...options, original });
  assert.notEqual(changed.transaction.shares, original.shares);
  assert.equal(changed.transaction.fee, 0);
});
test('first confirmed entry requires an explicit fee percentage, while zero and recalled percentages work', () => {
  assert.ok(derive({ feeRate: '' }).error);
  assert.equal(derive({ feeRate: '0' }).error, '');
  assert.equal(deriveTransactionDraft(draft({ feeRate: '' }), { ...options, defaultFeeRate: .15 }).preview.feeRate, .15);
});
test('invalid NAV does not confirm and malformed or excessive rates do not pass', () => {
  for (const nav of ['0', '-1', 'oops', 'Infinity']) assert.ok(derive({ nav }).error);
  for (const feeRate of ['-1', '100', 'Infinity', 'x']) assert.ok(derive({ feeRate }).error);
});
test('invalid, future, zero and non-finite amount/date inputs cannot be registered', () => {
  for (const amount of ['0', '-1', 'Infinity', '1e3', '.001']) assert.ok(derive({ amount }).error);
  for (const date of ['2026-02-30', '2026-10-20', 'bad']) assert.ok(derive({ date }).error);
});
test('reinvestment uses entered distribution amount without creating new cash contributions', () => {
  const result = derive({ type: 'reinvest', amount: '4', nav: '2', feeRate: '' });
  assert.equal(result.preview.shares, 2);
  assert.equal(result.transaction.amount, 0);
  assert.equal(result.transaction.fee, 0);
  const ledger = calculateLedger([buy, result.transaction]);
  assert.equal(ledger.summary.valid, true);
  assert.equal(ledger.summary.totalInvested, 100);
});
test('cash dividends use zero shares and zero fees, and transfers preserve total input cost', () => {
  const dividend = derive({ type: 'dividend', amount: '4', feeRate: '' }).transaction;
  assert.equal(dividend.shares, 0); assert.equal(dividend.fee, 0);
  assert.equal(calculateLedger([buy, dividend]).summary.valid, true);
  const transfer = derive({ type: 'transfer-in' }).transaction;
  assert.equal(transfer.cost, transfer.amount);
  assert.equal(calculateLedger([transfer]).summary.valid, true);
});
test('adding and editing sort dates stably without mutating original transactions', () => {
  const originals = [buy, sell], before = structuredClone(originals);
  const transaction = derive({ date: '2026-10-05', feeRate: '0' }).transaction;
  const result = validateTransactionMutation(originals, { type: 'add', transaction });
  assert.equal(result.valid, true);
  assert.equal(result.transactions[1].id, transaction.id);
  assert.deepEqual(originals, before);
});
test('deleting a funding purchase cannot silently invalidate a later sale or dividend', () => {
  const result = validateTransactionMutation([buy, sell], { type: 'remove', id: buy.id });
  assert.equal(result.valid, false);
  assert.match(result.error, /删除后/);
  assert.equal(validateTransactionMutation([buy, sell], { type: 'remove', id: sell.id }).valid, true);
});
test('overselling or reducing a historical purchase below a later sale is blocked', () => {
  const transaction = derive({ type: 'sell', amount: '200', feeRate: '0' }).transaction;
  assert.equal(validateTransactionMutation([buy], { type: 'add', transaction }).valid, false);
  const reduced = { ...buy, amount: 2, shares: 1 };
  assert.equal(validateTransactionMutation([buy, sell], { type: 'update', transaction: reduced }).valid, false);
});
test('an unrelated existing error is preserved, but a mutation cannot add new blocked rows', () => {
  const bad = { ...buy, id: 'synthetic-bad', nav: -1 };
  const pending = derive({ nav: '' }).transaction;
  assert.equal(validateTransactionMutation([bad], { type: 'add', transaction: pending }).valid, true);
  assert.equal(validateTransactionMutation([bad], { type: 'add', transaction: derive().transaction }).valid, false);
});
test('custom preparation validates the same estimated history used by the displayed ledger', () => {
  const pending = { ...buy, status: 'pending' };
  const prepareTransactions = rows => rows.map(row => row.id === buy.id ? { ...row, status: 'confirmed' } : row);
  const result = validateTransactionMutation([pending], { type: 'add', transaction: sell, prepareTransactions });
  assert.equal(result.valid, true);
});

const bases = [['amount', 'nav'], ['amount', 'shares'], ['nav', 'shares']];
const deriveBasis = (type, basis, mode, extra = {}) => deriveTransactionDraft({
  type, date: '2026-10-18', amount: type === 'sell' ? '99' : '101', nav: '2', shares: '50', basis,
  feeMode: mode, feeRate: mode === 'amount' ? 'ignored-invalid-rate' : '1', feeAmount: mode === 'amount' ? '1' : '', ...extra,
}, options);

for (const type of ['buy', 'sip', 'transfer-in', 'sell']) for (const mode of ['rate', 'amount']) {
  test(`${type} derives the missing field from every two-field basis with ${mode} fees`, () => {
    for (const basis of bases) {
      const result = deriveBasis(type, basis, mode);
      assert.equal(result.error, '');
      assert.equal(result.transaction.nav, 2);
      assert.equal(result.transaction.shares, 50);
      assert.equal(result.transaction.fee, 1);
      assert.equal(result.transaction.amount, type === 'sell' ? 99 : 101);
      assert.equal(result.preview.derivedField, ['amount', 'nav', 'shares'].find(field => !basis.includes(field)));
      assert.equal(result.preview.feeMode, mode);
      assert.equal(result.preview.feeRate, mode === 'amount' ? null : 1);
      assert.equal(result.preview.feeAmount, mode === 'amount' ? 1 : null);
      assert.equal(result.transaction.status, 'confirmed');
      if (type === 'transfer-in') assert.equal(result.transaction.cost, 101);
      const prior = type === 'sell' ? [{ ...buy, id: 'synthetic-available', shares: 100, amount: 200 }] : [];
      assert.equal(calculateLedger([...prior, result.transaction]).summary.valid, true);
    }
  });
}

test('zero fees are explicit in either input mode and an actual zero overrides an invalid percentage', () => {
  for (const type of ['buy', 'sell']) for (const basis of bases) for (const mode of ['rate', 'amount']) {
    const result = deriveBasis(type, basis, mode, { amount: '100', feeRate: mode === 'rate' ? '0' : 'ignored-invalid-rate', feeAmount: mode === 'amount' ? '0' : '' });
    assert.equal(result.error, '');
    assert.equal(result.transaction.amount, 100);
    assert.equal(result.transaction.fee, 0);
    assert.equal(result.transaction.nav, 2);
    assert.equal(result.transaction.shares, 50);
  }
});

test('a nonempty actual fee is authoritative regardless of feeMode or the default percentage', () => {
  for (const feeRate of ['bad', '-1', '100', '', '0', '50']) {
    const result = deriveTransactionDraft({ ...draft(), feeMode: 'rate', feeAmount: '.15', feeRate }, { ...options, defaultFeeRate: 80 });
    assert.equal(result.error, '');
    assert.equal(result.preview.feeMode, 'amount');
    assert.equal(result.preview.feeRate, null);
    assert.equal(result.transaction.feeRate, null);
    assert.equal(result.transaction.fee, .15);
  }
  const rate = deriveTransactionDraft({ ...draft(), feeMode: 'amount', feeAmount: ' ' }, options);
  assert.equal(rate.error, '');
  assert.equal(rate.preview.feeMode, 'rate');
});

test('an invalid actual fee is rejected rather than falling back to a valid percentage', () => {
  for (const feeAmount of ['bad', '-1', 'Infinity', '.001', '1000000000001']) {
    const result = deriveBasis('buy', ['amount', 'nav'], 'amount', { feeRate: '0', feeAmount });
    assert.ok(result.error);
    assert.equal(result.transaction, null);
    assert.doesNotMatch(result.error, /1000000000001|Infinity|bad|-1|0\.001/);
  }
});

test('purchase fees cannot consume expenditure and sale fees cannot consume gross proceeds', () => {
  for (const basis of [['amount', 'nav'], ['amount', 'shares']]) {
    assert.match(deriveBasis('buy', basis, 'amount', { feeAmount: '101' }).error, /手续费/);
    assert.match(deriveBasis('transfer-in', basis, 'amount', { feeAmount: '102' }).error, /手续费/);
  }
  for (const feeAmount of ['100', '101']) assert.match(deriveBasis('sell', ['nav', 'shares'], 'amount', { feeAmount }).error, /手续费/);
  assert.match(derive({ nav: '', feeAmount: '100.15', feeRate: '' }).error, /手续费/);
});

test('complete two-field bases require an explicit or remembered fee and never assume zero', () => {
  for (const basis of bases) {
    const result = deriveBasis('buy', basis, 'rate', { feeRate: '', feeAmount: '' });
    assert.match(result.error, /手续费/);
    const recalled = deriveTransactionDraft({ ...draft(), basis, shares: '50', feeRate: '', feeAmount: '' }, { ...options, defaultFeeRate: .15 });
    assert.equal(recalled.error, '');
    assert.equal(recalled.preview.feeRate, .15);
  }
});

test('unselected stale auto-filled values never override the two manual basis values', () => {
  for (const basis of bases) {
    const missing = ['amount', 'nav', 'shares'].find(field => !basis.includes(field));
    for (const stale of ['', 'bad', '-1', '999999999999999']) {
      const result = deriveBasis('buy', basis, 'rate', { [missing]: stale });
      assert.equal(result.error, '');
      assert.equal(result.transaction.nav, 2);
      assert.equal(result.transaction.shares, 50);
      assert.equal(result.transaction.amount, 101);
    }
  }
});

test('amount plus shares confirms a computed NAV even when the old NAV field is empty', () => {
  const result = deriveBasis('buy', ['amount', 'shares'], 'rate', { nav: '' });
  assert.equal(result.error, '');
  assert.equal(result.transaction.status, 'confirmed');
  assert.equal(result.transaction.nav, 2);
  assert.equal(result.preview.derivedField, 'nav');
});

test('incomplete bases save only an explicit amount as pending and clear stale derived NAV and shares', () => {
  for (const basis of [['amount', 'nav'], ['amount', 'shares']]) {
    const second = basis.find(field => field !== 'amount');
    const result = deriveBasis('buy', basis, 'rate', { [second]: '', feeRate: '', amount: '101', nav: second === 'nav' ? '' : 'stale', shares: second === 'shares' ? '' : 'stale' });
    assert.equal(result.error, '');
    assert.equal(result.transaction.status, 'pending');
    assert.equal(result.transaction.amount, 101);
    assert.equal(result.transaction.nav, null);
    assert.equal(result.transaction.shares, null);
    assert.equal(result.transaction.fee, null);
    assert.equal(result.preview.nav, null);
    assert.equal(result.preview.shares, null);
  }
  const staleAmount = deriveBasis('buy', ['nav', 'shares'], 'rate', { shares: '', amount: '101' });
  assert.ok(staleAmount.error);
  const actualPending = deriveBasis('buy', ['amount', 'nav'], 'amount', { nav: '', shares: 'stale', feeAmount: '.15' });
  assert.equal(actualPending.error, '');
  assert.equal(actualPending.transaction.fee, null);
  assert.equal(actualPending.transaction.feeAmount, .15);
  assert.equal(actualPending.transaction.feeRate, null);
});

test('invalid basis selections and invalid selected fields fail with fixed messages', () => {
  for (const basis of [null, [], ['amount'], ['amount', 'amount'], ['amount', 'other'], ['amount', 'nav', 'shares']]) assert.ok(deriveBasis('buy', basis, 'rate').error);
  for (const field of ['amount', 'nav', 'shares']) {
    const basis = field === 'shares' ? ['amount', 'shares'] : ['amount', 'nav'];
    for (const value of ['0', '-1', 'bad', 'Infinity']) assert.ok(deriveBasis('buy', basis, 'rate', { [field]: value }).error);
  }
  assert.ok(deriveBasis('buy', ['amount', 'shares'], 'rate', { shares: '.0000001' }).error);
});

test('derived NAV keeps sufficient precision while currency and share outputs use their own precision', () => {
  const result = deriveBasis('buy', ['amount', 'shares'], 'amount', { amount: '13.01', shares: '7.123456', feeAmount: '.01', nav: '' });
  assert.equal(result.error, '');
  assert.equal(result.transaction.nav, 13 / 7.123456);
  assert.equal(calculateLedger([result.transaction]).summary.valid, true);
  const shares = deriveBasis('buy', ['amount', 'nav'], 'amount', { amount: '10.01', nav: '3', feeAmount: '.01' });
  assert.equal(shares.transaction.shares, 3.333333);
  const amount = deriveBasis('sell', ['nav', 'shares'], 'amount', { nav: '2.3456', shares: '4.26', feeAmount: '.03' });
  assert.equal(amount.transaction.amount, 9.96);
  const rounded = deriveBasis('buy', ['nav', 'shares'], 'rate', { nav: '2', shares: '5.0025', feeRate: '0' });
  assert.equal(rounded.transaction.amount, 10.01);
});

test('all two-field reinvestment bases refer to distribution value while the stored cash contribution remains zero', () => {
  for (const basis of bases) {
    const result = deriveBasis('reinvest', basis, 'rate', { amount: '4', nav: '2', shares: '2', feeRate: 'ignored', feeAmount: '' });
    assert.equal(result.error, '');
    assert.equal(result.preview.amount, 4);
    assert.equal(result.transaction.amount, 0);
    assert.equal(result.transaction.shares, 2);
    assert.equal(result.transaction.nav, 2);
    assert.equal(result.transaction.fee, 0);
    assert.equal(calculateLedger([buy, result.transaction]).summary.valid, true);
  }
  const dividend = deriveBasis('dividend', ['nav', 'shares'], 'rate', { amount: '4', shares: 'not-used', feeRate: 'ignored' });
  assert.equal(dividend.error, '');
  assert.equal(dividend.transaction.shares, 0);
  assert.equal(dividend.preview.derivedField, null);
});

test('every two-field basis and both fee modes preserve the original rounded confirmation during non-economic edits', () => {
  for (const type of ['buy', 'sip', 'sell', 'transfer-in', 'reinvest']) for (const basis of bases) for (const mode of ['rate', 'amount']) {
    const original = { id: `synthetic-original-${type}`, type, date: '2026-10-01', amount: type === 'reinvest' ? 0 : type === 'sell' ? 9.96 : 10.02, nav: 2.3456, shares: 4.26, fee: type === 'reinvest' ? 0 : .03, status: 'confirmed', ...(type === 'transfer-in' ? { cost: 10.02 } : {}) };
    const rate = original.fee / (original.nav * original.shares) * 100;
    const result = deriveTransactionDraft({ type, date: '2026-10-02', amount: String(type === 'reinvest' ? original.nav * original.shares : original.amount), nav: String(original.nav), shares: String(original.shares), basis, feeAmount: mode === 'amount' ? String(original.fee) : '', feeRate: String(Number(rate.toPrecision(12))) }, { ...options, original });
    assert.equal(result.error, '');
    assert.equal(result.transaction.amount, original.amount);
    assert.equal(result.transaction.nav, original.nav);
    assert.equal(result.transaction.shares, original.shares);
    assert.equal(result.transaction.fee, original.fee);
    if (type === 'transfer-in') assert.equal(result.transaction.cost, original.cost);
  }
});

test('a manual share change remains effective even when its rounded currency total is unchanged', () => {
  const original = { id: 'synthetic-small-share-change', type: 'buy', date: '2026-10-01', amount: 10.02, nav: 2.3456, shares: 4.26, fee: .03, status: 'confirmed' };
  for (const basis of [['nav', 'shares'], ['amount', 'shares']]) {
    const result = deriveTransactionDraft({ type: 'buy', date: original.date, amount: String(original.amount), nav: String(original.nav), shares: '4.260001', basis, feeAmount: '.03' }, { ...options, original });
    assert.equal(result.error, '');
    assert.equal(result.transaction.shares, 4.260001);
    assert.equal(result.transaction.amount, original.amount);
    if (basis.includes('amount')) assert.notEqual(result.transaction.nav, original.nav);
    else assert.equal(result.transaction.nav, original.nav);
  }
});
