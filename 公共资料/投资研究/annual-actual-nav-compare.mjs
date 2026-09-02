function extractVar(text, varName) {
  const marker = `var ${varName} = `;
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const valueStart = start + marker.length;
  const first = text[valueStart];
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
    else if (ch === first) depth += 1;
    else if (ch === close && --depth === 0) return text.slice(valueStart, i + 1);
  }
  return null;
}

function lastByYear(rows, getDate, getValue) {
  const map = new Map();
  for (const row of rows) {
    const date = getDate(row);
    const value = Number(getValue(row));
    if (!date || !Number.isFinite(value)) continue;
    const year = Number(date.slice(0, 4));
    const previous = map.get(year);
    if (!previous || date > previous.date) map.set(year, { date, value });
  }
  return map;
}

async function fundYearEnds(code) {
  const text = await fetch(`https://fund.eastmoney.com/pingzhongdata/${code}.js`).then((r) => r.text());
  const raw = extractVar(text, "Data_ACWorthTrend");
  if (!raw) throw new Error(`No accumulated NAV trend for ${code}`);
  const rows = JSON.parse(raw.replace(/'/g, '"'));
  return lastByYear(
    rows,
    (row) => new Date(row[0]).toISOString().slice(0, 10),
    (row) => row[1],
  );
}

async function ndxYearEnds() {
  const url = "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=100.NDX&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&beg=19960101&end=20260710";
  const json = await fetch(url).then((r) => r.json());
  const rows = (json.data?.klines || []).map((line) => {
    const [date, , close] = line.split(",");
    return { date, close: Number(close) };
  });
  return lastByYear(rows, (row) => row.date, (row) => row.close);
}

const [huaxia, guangfa, ndx] = await Promise.all([
  fundYearEnds("005698"),
  fundYearEnds("270023"),
  ndxYearEnds(),
]);

function annualReturn(series, year, firstBase = null) {
  const current = series.get(year)?.value;
  if (!Number.isFinite(current)) return null;
  const previous = series.get(year - 1)?.value;
  const base = Number.isFinite(previous) ? previous : firstBase;
  return Number.isFinite(base) ? (current / base - 1) * 100 : null;
}

const output = [];
for (let year = 1997; year <= 2026; year += 1) {
  output.push({
    year,
    huaxia: huaxia.get(year) ? { ...huaxia.get(year), return: annualReturn(huaxia, year, 1) } : null,
    guangfa: guangfa.get(year) ? { ...guangfa.get(year), return: annualReturn(guangfa, year, 1) } : null,
    ndx: ndx.get(year) ? { ...ndx.get(year), return: annualReturn(ndx, year) } : null,
  });
}
console.log(JSON.stringify(output, null, 2));
