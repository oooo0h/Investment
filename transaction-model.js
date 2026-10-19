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

const FIELDS = ['amount', 'nav', 'shares'];
const present = value => value !== undefined && value !== null && String(value).trim() !== '';
const purchaseTypes = new Set(['buy', 'sip', 'transfer-in']);
const originalAmount = original => original.type === 'reinvest' ? original.nav * original.shares
  : original.amount ?? original.cost ?? (original.nav * original.shares + (original.type === 'sell' ? -1 : 1) * original.fee);

function unchangedEconomics(original, { type, values, basis, feeMode, feeRate, feeAmount }) {
  if (!original || ![undefined, 'confirmed', 'estimated', '已确认', '历史估算', '已录入'].includes(original.status)) return false;
  const sameKind = original.type === type || (['buy', 'sip'].includes(original.type) && ['buy', 'sip'].includes(type));
  if (!sameKind || !Number.isFinite(original.nav) || original.nav <= 0 || !Number.isFinite(original.shares) || original.shares < 0 ||
      (type !== 'dividend' && original.shares <= 0) || !Number.isFinite(original.fee) || original.fee < 0) return false;
  const gross = original.nav * original.shares;
  const priorAmount = originalAmount(original);
  if (!Number.isFinite(priorAmount) || !basis.every(field => values[field] === (field === 'amount' ? round(priorAmount) : original[field]))) return false;
  if (feeMode === 'amount') return original.fee === feeAmount;
  const priorRate = ['dividend', 'reinvest'].includes(type) ? 0 : Number.isFinite(original.feeRate)
    ? original.feeRate : gross > 0 ? original.fee / gross * 100 : null;
  return Number.isFinite(priorRate) && Math.abs(priorRate - feeRate) <= Math.max(1, Math.abs(priorRate), Math.abs(feeRate)) * 1e-10;
}

export function transactionToday(now = new Date()) {
  const date = new Date(new Date(now).getTime() + 8 * 60 * 60 * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

// Only the two manual basis fields are authoritative; the third may contain an
// old automatic value. A nonempty actual fee takes priority over any percentage.
// Amounts mean total purchase cost / net sale proceeds (distribution for reinvest).
export function deriveTransactionDraft(draft = {}, {
  original = null, defaultFeeRate = null, today = transactionToday(), id = original?.id,
} = {}) {
  const fail = error => ({ transaction: null, preview: null, error });
  const type = draft.type || original?.type || 'buy';
  const date = draft.date || today;
  if (!TYPES.has(type)) return fail('请选择有效交易类型。');
  if (!validDate(date) || (validDate(today) && date > today)) return fail('请选择有效日期，不能晚于今天。');
  const basis = type === 'dividend' ? ['amount', 'nav'] : draft.basis === undefined ? ['amount', 'nav'] : draft.basis;
  if (!Array.isArray(basis) || basis.length !== 2 || new Set(basis).size !== 2 || basis.some(field => !FIELDS.includes(field))) return fail('请选择用于推算的两项数据。');
  const derivedField = type === 'dividend' ? null : FIELDS.find(field => !basis.includes(field));
  const values = { amount: null, nav: null, shares: null };
  const errors = { amount: '请输入有效金额，金额须大于零。', nav: '净值须为有效正数。', shares: '份额须为有效正数。' };
  for (const field of basis) {
    if (!present(draft[field])) continue;
    const value = decimal(draft[field]);
    if (value === null || value <= 0 || value > (field === 'nav' ? 1e9 : 1e12)) return fail(errors[field]);
    values[field] = field === 'amount' ? round(value) : field === 'shares' ? round(value, 6) : value;
    if (values[field] <= 0) return fail(field === 'amount' ? '金额精度最多为小数点后两位。' : '份额精度最多为小数点后六位。');
  }
  const complete = basis.every(field => values[field] !== null);
  if (!complete && values.amount === null) return fail('请填写至少两项有效数据，或填写金额登记进行中交易。');
  const status = complete ? 'confirmed' : 'pending';
  const noFee = !rateTypes.has(type);
  const feeMode = present(draft.feeAmount) ? 'amount' : 'rate';
  const rawRate = present(draft.feeRate) ? draft.feeRate : defaultFeeRate;
  let feeAmount = noFee ? 0 : feeMode === 'amount' ? decimal(draft.feeAmount) : null;
  let feeRate = noFee ? 0 : feeMode === 'rate' && present(rawRate) ? decimal(rawRate) : null;
  if (!noFee && feeMode === 'amount') {
    if (feeAmount === null || feeAmount < 0 || feeAmount > 1e12) return fail('请输入有效非负手续费金额。');
    const roundedFee = round(feeAmount);
    if (feeAmount > 0 && roundedFee === 0) return fail('手续费金额精度最多为小数点后两位。');
    feeAmount = roundedFee;
  }
  if (!noFee && feeMode === 'rate' && present(rawRate) && feeRate === null) return fail('请输入有效手续费比例。');
  if (feeRate !== null && (feeRate < 0 || feeRate >= 100)) return fail('手续费比例须在 0% 至 100% 之间。');
  if (purchaseTypes.has(type) && feeAmount !== null && values.amount !== null && feeAmount >= values.amount) return fail('手续费不能达到或超过总支出。');
  if (complete && !noFee && feeMode === 'rate' && feeRate === null) return fail('请填写手续费比例或金额，无手续费请填 0。');
  const preview = (amount, nav, shares, fee) => ({ amount, nav, shares, fee, feeRate, feeAmount: feeMode === 'amount' ? feeAmount : null, status, derivedField, feeMode });
  const base = original && typeof original === 'object' ? { ...original } : {};
  const transaction = { ...base, ...(id ? { id } : {}), date, type, status, sourceStatus: status === 'pending' ? 'processing' : 'confirmed', estimated: false, feeMode, feeRate, feeAmount: feeMode === 'amount' ? feeAmount : null };
  // Editing a historical estimate creates the user's explicit record; stale
  // application metadata must not make it eligible for automatic estimation.
  delete transaction.estimateReason;
  delete transaction.originalStatus;
  delete transaction.cost;
  if (status === 'pending') {
    Object.assign(transaction, { amount: values.amount, nav: null, shares: null, fee: null });
    return { transaction, preview: preview(values.amount, null, null, null), error: '' };
  }
  // A historical confirmation may have rounded shares independently of cash.
  // Editing its date or buy/SIP label must not silently replace those shares.
  if (unchangedEconomics(original, { type, values, basis, feeMode, feeRate, feeAmount })) {
    const amount = round(originalAmount(original));
    Object.assign(transaction, { amount: original.amount ?? (type === 'reinvest' ? 0 : amount), nav: original.nav, shares: original.shares, fee: original.fee });
    if (Number.isFinite(original.cost)) transaction.cost = original.cost;
    else if (type === 'transfer-in') transaction.cost = amount;
    return { transaction, preview: preview(amount, original.nav, original.shares, original.fee), error: '' };
  }
  let { amount, nav, shares } = values;
  const purchase = purchaseTypes.has(type), sale = type === 'sell';
  let fee = noFee ? 0 : feeAmount;
  if (feeMode === 'rate' && !noFee) fee = derivedField === 'amount' ? round(nav * shares * feeRate / 100)
    : purchase ? round(amount - amount / (1 + feeRate / 100)) : round(amount / (1 - feeRate / 100) - amount);
  if (type === 'dividend') shares = 0;
  else if (derivedField === 'amount') {
    const gross = nav * shares;
    if (sale && fee >= gross) return fail('手续费不能达到或超过赎回总额。');
    amount = round(gross + (purchase ? fee : sale ? -fee : 0));
  } else {
    if (purchase && fee >= amount) return fail('手续费不能达到或超过总支出。');
    const gross = amount + (purchase ? -fee : sale ? fee : 0);
    if (derivedField === 'nav') nav = gross / shares;
    else shares = round(gross / nav, 6);
  }
  if (![amount, nav, shares, fee].every(Number.isFinite) || amount <= 0 || amount > 1e12 || nav <= 0 || nav > 1e9 || shares > 1e12 || fee < 0 || fee > 1e12 ||
      (type !== 'dividend' && shares <= 0)) return fail('金额、净值与份额无法形成有效交易，请检查输入。');
  if (purchase && fee >= amount) return fail('手续费不能达到或超过总支出。');
  if (sale && fee >= nav * shares) return fail('手续费不能达到或超过赎回总额。');
  if (!noFee && Math.abs(amount + (sale ? fee : -fee) - nav * shares) > .1 + 1e-8) return fail('净值或份额精度不足，请检查输入。');
  Object.assign(transaction, { amount: type === 'reinvest' ? 0 : amount, nav, shares, fee });
  if (type === 'transfer-in') transaction.cost = amount;
  return { transaction, preview: preview(amount, nav, shares, fee), error: '' };
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
