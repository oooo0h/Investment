const funds = [
  ["005698", "华夏QDII"],
  ["270023", "广发QDII"],
  ["009608", "中证500增强"],
  ["000216", "黄金联接"],
  ["015789", "高端装备"],
  ["018124", "先进制造"],
];

function extractVar(text, varName) {
  const marker = `var ${varName} = `;
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const valueStart = start + marker.length;
  const open = text[valueStart];
  const close = open === "[" ? "]" : "}";
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
    else if (ch === close && --depth === 0) return text.slice(valueStart, i + 1);
  }
  return null;
}

async function loadFund(code) {
  const text = await fetch(`https://fund.eastmoney.com/pingzhongdata/${code}.js`).then((r) => r.text());
  const raw = extractVar(text, "Data_ACWorthTrend") || extractVar(text, "Data_netWorthTrend");
  if (!raw) throw new Error(`No NAV for ${code}`);
  return JSON.parse(raw.replace(/'/g, '"'))
    .map((row) => ({ date: new Date(row[0]).toISOString().slice(0, 10), nav: Number(row[1]) }))
    .filter((row) => Number.isFinite(row.nav))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function valueOnOrBefore(rows, date) {
  let found = null;
  for (const row of rows) {
    if (row.date > date) break;
    found = row;
  }
  return found;
}

function buyAndHold(series, weights, dates) {
  const start = dates[0];
  const units = {};
  for (const [code, weight] of Object.entries(weights)) {
    units[code] = weight / valueOnOrBefore(series[code], start).nav;
  }
  const values = dates.map((date) => {
    let value = 0;
    const endpoints = {};
    for (const code of Object.keys(weights)) {
      const point = valueOnOrBefore(series[code], date);
      endpoints[code] = point;
      value += units[code] * point.nav;
    }
    return { date, value, endpoints };
  });
  return values.map((row, index) => ({
    ...row,
    monthlyReturn: index === 0 ? null : (row.value / values[index - 1].value - 1) * 100,
    cumulativeReturn: (row.value / values[0].value - 1) * 100,
  }));
}

const entries = await Promise.all(funds.map(async ([code, name]) => [code, name, await loadFund(code)]));
const series = Object.fromEntries(entries.map(([code, , rows]) => [code, rows]));
const dates = ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30"];

const sleeve7030 = buyAndHold(series, { "009608": 0.7, "000216": 0.3 }, dates);

// Approximate whole-portfolio weights after the proposed new-money allocation,
// derived from the latest recorded structure. Output is percentage-only.
const wholeApprox = buyAndHold(series, {
  "005698": 0.198,
  "270023": 0.488,
  "009608": 0.209,
  "000216": 0.095,
  "015789": 0.004,
  "018124": 0.006,
}, dates);

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), dates, sleeve7030, wholeApprox }, null, 2));
