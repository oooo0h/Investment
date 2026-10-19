import { calculateLedger } from './engine.js';

const TYPES = new Set(['buy', 'sip', 'sell', 'reinvest', 'dividend', 'transfer-in']);
const rateTypes = new Set(['buy', 'sip', 'sell', 'transfer-in']);
const validDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
};
const decimal = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = typeof value === 'string' ? value.trim() : '';
  return /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) && Number.isFinite(Number(text)) ? Number(text) : null;
};
const round = (value, digits = 2) => {
  const shift = (number, exponent) => {
    const [coefficient, existingExponent = '0'] = String(number).split('e');
    return Number(`${coefficient}e${Number(existingExponent) + exponent}`);
  };
  return shift(Math.round(shift(value, digits)), -digits) || 0;
};

export function transactionToday(now = new Date()) {
  const date = new Date(new Date(now).getTime() + 8 * 60 * 60 * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

// Input amounts mean total purchase cost / net sale proceeds. Rates are entered
// as percentages, e.g. 0.15 means 0.15%. This module never reads storage or logs.
export function deriveTransactionDraft(draft = {}, {
  original = null, defaultFeeRate = null, today = transactionToday(), id = original?.id,
} = {}) {
  const fail = error => ({ transaction: null, preview: null, error });
  const type = draft.type || original?.type || 'buy';
  const date = draft.date || today;
  if (!TYPES.has(type)) return fail('请选择有效交易类型。');
  if (!validDate(date) || (validDate(today) && date > today)) return fail('请选择有效日期，不能晚于今天。');
  const enteredAmount = decimal(draft.amount);
  if (enteredAmount === null || enteredAmount <= 0 || enteredAmount > 1e12) return fail('请输入有效金额，金额须大于零。');
  const amount = round(enteredAmount);
  if (amount <= 0) return fail('金额精度最多为小数点后两位。');
  const hasNav = draft.nav !== null && draft.nav !== undefined && String(draft.nav).trim() !== '';
  const nav = hasNav ? decimal(draft.nav) : null;
  if (hasNav && (nav === null || nav <= 0 || nav > 1e9)) return fail('净值须为有效正数。');
  const status = hasNav ? 'confirmed' : 'pending';
  const rawRate = draft.feeRate === undefined || draft.feeRate === null || String(draft.feeRate).trim() === '' ? defaultFeeRate : draft.feeRate;
  let feeRate = rateTypes.has(type) ? decimal(rawRate) : 0;
  if (rawRate !== null && rawRate !== undefined && String(rawRate).trim() !== '' && rateTypes.has(type) && feeRate === null) return fail('请输入有效手续费比例。');
  if (feeRate !== null && (feeRate < 0 || feeRate >= 100)) return fail('手续费比例须在 0% 至 100% 之间。');
  if (status === 'confirmed' && feeRate === null) return fail('请填写手续费比例，无手续费请填 0。');
  const base = original && typeof original === 'object' ? { ...original } : {};
  const transaction = { ...base, ...(id ? { id } : {}), date, type, status, sourceStatus: status === 'pending' ? 'processing' : 'confirmed', estimated: false };
  // Editing a historical estimate creates the user's explicit record; stale
  // application metadata must not make it eligible for automatic estimation.
  delete transaction.estimateReason;
  delete transaction.originalStatus;
  delete transaction.cost;
  if (feeRate === null) delete transaction.feeRate;
  else transaction.feeRate = feeRate;
  if (status === 'pending') {
    Object.assign(transaction, { amount, nav: null, shares: null, fee: null });
    return { transaction, preview: { amount, nav: null, shares: null, fee: null, feeRate, status }, error: '' };
  }
  const rate = feeRate / 100;
  let fee = 0, shares = 0;
  if (['buy', 'sip', 'transfer-in'].includes(type)) {
    fee = round(amount - amount / (1 + rate));
    shares = round((amount - fee) / nav, 6);
  } else if (type === 'sell') {
    fee = round(amount / (1 - rate) - amount);
    shares = round((amount + fee) / nav, 6);
  } else if (type === 'reinvest') shares = round(amount / nav, 6);
  if (!Number.isFinite(fee) || !Number.isFinite(shares) || fee > 1e12 || shares > 1e12 || (type !== 'dividend' && shares <= 0)) return fail('金额与净值无法推算有效份额，请检查输入。');
  Object.assign(transaction, { amount: type === 'reinvest' ? 0 : amount, nav, shares, fee });
  if (type === 'transfer-in') transaction.cost = amount;
  return { transaction, preview: { amount, nav, shares, fee, feeRate, status }, error: '' };
}

export function sortTransactions(transactions) {
  return transactions.map((transaction, index) => ({ transaction: { ...transaction }, index }))
    .sort((left, right) => String(left.transaction.date || left.transaction.submittedAt || '').localeCompare(String(right.transaction.date || right.transaction.submittedAt || '')) || left.index - right.index)
    .map(item => item.transaction);
}

export function validateTransactionMutation(transactions, {
  type, transaction = null, id = transaction?.id, mode = 'profit-first', prepareTransactions = rows => rows,
} = {}) {
  const original = Array.isArray(transactions) ? transactions : [];
  const fail = error => ({ valid: false, error, transactions: original });
  if (!['add', 'update', 'remove'].includes(type) || typeof id !== 'string' || !id) return fail('交易操作无效，请重新打开表单。');
  const existing = original.findIndex(row => row.id === id);
  if (type === 'add' && existing >= 0) return fail('交易已存在，请勿重复登记。');
  if (type !== 'add' && existing < 0) return fail('交易已更新，请重新打开记录。');
  if (type !== 'remove' && (!transaction || transaction.id !== id)) return fail('交易记录无效，请检查表单。');
  const next = sortTransactions(type === 'add' ? [...original, transaction] : type === 'remove'
    ? original.filter(row => row.id !== id) : original.map(row => row.id === id ? transaction : row));
  let before, after;
  try {
    before = calculateLedger(prepareTransactions(sortTransactions(original)), { mode });
    after = calculateLedger(prepareTransactions(next), { mode });
  } catch { return fail('暂时无法核对交易，请稍后重试。'); }
  const problems = new Map(before.rows.filter(row => ['error', 'blocked'].includes(row.status)).map(row => [row.id, row.error]));
  const newProblem = after.rows.find(row => ['error', 'blocked'].includes(row.status) && problems.get(row.id) !== row.error);
  if (newProblem || after.errors.some(error => error.index === 0)) {
    const reason = newProblem?.error || '请检查账本设置。';
    return fail(type === 'remove' ? `删除后会影响后续交易：${reason}` : `无法保存：${reason}`);
  }
  return { valid: true, error: '', transactions: next };
}
