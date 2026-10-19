import { summarizeNavRange } from './nav-range.js';

// Chart presentation only: inputs and outputs contain public dates, NAVs and rates.
const validDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
};
const validNav = value => typeof value === 'number' && Number.isFinite(value)
  && value > 0 && value <= Number.MAX_SAFE_INTEGER / 10000;
const byDate = (left, right) => left.date.localeCompare(right.date);

/**
 * range.points is the selected official series, not the full fund history.
 * estimatedData is buildEstimatedNav()'s existing result. No clock or storage is
 * read here. The chart and its headline must consume this same display result.
 */
export function getNavChartDisplay(range, estimatedData) {
  const official = new Map();
  for (const point of !range?.unavailable && Array.isArray(range?.points) ? range.points : []) {
    if (point && validDate(point.date) && validNav(point.nav)) official.set(point.date, { date: point.date, nav: point.nav });
  }
  const points = [...official.values()].sort(byDate);
  const first = points[0]?.date;
  const last = points.at(-1)?.date;
  const live = Boolean(points.length && !range?.unavailable
    && last === estimatedData?.latestOfficialDate && range?.preset !== 'last-month');
  const domainEnd = live && validDate(estimatedData?.today) ? estimatedData.today : null;
  // renderNavChart extends only forward; invalid or earlier domain ends do not
  // make future estimates visible beyond the selected official endpoint.
  const visibleEnd = domainEnd && domainEnd > last ? domainEnd : last;
  const estimates = new Map();
  if (live) for (const point of Array.isArray(estimatedData?.points) ? estimatedData.points : []) {
    if (!point || point.estimated !== true || !validDate(point.date) || !validNav(point.nav)
      || point.date < first || point.date > visibleEnd || official.has(point.date)) continue;
    const change = typeof point.change === 'number' && Number.isFinite(point.change * 100) ? point.change : null;
    estimates.set(point.date, { date: point.date, nav: point.nav, estimated: true, ...(change !== null ? { change } : {}) });
  }
  const estimatedPoints = [...estimates.values()].sort(byDate);
  const summary = summarizeNavRange([...points, ...estimatedPoints].sort(byDate));
  return { points, estimatedPoints, domainEnd, summary };
}
