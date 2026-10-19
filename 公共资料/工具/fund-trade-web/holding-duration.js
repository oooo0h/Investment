// Calendar-only display logic. Share values stay in memory and are never returned.
const DAY_MS = 86400000;
const ADDITIONS = new Set(['buy', 'sip', 'transfer-in']);
const TYPES = new Set([...ADDITIONS, 'sell', 'reinvest', 'dividend']);
const finite = value => typeof value === 'number' && Number.isFinite(value);

function dateStamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value ? stamp : null;
}

// Match the ledger's six-decimal share rounding, including decimal half values.
function sharesAtLedgerPrecision(value) {
  const shift = (number, exponent) => {
    const [coefficient, existingExponent = '0'] = String(number).split('e');
    return Number(`${coefficient}e${Number(existingExponent) + exponent}`);
  };
  return Math.sign(value) * shift(Math.round(shift(Math.abs(value), 6)), -6) || 0;
}

function initialShares(after, change) {
  const nearest = sharesAtLedgerPrecision(after - change), matches = new Set();
  // Subtracting a half-microshare from an already rounded row can land on the
  // neighboring grid point. Recover only a unique ledger-consistent balance.
  for (const offset of [-0.000001, 0, 0.000001]) {
    const candidate = sharesAtLedgerPrecision(nearest + offset);
    if (finite(candidate) && candidate >= 0 && sharesAtLedgerPrecision(candidate + change) === after) matches.add(candidate);
  }
  return matches.size === 1 ? [...matches][0] : null;
}

/** Count calendar days in the current continuous holding period, using Beijing today. */
export function calculateHoldingDuration(rows, { now = new Date(), incomplete = false, hasErrors = false } = {}) {
  let estimated = Boolean(incomplete);
  const unavailable = () => ({ status: 'unavailable', days: null, startDate: null, estimated });
  if (hasErrors || !Array.isArray(rows) || !(now instanceof Date) || !Number.isFinite(now.getTime())) return unavailable();
  const beijing = new Date(now.getTime() + 8 * 3600000);
  if (!Number.isFinite(beijing.getTime())) return unavailable();
  const today = beijing.toISOString().slice(0, 10), todayStamp = dateStamp(today);
  if (todayStamp === null) return unavailable();
  let previousShares = null, previousDate = null, startDate = null, closed = false, seen = false;

  for (const row of rows) {
    if (!row || typeof row !== 'object') return unavailable();
    if (row.status === 'pending' || row.status === 'excluded') continue;
    if (row.status !== 'included') return unavailable();
    const stamp = dateStamp(row.date);
    if (stamp === null) return unavailable();
    if (stamp > todayStamp) continue;
    if ((previousDate !== null && row.date < previousDate) || !TYPES.has(row.type)
      || !finite(row.sharesAfter) || !finite(row.shareChange)) return unavailable();
    const after = sharesAtLedgerPrecision(row.sharesAfter);
    const before = previousShares === null ? initialShares(after, row.shareChange) : previousShares;
    if (!finite(after) || !finite(before) || before < 0 || after < 0
      || after !== sharesAtLedgerPrecision(before + row.shareChange)) return unavailable();
    if (ADDITIONS.has(row.type) ? row.shareChange <= 0
      : row.type === 'sell' ? row.shareChange >= 0 || before <= 0
        : row.type === 'reinvest' ? row.shareChange <= 0 || before <= 0
          : row.shareChange !== 0 || before <= 0) return unavailable();

    if (before === 0 && after > 0 && ADDITIONS.has(row.type)) {
      startDate = row.date;
      estimated = Boolean(incomplete) || row.estimated === true;
    } else {
      estimated ||= row.estimated === true;
    }
    if (row.type === 'sell' && after === 0) {
      startDate = null;
      closed = true;
    } else if (after > 0) closed = false;
    previousShares = after;
    previousDate = row.date;
    seen = true;
  }

  if (!seen) return unavailable();
  if (previousShares === 0 && closed) return { status: 'closed', days: null, startDate: null, estimated };
  if (previousShares > 0 && startDate !== null) {
    return { status: 'holding', days: (todayStamp - dateStamp(startDate)) / DAY_MS, startDate, estimated };
  }
  return unavailable();
}

/** A display-axis scale only; its maximum is never an investment target. */
export function createHoldingDurationScale(days, fraction) {
  if (!Number.isSafeInteger(days) || days < 0 || !finite(fraction) || fraction <= 0.6 || fraction >= 1) return null;
  if (days === 0) return { maximum: 1, ratio: 0 };
  const maximum = Math.max(days, Math.floor(days / fraction));
  return { maximum, ratio: days / maximum };
}
