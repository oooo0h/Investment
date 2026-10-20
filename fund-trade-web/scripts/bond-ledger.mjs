// Pure in-memory calculations from completed workbook rows, with no inferred
// fees, shares, opening balance, or confirmation date.
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const money = value => Math.round((value + Number.EPSILON) * 100) / 100;

export function calculateBondWorkbook(code, rows, quote) {
  if (!['006485', '006663'].includes(code) || !Array.isArray(rows) || !rows.length || !day(quote?.date) || !positive(quote?.nav)) return null;
  const lots = [];
  const active = rows.filter(row => row && !['pending', 'cancelled', 'canceled', 'failed', 'closed'].includes(row.status) && !['processing', 'draft'].includes(row.sourceStatus));
  if (active.some(row => !day(row.date))) return null;
  for (const row of active.sort((a, b) => a.date.localeCompare(b.date))) {
    if (!['confirmed', 'estimated'].includes(row.status) || !day(row.date) || row.date > quote.date
      || !positive(row.shares) || !positive(row.nav) || !positive(row.amount)
      || !Number.isFinite(row.fee) || row.fee < 0 || !['buy', 'sell'].includes(row.type)) return null;
    if (row.type === 'buy') {
      lots.push({ shares: row.shares, cost: row.amount, orderDate: row.date,
        ...(day(row.confirmedDate) ? { confirmedDate: row.confirmedDate } : {}) });
    } else {
      let left = row.shares;
      for (const lot of lots) {
        const take = Math.min(left, lot.shares);
        if (take <= 0) continue;
        const fraction = take / lot.shares;
        lot.cost *= 1 - fraction; lot.shares -= take; left -= take;
        if (left <= 1e-7) break;
      }
      if (left > 1e-7) return null;
    }
  }
  const remaining = lots.filter(lot => lot.shares > 1e-7);
  const shares = remaining.reduce((sum, lot) => sum + lot.shares, 0);
  const cost = remaining.reduce((sum, lot) => sum + lot.cost, 0);
  if (!positive(shares) || !positive(cost)) return null;
  const marketValue = money(shares * quote.nav), holdingProfit = money(marketValue - cost);
  if (![marketValue, holdingProfit].every(Number.isFinite) || marketValue - holdingProfit <= 0) return null;
  return { entry: { code, marketValue, holdingProfit }, valuationDate: quote.date,
    holdingLots: { complete: false, basis: 'calculated', lots: remaining.map(lot => ({
      ...(lot.confirmedDate ? { confirmedDate: lot.confirmedDate } : { orderDate: lot.orderDate }),
      remainingShares: lot.shares, status: 'confirmed',
    })) } };
}
