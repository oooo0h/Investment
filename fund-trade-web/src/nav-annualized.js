const DAY_MS = 86400000;
const YEAR_DAYS = 365.2425;

function utcDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
}

function navPoints(history) {
  if (!Array.isArray(history)) return [];
  const dates = new Map();
  for (const point of history) {
    const timestamp = utcDate(point?.date);
    if (timestamp !== null && Number.isFinite(point?.nav) && point.nav > 0) dates.set(timestamp, point.nav);
  }
  return [...dates].sort((left, right) => left[0] - right[0]);
}

function annualizedFromPoints(points) {
  if (points.length < 2) return null;
  const [firstDate, firstNav] = points[0];
  const [lastDate, lastNav] = points.at(-1);
  const anniversary = new Date(firstDate);
  const month = anniversary.getUTCMonth();
  anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 1);
  if (anniversary.getUTCMonth() !== month) anniversary.setUTCDate(0);
  if (lastDate < anniversary.getTime()) return null;
  const days = (lastDate - firstDate) / DAY_MS;
  const annualized = Math.expm1((Math.log(lastNav) - Math.log(firstNav)) * YEAR_DAYS / days);
  return Number.isFinite(annualized) ? annualized : null;
}

export function calculateNavAnnualized(history) {
  return annualizedFromPoints(navPoints(history));
}

export function evaluateAnnualDiscipline(history, { rule = null, now = new Date(), annualizedHistory = null } = {}) {
  const text = ['annual-profit', 'annual-profit-100', 'annual-profit-multiple'].includes(rule?.id)
    ? `${typeof rule.title === 'string' ? rule.title : ''}${typeof rule.detail === 'string' ? rule.detail : ''}`.replace(/\s+/g, '').replaceAll('％', '%') : '';
  const parsedMultiple = Number(/平均年化收益率的(\d+(?:\.\d+)?)倍/.exec(text)?.[1]);
  const parsedAbsolute = Number(/达到(?:了)?(\d+(?:\.\d+)?)%/.exec(text)?.[1]);
  const multiple = Number.isFinite(parsedMultiple) && parsedMultiple > 0 ? parsedMultiple : null;
  const absoluteThreshold = Number.isFinite(parsedAbsolute) && parsedAbsolute > 0 ? parsedAbsolute / 100 : null;
  const timestamp = new Date(now).getTime();
  const shifted = new Date(timestamp + 8 * 60 * 60 * 1000);
  const year = Number.isFinite(shifted.getTime()) ? shifted.getUTCFullYear() : null;
  const points = navPoints(history);
  const result = { triggered: false, year, asOf: null, baselineDate: null, yearReturn: null, annualized: null, multiple, absoluteThreshold };
  if (year === null) return result;
  const today = utcDate(shifted.toISOString().slice(0, 10));
  const published = points.filter(([stamp]) => stamp <= today);
  const annualizedPoints = annualizedHistory === null
    ? published
    : navPoints(annualizedHistory).filter(([stamp]) => stamp <= today);
  result.annualized = annualizedFromPoints(annualizedPoints);
  const yearStart = utcDate(`${year}-01-01`);
  const previousYearStart = utcDate(`${year - 1}-01-01`);
  if (yearStart === null || previousYearStart === null) return result;
  const current = published.filter(([stamp]) => stamp >= yearStart);
  if (!current.length) return result;
  result.asOf = new Date(current.at(-1)[0]).toISOString().slice(0, 10);
  // An earlier calendar year's coverage prevents a truncated midyear first row
  // from being presented as the first NAV observation of this year.
  if (!published.some(([stamp]) => stamp >= previousYearStart && stamp < yearStart)) return result;
  result.baselineDate = new Date(current[0][0]).toISOString().slice(0, 10);
  const yearReturn = current.at(-1)[1] / current[0][1] - 1;
  if (!Number.isFinite(yearReturn)) return result;
  result.yearReturn = yearReturn;
  const relativeThreshold = multiple !== null && result.annualized !== null ? result.annualized * multiple : null;
  // Equality must not trigger because logarithmic CAGR introduced a few machine ulps.
  const aboveRelative = relativeThreshold !== null && yearReturn - relativeThreshold >
    Number.EPSILON * Math.max(1, Math.abs(yearReturn), Math.abs(relativeThreshold)) * 4;
  result.triggered = yearReturn > 0 && (
    aboveRelative ||
    (absoluteThreshold !== null && yearReturn >= absoluteThreshold)
  );
  return result;
}

export function evaluateAddDiscipline(history, { rule = null, tradePoint = null, now = new Date(), annualizedHistory = null } = {}) {
  const text = rule?.id === 'add-discipline-decline'
    ? `${typeof rule.title === 'string' ? rule.title : ''}${typeof rule.detail === 'string' ? rule.detail : ''}`.replace(/\s+/g, '') : '';
  const parsedMultiple = Number(/平均年化收益率的?(\d+(?:\.\d+)?)倍/.exec(text)?.[1]);
  const multiple = Number.isFinite(parsedMultiple) && parsedMultiple > 0 ? parsedMultiple : null;
  const result = { triggered: false, asOf: null, baselineDate: null, decline: null, annualized: null, multiple, estimated: tradePoint?.estimated === true };
  const shifted = new Date(new Date(now).getTime() + 8 * 60 * 60 * 1000);
  if (!Number.isFinite(shifted.getTime())) return result;
  const today = utcDate(shifted.toISOString().slice(0, 10));
  const published = navPoints(history).filter(([stamp]) => stamp <= today);
  const annualizedPoints = annualizedHistory === null
    ? published
    : navPoints(annualizedHistory).filter(([stamp]) => stamp <= today);
  result.annualized = annualizedFromPoints(annualizedPoints);
  if (!published.length) return result;
  const [latestDate, latestNav] = published.at(-1);
  result.asOf = new Date(latestDate).toISOString().slice(0, 10);
  const baseline = utcDate(tradePoint?.date);
  if (baseline === null || !Number.isFinite(tradePoint?.nav) || tradePoint.nav <= 0 || baseline > today) return result;
  result.baselineDate = tradePoint.date;
  if (latestDate < baseline) return result;
  const decline = 1 - latestNav / tradePoint.nav;
  if (!Number.isFinite(decline)) return result;
  result.decline = decline;
  if (multiple === null || result.annualized === null || result.annualized <= 0) return result;
  const threshold = result.annualized * multiple;
  // A mathematical equality must remain false despite logarithmic CAGR rounding.
  result.triggered = Number.isFinite(threshold) && decline - threshold >
    Number.EPSILON * Math.max(1, Math.abs(decline), Math.abs(threshold)) * 4;
  return result;
}

// Select a nearby discipline using the displayed return's direction. The gap is
// a difference between return rates (percentage points), not a new price target.
// Signals retain their existing operation/year baselines and include estimates.
export function getNavDisciplineGap(change, { addSignal = null, profitSignals = [] } = {}) {
  if (!Number.isFinite(change) || change === 0) return null;
  const kind = change < 0 ? 'add' : 'profit';
  const candidates = [];
  const consider = (signal, threshold, current) => {
    if (!Number.isFinite(threshold) || !Number.isFinite(current)) return;
    const remaining = Math.max(0, threshold - current);
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(threshold), Math.abs(current)) * 4;
    if (remaining - 0.05 > tolerance) return;
    candidates.push({ kind, remaining: remaining <= tolerance ? 0 : remaining, triggered: signal.triggered === true });
  };
  if (kind === 'add') {
    if (addSignal?.annualized > 0 && addSignal?.multiple > 0) {
      consider(addSignal, addSignal.annualized * addSignal.multiple, addSignal.decline);
    }
  } else {
    for (const signal of Array.isArray(profitSignals) ? profitSignals : []) {
      if (!signal || !Number.isFinite(signal.yearReturn)) continue;
      if (Number.isFinite(signal.absoluteThreshold) && signal.absoluteThreshold > 0) {
        consider(signal, signal.absoluteThreshold, signal.yearReturn);
      }
      if (Number.isFinite(signal.annualized) && signal.multiple > 0) {
        // Existing profit rules also require a positive year return, even when
        // the historical annualized multiple is zero or negative.
        consider(signal, Math.max(0, signal.annualized * signal.multiple), signal.yearReturn);
      }
    }
  }
  return candidates.sort((left, right) => Number(right.triggered) - Number(left.triggered) || left.remaining - right.remaining)[0] || null;
}
