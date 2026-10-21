// Shared Beijing trading calendar for the local registration form and server.
// The 2026 closures follow the Shanghai Stock Exchange holiday notice; the
// calendar deliberately refuses years it has not verified instead of guessing.
export const TRADING_DAY = 86400000;
// https://www.sse.com.cn/disclosure/dealinstruc/closed/c/c_20251222_10802510.shtml
const CLOSURES_2026 = [['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'], ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07']];

export function isLocalTradingDay(date) {
  const stamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== date) throw new Error('Trading calendar unavailable.');
  if (!date.startsWith('2026-') && date !== '2025-12-31') throw new Error('Trading calendar unavailable.');
  if ([0, 6].includes(new Date(stamp).getUTCDay())) return false;
  return !date.startsWith('2026-') || !CLOSURES_2026.some(([from, to]) => date.slice(5) >= from && date.slice(5) <= to);
}

const iso = stamp => new Date(stamp).toISOString().slice(0, 10);

// After the 15:00 cutoff, or on a non-trading order day, the NAV date rolls to
// the next trading day. The order date itself is kept separately by the caller.
export function navDateForOrder(orderDate, cutoff = 'before') {
  const stamp = Date.parse(`${orderDate}T00:00:00Z`);
  if (!Number.isFinite(stamp) || iso(stamp) !== orderDate) throw new Error('Trading calendar unavailable.');
  let day = stamp;
  if (cutoff === 'after' || !isLocalTradingDay(orderDate)) day += TRADING_DAY;
  for (let attempt = 0; attempt < 370; attempt++, day += TRADING_DAY) {
    const date = iso(day);
    try { if (isLocalTradingDay(date)) return date; } catch { throw new Error('Trading calendar unavailable.'); }
  }
  throw new Error('Trading calendar unavailable.');
}
