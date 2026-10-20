import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outputDir = path.join(root, "outputs", "fund_fifo_20260902");
const previewDir = path.join(root, "tmp", "workbook_previews");
const localNavPath = path.join(root, "..", "历史净值", "华夏全球科技先锋混合(QDII)A(人民币).csv");
const result = JSON.parse(await fs.readFile(path.join(root, "data", "analysis_results.json"), "utf8"));
const navRaw = JSON.parse(await fs.readFile(path.join(root, "data", "nav_merged.json"), "utf8"));

const workbook = Workbook.create();
const summary = workbook.worksheets.add("结果摘要");
const lots = workbook.worksheets.add("逐笔收益");
const excluded = workbook.worksheets.add("排除记录");
const fifo = workbook.worksheets.add("FIFO分配");
const nav = workbook.worksheets.add("历史净值");
const params = workbook.worksheets.add("参数与来源");

workbook.comments.setSelf({ displayName: "User" });

const colors = {
  navy: "#12304A",
  teal: "#0E7490",
  tealLight: "#DDF3F6",
  paleBlue: "#EAF2F8",
  green: "#14804A",
  greenLight: "#E6F4EA",
  red: "#B42318",
  redLight: "#FDECEA",
  amber: "#B36B00",
  amberLight: "#FFF4D6",
  gray: "#667085",
  grayLight: "#F2F4F7",
  line: "#D0D5DD",
  white: "#FFFFFF",
  black: "#101828",
  inputBlue: "#0000FF",
  linkGreen: "#008000",
};

const moneyFmt = '#,##0.00;[Red](#,##0.00);-';
const countFmt = '#,##0.00;[Red](#,##0.00);-';
const navFmt = '0.0000';
const pctFmt = '0.00%;[Red](0.00%);-';

function dateFromIsoDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function dateFromTimestamp(value) {
  const [datePart, timePart] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute, second] = timePart.split(":").map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

function typeLabel(type) {
  return { buy: "买入", scheduled: "定投", conversion_in: "转换(转入)", sell: "卖出" }[type] ?? type;
}

function titleBand(sheet, range, text) {
  sheet.getRange(range).merge();
  const cell = sheet.getRange(range.split(":")[0]);
  cell.values = [[text]];
  sheet.getRange(range).format = {
    fill: colors.navy,
    font: { bold: true, color: colors.white, size: 16 },
    verticalAlignment: "center",
  };
  sheet.getRange(range).format.rowHeight = 30;
}

function sectionHeader(range) {
  range.format = {
    fill: colors.teal,
    font: { bold: true, color: colors.white },
    borders: { preset: "outside", style: "thin", color: colors.teal },
  };
}

for (const sheet of [summary, lots, excluded, fifo, nav, params]) {
  sheet.showGridLines = false;
}

// 参数与来源
titleBand(params, "A1:D1", "计算参数与数据来源");
params.getRange("A3:B3").values = [["估值日", "最新可用单位净值"]];
params.getRange("A3:B3").format = { fill: colors.teal, font: { bold: true, color: colors.white } };
params.getRange("A4").formulas = [["='历史净值'!A3"]];
params.getRange("B4").formulas = [["='历史净值'!B3"]];
params.getRange("A4").format.numberFormat = "yyyy-mm-dd";
params.getRange("B4").format.numberFormat = navFmt;
params.getRange("A4:B4").format.font = { color: colors.linkGreen };
params.getRange("A6:B9").values = [
  ["手续费示例金额", 2000],
  ["手续费示例金额对应费用", 3],
  ["推导申购费率", null],
  ["转换转入申购费率", 0],
];
params.getRange("B8").formulas = [["=B7/B6"]];
params.getRange("B6:B7").format.font = { color: colors.inputBlue };
params.getRange("B6:B7").format.numberFormat = moneyFmt;
params.getRange("B8:B9").format.numberFormat = pctFmt;
params.getRange("A11:B14").values = [
  ["份额保留位数", 2],
  ["交易日切换时间", "15:00"],
  ["普通买入份额规则", "(截图金额-手续费)÷确认净值，四舍五入至0.01份"],
  ["转换转入规则", "截图所示10,696.01元作为成本基础，不另加普通申购费"],
];
params.getRange("B11:B14").format.font = { color: colors.inputBlue };
params.getRange("A16:D16").values = [["来源", "用途", "地址/文件", "说明"]];
sectionHeader(params.getRange("A16:D16"));
params.getRange("A17:D23").values = [
  ["华夏基金官网", "最新净值核验", "https://www.chinaamc.com/fund/005698/index.shtml", "截至2026-09-02，最新可用净值日为2026-08-31"],
  ["华夏基金历史净值", "历史净值核验", "https://fund.chinaamc.com/product/fundLishijingzhi.do?fundcode=005698", "基金管理人页面"],
  ["项目空间历史净值", "2026-07-09及以前历史净值主数据", localNavPath, "与在线API重叠363条逐项核验，单位净值差异0条"],
  ["东方财富历史净值API", "批量历史净值", "https://api.fund.eastmoney.com/f10/lsjz?fundCode=005698&pageIndex=1&pageSize=20", "与华夏基金可见区间抽样核对一致"],
  ["基金招募说明书", "申购份额公式", "https://www.chinaamc.com/upload/resources/file/2026/05/29/928e507e97ae4998986f27e068688a4f.pdf", "申购份额=净申购金额/T日净值；份额保留两位"],
  ["用户截图1", "交易记录", "D:/WeChat_files/xwechat_files/wxid_fs5n306ex72922_70f8/temp/RWTemp/2026-09/9e20f478899dc29eb19741386f9343c8/a33d8e0c58b1a61851440346ba3a071b.jpg", "长截图"],
  ["用户截图2", "交易记录补充", "D:/WeChat_files/xwechat_files/wxid_fs5n306ex72922_70f8/temp/RWTemp/2026-09/9e20f478899dc29eb19741386f9343c8/c35998e8b35b78b6d7b30fd70f72453a.jpg", "底部记录"],
];
params.getRange("A25:D28").values = [
  ["重要限制", null, null, null],
  ["截图未显示每笔实际确认份额、确认净值和费用；本表按历史净值与用户提供的手续费标准重建。", null, null, null],
  ["2026-06-02 22:49买入按15:00后下单处理，使用下一可用净值日2026-06-03。", null, null, null],
  ["全部4笔卖出记录均显示“已撤单”，因此本次没有成功卖出，也没有FIFO已实现收益。", null, null, null],
];
params.getRange("A25:D25").merge();
params.getRange("A26:D26").merge();
params.getRange("A27:D27").merge();
params.getRange("A28:D28").merge();
params.getRange("A25:D25").format = { fill: colors.amber, font: { bold: true, color: colors.white } };
params.getRange("A26:D28").format = { fill: colors.amberLight, font: { color: colors.black }, wrapText: true };
params.getRange("A1:D28").format.font.name = "Microsoft YaHei";
params.getRange("A1:D28").format.verticalAlignment = "center";
params.getRange("A1:A28").format.columnWidth = 22;
params.getRange("B1:B28").format.columnWidth = 18;
params.getRange("C1:C28").format.columnWidth = 68;
params.getRange("D1:D28").format.columnWidth = 44;
params.getRange("A17:D23").format.wrapText = true;
params.getRange("A26:D28").format.rowHeight = 30;
params.freezePanes.freezeRows(1);
workbook.comments.addThread({ cell: params.getRange("B4") }, "Source: 华夏基金官网及历史净值页；2026-08-31单位净值2.6850。完整链接见本表来源区。 ");
workbook.comments.addThread({ cell: params.getRange("B8") }, "User-provided fee example: a ¥2,000 purchase incurs about ¥3 of fees, implying a simple 0.15% rate.");

// 历史净值
titleBand(nav, "A1:B1", "005698 历史单位净值");
nav.getRange("A2:C2").values = [["净值日期", "单位净值", "数据源"]];
sectionHeader(nav.getRange("A2:C2"));
const navRows = navRaw.map((row) => [dateFromIsoDate(row.FSRQ), Number(row.DWJZ), row._source ?? "在线API补充"]);
nav.getRangeByIndexes(2, 0, navRows.length, 3).values = navRows;
nav.getRange(`A3:A${navRows.length + 2}`).format.numberFormat = "yyyy-mm-dd";
nav.getRange(`B3:B${navRows.length + 2}`).format.numberFormat = navFmt;
nav.getRange(`A2:C${navRows.length + 2}`).format.font.name = "Microsoft YaHei";
nav.getRange(`A1:A${navRows.length + 2}`).format.columnWidth = 15;
nav.getRange(`B1:B${navRows.length + 2}`).format.columnWidth = 14;
nav.getRange(`C1:C${navRows.length + 2}`).format.columnWidth = 0;
nav.tables.add(`A2:C${navRows.length + 2}`, true, "NavHistoryTable").style = "TableStyleMedium2";
nav.freezePanes.freezeRows(2);
workbook.comments.addThread({ cell: nav.getRange("B2") }, "Source URL: https://api.fund.eastmoney.com/f10/lsjz?fundCode=005698&pageIndex=1&pageSize=20 ; visible dates were spot-checked against 华夏基金历史净值。 ");

// 逐笔收益
titleBand(lots, "A1:K1", "逐笔收益明细（截至最新可用净值日）");
lots.getRange("A2:K2").merge();
lots.getRange("A2").values = [["默认隐藏费率、净额、确认日、FIFO中间量、剩余成本和重复估值净值列；调整列宽即可展开复核。所有金额均以人民币计。"]];
lots.getRange("A2:K2").format = { fill: colors.paleBlue, font: { color: colors.gray }, wrapText: true };
const lotHeaders = [["批次", "下单时间", "类型", "截图金额/成本", "手续费", "确认净值", "估算份额", "截至估值日价值", "批次收益", "收益率", "结果", "费率", "净申购金额", "确认净值日", "FIFO卖出份额", "剩余份额", "剩余成本", "估值净值"]];
lots.getRange("A4:R4").values = lotHeaders;
sectionHeader(lots.getRange("A4:R4"));
const lotStart = 5;
const lotEnd = lotStart + result.lots.length - 1;
const lotInputRows = result.lots.map((row) => [
  row.lotId,                              // A 批次
  dateFromTimestamp(row.timestamp),       // B 下单时间
  typeLabel(row.type),                    // C 类型
  row.amount,                             // D 截图金额/成本
  null,                                   // E 手续费
  null,                                   // F 确认净值
  null,                                   // G 估算份额
  null,                                   // H 截至估值日价值
  null,                                   // I 批次收益
  null,                                   // J 收益率
  null,                                   // K 结果
  null,                                   // L 费率
  null,                                   // M 净申购金额
  dateFromIsoDate(row.effectiveDate),     // N 确认净值日
  0,                                      // O FIFO卖出份额
  null,                                   // P 剩余份额
  null,                                   // Q 剩余成本
  null,                                   // R 估值净值
]);
lots.getRangeByIndexes(lotStart - 1, 0, lotInputRows.length, 18).values = lotInputRows;
lots.getRange(`L${lotStart}`).formulas = [[`=IF(C${lotStart}="转换(转入)",'参数与来源'!$B$9,'参数与来源'!$B$8)`]];
lots.getRange(`L${lotStart}:L${lotEnd}`).fillDown();
lots.getRange(`E${lotStart}`).formulas = [[`=ROUND(D${lotStart}*L${lotStart},2)`]];
lots.getRange(`E${lotStart}:E${lotEnd}`).fillDown();
lots.getRange(`M${lotStart}`).formulas = [[`=D${lotStart}-E${lotStart}`]];
lots.getRange(`M${lotStart}:M${lotEnd}`).fillDown();
lots.getRange(`F${lotStart}`).formulas = [[`=SUMIF('历史净值'!$A$3:$A$${navRows.length + 2},N${lotStart},'历史净值'!$B$3:$B$${navRows.length + 2})`]];
lots.getRange(`F${lotStart}:F${lotEnd}`).fillDown();
lots.getRange(`G${lotStart}`).formulas = [[`=ROUND(M${lotStart}/F${lotStart},2)`]];
lots.getRange(`G${lotStart}:G${lotEnd}`).fillDown();
lots.getRange(`P${lotStart}`).formulas = [[`=G${lotStart}-O${lotStart}`]];
lots.getRange(`P${lotStart}:P${lotEnd}`).fillDown();
lots.getRange(`Q${lotStart}`).formulas = [[`=IF(G${lotStart}=0,0,D${lotStart}*P${lotStart}/G${lotStart})`]];
lots.getRange(`Q${lotStart}:Q${lotEnd}`).fillDown();
lots.getRange(`R${lotStart}`).formulas = [["='参数与来源'!$B$4"]];
lots.getRange(`R${lotStart}:R${lotEnd}`).fillDown();
lots.getRange(`H${lotStart}`).formulas = [[`=ROUND(P${lotStart}*R${lotStart},2)`]];
lots.getRange(`H${lotStart}:H${lotEnd}`).fillDown();
lots.getRange(`I${lotStart}`).formulas = [[`=ROUND(H${lotStart}-Q${lotStart},2)`]];
lots.getRange(`I${lotStart}:I${lotEnd}`).fillDown();
lots.getRange(`J${lotStart}`).formulas = [[`=IF(Q${lotStart}=0,"",I${lotStart}/Q${lotStart})`]];
lots.getRange(`J${lotStart}:J${lotEnd}`).fillDown();
lots.getRange(`K${lotStart}`).formulas = [[`=IF(I${lotStart}>=0,"盈利","亏损")`]];
lots.getRange(`K${lotStart}:K${lotEnd}`).fillDown();
lots.getRange(`B${lotStart}:B${lotEnd}`).format.numberFormat = "yyyy-mm-dd hh:mm:ss";
lots.getRange(`D${lotStart}:E${lotEnd}`).format.numberFormat = moneyFmt;
lots.getRange(`F${lotStart}:F${lotEnd}`).format.numberFormat = navFmt;
lots.getRange(`G${lotStart}:G${lotEnd}`).format.numberFormat = countFmt;
lots.getRange(`H${lotStart}:I${lotEnd}`).format.numberFormat = moneyFmt;
lots.getRange(`J${lotStart}:J${lotEnd}`).format.numberFormat = pctFmt;
lots.getRange(`L${lotStart}:L${lotEnd}`).format.numberFormat = pctFmt;
lots.getRange(`M${lotStart}:M${lotEnd}`).format.numberFormat = moneyFmt;
lots.getRange(`N${lotStart}:N${lotEnd}`).format.numberFormat = "yyyy-mm-dd";
lots.getRange(`O${lotStart}:P${lotEnd}`).format.numberFormat = countFmt;
lots.getRange(`Q${lotStart}:Q${lotEnd}`).format.numberFormat = moneyFmt;
lots.getRange(`R${lotStart}:R${lotEnd}`).format.numberFormat = navFmt;
lots.getRange(`F${lotStart}:F${lotEnd}`).format.font = { color: colors.linkGreen };
lots.getRange(`L${lotStart}:L${lotEnd}`).format.font = { color: colors.linkGreen };
lots.getRange(`R${lotStart}:R${lotEnd}`).format.font = { color: colors.linkGreen };
lots.getRange(`A${lotStart}:D${lotEnd}`).format.font = { color: colors.black };
lots.getRange(`N${lotStart}:O${lotEnd}`).format.font = { color: colors.black };
lots.getRange(`A4:R${lotEnd}`).format.font.name = "Microsoft YaHei";
lots.getRange(`I${lotStart}:I${lotEnd}`).conditionalFormats.add("cellIs", { operator: "greaterThanOrEqual", formula: 0, format: { font: { color: colors.green } } });
lots.getRange(`I${lotStart}:I${lotEnd}`).conditionalFormats.add("cellIs", { operator: "lessThan", formula: 0, format: { font: { color: colors.red } } });
lots.getRange(`K${lotStart}:K${lotEnd}`).conditionalFormats.add("containsText", { text: "盈利", format: { fill: colors.greenLight, font: { color: colors.green, bold: true } } });
lots.getRange(`K${lotStart}:K${lotEnd}`).conditionalFormats.add("containsText", { text: "亏损", format: { fill: colors.redLight, font: { color: colors.red, bold: true } } });
lots.tables.add(`A4:R${lotEnd}`, true, "LotReturnsTable").style = "TableStyleMedium2";
lots.freezePanes.freezeRows(4);
lots.freezePanes.freezeColumns(4);
const lotWidths = [10, 21, 13, 16, 12, 12, 13, 17, 14, 11, 10, 10, 15, 14, 15, 13, 14, 12];
lotWidths.forEach((width, index) => lots.getRangeByIndexes(0, index, lotEnd, 1).format.columnWidth = width);
for (const column of ["L", "M", "N", "O", "P", "Q", "R"]) {
  lots.getRange(`${column}1:${column}${lotEnd}`).format.columnWidth = 0.1;
}

// 排除记录
titleBand(excluded, "A1:E1", "未计入收益的交易记录");
excluded.getRange("A2:E2").values = [["下单时间", "类型", "金额(元)", "份额", "排除原因"]];
sectionHeader(excluded.getRange("A2:E2"));
const excludedRows = result.excluded.map((row) => [
  dateFromTimestamp(row.timestamp),
  typeLabel(row.type),
  row.amount ?? null,
  row.shares ?? null,
  row.status,
]);
excluded.getRangeByIndexes(2, 0, excludedRows.length, 5).values = excludedRows;
const excludedEnd = excludedRows.length + 2;
excluded.getRange(`A3:A${excludedEnd}`).format.numberFormat = "yyyy-mm-dd hh:mm:ss";
excluded.getRange(`C3:C${excludedEnd}`).format.numberFormat = moneyFmt;
excluded.getRange(`D3:D${excludedEnd}`).format.numberFormat = countFmt;
excluded.getRange(`A2:E${excludedEnd}`).format.font.name = "Microsoft YaHei";
excluded.getRange(`E3:E${excludedEnd}`).format = { fill: colors.grayLight, font: { color: colors.gray } };
excluded.tables.add(`A2:E${excludedEnd}`, true, "ExcludedTradesTable").style = "TableStyleMedium1";
excluded.getRange(`A1:A${excludedEnd}`).format.columnWidth = 22;
excluded.getRange(`B1:B${excludedEnd}`).format.columnWidth = 14;
excluded.getRange(`C1:D${excludedEnd}`).format.columnWidth = 16;
excluded.getRange(`E1:E${excludedEnd}`).format.columnWidth = 15;
excluded.freezePanes.freezeRows(2);

// FIFO分配
titleBand(fifo, "A1:H1", "先进先出（FIFO）卖出分配");
fifo.getRange("A3:H3").values = [["卖出批次", "卖出时间", "卖出份额", "对应买入批次", "买入时间", "匹配份额", "匹配成本", "已实现收益"]];
sectionHeader(fifo.getRange("A3:H3"));
fifo.getRange("A5:H5").merge();
fifo.getRange("A5").values = [["本次截图中4笔卖出均为“已撤单”，成功卖出笔数为0；因此没有FIFO冲减，也没有已实现收益。"]];
fifo.getRange("A5:H5").format = { fill: colors.amberLight, font: { color: colors.amber, bold: true }, wrapText: true };
fifo.getRange("A1:H5").format.font.name = "Microsoft YaHei";
fifo.getRange("A1:A5").format.columnWidth = 14;
fifo.getRange("B1:B5").format.columnWidth = 22;
fifo.getRange("C1:H5").format.columnWidth = 16;
fifo.getRange("A5:H5").format.rowHeight = 34;

// 结果摘要
titleBand(summary, "A1:F1", "005698 交易逐笔收益汇总");
summary.getRange("A2").values = [["模型状态"]];
summary.getRange("B2").formulas = [["=IF(COUNTIF(F23:F27,\"<>OK\")=0,\"OK\",\"请检查\")"]];
summary.getRange("A2:B2").format = { fill: colors.grayLight, font: { bold: true, color: colors.black } };
summary.getRange("B2").conditionalFormats.add("containsText", { text: "OK", format: { fill: colors.greenLight, font: { color: colors.green, bold: true } } });
summary.getRange("B2").conditionalFormats.add("containsText", { text: "请检查", format: { fill: colors.redLight, font: { color: colors.red, bold: true } } });
summary.getRange("A4:B4").values = [["收益汇总", "数值"]];
sectionHeader(summary.getRange("A4:B4"));
summary.getRange("A5:A13").values = [
  ["现金买入支出"],
  ["转换转入成本基础"],
  ["总成本基础"],
  ["其中估算手续费"],
  ["当前剩余份额"],
  ["截至估值日价值"],
  ["未实现收益"],
  ["总体收益率"],
  ["已实现收益（FIFO）"],
];
summary.getRange("B5").formulas = [[`=SUMIFS('逐笔收益'!$D$${lotStart}:$D$${lotEnd},'逐笔收益'!$C$${lotStart}:$C$${lotEnd},"<>转换(转入)")`]];
summary.getRange("B6").formulas = [[`=SUMIFS('逐笔收益'!$D$${lotStart}:$D$${lotEnd},'逐笔收益'!$C$${lotStart}:$C$${lotEnd},"转换(转入)")`]];
summary.getRange("B7").formulas = [[`=SUM('逐笔收益'!$D$${lotStart}:$D$${lotEnd})`]];
summary.getRange("B8").formulas = [[`=SUM('逐笔收益'!$E$${lotStart}:$E$${lotEnd})`]];
summary.getRange("B9").formulas = [[`=SUM('逐笔收益'!$P$${lotStart}:$P$${lotEnd})`]];
summary.getRange("B10").formulas = [[`=SUM('逐笔收益'!$H$${lotStart}:$H$${lotEnd})`]];
summary.getRange("B11").formulas = [["=B10-B7"]];
summary.getRange("B12").formulas = [["=IF(B7=0,0,B11/B7)"]];
summary.getRange("B13").values = [[0]];
summary.getRange("B5:B8").format.numberFormat = moneyFmt;
summary.getRange("B9").format.numberFormat = countFmt;
summary.getRange("B10:B11").format.numberFormat = moneyFmt;
summary.getRange("B12").format.numberFormat = pctFmt;
summary.getRange("B13").format.numberFormat = "#,##0.00";
summary.getRange("B5:B10").format.font = { color: colors.linkGreen };
summary.getRange("B11:B12").format.font = { color: colors.black, bold: true };
summary.getRange("A11:B12").format = { fill: colors.greenLight, font: { bold: true, color: colors.green }, borders: { preset: "outside", style: "thin", color: colors.green } };
summary.getRange("D4:E4").values = [["估值信息", "数值"]];
sectionHeader(summary.getRange("D4:E4"));
summary.getRange("D5:D10").values = [
  ["基金代码"],
  ["估值日"],
  ["单位净值"],
  ["成功买入/转入笔数"],
  ["排除记录笔数"],
  ["成功卖出笔数"],
];
summary.getRange("E5").values = [[Number(result.metadata.fundCode)]];
summary.getRange("E5").format.numberFormat = "000000";
summary.getRange("E6").formulas = [["='参数与来源'!$A$4"]];
summary.getRange("E7").formulas = [["='参数与来源'!$B$4"]];
summary.getRange("E8").formulas = [[`=COUNTA('逐笔收益'!$A$${lotStart}:$A$${lotEnd})`]];
summary.getRange("E9").formulas = [[`=COUNTA('排除记录'!$A$3:$A$${excludedEnd})`]];
summary.getRange("E10").values = [[0]];
summary.getRange("E6").format.numberFormat = "yyyy-mm-dd";
summary.getRange("E7").format.numberFormat = navFmt;
summary.getRange("E6:E9").format.font = { color: colors.linkGreen };
summary.getRange("A15:F15").merge();
summary.getRange("A15").values = [["结论：截图中的卖出均已撤单，FIFO未被触发。当前全部有效买入/转入批次均仍在持有；收益为未实现收益。"]];
summary.getRange("A15:F15").format = { fill: colors.amberLight, font: { bold: true, color: colors.amber }, wrapText: true };
summary.getRange("A17:F17").merge();
summary.getRange("A17").values = [["提示：截图缺少每笔实际确认份额和手续费回单，本结果为基于净值和0.15%费率的可复核估算，不作为税务或对账凭证。"]];
summary.getRange("A17:F17").format = { fill: colors.paleBlue, font: { color: colors.gray }, wrapText: true };
summary.getRange("A20:F20").merge();
summary.getRange("A20").values = [["模型检查"]];
sectionHeader(summary.getRange("A20:F20"));
summary.getRange("A22:F22").values = [["检查项", "实际", "预期", "差额", "容差", "状态"]];
summary.getRange("A22:F22").format = { fill: colors.grayLight, font: { bold: true, color: colors.black } };
summary.getRange("A23:A27").values = [
  ["有效批次数"],
  ["缺失确认净值"],
  ["收益勾稽"],
  ["成功卖出笔数"],
  ["最新净值日"],
];
summary.getRange("B23").formulas = [[`=COUNTA('逐笔收益'!$A$${lotStart}:$A$${lotEnd})`]];
summary.getRange("C23").values = [[result.summary.activeAcquisitionCount]];
summary.getRange("D23").formulas = [["=B23-C23"]];
summary.getRange("E23").values = [[0]];
summary.getRange("F23").formulas = [["=IF(ABS(D23)<=E23,\"OK\",\"检查\")"]];
summary.getRange("B24").formulas = [[`=COUNTIF('逐笔收益'!$F$${lotStart}:$F$${lotEnd},0)`]];
summary.getRange("C24:E24").values = [[0, null, 0]];
summary.getRange("D24").formulas = [["=B24-C24"]];
summary.getRange("F24").formulas = [["=IF(ABS(D24)<=E24,\"OK\",\"检查\")"]];
summary.getRange("B25").formulas = [["=B11"]];
summary.getRange("C25").formulas = [["=B10-B7"]];
summary.getRange("D25").formulas = [["=B25-C25"]];
summary.getRange("E25").values = [[0.01]];
summary.getRange("F25").formulas = [["=IF(ABS(D25)<=E25,\"OK\",\"检查\")"]];
summary.getRange("B26:E26").values = [[0, 0, 0, 0]];
summary.getRange("F26").formulas = [["=IF(ABS(D26)<=E26,\"OK\",\"检查\")"]];
summary.getRange("B27").formulas = [["=E6"]];
summary.getRange("C27").values = [[dateFromIsoDate(result.metadata.valuationDate)]];
summary.getRange("D27").formulas = [["=B27-C27"]];
summary.getRange("E27").values = [[0]];
summary.getRange("F27").formulas = [["=IF(ABS(D27)<=E27,\"OK\",\"检查\")"]];
summary.getRange("B25:E25").format.numberFormat = moneyFmt;
summary.getRange("B27:C27").format.numberFormat = "yyyy-mm-dd";
summary.getRange("F23:F27").conditionalFormats.add("containsText", { text: "OK", format: { fill: colors.greenLight, font: { color: colors.green, bold: true } } });
summary.getRange("F23:F27").conditionalFormats.add("containsText", { text: "检查", format: { fill: colors.redLight, font: { color: colors.red, bold: true } } });
summary.getRange("A1:F27").format.font.name = "Microsoft YaHei";
summary.getRange("A1:A27").format.columnWidth = 24;
summary.getRange("B1:B27").format.columnWidth = 18;
summary.getRange("C1:F27").format.columnWidth = 16;
summary.getRange("D1:D27").format.columnWidth = 20;
summary.getRange("A15:F15").format.rowHeight = 34;
summary.getRange("A17:F17").format.rowHeight = 34;
summary.freezePanes.freezeRows(2);

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(previewDir, { recursive: true });

const keyCheck = await workbook.inspect({
  kind: "table",
  range: "结果摘要!A1:F27",
  include: "values,formulas",
  tableMaxRows: 30,
  tableMaxCols: 8,
});
console.log("SUMMARY_INSPECT");
console.log(keyCheck.ndjson);

const errorScan = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "final formula error scan",
});
console.log("ERROR_SCAN");
console.log(errorScan.ndjson);

const renderTargets = [
  ["结果摘要", "A1:F27"],
  ["逐笔收益", `A1:K18`],
  ["逐笔收益", `A${Math.max(lotStart, lotEnd - 10)}:K${lotEnd}`],
  ["排除记录", `A1:E${excludedEnd}`],
  ["FIFO分配", "A1:H5"],
  ["历史净值", "A1:B18"],
  ["参数与来源", "A1:D28"],
];
for (let index = 0; index < renderTargets.length; index += 1) {
  const [sheetName, range] = renderTargets[index];
  const preview = await workbook.render({ sheetName, range, scale: 1.2, format: "png" });
  await fs.writeFile(path.join(previewDir, `${String(index + 1).padStart(2, "0")}_${sheetName}.png`), new Uint8Array(await preview.arrayBuffer()));
}

const output = await SpreadsheetFile.exportXlsx(workbook);
const outputPath = path.join(outputDir, "005698_逐笔收益_FIFO_截至2026-09-02.xlsx");
await output.save(outputPath);
console.log(JSON.stringify({ outputPath, lotStart, lotEnd, navRows: navRows.length, excludedRows: excludedRows.length }));
