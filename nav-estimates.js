// Public NAV/rate calculations. No account, ledger, storage or network access.
const DAY_MS = 86400000;
const BEIJING_OFFSET = 8 * 60 * 60 * 1000;
const MAX_NAV = Number.MAX_SAFE_INTEGER / 10000;

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
}

const validNav = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_NAV;
const validChange = value => typeof value === 'number' && Number.isFinite(value) && value > -1;

/** Beijing calendar dates, independent of the execution host's timezone. */
export function getEstimateDates(now = new Date()) {
  const stamp = now instanceof Date ? now.getTime()
    : typeof now === 'number' || (typeof now === 'string' && now.trim()) ? new Date(now).getTime() : NaN;
  const todayDate = new Date(stamp + BEIJING_OFFSET);
  const yesterdayDate = new Date(stamp + BEIJING_OFFSET - DAY_MS);
  if (!Number.isFinite(todayDate.getTime()) || !Number.isFinite(yesterdayDate.getTime())) return { today: null, yesterday: null };
  const today = todayDate.toISOString().slice(0, 10);
  const yesterday = yesterdayDate.toISOString().slice(0, 10);
  return validDate(today) && validDate(yesterday) ? { today, yesterday } : { today: null, yesterday: null };
}

/** Parse UI text in percent units: "-1.25%" becomes the ratio -0.0125. */
export function parseEstimatePercent(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*%?$/.test(text)) return null;
  const numericText = text.replace(/\s*%$/, '');
  const percent = Number(numericText);
  // Shift the decimal during parsing rather than dividing an already rounded float.
  const change = Number(`${numericText}e-2`);
  if (!validChange(change) || !Number.isFinite(percent) || (percent !== 0 && change === 0)) return null;
  return change || 0;
}

/**
 * Build one fund's effective NAV points. Entries are { date, change }, with change as a
 * return ratio, not a percent number. `pending` is the sanitized date/rate list
 * to retain in the caller's estimate store; it deliberately contains no NAV.
 * Consumers may use the merged points for the user's current valuation and rules.
 * Historical confirmed transactions and the official NAV source remain unchanged.
 */
export function buildEstimatedNav(history, entries, options = {}) {
  const { now = new Date() } = options && typeof options === 'object' ? options : {};
  const { today, yesterday } = getEstimateDates(now);
  const result = { points: [], pending: [], today, yesterday, latestOfficialDate: null };
  if (!today) return result;

  const officialByDate = new Map();
  for (const point of Array.isArray(history) ? history : []) {
    if (!point || point.estimated === true || !validDate(point.date) || point.date > today || !validNav(point.nav)) continue;
    officialByDate.set(point.date, { date: point.date, nav: point.nav, estimated: false });
  }
  result.points = [...officialByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  result.latestOfficialDate = result.points.at(-1)?.date ?? null;

  const estimatesByDate = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !validDate(entry.date) || entry.date > yesterday || !validChange(entry.change)
      || (result.latestOfficialDate && entry.date <= result.latestOfficialDate)) continue;
    estimatesByDate.set(entry.date, { date: entry.date, change: entry.change || 0 });
  }
  result.pending = [...estimatesByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  let previous = result.points.at(-1);
  for (const entry of result.pending) {
    if (!previous) continue;
    const nav = previous.nav * (1 + entry.change);
    if (!validNav(nav)) continue;
    const point = {
      date: entry.date, nav, estimated: true, change: entry.change,
      baseDate: previous.date, baseEstimated: previous.estimated === true,
    };
    result.points.push(point);
    previous = point;
  }
  return result;
}
