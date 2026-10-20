const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, 'data/raw', name), 'utf8').replace(/^\uFEFF/, '');
function turnoverData(symbol) {
  const payload = JSON.parse(read(`turnover-${symbol}.json`))[0];
  assert(payload?.status === 0 && payload.hq?.length > 400, `Incomplete turnover data: ${symbol}`);
  // Sohu historical table column 8 is daily turnover in CNY 10,000 (万元).
  return new Map(payload.hq.map(row => [row[0], row[8] !== '' && row[8] !== '-' ? Number(row[8]) * 10000 : null]));
}
const sh = turnoverData('000002');
const sz = turnoverData('399107');
const marginResponse = JSON.parse(read('margin.json'));
assert(marginResponse.success && marginResponse.result.pages >= 1, 'Invalid financing response');
const marginRecords = [...marginResponse.result.data];
for (let page = 2; page <= marginResponse.result.pages; page++) {
  const payload = JSON.parse(read(`margin-page-${page}.json`));
  assert(payload.success && Array.isArray(payload.result?.data), `Invalid financing page ${page}`);
  marginRecords.push(...payload.result.data);
}
const margin = new Map(marginRecords.map(row => [row.DIM_DATE.slice(0, 10), row]));
assert(margin.size === marginResponse.result.count, 'Financing pagination has gaps or duplicate dates');
const indices = {};
for (const [key, symbol] of Object.entries({ market: 'sh000300', bank: 'sz399986', tech: 'sh000993' })) {
  const payload = JSON.parse(read(`${symbol}.json`));
  const records = payload.data?.[symbol]?.day;
  assert(payload.code === 0 && Array.isArray(records) && records.length > 400, `Incomplete index: ${symbol}`);
  indices[key] = new Map(records.map(row => [row[0], Number(row[2])]));
}
const now = new Date();
const china = new Date(now.getTime() + 8 * 3600000);
const today = china.toISOString().slice(0, 10);
const includeToday = china.getUTCHours() >= 16;
const dates = [...new Set(Object.values(indices).flatMap(m => [...m.keys()]))]
  .filter(date => date >= '2024-01-01' && (date < today || (date === today && includeToday))).sort();
const rows = dates.map(date => {
  const m = margin.get(date);
  const shAmount = sh.get(date), szAmount = sz.get(date);
  // Both numerator and denominator cover Shanghai/Shenzhen A shares only.
  // TOTAL_RZMRE includes Beijing and must not be mixed into this denominator.
  const financingBuy = m && Number.isFinite(m.H_RZMRE) && Number.isFinite(m.S_RZMRE) ? m.H_RZMRE + m.S_RZMRE : null;
  const turnover = Number.isFinite(shAmount) && Number.isFinite(szAmount) && shAmount > 0 && szAmount > 0 ? shAmount + szAmount : null;
  const financing = financingBuy !== null && turnover !== null ? financingBuy / turnover * 100 : null;
  assert(financing === null || (financing >= 0 && financing <= 100), `Invalid financing percentage on ${date}`);
  return { date, market: indices.market.get(date) ?? null, bank: indices.bank.get(date) ?? null,
    tech: indices.tech.get(date) ?? null, financing, financingBuy, turnover };
});
assert(rows.length > 400 && rows[0].date === '2024-01-02', 'Missing 2024 history');
assert(rows.filter(r => r.financing !== null).length > rows.length * 0.9, 'Insufficient matched financing and turnover dates');
const result = {
  meta: {
    fetchedAt: now.toISOString(), requestedStart: '2024-01-01', requestedEnd: today,
    firstDate: rows[0].date, lastDate: rows.at(-1).date,
    financingLastDate: rows.findLast(row => row.financing !== null)?.date,
    scope: '沪深A股（不含北交所）',
    formula: '（沪市融资买入额 + 深市融资买入额）÷（上证A股成交额 + 深证A股成交额）× 100%',
    missingFinancingDays: rows.filter(row => row.financing === null).length,
    sources: [
      { name: '指数日线 · 腾讯财经', url: 'https://gu.qq.com/sh000300/zs', fields: '沪深300 / 中证银行 / 中证全指信息技术，日收盘点位' },
      { name: '融资买入额 · 东方财富', url: 'https://data.eastmoney.com/rzrq/', fields: 'RPTA_RZRQ_LSDB：H_RZMRE + S_RZMRE，单位元' },
      { name: '沪市成交额 · 搜狐证券', url: 'https://q.stock.sohu.com/zs/000002/lshq.shtml', fields: '上证A股（000002）历史成交金额（万元），乘10,000换算为元' },
      { name: '深市成交额 · 搜狐证券', url: 'https://q.stock.sohu.com/zs/399107/lshq.shtml', fields: '深证A股（399107）历史成交金额（万元），乘10,000换算为元' }
    ]
  }, rows
};
// Publish only after every payload and the merged result passed validation.
const json = JSON.stringify(result);
fs.writeFileSync(path.join(root, 'data/market-data.json'), json);
fs.writeFileSync(path.join(root, 'data/market-data.js'), `window.MARKET_DATA = ${json};\n`);
console.log(JSON.stringify({ rows: rows.length, start: result.meta.firstDate, end: result.meta.lastDate,
  financingEnd: result.meta.financingLastDate, missing: result.meta.missingFinancingDays,
  first: rows[0], last: rows.at(-1) }, null, 2));
