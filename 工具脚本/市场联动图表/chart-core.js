(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChartCore = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const keys = ['market', 'bank', 'tech', 'financing'];
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  function bounds(values, percentage = false) {
    const valid = values.filter(finite);
    if (!valid.length) return { min: 0, max: 1, interval: 0.2, hasData: false };
    const min = Math.min(...valid), max = Math.max(...valid);
    const span = max - min;
    const pad = span > 0 ? span * 0.04 : Math.max(Math.abs(min) * 0.035, percentage ? 0.1 : 1);
    const low = min - pad, high = max + pad;
    const rough = (high - low) / 5;
    const power = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 2.5, 5, 10].find(n => n * power >= rough) * power;
    return { min: Number((Math.floor(low / step) * step).toPrecision(12)), max: Number((Math.ceil(high / step) * step).toPrecision(12)), interval: step, hasData: true };
  }
  function normalize(rows, mode = 'return') {
    const base = rows.find(row => ['market', 'bank', 'tech'].every(k => finite(row[k]) && row[k] > 0));
    const values = Object.fromEntries(keys.map(key => [key, rows.map(row => {
      if (!finite(row[key])) return null;
      return key === 'financing' || mode === 'points' ? row[key] : base ? (row[key] / base[key] - 1) * 100 : null;
    })]));
    return { values, baseDate: base?.date ?? null };
  }
  function rangeForDates(rows, start, end) {
    if (!rows.length || start > end) return null;
    const first = rows.findIndex(row => row.date >= start);
    const last = rows.findLastIndex(row => row.date <= end);
    return first >= 0 && last >= first ? [first, last] : null;
  }
  function scaleForVisible(values, selected, start, end, mode = 'return') {
    const left = ['market', 'bank', 'tech'].filter(k => selected[k]).flatMap(k => values[k].slice(start, end + 1));
    const right = selected.financing ? values.financing.slice(start, end + 1) : [];
    return { left: bounds(left, mode === 'return'), right: bounds(right, true) };
  }
  return { keys, finite, bounds, normalize, rangeForDates, scaleForVisible };
});
