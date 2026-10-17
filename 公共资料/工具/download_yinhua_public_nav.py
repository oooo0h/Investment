"""Archive the two public Yinhua overseas digital-economy share classes.

No account data is read.  This script does not change portfolio membership.
"""
from __future__ import annotations

import concurrent.futures
import datetime as dt
from decimal import Decimal
import hashlib
import json
import math
import pathlib
import re
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
TZ = dt.timezone(dt.timedelta(hours=8))
STAMP = dt.datetime.now(TZ).date().isoformat()
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://fundf10.eastmoney.com/", "Cache-Control": "no-cache"}
FUNDS = [("016701", "银华海外数字经济量化选股混合发起_QDII_A"), ("016702", "银华海外数字经济量化选股混合发起_QDII_C")]


def fetch(url):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=40) as response:
                return response.read()
        except Exception:
            if attempt == 3:
                raise
            time.sleep(attempt + 1)


def page(code, index, end):
    url = "https://api.fund.eastmoney.com/f10/lsjz?" + urllib.parse.urlencode({"fundCode": code, "pageIndex": index, "pageSize": 20, "startDate": "", "endDate": end, "_": time.time_ns()})
    raw = fetch(url)
    obj = json.loads(raw)
    if obj.get("ErrCode") != 0 or not isinstance(obj.get("Data"), dict):
        raise ValueError(f"Bad public history response {code} page {index}")
    return index, url, raw, obj


def number(value):
    if value in (None, "", "--", "---"):
        return None
    val = Decimal(str(value))
    if not val.is_finite():
        raise ValueError("Non-finite public data")
    return str(val)


def main():
    summary = []
    for code, name in FUNDS:
        fund = ROOT / "基金" / f"{code}_{name}"
        history = fund / "历史净值"
        rawdir = history / "原始数据" / f"东财全页_{STAMP}"
        rawdir.mkdir(parents=True, exist_ok=True)
        (fund / "研究").mkdir(exist_ok=True)
        (fund / "临时资料").mkdir(exist_ok=True)
        first = page(code, 1, STAMP)
        latest = max(row["FSRQ"] for row in first[3]["Data"]["LSJZList"])
        # Repeat page 1 pinned to the same last date as every subsequent page.
        first = page(code, 1, latest)
        total = first[3]["TotalCount"]
        count = math.ceil(total / 20)
        batches = [first]
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            batches.extend(pool.map(lambda i: page(code, i, latest), range(2, count + 1)))
        rows = []
        manifest = []
        for index, url, raw, obj in sorted(batches):
            if obj["TotalCount"] != total:
                raise ValueError("History changed during pinned download")
            filename = f"{code}_lsjz_page{index:03d}.json"
            (rawdir / filename).write_bytes(raw)
            manifest.append({"page": index, "url": url, "file": filename, "count": len(obj["Data"]["LSJZList"]), "sha256": hashlib.sha256(raw).hexdigest()})
            for x in obj["Data"]["LSJZList"]:
                rows.append({"date": x["FSRQ"], "nav": number(x["DWJZ"]), "accumulated_nav": number(x.get("LJJZ")), "daily_growth_pct": number(x.get("JZZZL")), "event": x.get("FHSP") or x.get("FHFCZ") or "", "source": "天天基金 f10/lsjz（公开第三方）"})
        rows.sort(key=lambda x: x["date"])
        if len(rows) != total or len({x["date"] for x in rows}) != total:
            raise ValueError("Incomplete or duplicate public NAV dates")
        if any(x["nav"] is None or Decimal(x["nav"]) <= 0 for x in rows):
            raise ValueError("Missing/non-positive public NAV")
        chart_url = f"https://fund.eastmoney.com/pingzhongdata/{code}.js?v={time.time_ns()}"
        chart_raw = fetch(chart_url)
        (rawdir / f"{code}_pingzhongdata.js").write_bytes(chart_raw)
        chart_text = chart_raw.decode("utf-8-sig")
        def variable(name):
            match = re.search(r"var\s+" + name + r"\s*=\s*(\[.*?\]);", chart_text, re.S)
            if not match:
                raise ValueError(f"Missing {name}")
            return json.loads(match.group(1))
        chart = {dt.datetime.fromtimestamp(x["x"] / 1000, TZ).date().isoformat(): x for x in variable("Data_netWorthTrend")}
        chart_accum = {dt.datetime.fromtimestamp(x / 1000, TZ).date().isoformat(): y for x, y in variable("Data_ACWorthTrend")}
        missing = [x["date"] for x in rows if x["date"] not in chart]
        mismatch = [x["date"] for x in rows if x["date"] in chart and Decimal(x["nav"]) != Decimal(str(chart[x["date"]]["y"]))]
        accumulated_mismatch = [x["date"] for x in rows if x["date"] in chart_accum and x["accumulated_nav"] is not None and Decimal(x["accumulated_nav"]) != Decimal(str(chart_accum[x["date"]]))]
        chart_only = sorted(set(chart) - {x["date"] for x in rows})
        if mismatch or accumulated_mismatch:
            raise ValueError(f"Public same-vendor history/chart conflict: {mismatch}, {accumulated_mismatch}")
        weekend = [x["date"] for x in rows if dt.date.fromisoformat(x["date"]).weekday() >= 5]
        events = [x for x in rows if x["event"]]
        gaps = [x["date"] for x in rows if x["accumulated_nav"] is not None and Decimal(x["nav"]) != Decimal(x["accumulated_nav"])]
        validation = {"api_total_count": total, "pages": count, "unique_date_count": len(rows), "duplicate_dates": [], "all_pages_pinned_end_date": latest, "chart_same_vendor_only": True, "chart_count": len(chart), "chart_missing_dates": missing, "chart_only_dates": chart_only, "chart_nav_mismatches": mismatch, "chart_accumulated_nav_mismatches": accumulated_mismatch, "nav_vs_accumulated_gap_dates": gaps, "nonempty_event_count": len(events), "weekend_accounting_nav_dates": weekend, "official_independent_full_validation": "待核验；不冒称已完成双源全量比对"}
        output = {"schema": "public-fund-nav-v1", "code": code, "name": name, "identity_status": "用户指定研究对象；不代表用户持仓或实际份额类别", "downloaded_at": dt.datetime.now(TZ).isoformat(timespec="seconds"), "inception_date": "2023-03-15", "first_date": rows[0]["date"], "last_date": rows[-1]["date"], "count": len(rows), "source": "天天基金 f10/lsjz 全页公开历史净值；pingzhongdata 同供应商交叉检查", "source_urls": [manifest[0]["url"], chart_url], "validation": validation, "field_notes": {"nav": "公开单位净值十进制字符串", "accumulated_nav": "公开累计净值；缺失保持 null，不填估计值", "daily_growth_pct": "来源公布的日增长率百分比；不得未经分红调整直接连乘当作总回报", "event": "公开分红/拆分文字，未提供为空；空文字不单独构成从未分红的证明", "calendar": "全历史观察含成立面值、封闭期与可能的会计净值；交易模型须另设开放日/周末过滤"}, "rows": rows}
        target = history / f"{code}_全部历史净值_截至{latest}.json"
        target.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        audit = {"schema": "public-nav-download-audit-v1", "code": code, "as_of": STAMP, "source_json": str(target.relative_to(ROOT)).replace("\\", "/"), "sha256": hashlib.sha256(target.read_bytes()).hexdigest(), "validation": validation, "raw_pages": manifest, "chart_url": chart_url, "events": events}
        (rawdir / "下载核验清单.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        summary.append({"code": code, "file": str(target.relative_to(ROOT)).replace("\\", "/"), "count": len(rows), "first_date": rows[0]["date"], "last_date": latest, "pages": count, "event_count": len(events), "gap_count": len(gaps), "weekend_dates": weekend, "chart_missing": missing, "chart_only": chart_only})
    print(json.dumps(summary, ensure_ascii=True))


if __name__ == "__main__":
    main()
