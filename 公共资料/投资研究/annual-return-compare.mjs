const funds = [
  { code: "005698", name: "华夏全球科技先锋混合(QDII)A" },
  { code: "270023", name: "广发全球精选股票(QDII)A" },
];

function extractVar(text, varName) {
  const marker = `var ${varName} = `;
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const valueStart = start + marker.length;
  const first = text[valueStart];
  if (first === "[" || first === "{") {
    const open = first;
    const close = first === "[" ? "]" : "}";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = valueStart; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) return text.slice(valueStart, i + 1).trim();
      }
    }
  }
  const end = text.indexOf(";", valueStart);
  return text.slice(valueStart, end < 0 ? undefined : end).trim();
}

function yearlyReturnsFromTrend(trend) {
  const byYear = new Map();
  for (const [ts, value] of trend) {
    const year = new Date(ts).getUTCFullYear();
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push({ ts, value: Number(value) });
  }
  const lastByYear = new Map();
  const firstByYear = new Map();
  for (const [year, rows] of byYear) {
    rows.sort((a, b) => a.ts - b.ts);
    firstByYear.set(year, rows[0].value);
    lastByYear.set(year, rows[rows.length - 1].value);
  }
  const out = new Map();
  for (const year of Array.from(lastByYear.keys()).sort((a, b) => a - b)) {
    const last = lastByYear.get(year);
    const prev = lastByYear.get(year - 1);
    const base = prev || firstByYear.get(year);
    if (base > 0) out.set(year, (last / base - 1) * 100);
  }
  return out;
}

async function fundAnnualReturns(code) {
  const text = await fetch(`https://fund.eastmoney.com/pingzhongdata/${code}.js`).then((r) => r.text());
  const raw = extractVar(text, "Data_ACWorthTrend") || extractVar(text, "Data_netWorthTrend");
  if (!raw) throw new Error(`No NAV trend found for ${code}`);
  const trend = JSON.parse(raw.replace(/'/g, '"'));
  return yearlyReturnsFromTrend(trend);
}

async function nasdaq100AnnualReturns() {
  const url =
    "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=100.NDX&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&beg=19960101&end=20260710";
  const json = await fetch(url).then((r) => r.json());
  const rows = (json.data?.klines || [])
    .map((line) => {
      const [date, open, close] = line.split(",");
      return { date, close: Number(close) };
    })
    .filter((row) => row.date && Number.isFinite(row.close));
  const byYear = new Map();
  for (const row of rows) {
    const year = Number(row.date.slice(0, 4));
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(row);
  }
  const out = new Map();
  for (const [year, items] of byYear) {
    items.sort((a, b) => a.date.localeCompare(b.date));
    const first = items[0].close;
    const last = items[items.length - 1].close;
    out.set(year, (last / first - 1) * 100);
  }
  return out;
}

function fmt(value) {
  if (value == null || !Number.isFinite(value)) return "";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function stats(values) {
  let up = 0;
  let down = 0;
  let flat = 0;
  for (const value of values) {
    if (value > 0) up += 1;
    else if (value < 0) down += 1;
    else flat += 1;
  }
  return { up, down, flat, count: values.length };
}

function normalizedValues(rows, key) {
  let value = 1;
  const out = new Map();
  for (const row of rows) {
    const annualReturn = row[key];
    if (annualReturn == null || !Number.isFinite(annualReturn)) continue;
    value *= 1 + annualReturn / 100;
    out.set(row.year, value);
  }
  return out;
}

const [huaxia, guangfa, ndx] = await Promise.all([
  fundAnnualReturns("005698"),
  fundAnnualReturns("270023"),
  nasdaq100AnnualReturns(),
]);

const currentYear = 2026;
const startYear = currentYear - 29;
const years = Array.from({ length: 30 }, (_, i) => startYear + i);
const table = years.map((year) => ({
  year,
  huaxia: huaxia.get(year),
  guangfa: guangfa.get(year),
  ndx: ndx.get(year),
}));
const normalized = {
  huaxia: normalizedValues(table, "huaxia"),
  guangfa: normalizedValues(table, "guangfa"),
  ndx: normalizedValues(table, "ndx"),
};

const result = {
  generated_at: new Date().toISOString(),
  note: "Annual returns use previous year-end value to current year-end value. First available fund year is partial since inception. 2026 is YTD. Fund data uses Eastmoney accumulated NAV trend where available; Nasdaq-100 uses Eastmoney daily NDX close.",
  rows: table.map((row) => ({
    year: row.year,
    huaxia_005698: fmt(row.huaxia),
    huaxia_normalized_nav: normalized.huaxia.get(row.year)?.toFixed(4) || "",
    guangfa_270023: fmt(row.guangfa),
    guangfa_normalized_nav: normalized.guangfa.get(row.year)?.toFixed(4) || "",
    nasdaq_100_ndx: fmt(row.ndx),
    nasdaq_100_normalized_nav: normalized.ndx.get(row.year)?.toFixed(4) || "",
  })),
  stats: {
    huaxia_005698: stats(table.map((r) => r.huaxia).filter((v) => v != null)),
    guangfa_270023: stats(table.map((r) => r.guangfa).filter((v) => v != null)),
    nasdaq_100_ndx: stats(table.map((r) => r.ndx).filter((v) => v != null)),
  },
};

console.log(JSON.stringify(result, null, 2));
