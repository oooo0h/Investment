/** Per-transaction FIFO economics. No storage, account totals, or mode allocation. */
const TYPES = new Set(['buy', 'sip', 'sell', 'transfer-in', 'reinvest', 'dividend']);
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const round = (value, digits = 2) => {
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
const invalid = () => { throw new Error('Invalid transaction performance input.'); };
const integer = value => { if (!Number.isSafeInteger(value)) invalid(); return value; };
const units = value => { if (!numeric(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 1e6) invalid(); return integer(Math.round(round(value, 6) * 1e6)); };
const cents = value => { if (!numeric(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 100) invalid(); return integer(Math.round(round(value) * 100)); };
const money = value => value / 100;
const shares = value => value / 1e6;
const sum = (...values) => integer(Number(values.reduce((total, value) => total + BigInt(integer(value)), 0n)));
const estimated = row => row?.estimated === true || ['estimated', '历史估算'].includes(row?.originalStatus) || row?.sourceStatus === 'estimated';

// Integer ratios make every cent belong to one lot and settle all closing dust.
function ratio(total, part, whole) {
  if (!whole || part < 0 || part > whole) invalid();
  const denominator = BigInt(whole);
  return Number((BigInt(total) * BigInt(part) * 2n + denominator) / (denominator * 2n));
}

function allocate(total, weights) {
  const whole = sum(...weights);
  if (!whole) invalid();
  let cumulative = 0, prior = 0;
  return weights.map(weight => {
    cumulative = sum(cumulative, weight);
    const current = ratio(total, cumulative, whole), portion = current - prior;
    prior = current;
    return portion;
  });
}

const unavailable = (row, reason = 'not-included') => ({
  kind: 'unavailable', type: TYPES.has(row?.type) ? row.type : null,
  cost: null, marketValue: null, profit: null, returnRate: null,
  realizedProfit: null, unrealizedProfit: null, remainingShares: null,
  originalShares: null, remainingCost: null, soldCost: null,
  proceeds: null, cashDividends: null, valuationDate: null,
  estimated: estimated(row), reason,
});

/**
 * `rows` are calculateLedger(...).rows. Add `estimated: true` before calling if
 * the source status was estimated and the engine has replaced it with included.
 * Lot profit includes prior sale receipts, allocated cash dividends and its
 * remaining value, less its original fee-inclusive cost. Sale rows independently
 * show net proceeds less FIFO cost. Do not sum lot and sale/dividend row profits.
 */
export function calculateTransactionPerformance(rows, { valuationNav = null, valuationDate = null } = {}) {
  const output = new Map(), lots = [];
  let lastDate = null, lastNav = null, heldUnits = 0, blocked = false;
  const identifiers = new Set(), duplicateIds = new Set();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = raw && typeof raw === 'object' ? raw : {};
    const id = row.id;
    if (identifiers.has(id)) {
      duplicateIds.add(id);
      output.set(id, unavailable(row, 'invalid-input'));
      blocked = true;
      continue;
    }
    identifiers.add(id);
    if (row.status !== 'included') {
      output.set(id, unavailable(row));
      if (row.status === 'error' || row.status === 'blocked') blocked = true;
      continue;
    }
    if (blocked) { output.set(id, unavailable(row, 'blocked')); continue; }
    try {
      if (typeof id !== 'string' || !id || !TYPES.has(row.type)
        || !validDate(row.date) || (lastDate !== null && row.date < lastDate)
        || !numeric(row.nav) || row.nav <= 0 || !numeric(row.fee) || row.fee < 0) invalid();
      const quantity = units(row.shares), amount = cents(row.amount);
      if (row.type !== 'dividend' && !quantity) invalid();
      if (['buy', 'sip', 'transfer-in'].includes(row.type)
        && (row.fee > row.amount || Math.abs(row.amount - row.fee - row.nav * row.shares) > 0.10000001)) invalid();
      if (row.type === 'sell'
        && (row.fee >= row.nav * row.shares || Math.abs(row.amount + row.fee - row.nav * row.shares) > 0.10000001)) invalid();
      if (row.type === 'reinvest' && (row.fee !== 0 || amount !== 0 || !heldUnits)) invalid();
      if (row.type === 'dividend' && (quantity !== 0 || row.fee !== 0 || !heldUnits)) invalid();

      if (['buy', 'sip', 'transfer-in', 'reinvest'].includes(row.type)) {
        heldUnits = sum(heldUnits, quantity);
        lots.push({ id, type: row.type, date: row.date, originalUnits: quantity, remainingUnits: quantity,
          cost: row.type === 'reinvest' ? 0 : amount, soldCost: 0, proceeds: 0, cashDividends: 0,
          estimated: estimated(row), closedAt: null });
      } else if (row.type === 'sell') {
        if (quantity > heldUnits) invalid();
        let toMatch = quantity;
        const matched = [];
        for (const lot of lots) {
          if (!toMatch) break;
          if (!lot.remainingUnits) continue;
          const taken = Math.min(toMatch, lot.remainingUnits);
          const nextSoldCost = ratio(lot.cost, lot.originalUnits - lot.remainingUnits + taken, lot.originalUnits);
          const cost = nextSoldCost - lot.soldCost;
          if (cost < 0 || cost > lot.cost - lot.soldCost) invalid();
          matched.push({ lot, units: taken, cost, nextSoldCost });
          toMatch -= taken;
        }
        if (toMatch) invalid();
        const receipts = allocate(amount, matched.map(item => item.units));
        const soldCost = sum(...matched.map(item => item.cost));
        const isEstimated = estimated(row) || matched.some(item => item.lot.estimated);
        // Validate every update before mutating any matched lot.
        const nextReceipts = matched.map((item, index) => sum(item.lot.proceeds, receipts[index]));
        const matches = matched.map((item, index) => ({
          id: item.lot.id, shares: shares(item.units), cost: money(item.cost),
          proceeds: money(receipts[index]), profit: money(receipts[index] - item.cost),
        }));
        matched.forEach((item, index) => {
          item.lot.remainingUnits -= item.units;
          item.lot.soldCost = item.nextSoldCost;
          item.lot.proceeds = nextReceipts[index];
          item.lot.estimated ||= isEstimated;
          if (!item.lot.remainingUnits) item.lot.closedAt = row.date;
        });
        heldUnits -= quantity;
        const profit = money(amount - soldCost);
        output.set(id, {
          kind: 'sell', type: row.type, cost: money(soldCost), marketValue: 0, profit,
          returnRate: soldCost > 0 ? (amount - soldCost) / soldCost : null,
          realizedProfit: profit, unrealizedProfit: 0, remainingShares: 0,
          originalShares: shares(quantity), remainingCost: 0, soldCost: money(soldCost),
          proceeds: money(amount), cashDividends: 0, valuationDate: row.date,
          estimated: isEstimated, matches,
        });
      } else if (row.type === 'dividend') {
        const active = lots.filter(lot => lot.remainingUnits > 0);
        const portions = allocate(amount, active.map(lot => lot.remainingUnits));
        const isEstimated = estimated(row) || active.some(lot => lot.estimated);
        const totals = active.map((lot, index) => sum(lot.cashDividends, portions[index]));
        active.forEach((lot, index) => { lot.cashDividends = totals[index]; lot.estimated ||= isEstimated; });
        output.set(id, {
          kind: 'dividend', type: row.type, cost: 0, marketValue: 0, profit: money(amount),
          returnRate: null, realizedProfit: money(amount), unrealizedProfit: 0,
          remainingShares: 0, originalShares: 0, remainingCost: 0, soldCost: 0,
          proceeds: money(amount), cashDividends: money(amount), valuationDate: row.date,
          estimated: isEstimated,
          allocations: active.map((lot, index) => ({ id: lot.id, amount: money(portions[index]) })),
        });
      }
      lastDate = row.date;
      lastNav = row.nav;
    } catch {
      output.set(id, unavailable(row, 'invalid-input'));
      blocked = true;
    }
  }

  const published = numeric(valuationNav) && valuationNav > 0 && validDate(valuationDate)
    && (lastDate === null || valuationDate >= lastDate);
  const selectedNav = published ? valuationNav : lastNav;
  const selectedDate = published ? valuationDate : lastDate;
  for (const lot of lots) {
    if (duplicateIds.has(lot.id)) continue;
    try {
      const remainingCost = lot.cost - lot.soldCost;
      const marketValue = lot.remainingUnits === 0 ? 0
        : numeric(selectedNav) && validDate(selectedDate) && selectedDate >= lot.date
          ? cents(shares(lot.remainingUnits) * selectedNav) : null;
      const realizedProfit = sum(lot.proceeds, lot.cashDividends, -lot.soldCost);
      const unrealizedProfit = marketValue === null ? null : marketValue - remainingCost;
      const profit = unrealizedProfit === null ? null : sum(realizedProfit, unrealizedProfit);
      output.set(lot.id, {
        kind: 'lot', type: lot.type, cost: money(lot.cost),
        marketValue: marketValue === null ? null : money(marketValue),
        profit: profit === null ? null : money(profit),
        returnRate: profit !== null && lot.cost > 0 ? profit / lot.cost : null,
        realizedProfit: money(realizedProfit),
        unrealizedProfit: unrealizedProfit === null ? null : money(unrealizedProfit),
        remainingShares: shares(lot.remainingUnits), originalShares: shares(lot.originalUnits),
        remainingCost: money(remainingCost), soldCost: money(lot.soldCost),
        proceeds: money(lot.proceeds), cashDividends: money(lot.cashDividends),
        valuationDate: lot.remainingUnits ? selectedDate : lot.closedAt,
        estimated: lot.estimated, closedAt: lot.closedAt,
      });
    } catch { output.set(lot.id, unavailable(lot, 'invalid-input')); }
  }
  return output;
}
