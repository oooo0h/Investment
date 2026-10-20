// Public fee settings and pure holding-period calculations. Inputs stay private;
// the display result exposes dates, counts and proportions, never lot balances.
const DAY_MS = 86400000;
const MATURITY_DAYS = 30;
const CODES = new Set(['006485', '006663']);
const IGNORED_STATUSES = new Set(['pending', 'cancelled', 'failed', 'closed']);

const freezeFee = (redemption) => Object.freeze({
  purchaseRate: 0,
  redemption: Object.freeze(redemption.map(tier => Object.freeze(tier))),
});

/** User-supplied ordinary buy/redemption fees, not actual conversion charges. */
export const BOND_FEE_RULES = Object.freeze({
  '006485': freezeFee([
    { minDays: 0, maxDaysExclusive: 7, rate: .015 },
    { minDays: 7, maxDaysExclusive: 30, rate: .001 },
    { minDays: 30, maxDaysExclusive: null, rate: 0 },
  ]),
  '006663': freezeFee([
    { minDays: 0, maxDaysExclusive: 7, rate: .015 },
    { minDays: 7, maxDaysExclusive: null, rate: 0 },
  ]),
});

export function getBondRedemptionFeeRate(code, holdingDays) {
  if (typeof code !== 'string' || !Object.hasOwn(BOND_FEE_RULES, code) || !Number.isSafeInteger(holdingDays) || holdingDays < 0) return null;
  return BOND_FEE_RULES[code].redemption.find(tier => holdingDays >= tier.minDays
    && (tier.maxDaysExclusive === null || holdingDays < tier.maxDaysExclusive))?.rate ?? null;
}

function utcDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value ? stamp : null;
}

function beijingDay(now) {
  if (typeof now === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(now)) return utcDay(now);
  if (now === null || now === '' || (typeof now !== 'string' && typeof now !== 'number' && !(now instanceof Date))) return null;
  const shifted = new Date(new Date(now).getTime() + 8 * 60 * 60 * 1000);
  return Number.isFinite(shifted.getTime()) ? utcDay(shifted.toISOString().slice(0, 10)) : null;
}

const invalid = () => { throw new Error('Invalid bond holding lots.'); };
const recordObject = value => value && typeof value === 'object' && !Array.isArray(value);

function normalizeRecord(record) {
  if (!recordObject(record) || Object.keys(record).some(key => !['complete', 'lots', 'basis'].includes(key))
    || typeof record.complete !== 'boolean' || !Array.isArray(record.lots) || record.lots.length > 10000
    || (record.basis !== undefined && !['reported', 'calculated'].includes(record.basis))) invalid();
  const lots = [];
  for (const lot of record.lots) {
    if (!recordObject(lot) || Object.keys(lot).some(key => !['confirmedDate', 'orderDate', 'remainingShares', 'status'].includes(key))) invalid();
    if (IGNORED_STATUSES.has(lot.status)) continue;
    const orderBased = record.basis === 'calculated' && !lot.confirmedDate && utcDay(lot.orderDate) !== null;
    if (lot.status !== 'confirmed' || (!orderBased && utcDay(lot.confirmedDate) === null)
      || typeof lot.remainingShares !== 'number' || !Number.isFinite(lot.remainingShares) || lot.remainingShares < 0) invalid();
    if (lot.remainingShares > 0) lots.push({ ...(orderBased ? { orderDate: lot.orderDate } : { confirmedDate: lot.confirmedDate }), remainingShares: lot.remainingShares, status: 'confirmed' });
  }
  return { complete: record.complete, lots, ...(record.basis === undefined ? {} : { basis: record.basis }) };
}

/** Optional encrypted metadata, kept outside the existing financial entries. */
export function normalizeBondHoldingLots(value) {
  if (value === undefined) return undefined;
  if (!recordObject(value) || Object.keys(value).some(code => !CODES.has(code))) invalid();
  return Object.fromEntries(Object.entries(value).map(([code, record]) => [code, normalizeRecord(record)]));
}

const unknown = (reason, maturityDays = MATURITY_DAYS) => ({
  status: 'unknown', reason, recentRatio: null, matureRatio: null, under7Ratio: null, sevenTo29Ratio: null, maturityDays,
  youngestDays: null, oldestDays: null, remainingDays: null, lotCount: 0,
});

/**
 * `complete` explicitly attests that lots are the CURRENT remaining holdings,
 * after any confirmed redemptions/transfers. This function never reconstructs
 * holdings from application amounts or execution deadlines. A separately
 * calculated partial history is allowed only under basis='calculated'; its
 * ratios describe supplied lots and never attest that the source is complete.
 * Within one fund all remaining shares have the same current per-share value,
 * so share weights equal current market-value weights without needing a NAV.
 */
export function calculateBondHoldingDuration(record, { now = new Date(), code } = {}) {
  const maturityDays = code === '006663' ? 7 : MATURITY_DAYS;
  const unavailable = reason => unknown(reason, maturityDays);
  if (!recordObject(record) || (record.complete !== true && record.basis !== 'calculated')) return unavailable('incomplete');
  const today = beijingDay(now);
  if (today === null) return unavailable('invalid-clock');
  let normalized;
  try { normalized = normalizeRecord(record); }
  catch { return unavailable('invalid-lots'); }
  if (!normalized.lots.length) return normalized.complete
    ? { ...unavailable('empty'), status: 'empty', recentRatio: 0, matureRatio: 0, under7Ratio: 0, sevenTo29Ratio: 0, remainingDays: 0 }
    : unavailable('no-provided-lots');
  const lots = normalized.lots.map(lot => ({
    shares: lot.remainingShares, days: (today - utcDay(lot.confirmedDate || lot.orderDate)) / DAY_MS,
  }));
  if (lots.some(lot => lot.days < 0)) return unavailable('future-confirmation');
  const scale = Math.max(...lots.map(lot => lot.shares));
  const weights = lots.reduce((sum, lot) => {
    const weight = lot.shares / scale;
    sum.total += weight;
    if (lot.days < maturityDays) sum.recent += weight;
    if (lot.days < 7) sum.under7 += weight;
    return sum;
  }, { total: 0, recent: 0, under7: 0 });
  const recentRatio = Math.min(1, Math.max(0, weights.recent / weights.total));
  const under7Ratio = Math.min(recentRatio, Math.max(0, weights.under7 / weights.total));
  const youngestDays = Math.min(...lots.map(lot => lot.days));
  return {
    status: normalized.basis === 'calculated' ? 'calculated' : 'known', reason: normalized.basis === 'calculated' ? 'provided-history' : 'complete-lots', recentRatio, matureRatio: 1 - recentRatio, under7Ratio, sevenTo29Ratio: recentRatio - under7Ratio, maturityDays,
    dateBasis: normalized.lots.some(lot => lot.orderDate) ? 'order' : 'confirmed',
    youngestDays, oldestDays: Math.max(...lots.map(lot => lot.days)),
    remainingDays: Math.max(0, maturityDays - youngestDays), lotCount: lots.length,
  };
}
