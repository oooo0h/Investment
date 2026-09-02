import fs from "node:fs/promises";

const transactions = JSON.parse(await fs.readFile(new URL("../data/transactions.json", import.meta.url), "utf8"));
const navRaw = JSON.parse(await fs.readFile(new URL("../data/nav_merged.json", import.meta.url), "utf8"));

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const nav = navRaw
  .map((row) => ({ date: row.FSRQ, nav: Number(row.DWJZ) }))
  .filter((row) => Number.isFinite(row.nav))
  .sort((a, b) => a.date.localeCompare(b.date));
const latest = nav.at(-1);
const feeRate = 0.0015;

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function effectiveNav(timestamp) {
  const [dateString, timeString] = timestamp.split("T");
  const target = timeString >= "15:00:00" ? addDays(dateString, 1) : dateString;
  const record = nav.find((row) => row.date >= target);
  if (!record) throw new Error(`No NAV found on or after ${target}`);
  return record;
}

const lots = transactions.active.map((transaction, index) => {
  const navRecord = effectiveNav(transaction.timestamp);
  const fee = transaction.type === "conversion_in" ? 0 : round2(transaction.amount * feeRate);
  const netAmount = round2(transaction.amount - fee);
  const shares = round2(netAmount / navRecord.nav);
  const currentValue = round2(shares * latest.nav);
  const profit = round2(currentValue - transaction.amount);
  return {
    lotId: `L${String(index + 1).padStart(3, "0")}`,
    ...transaction,
    orderDate: transaction.timestamp.slice(0, 10),
    effectiveDate: navRecord.date,
    feeRate: transaction.type === "conversion_in" ? 0 : feeRate,
    fee,
    netAmount,
    buyNav: navRecord.nav,
    shares,
    soldShares: 0,
    remainingShares: shares,
    grossCost: transaction.amount,
    remainingCost: transaction.amount,
    latestNavDate: latest.date,
    latestNav: latest.nav,
    currentValue,
    profit,
    returnPct: transaction.amount ? profit / transaction.amount : null,
  };
});

const totalGrossCost = round2(lots.reduce((sum, row) => sum + row.grossCost, 0));
const cashPurchases = round2(lots.filter((row) => row.type !== "conversion_in").reduce((sum, row) => sum + row.grossCost, 0));
const conversionBasis = round2(lots.filter((row) => row.type === "conversion_in").reduce((sum, row) => sum + row.grossCost, 0));
const totalFees = round2(lots.reduce((sum, row) => sum + row.fee, 0));
const totalShares = round2(lots.reduce((sum, row) => sum + row.remainingShares, 0));
const currentValue = round2(lots.reduce((sum, row) => sum + row.currentValue, 0));
const totalProfit = round2(currentValue - totalGrossCost);

const result = {
  metadata: {
    fundCode: transactions.fundCode,
    fundName: transactions.fundName,
    feeRate,
    feeRule: "普通买入/定投手续费=交易金额×0.15%，四舍五入到分；手续费包含在截图金额所代表的总支出中",
    conversionFeeRule: "转换转入按截图金额作为成本基础，不另加普通申购费",
    navRule: "15:00前按当日（或其后首个可用）净值；15:00后按下一可用净值日",
    shareRule: "确认份额估算为(交易金额-手续费)/确认净值，四舍五入到0.01份",
    valuationDate: latest.date,
    valuationNav: latest.nav,
  },
  summary: {
    activeAcquisitionCount: lots.length,
    excludedCount: transactions.excluded.length,
    successfulSellCount: 0,
    cashPurchases,
    conversionBasis,
    totalGrossCost,
    totalFees,
    totalShares,
    currentValue,
    totalProfit,
    totalReturnPct: totalGrossCost ? totalProfit / totalGrossCost : null,
  },
  lots,
  excluded: transactions.excluded,
  fifoAllocations: [],
};

await fs.writeFile(new URL("../data/analysis_results.json", import.meta.url), JSON.stringify(result, null, 2), "utf8");
console.log(JSON.stringify({ metadata: result.metadata, summary: result.summary }, null, 2));
