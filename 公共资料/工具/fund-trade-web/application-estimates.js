const ELIGIBLE_TYPES = new Set(['buy', 'sip']);

// Source: https://www.ftsfund.com/ftp/upload/file/202601/14/5P1oxvXBzaPXK6TJ.pdf
// Fund opening calendar checked through 2026-10-15, limited to 2026-07-01..2026-10-15.
// Explicitly verified closures are excluded; NAV availability never defines an open day.
export const GUOFU_TRADING_DATES = (() => {
  const start = '2026-07-01';
  const end = '2026-10-15';
  const closures = new Set(['2026-07-03', '2026-09-07', '2026-09-25', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
  const dates = [];
  for (let stamp = Date.parse(`${start}T00:00:00Z`); stamp <= Date.parse(`${end}T00:00:00Z`); stamp += 86400000) {
    const date = new Date(stamp);
    const day = date.getUTCDay();
    const key = date.toISOString().slice(0, 10);
    if (day !== 0 && day !== 6 && !closures.has(key)) dates.push(key);
  }
  // Non-enumerable coverage bounds let the estimator reject dates outside the
  // verified window without guessing whether a missing date was a holiday.
  Object.defineProperties(dates, { coverageStart: { value: start }, coverageEnd: { value: end } });
  return Object.freeze(dates);
})();

const round = (value, digits = 2) => {
  // Use the ledger engine's decimal shift to preserve decimal half boundaries.
  const shift = (number, exponent) => {
    const [coefficient, existingExponent = '0'] = String(number).split('e');
    return Number(`${coefficient}e${Number(existingExponent) + exponent}`);
  };
  return Math.sign(value) * shift(Math.round(shift(Math.abs(value), digits)), -digits) || 0;
};
const validDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
};

// A timestamp without an offset is an explicit Beijing local application time.
// An explicit +08:00 suffix is also accepted; other offsets are not inferred.
function applicationTime(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:\+08:00)?$/.exec(value.trim());
  if (!match || !validDate(match[1])) return null;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] || 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { date: match[1], afterCutoff: hour >= 15 };
}

const pending = (transaction, reason) => ({
  ...transaction,
  status: 'pending',
  estimated: false,
  originalStatus: transaction.originalStatus ?? transaction.status,
  estimateReason: reason,
});

/**
 * Derive estimates from unverified historical applications, entirely in memory.
 * `tradingDates` is a caller-verified list of this fund's open application dates.
 * Pass GUOFU_TRADING_DATES directly to retain its verified coverage bounds.
 * Only an exact NAV on the selected open date is used. The returned array is
 * chronological by effective NAV date (or application date), then submittedAt.
 * Every input transaction is retained and no source object or array is mutated.
 */
export function estimateApplications(transactions, history, { rate = 0.0015, tradingDates = [] } = {}) {
  const source = Array.isArray(transactions) ? transactions : [];
  const openDates = [...new Set(Array.isArray(tradingDates) ? tradingDates.filter(validDate) : [])].sort();
  const coverageStart = validDate(tradingDates?.coverageStart) ? tradingDates.coverageStart : null;
  const coverageEnd = validDate(tradingDates?.coverageEnd) ? tradingDates.coverageEnd : null;
  const navByDate = new Map();
  for (const point of Array.isArray(history) ? history : []) {
    if (point && validDate(point.date) && Number.isFinite(point.nav) && point.nav > 0) navByDate.set(point.date, point.nav);
  }

  const derived = source.map((transaction, index) => {
    const tx = { ...transaction };
    if (tx.status !== 'pending' || tx.sourceStatus !== 'unverified' || !ELIGIBLE_TYPES.has(tx.type)) return { tx, index };

    const submitted = applicationTime(tx.submittedAt);
    let result;
    if (!submitted) result = pending(tx, '申请日期或时间不完整，暂不估算。');
    else if ((coverageStart && submitted.date < coverageStart) || (coverageEnd && submitted.date > coverageEnd)) result = pending(tx, '申请日期在已核验日历窗口之外，开放日历待补充。');
    else if (!openDates.length) result = pending(tx, '尚无已核验的基金开放日期，暂不估算。');
    else {
      const date = openDates.find(openDate => submitted.afterCutoff ? openDate > submitted.date : openDate >= submitted.date);
      if (!date) result = pending(tx, '已核验开放日期尚未覆盖本笔申请，暂不估算。');
      else if (!navByDate.has(date)) result = pending(tx, '对应开放日期尚无可用净值，不改用其他日期。');
      else if (!Number.isFinite(tx.amount) || tx.amount <= 0) result = pending(tx, '申请金额无效，暂不估算。');
      else if (!Number.isFinite(rate) || rate < 0) result = pending(tx, '参考费率无效，暂不估算。');
      else {
        const nav = navByDate.get(date);
        const net = round(tx.amount / (1 + rate));
        const fee = round(tx.amount - net);
        const shares = round(net / nav);
        result = [net, fee, shares].every(Number.isFinite) ? {
          ...tx, date, nav, fee, shares, netAmount: net,
          status: 'estimated', estimated: true, estimatedRate: rate,
          originalStatus: tx.originalStatus ?? tx.status,
          estimateReason: '按已核验开放日期及当日公开净值，使用参考费率估算；成交资料仍待确认。',
        } : pending(tx, '无法形成有效估算，请核验申请资料。');
      }
    }
    return { tx: result, index };
  });

  return derived.sort((a, b) => {
    const dateA = validDate(a.tx.date) ? a.tx.date : applicationTime(a.tx.submittedAt)?.date || '9999-12-31';
    const dateB = validDate(b.tx.date) ? b.tx.date : applicationTime(b.tx.submittedAt)?.date || '9999-12-31';
    return dateA.localeCompare(dateB)
      || String(a.tx.submittedAt || '').localeCompare(String(b.tx.submittedAt || ''))
      || a.index - b.index;
  }).map(({ tx }) => tx);
}
