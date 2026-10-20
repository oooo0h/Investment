import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const funds = [
  { code: "270023", name: "广发全球精选股票(QDII)人民币A", group: "持仓基金", dir: "270023_广发全球精选股票_QDII_人民币A" },
  { code: "005698", name: "华夏全球科技先锋混合(QDII)A(人民币)", group: "持仓基金", dir: "005698_华夏全球科技先锋混合_QDII_A人民币" },
  { code: "009608", name: "广发中证500指数增强A", group: "观察基金", dir: "009608_广发中证500指数增强A" },
  { code: "000216", name: "华安黄金ETF联接A", group: "观察基金", dir: "000216_华安黄金ETF联接A" },
  { code: "018124", name: "永赢先进制造智选混合发起A", group: "观察基金", dir: "018124_永赢先进制造智选混合发起A" },
  { code: "015789", name: "永赢高端装备智选混合发起A", group: "观察基金", dir: "015789_永赢高端装备智选混合发起A" },
];

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const summaryDir = path.join(projectRoot, "公共资料", "历史净值");
const pageSize = 20;
const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
  Referer: "https://fundf10.eastmoney.com/",
};

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function csv(rows) {
  return "\uFEFF" + rows.map((row) => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

function safeFileName(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

async function fetchJson(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  return response.json();
}

async function fetchFundSearch(code) {
  const url =
    "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=" +
    encodeURIComponent(code);
  const data = await fetchJson(url);
  const hit = data.Datas?.find((item) => item.CODE === code);
  if (!hit) {
    throw new Error(`未能在基金搜索接口确认代码 ${code}`);
  }
  return hit;
}

async function fetchHistoryPage(code, pageIndex) {
  const url =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
    `&pageIndex=${pageIndex}&pageSize=${pageSize}&startDate=&endDate=&_=${Date.now()}`;
  const data = await fetchJson(url);
  if (data.ErrCode !== 0) {
    throw new Error(`历史净值接口返回错误 ${code}: ${data.ErrMsg ?? data.ErrCode}`);
  }
  if (!data.Data?.LSJZList?.length || !data.TotalCount) {
    throw new Error(`历史净值接口未返回有效列表 ${code} page ${pageIndex}`);
  }
  return data;
}

function validateRows(fund, rows, expectedCount, latestFromSearch) {
  if (rows.length !== expectedCount) {
    throw new Error(`${fund.code} 记录数不一致: got ${rows.length}, expected ${expectedCount}`);
  }

  const seenDates = new Set();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row.FSRQ || !row.DWJZ) {
      throw new Error(`${fund.code} 第 ${i + 1} 行缺少日期或单位净值`);
    }
    if (seenDates.has(row.FSRQ)) {
      throw new Error(`${fund.code} 日期重复: ${row.FSRQ}`);
    }
    seenDates.add(row.FSRQ);
    if (i > 0 && rows[i - 1].FSRQ < row.FSRQ) {
      throw new Error(`${fund.code} 日期顺序异常: ${rows[i - 1].FSRQ} before ${row.FSRQ}`);
    }
  }

  const latest = rows[0];
  if (latestFromSearch?.FSRQ && latest.FSRQ !== latestFromSearch.FSRQ) {
    throw new Error(
      `${fund.code} 最新日期与搜索接口不一致: ${latest.FSRQ} vs ${latestFromSearch.FSRQ}`,
    );
  }
  if (
    latestFromSearch?.DWJZ != null &&
    Number(latest.DWJZ).toFixed(4) !== Number(latestFromSearch.DWJZ).toFixed(4)
  ) {
    throw new Error(
      `${fund.code} 最新单位净值与搜索接口不一致: ${latest.DWJZ} vs ${latestFromSearch.DWJZ}`,
    );
  }
}

async function fetchFund(fund) {
  const searchHit = await fetchFundSearch(fund.code);
  if (searchHit.NAME !== fund.name) {
    throw new Error(`${fund.code} 名称不一致: ${searchHit.NAME} vs ${fund.name}`);
  }

  const firstPage = await fetchHistoryPage(fund.code, 1);
  const totalCount = firstPage.TotalCount;
  const actualPageSize = firstPage.PageSize || pageSize;
  const pages = Math.ceil(totalCount / actualPageSize);
  const rows = [...(firstPage.Data?.LSJZList ?? [])];

  for (let page = 2; page <= pages; page += 1) {
    const pageData = await fetchHistoryPage(fund.code, page);
    rows.push(...(pageData.Data?.LSJZList ?? []));
  }

  validateRows(fund, rows, totalCount, searchHit.FundBaseInfo);

  const csvRows = [
    [
      "基金代码",
      "基金名称",
      "净值日期",
      "单位净值",
      "累计净值",
      "日增长率(%)",
      "申购状态",
      "赎回状态",
      "分红送配",
      "数据来源",
    ],
    ...rows.map((row) => [
      fund.code,
      fund.name,
      row.FSRQ,
      row.DWJZ,
      row.LJJZ,
      row.JZZZL,
      row.SGZT,
      row.SHZT,
      row.FHSP || row.FHFCZ || row.FHFCBZ || "",
      "东方财富基金 f10/lsjz",
    ]),
  ];

  const outDir = path.join(projectRoot, "基金", fund.group, fund.dir, "历史净值");
  await fs.mkdir(outDir, { recursive: true });
  const filePath = path.join(outDir, `${safeFileName(fund.name)}.csv`);
  await fs.writeFile(filePath, csv(csvRows), "utf8");

  return {
    code: fund.code,
    name: fund.name,
    count: rows.length,
    latestDate: rows[0]?.FSRQ ?? "",
    latestUnitNav: rows[0]?.DWJZ ?? "",
    earliestDate: rows.at(-1)?.FSRQ ?? "",
    file: path.relative(projectRoot, filePath).replaceAll(path.sep, "/"),
  };
}

async function main() {
  await fs.mkdir(summaryDir, { recursive: true });
  const summaries = [];

  for (const fund of funds) {
    console.log(`fetching ${fund.code} ${fund.name}`);
    summaries.push(await fetchFund(fund));
  }

  const summaryRows = [
    ["基金代码", "基金名称", "记录数", "最早净值日期", "最新净值日期", "最新单位净值", "文件名"],
    ...summaries.map((item) => [
      item.code,
      item.name,
      item.count,
      item.earliestDate,
      item.latestDate,
      item.latestUnitNav,
      item.file,
    ]),
  ];
  await fs.writeFile(path.join(summaryDir, "核验汇总_最新.csv"), csv(summaryRows), "utf8");
  console.table(summaries);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
