// Calendar ranges use the latest published NAV date, not the device clock.
export const NAV_PERIODS = [
  { id: 'recent-decline', label: '最近下跌' },
  { id: 'recent-rise', label: '最近上涨' },
  { id: 'since-trade', label: '自交易以来' },
  { id: '1m', label: '最近1个月', months: 1 },
  { id: 'last-month', label: '上个月' },
  { id: '3m', label: '最近3个月', months: 3 },
  { id: '6m', label: '最近半年', months: 6 },
  { id: '1y', label: '最近1年', months: 12 },
  { id: '3y', label: '最近3年', months: 36 },
  { id: 'all', label: '成立以来' },
];

const iso = date => date.toISOString().slice(0, 10);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function monthsBefore(value, months) {
  const [year, month, day] = value.split('-').map(Number);
  const last = new Date(Date.UTC(year, month - months, 0)).getUTCDate();
  return iso(new Date(Date.UTC(year, month - 1 - months, Math.min(day, last))));
}

function recentMoveStart(history, rising) {
  const end = history.length - 1;
  const latestNav = history[end].nav;
  const beyond = (value, extreme) => rising ? value > extreme : value < extreme;
  for (let right = end; right >= 0;) {
    let left = right;
    const extreme = history[right].nav;
    while (left > 0 && history[left - 1].nav === extreme) left -= 1;
    // Confirm a turn on both sides; the first observed plateau is a boundary turn.
    if (right < end && beyond(history[right + 1].nav, extreme) &&
        (left === 0 || beyond(history[left - 1].nav, extreme))) {
      // A newer same-kind turn supersedes older ones even when it is no longer valid.
      return beyond(latestNav, extreme) ? right : null;
    }
    right = left - 1;
  }
  return null;
}

export function recentNavPeriod(history) {
  if (!history.length) return null;
  const decline = recentMoveStart(history, false), rise = recentMoveStart(history, true);
  if (decline === null && rise === null) return null;
  const id = decline !== null && (rise === null || decline > rise) ? 'recent-decline' : 'recent-rise';
  return NAV_PERIODS.find(period => period.id === id);
}

export function resolveNavRange(history, selection, { tradeDate = null } = {}) {
  if (!history.length) return {
    start: 0, end: 0, from: null, to: null, points: [], preset: selection ? selection.preset ?? null : '3m',
    declineAvailable: false, riseAvailable: false, tradeAvailable: false,
  };
  const declineStart = recentMoveStart(history, false);
  const riseStart = recentMoveStart(history, true);
  const tradeStamp = typeof tradeDate === 'string' ? Date.parse(`${tradeDate}T00:00:00Z`) : NaN;
  const tradeStart = Number.isFinite(tradeStamp) && iso(new Date(tradeStamp)) === tradeDate
    ? history.findIndex(point => point.date >= tradeDate) : -1;
  const availability = { declineAvailable: declineStart !== null, riseAvailable: riseStart !== null, tradeAvailable: tradeStart >= 0 };
  selection ||= { preset: recentNavPeriod(history)?.id || '3m' };
  if (selection.preset === 'since-trade') {
    const end = history.length - 1;
    const start = tradeStart >= 0 ? tradeStart : end;
    return { start, end, from: history[start].date, to: history[end].date, points: history.slice(start), preset: 'since-trade', ...availability };
  }
  if (selection.preset === 'recent-decline' || selection.preset === 'recent-rise') {
    const end = history.length - 1;
    const start = (selection.preset === 'recent-rise' ? riseStart : declineStart) ?? end;
    return {
      start, end, from: history[start].date, to: history[end].date,
      points: history.slice(start), preset: selection.preset, ...availability,
    };
  }
  const first = history[0].date;
  const latest = history.at(-1).date;
  const period = NAV_PERIODS.find(item => item.id === selection.preset);
  let from = selection.from || first;
  let to = selection.to || latest;
  if (period) {
    to = latest;
    if (period.id === 'all') from = first;
    else if (period.id === 'last-month') {
      const [year, month] = latest.split('-').map(Number);
      from = iso(new Date(Date.UTC(year, month - 2, 1)));
      to = iso(new Date(Date.UTC(year, month - 1, 0)));
    } else from = monthsBefore(latest, period.months);
  }
  const firstIndex = history.findIndex(point => point.date >= from);
  const startIndex = firstIndex < 0 ? history.length : firstIndex;
  let endIndex = history.length - 1;
  while (endIndex >= 0 && history[endIndex].date > to) endIndex -= 1;
  const points = startIndex <= endIndex ? history.slice(startIndex, endIndex + 1) : [];
  const start = clamp(startIndex, 0, history.length - 1);
  const end = clamp(endIndex, start, history.length - 1);
  return { start, end, from: points[0]?.date || from, to: points.at(-1)?.date || to, points, preset: period?.id ?? null, ...availability };
}

export function moveNavBoundary(history, selection, boundary, value, context) {
  if (!history.length) return selection;
  const range = resolveNavRange(history, selection, context);
  const index = clamp(Math.round(Number(value) || 0), 0, history.length - 1);
  const start = boundary === 'start' ? Math.min(index, range.end) : range.start;
  const end = boundary === 'end' ? Math.max(index, range.start) : range.end;
  return { from: history[start].date, to: history[end].date };
}

export function resolveNavSliderDomain(history, range, previous = null, { phase = 'initial', boundary = null } = {}) {
  const max = Math.max(0, history.length - 1);
  if (history.length < 2) return { min: 0, max, from: history[0]?.date ?? null, to: history[0]?.date ?? null };
  const start = clamp(Math.round(Number(range?.start) || 0), 0, max);
  const endValue = Number(range?.end);
  const end = clamp(Number.isFinite(endValue) ? Math.round(endValue) : max, start, max);
  // Three selected spans, with at least twelve observations, leave recent dates usable.
  const initialMin = Math.max(0, Math.min(start, max - Math.max(11, (end - start) * 3)));
  let min = initialMin;
  if (typeof previous?.from === 'string' && typeof previous?.to === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(previous.from) && /^\d{4}-\d{2}-\d{2}$/.test(previous.to) &&
      previous.from <= previous.to && previous.to >= history[0].date && previous.from <= history[max].date) {
    const index = history.findIndex(point => point.date >= previous.from);
    if (index >= 0) min = Math.min(index, start);
  }
  const position = (start - min) / Math.max(1, max - min);
  if (phase === 'drag' && boundary === 'start' && position <= 0.12) {
    min = Math.max(0, min - Math.max(6, Math.ceil((max - min) * 0.5)));
  } else if (phase === 'commit' && boundary === 'start' && position >= 0.35) {
    min = Math.max(min, initialMin);
  }
  return { min, max, from: history[min].date, to: history[max].date };
}

export function summarizeNavRange(points) {
  const empty = { startDate: null, endDate: null, startNav: null, endNav: null, change: null };
  if (!Array.isArray(points) || !points.length || points.some(point => !point || !Number.isFinite(point.nav) || point.nav <= 0)) return empty;
  const first = points[0], last = points.at(-1);
  const change = last.nav / first.nav - 1;
  if (!Number.isFinite(change)) return empty;
  return { startDate: first.date, endDate: last.date, startNav: first.nav, endNav: last.nav, change };
}
