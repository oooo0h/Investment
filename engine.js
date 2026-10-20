/** Spreadsheet-compatible, entirely local fund ledger. No network or storage. */
const TYPES = new Set(['buy', 'sip', 'sell', 'reinvest', 'dividend', 'transfer-in']);
const EXCLUDED = new Set(['cancelled', 'failed', 'closed', '撤单', '交易失败', '交易关闭']);
const PENDING = new Set(['pending', '待确认']);
const CONFIRMED = new Set(['confirmed', 'estimated', '已确认', '历史估算', '已录入']);
const numeric = (value) => typeof value === 'number' && Number.isFinite(value);
const round = (value, digits = 2) => {
  // Decimal shifting avoids a binary-float half value rounding downward.
  const shift = (number, exponent) => {
    const [coefficient, existingExponent = '0'] = String(number).split('e');
    return Number(`${coefficient}e${Number(existingExponent) + exponent}`);
  };
  return Math.sign(value) * shift(Math.round(shift(Math.abs(value), digits)), -digits) || 0;
};
const validDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
};
const zeroState = (principal, shares) => ({
  shares, principal, totalInvested: principal, totalRecovered: 0,
  totalProfitWithdrawn: 0, totalClosedLoss: 0, lastDate: null, lastNav: null,
});

/**
 * Row indexes and error indexes start at one. Amounts in errors are never echoed.
 * An invalid transaction blocks following transactions, matching the workbook.
 * The caller is responsible for keeping all account data private in the UI.
 */
export function calculateLedger(transactions, {
  mode = 'profit-first', valuationNav = null, valuationDate = null,
  openingPrincipal = 0, openingShares = 0, tolerance = 0.1,
} = {}) {
  const rows = [];
  const errors = [];
  const list = Array.isArray(transactions) ? transactions : [];
  let invalid = false;
  let includedCount = 0;
  let pendingCount = 0;
  let estimatedCount = 0;
  let latestEstimatedDate = null;
  const optionsValid = ['profit-first', 'principal-first'].includes(mode)
    && numeric(openingPrincipal) && openingPrincipal >= 0
    && numeric(openingShares) && openingShares >= 0
    && numeric(tolerance) && tolerance >= 0;
  let state = zeroState(optionsValid ? round(openingPrincipal) : 0, optionsValid ? round(openingShares, 6) : 0);
  if (!Array.isArray(transactions)) errors.push({ index: 0, message: '交易列表格式无效。' });
  if (!optionsValid) errors.push({ index: 0, message: '请检查分配模式、期初本金、期初份额和核对容差。' });
  invalid = errors.length > 0;

  for (let i = 0; i < list.length; i += 1) {
    const tx = list[i] && typeof list[i] === 'object' ? list[i] : {};
    const index = i + 1;
    const row = { ...tx, index };
    const inputStatus = tx.status ?? 'confirmed';
    if (EXCLUDED.has(inputStatus) || PENDING.has(inputStatus)) {
      row.status = EXCLUDED.has(inputStatus) ? 'excluded' : 'pending';
      if (row.status === 'pending') pendingCount += 1;
      if (!invalid) Object.assign(row, {
        shareChange: 0, sharesAfter: state.shares, principalAfter: state.principal,
        totalInvested: state.totalInvested, totalRecovered: state.totalRecovered,
        totalProfitWithdrawn: state.totalProfitWithdrawn, totalClosedLoss: state.totalClosedLoss,
        lastNav: state.lastNav, lastDate: state.lastDate,
      });
      rows.push(row);
      continue;
    }
    if (invalid) {
      row.status = 'blocked';
      row.error = '前序交易待修正。';
      pendingCount += 1;
      errors.push({ index, message: row.error });
      rows.push(row);
      continue;
    }

    let message = '';
    let amount;
    const check = (condition, text) => { if (!message && condition) message = text; };
    check(!CONFIRMED.has(inputStatus), '请选择有效确认状态。');
    check(!validDate(tx.date), '请填写有效净值日期。');
    check(!TYPES.has(tx.type), '请选择有效交易类型。');
    check(!numeric(tx.nav) || tx.nav <= 0, '成交净值须大于零。');
    check(!numeric(tx.shares) || tx.shares < 0, '请填写非负确认份额。');
    check(!numeric(tx.fee) || tx.fee < 0, '请填写非负手续费，无费用请填零。');
    check(state.lastDate !== null && validDate(tx.date) && tx.date < state.lastDate, '日期需按成交顺序递增。');
    if (['buy', 'sip', 'sell', 'transfer-in', 'reinvest'].includes(tx.type)) {
      check(numeric(tx.shares) && tx.shares <= 0, '确认份额须大于零。');
    }
    if (tx.type === 'buy' || tx.type === 'sip') {
      amount = tx.amount ?? (numeric(tx.nav) && numeric(tx.shares) && numeric(tx.fee) ? round(tx.nav * tx.shares + tx.fee) : null);
    } else if (tx.type === 'sell') {
      amount = tx.amount ?? (numeric(tx.nav) && numeric(tx.shares) && numeric(tx.fee) ? round(tx.nav * tx.shares - tx.fee) : null);
      check(numeric(tx.shares) && tx.shares > state.shares + 0.000001, '卖出份额超过持仓。');
      check(numeric(tx.fee) && numeric(tx.nav) && numeric(tx.shares) && tx.fee >= tx.nav * tx.shares, '赎回费不能达到赎回总额。');
    } else if (tx.type === 'reinvest') {
      amount = tx.amount ?? 0;
      check(tx.fee !== 0 || amount !== 0, '红利再投金额和手续费须为零。');
      check(state.shares <= 0, '红利再投前须有持仓。');
    } else if (tx.type === 'dividend') {
      amount = tx.amount;
      check(tx.shares !== 0 || tx.fee !== 0, '现金分红份额和手续费须为零。');
      check(state.shares <= 0, '现金分红前须有持仓。');
    } else if (tx.type === 'transfer-in') {
      amount = tx.cost ?? tx.amount;
      check(amount === undefined || amount === null, '转换转入需填写实际转入成本。');
    }
    check(!numeric(amount) || amount < 0, '请填写有效确认金额或转入成本。');
    if (['buy', 'sip', 'sell', 'transfer-in', 'dividend'].includes(tx.type)) {
      check(numeric(amount) && amount <= 0, '买卖、分红及转入金额须大于零。');
    }
    if (['buy', 'sip', 'transfer-in'].includes(tx.type)) {
      check(numeric(tx.fee) && numeric(amount) && tx.fee >= amount, '申购费不能达到总支出。');
      check(numeric(amount) && numeric(tx.fee) && numeric(tx.nav) && numeric(tx.shares)
        && Math.abs(amount - tx.fee - tx.nav * tx.shares) > tolerance + 1e-8,
      '买入金额与份额净值不符。');
    }
    if (tx.type === 'sell') {
      check(numeric(amount) && numeric(tx.fee) && numeric(tx.nav) && numeric(tx.shares)
        && Math.abs(amount + tx.fee - tx.nav * tx.shares) > tolerance + 1e-8,
      '到账加费用与赎回市值不符。');
    }
    if (message) {
      row.status = 'error';
      row.error = message;
      pendingCount += 1;
      invalid = true;
      errors.push({ index, message });
      rows.push(row);
      continue;
    }

    amount = round(amount);
    const addition = ['buy', 'sip', 'transfer-in'].includes(tx.type);
    const cashOut = tx.type === 'sell' || tx.type === 'dividend';
    const shareChange = tx.type === 'sell' ? -tx.shares : (addition || tx.type === 'reinvest' ? tx.shares : 0);
    const sharesAfter = round(state.shares + shareChange, 6);
    const valueBefore = round(state.shares * tx.nav);
    const availableProfit = tx.type === 'sell' ? Math.max(0, valueBefore - state.principal - tx.fee)
      : tx.type === 'dividend' ? Math.max(0, valueBefore + amount - state.principal) : 0;
    const profitWithdrawn = round(tx.type === 'sell' && mode === 'principal-first'
      ? Math.max(0, amount - state.principal) : cashOut ? Math.min(amount, availableProfit) : 0);
    const principalRecovered = round(cashOut ? Math.min(state.principal, Math.max(0, amount - profitWithdrawn)) : 0);
    const closedLoss = round(tx.type === 'sell' && sharesAfter === 0 ? Math.max(0, state.principal - principalRecovered) : 0);
    const principalAfter = round(state.principal + (addition ? amount : 0) - principalRecovered - closedLoss);
    const valueAfter = round(sharesAfter * tx.nav);
    const holdingProfit = round(valueAfter - principalAfter);
    const totalInvested = round(state.totalInvested + (addition ? amount : 0));
    const totalRecovered = round(state.totalRecovered + (cashOut ? amount : 0));
    const totalProfitWithdrawn = round(state.totalProfitWithdrawn + profitWithdrawn);
    const totalClosedLoss = round(state.totalClosedLoss + closedLoss);
    Object.assign(row, {
      status: 'included', amount, shareChange, sharesAfter, valueBefore,
      availableProfit: round(availableProfit), profitWithdrawn, principalRecovered, closedLoss,
      principalAfter, valueAfter, holdingProfit,
      holdingReturn: principalAfter > 0 ? holdingProfit / principalAfter : null,
      totalInvested, totalRecovered, totalProfitWithdrawn, totalClosedLoss,
      totalProfit: round(valueAfter + totalRecovered - totalInvested),
      lastDate: tx.date, lastNav: tx.nav,
    });
    state = { shares: sharesAfter, principal: principalAfter, totalInvested,
      totalRecovered, totalProfitWithdrawn, totalClosedLoss, lastDate: tx.date, lastNav: tx.nav };
    includedCount += 1;
    if (inputStatus === 'estimated' || inputStatus === '历史估算') {
      estimatedCount += 1;
      if (!latestEstimatedDate || tx.date > latestEstimatedDate) latestEstimatedDate = tx.date;
    }
    rows.push(row);
  }

  const publishedValid = validDate(valuationDate) && numeric(valuationNav) && valuationNav > 0;
  const usePublished = publishedValid && (state.lastDate === null || valuationDate >= state.lastDate);
  const selectedDate = usePublished ? valuationDate : state.lastDate;
  const selectedNav = usePublished ? valuationNav : state.lastNav;
  const marketValue = state.shares === 0 ? 0 : selectedNav !== null ? round(state.shares * selectedNav) : null;
  const holdingProfit = marketValue === null ? null : round(marketValue - state.principal);
  const totalProfit = marketValue === null ? null : round(marketValue + state.totalRecovered - state.totalInvested);
  const summary = {
    valid: !invalid, shares: state.shares, principal: state.principal, marketValue,
    holdingProfit, holdingReturn: holdingProfit !== null && state.principal > 0 ? holdingProfit / state.principal : null,
    totalInvested: state.totalInvested, totalRecovered: state.totalRecovered,
    totalProfitWithdrawn: state.totalProfitWithdrawn, totalClosedLoss: state.totalClosedLoss,
    totalProfit, totalReturn: totalProfit !== null && state.totalInvested > 0 ? totalProfit / state.totalInvested : null,
    principalStatus: state.shares === 0 ? 'empty' : state.principal === 0 ? 'recovered' : 'invested',
    includedCount, pendingCount, estimatedCount, latestEstimatedDate, valuationNav: selectedNav, valuationDate: selectedDate,
    lastNav: state.lastNav, lastDate: state.lastDate,
    identityCheck: totalProfit === null ? null : Math.abs(totalProfit - (holdingProfit + state.totalProfitWithdrawn - state.totalClosedLoss)) < 0.02,
  };
  if (invalid) {
    for (const key of ['shares', 'principal', 'marketValue', 'holdingProfit', 'holdingReturn', 'totalInvested',
      'totalRecovered', 'totalProfitWithdrawn', 'totalClosedLoss', 'totalProfit', 'totalReturn', 'identityCheck']) summary[key] = null;
    summary.principalStatus = null;
  }
  return { rows, summary, errors };
}

/** Explain mode effects without exposing any account amounts or quantities. */
export function describeModeEffect(current, alternate, { incomplete = false } = {}) {
  const common = '两种模式只影响卖出到账的本金与利润分配，不改变份额、市值和累计总收益。';
  if (incomplete || !current?.summary?.valid || !alternate?.summary?.valid) {
    return { kind: 'unavailable', message: `交易资料待补全或修正，暂时无法完整比较。${common}` };
  }
  const sells = current.rows.filter(row => row.status === 'included' && row.type === 'sell');
  if (!sells.length) return { kind: 'no-sells', message: `暂无已计入的卖出，切换模式暂不改变结果。${common}` };
  const differs = current.rows.some((row, index) => row.status === 'included' && row.type === 'sell'
    && ['principalRecovered', 'profitWithdrawn', 'principalAfter'].some(field => row[field] !== alternate.rows[index]?.[field]));
  if (differs) return { kind: 'different', message: `当前两种模式分配不同，可对比剩余本金、已提取利润和持有收益率。${common}` };
  if (sells.every(row => row.availableProfit === 0)) {
    return { kind: 'same-no-profit', message: `当前已计入的卖出没有可优先提取的利润，到账均用于收回本金，因此切换后结果相同。${common}` };
  }
  return { kind: 'same', message: `当前已计入的卖出在两种模式下分配相同，因此展示结果不变。${common}` };
}
