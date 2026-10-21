// Public fee schedules transcribed from the per-fund 交易规则 screenshots.
// Amounts are gross subscription/redemption amounts; no account values live here.
export const FEE_RULES = Object.freeze({
  '005698': {
    buy: [
      { below: 500000, rate: 0.0015 },
      { below: 2000000, rate: 0.0012 },
      { below: 5000000, rate: 0.0008 },
      { below: Infinity, fixed: 1000 },
    ],
    sell: [
      { belowDays: 7, rate: 0.015 },
      { belowDays: 30, rate: 0.0075 },
      { belowDays: 365, rate: 0.005 },
      { belowDays: Infinity, rate: 0 },
    ],
  },
  '270023': {
    buy: [
      { below: 1000000, rate: 0.0016 },
      { below: 5000000, rate: 0.0010 },
      { below: 10000000, rate: 0.0005 },
      { below: Infinity, fixed: 1000 },
    ],
    sell: [
      { belowDays: 7, rate: 0.015 },
      { belowDays: 365, rate: 0.005 },
      { belowDays: 730, rate: 0.003 },
      { belowDays: Infinity, rate: 0 },
    ],
  },
  '006373': {
    buy: [
      { below: 1000000, rate: 0.0015 },
      { below: 3000000, rate: 0.0008 },
      { below: 5000000, rate: 0.0004 },
      { below: Infinity, fixed: 1000 },
    ],
    sell: [
      { belowDays: 7, rate: 0.015 },
      { belowDays: 30, rate: 0.0075 },
      { belowDays: 180, rate: 0.005 },
      { belowDays: Infinity, rate: 0 },
    ],
  },
  '016701': {
    buy: [
      { below: 10000000, rate: 0.0015 },
      { below: Infinity, fixed: 1000 },
    ],
    sell: [
      { belowDays: 7, rate: 0.015 },
      { belowDays: 30, rate: 0.0075 },
      { belowDays: 180, rate: 0.005 },
      { belowDays: Infinity, rate: 0 },
    ],
  },
  '006663': {
    buy: [{ below: Infinity, rate: 0 }],
    sell: [
      { belowDays: 7, rate: 0.015 },
      { belowDays: Infinity, rate: 0 },
    ],
  },
  '004103': {
    buy: [{ below: Infinity, rate: 0 }],
    sell: [
      { belowDays: 7, rate: 0.015 },
      { belowDays: 30, rate: 0.001 },
      { belowDays: Infinity, rate: 0 },
    ],
  },
  '006485': {
    buy: [{ below: Infinity, rate: 0 }],
    sell: [
      { belowDays: 7, rate: 0.015 },
      { belowDays: 30, rate: 0.001 },
      { belowDays: Infinity, rate: 0 },
    ],
  },
});

const round2 = value => Math.round((value + Number.EPSILON) * 100) / 100;
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const DAY = 86400000;

export function feeRule(code) {
  return FEE_RULES[code] || null;
}

export function buyTier(code, amount) {
  const rule = feeRule(code);
  if (!rule || !positive(amount)) return null;
  return rule.buy.find(tier => amount < tier.below) || rule.buy.at(-1);
}

export function buyFee(code, amount) {
  const tier = buyTier(code, amount);
  if (!tier) return null;
  if (tier.fixed) {
    return { fee: round2(tier.fixed), net: round2(amount - tier.fixed), rate: null, fixed: tier.fixed };
  }
  const fee = round2(amount - amount / (1 + tier.rate));
  return { fee, net: round2(amount - fee), rate: tier.rate, fixed: null };
}

// Effective percentage used for conversion subscription differential. A fixed
// fee tier is converted to its effective rate at the transferred amount.
export function effectiveSubscriptionRate(code, amount) {
  const tier = buyTier(code, amount);
  if (!tier || !positive(amount)) return 0;
  return tier.fixed ? tier.fixed / amount : tier.rate;
}

export function sellRate(code, days) {
  const rule = feeRule(code);
  if (!rule || !Number.isFinite(days)) return null;
  const normalized = Math.max(0, days);
  return (rule.sell.find(tier => normalized < tier.belowDays) || rule.sell.at(-1)).rate;
}

export function daysBetween(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  const start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.floor((end - start) / DAY);
}

export function lotDate(lot) {
  return typeof lot?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(lot.date) ? lot.date : null;
}

// FIFO redemption fee. Each lot's holding days are counted from its recorded
// transaction date, matching the user's chosen basis.
export function redemptionFee(code, lots, nav, saleDate, requestedShares) {
  if (!Array.isArray(lots) || !positive(nav) || !positive(requestedShares)) return { ok: false, available: 0 };
  const ordered = lots.map((lot, index) => ({ lot, index })).sort((left, right) => String(left.lot?.date || '').localeCompare(String(right.lot?.date || '')) || left.index - right.index).map(item => item.lot);
  let available = 0;
  for (const lot of ordered) {
    const shares = Number(lot?.shares);
    if (!Number.isFinite(shares) || shares <= 0 || !lotDate(lot)) return { ok: false, available: 0 };
    available += shares;
  }
  if (requestedShares > available + 1e-6) return { ok: false, available };
  let remaining = requestedShares, gross = 0, fee = 0;
  for (const lot of ordered) {
    if (remaining <= 1e-9) break;
    const take = Math.min(remaining, Number(lot.shares));
    if (take <= 0) continue;
    const days = daysBetween(lot.date, saleDate);
    const rate = sellRate(code, days);
    if (rate === null) return { ok: false, available };
    gross += take * nav;
    fee += take * nav * rate;
    remaining -= take;
  }
  if (remaining > 1e-6) return { ok: false, available };
  return { ok: true, fee: round2(fee), gross: round2(gross), net: round2(gross - fee), available, rate: gross > 0 ? fee / gross : 0 };
}

export function subscriptionDiffFee(outCode, inCode, amount) {
  if (!positive(amount)) return { diff: 0, fee: 0, outRate: 0, inRate: 0 };
  const outRate = effectiveSubscriptionRate(outCode, amount);
  const inRate = effectiveSubscriptionRate(inCode, amount);
  const diff = Math.max(0, inRate - outRate);
  const fee = diff > 0 ? round2(amount - amount / (1 + diff)) : 0;
  return { diff, fee, outRate, inRate };
}
