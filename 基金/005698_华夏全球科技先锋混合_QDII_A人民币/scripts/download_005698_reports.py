from __future__ import annotations

import csv
import hashlib
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

from pypdf import PdfReader


FUND_CODE = "005698"
BASE_DIR = Path(__file__).resolve().parents[1]
CATALOG_URL = (
    "https://api.fund.eastmoney.com/f10/JJGG"
    f"?fundcode={FUND_CODE}&pageIndex=1&pageSize=200&type=3"
)
OUTPUT_DIR = BASE_DIR / "定期报告"
HEADERS = {
    "Referer": "https://fundf10.eastmoney.com/jjgg_005698_3.html",
    "User-Agent": "Mozilla/5.0",
}


def fetch(url: str, *, retries: int = 3) -> bytes:
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(request, timeout=45) as response:
                return response.read()
        except Exception as exc:  # network errors are retried below
            last_error = exc
            if attempt + 1 < retries:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"下载失败: {url}") from last_error


def safe_name(value: str) -> str:
    value = value.replace("(QDII)", "（QDII）")
    value = re.sub(r'[<>:"/\\|?*]', "_", value)
    return re.sub(r"\s+", "", value).strip(" .")


def report_year(title: str, publish_date: str) -> str:
    match = re.search(r"(20\d{2})年", title)
    return match.group(1) if match else publish_date[:4]


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = json.loads(fetch(CATALOG_URL).decode("utf-8"))
    reports = payload.get("Data", [])
    if payload.get("ErrCode") != 0 or not reports:
        raise RuntimeError(f"公告目录返回异常: {payload.get('ErrMsg')}")

    manifest: list[dict[str, object]] = []
    for index, item in enumerate(reports, start=1):
        title = item["TITLE"]
        publish_date = item["PUBLISHDATEDesc"]
        announcement_id = item["ID"]
        year = report_year(title, publish_date)
        year_dir = OUTPUT_DIR / year
        year_dir.mkdir(exist_ok=True)
        filename = f"{publish_date}_{safe_name(title)}_{announcement_id}.pdf"
        output_path = year_dir / filename
        pdf_url = f"https://pdf.dfcfw.com/pdf/H2_{announcement_id}_1.pdf"

        if output_path.exists() and output_path.stat().st_size > 1024:
            content = output_path.read_bytes()
        else:
            content = fetch(pdf_url)
            if not content.startswith(b"%PDF"):
                raise RuntimeError(f"下载内容不是PDF: {pdf_url}")
            output_path.write_bytes(content)

        reader = PdfReader(output_path)
        digest = hashlib.sha256(content).hexdigest()
        manifest.append(
            {
                "序号": index,
                "报告年度": year,
                "公告日期": publish_date,
                "公告标题": title,
                "是否摘要版": "是" if "摘要" in title else "否",
                "页数": len(reader.pages),
                "文件大小_字节": len(content),
                "公告ID": announcement_id,
                "PDF来源": pdf_url,
                "相对路径": output_path.relative_to(OUTPUT_DIR).as_posix(),
                "SHA256": digest,
            }
        )
        print(f"[{index:02d}/{len(reports)}] {output_path}")

    csv_path = OUTPUT_DIR / "定期报告目录.csv"
    with csv_path.open("w", newline="", encoding="utf-8-sig") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(manifest[0].keys()))
        writer.writeheader()
        writer.writerows(manifest)

    json_path = OUTPUT_DIR / "定期报告目录.json"
    json_path.write_text(
        json.dumps(
            {
                "基金代码": FUND_CODE,
                "基金名称": "华夏全球科技先锋混合型证券投资基金（QDII）",
                "原始页面": "https://fundf10.eastmoney.com/jjgg_005698_3.html",
                "公告记录数": len(manifest),
                "非摘要报告数": sum(row["是否摘要版"] == "否" for row in manifest),
                "报告": manifest,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"完成：{len(manifest)}个PDF，目录：{OUTPUT_DIR.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
