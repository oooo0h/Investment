import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localPath = path.join(root, "..", "历史净值", "华夏全球科技先锋混合(QDII)A(人民币).csv");
const apiPath = path.join(root, "data", "nav_history.json");

const localText = (await fs.readFile(localPath, "utf8")).replace(/^\uFEFF/, "").trim();
const [headerLine, ...dataLines] = localText.split(/\r?\n/);
const headers = headerLine.split(",");
const localRows = dataLines.map((line) => {
  const cells = line.split(",");
  return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
});
const apiRows = JSON.parse(await fs.readFile(apiPath, "utf8"));

const localByDate = new Map(
  localRows.map((row) => [
    row["净值日期"],
    {
      FSRQ: row["净值日期"],
      DWJZ: row["单位净值"],
      LJJZ: row["累计净值"],
      JZZZL: row["日增长率(%)"],
      _source: "项目空间本地CSV",
    },
  ]),
);

let overlapCount = 0;
let mismatchCount = 0;
for (const row of apiRows) {
  const local = localByDate.get(row.FSRQ);
  if (local) {
    overlapCount += 1;
    if (Number(local.DWJZ) !== Number(row.DWJZ)) mismatchCount += 1;
  } else {
    localByDate.set(row.FSRQ, { ...row, _source: "在线API补充" });
  }
}

const merged = [...localByDate.values()].sort((a, b) => b.FSRQ.localeCompare(a.FSRQ));
await fs.writeFile(path.join(root, "data", "nav_merged.json"), JSON.stringify(merged, null, 2), "utf8");

console.log(
  JSON.stringify(
    {
      localCount: localRows.length,
      apiCount: apiRows.length,
      overlapCount,
      mismatchCount,
      mergedCount: merged.length,
      newest: merged[0],
      oldest: merged.at(-1),
    },
    null,
    2,
  ),
);
