// Public identities only. Account inputs are processed in memory, never logged.
export const BOND_FUNDS = Object.freeze([
  Object.freeze({ code: '006485', name: '广发中债1-3年国开行债券指数C' }),
  Object.freeze({ code: '006663', name: '易方达安悦超短债债券C' }),
]);

const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const invalid = () => { throw new Error('Invalid bond entries.'); };

// Round the decimal representation to cents, including 1.005 and negative
// half-cent values, without multiplying binary floating-point amounts by 100.
function cents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
  const [coefficient, exponentText = '0'] = Math.abs(value).toString().split('e');
  const [whole, fraction = ''] = coefficient.split('.');
  const digits = BigInt(whole + fraction);
  const places = 2 + Number(exponentText) - fraction.length;
  const scale = 10n ** BigInt(Math.abs(places));
  const absolute = places >= 0 ? digits * scale : (digits * 2n + scale) / (scale * 2n);
  if (absolute > MAX_CENTS) invalid();
  return value < 0 ? -absolute : absolute;
}

function money(value) {
  if (value < -MAX_CENTS || value > MAX_CENTS) invalid();
  const result = Number(value) / 100;
  // The numeric API must never silently lose a cent at very large magnitudes.
  if (cents(result) !== value) invalid();
  return result || 0;
}

function normalized(entries) {
  if (!Array.isArray(entries) || entries.length !== BOND_FUNDS.length) invalid();
  const byCode = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).sort().join(',') !== 'code,holdingProfit,marketValue'
      || !BOND_FUNDS.some(fund => fund.code === entry.code) || byCode.has(entry.code)
      || typeof entry.marketValue !== 'number' || entry.marketValue < 0) invalid();
    const marketValue = cents(entry.marketValue);
    const holdingProfit = cents(entry.holdingProfit);
    const cost = marketValue - holdingProfit;
    if (cost <= 0n || cost > MAX_CENTS) invalid();
    // Validate that every returned amount can preserve the exact cent values.
    money(marketValue); money(holdingProfit); money(cost);
    byCode.set(entry.code, { code: entry.code, marketValue, holdingProfit, cost });
  }
  return BOND_FUNDS.map(fund => byCode.get(fund.code) || invalid());
}

/** Exactly one entry per known fund; amounts are numbers rounded to cents. */
export function normalizeBondEntries(entries) {
  try {
    return normalized(entries).map(({ code, marketValue, holdingProfit }) => ({
      code, marketValue: money(marketValue), holdingProfit: money(holdingProfit),
    }));
  } catch { invalid(); }
}

/** Null clears the optional free-cash-flow record; finite amounts round to cents. */
export function normalizeFreeCashFlow(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
  const amount = cents(value);
  return money(amount);
}

/** Allocation total includes signed free cash flow; fund profits stay separate. */
export function calculateBondHoldingValue(entries, freeCashFlow = null) {
  try {
    const rows = normalized(entries);
    const cash = normalizeFreeCashFlow(freeCashFlow);
    return money(rows.reduce((sum, row) => sum + row.marketValue, 0n) + (cash === null ? 0n : cents(cash)));
  } catch { invalid(); }
}

/** returnRate is a ratio: 0.01 means 1%, using cost = marketValue - profit. */
export function calculateBondSummary(entries) {
  try {
    const rows = normalized(entries);
    const holdings = rows.map(({ code, marketValue, holdingProfit, cost }, index) => ({
      code,
      name: BOND_FUNDS[index].name,
      marketValue: money(marketValue),
      holdingProfit: money(holdingProfit),
      cost: money(cost),
      returnRate: Number(holdingProfit) / Number(cost) || 0,
    }));
    const total = rows.reduce((sum, row) => ({
      marketValue: sum.marketValue + row.marketValue,
      holdingProfit: sum.holdingProfit + row.holdingProfit,
      cost: sum.cost + row.cost,
    }), { marketValue: 0n, holdingProfit: 0n, cost: 0n });
    return {
      holdings,
      marketValue: money(total.marketValue),
      holdingProfit: money(total.holdingProfit),
      cost: money(total.cost),
      returnRate: Number(total.holdingProfit) / Number(total.cost) || 0,
    };
  } catch { invalid(); }
}
