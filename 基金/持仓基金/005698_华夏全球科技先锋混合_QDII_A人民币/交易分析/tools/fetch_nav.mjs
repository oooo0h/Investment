import fs from "node:fs/promises";

const headers = {
  referer: "https://fundf10.eastmoney.com/jjjz_005698.html",
  "user-agent": "Mozilla/5.0",
};
const urls = Array.from(
  { length: 20 },
  (_, index) =>
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=005698&pageIndex=${index + 1}&pageSize=20`,
);
const responses = await Promise.all(urls.map((url) => fetch(url, { headers })));
if (responses.some((response) => !response.ok)) {
  throw new Error("One or more NAV requests failed");
}
const payloads = await Promise.all(responses.map((response) => response.json()));
const records = payloads.flatMap((payload) => payload?.Data?.LSJZList ?? []);
if (!records.length) {
  throw new Error("NAV responses did not contain historical records");
}

await fs.mkdir(new URL("../data/", import.meta.url), { recursive: true });
await fs.writeFile(
  new URL("../data/nav_history.json", import.meta.url),
  JSON.stringify(records, null, 2),
  "utf8",
);

console.log(JSON.stringify({ count: records.length, latest: records[0], oldest: records.at(-1) }));
