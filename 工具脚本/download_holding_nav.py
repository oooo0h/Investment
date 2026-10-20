"""Archive public NAV histories, reusing local history and fetching missing dates.

Does not read account amounts, infer trades, or change the portfolio state.
Run from any directory with the bundled Python runtime.
"""

from __future__ import annotations

import sys
sys.dont_write_bytecode = True

import concurrent.futures
import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import pathlib
import re
import time
import urllib.parse
import urllib.request
from decimal import Decimal

ROOT = pathlib.Path(__file__).resolve().parents[1]
TZ = dt.timezone(dt.timedelta(hours=8))
TODAY = dt.datetime.now(TZ).date().isoformat()
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://fundf10.eastmoney.com/", "Cache-Control": "no-cache"}
API = "https://api.fund.eastmoney.com/f10/lsjz"
SUMMARY = ROOT / "公共资料" / "历史净值"

# Names identify public products, not account holdings or amounts.
FUNDS = [
    ("000216", "华安黄金ETF联接A", "2013-08-22", "已记录A类"),
    ("005698", "华夏全球科技先锋混合_QDII_A人民币", "2018-04-17", "已记录人民币A类"),
    ("006373", "国富全球科技互联混合_QDII_人民币A", "2018-11-20", "候选：国富实际份额类别待确认"),
    ("021842", "国富全球科技互联混合_QDII_人民币C", "2024-07-25", "候选：国富实际份额类别待确认"),
    ("009608", "广发中证500指数增强A", "2020-10-15", "已记录A类"),
    ("015789", "永赢高端装备智选混合发起A", "2022-07-15", "已记录A类"),
    ("018124", "永赢先进制造智选混合发起A", "2023-05-04", "已记录A类"),
    ("020712", "华安三菱日联日经225ETF发起式联接_QDII_A", "2024-02-07", "已记录A类；代码本次核验"),
    ("019454", "华泰柏瑞中韩半导体ETF发起式联接_QDII_A", "2023-09-22", "候选：中韩半导体实际份额类别待确认"),
    ("019455", "华泰柏瑞中韩半导体ETF发起式联接_QDII_C", "2023-09-22", "候选：中韩半导体实际份额类别待确认"),
    ("022681", "华泰柏瑞中韩半导体ETF发起式联接_QDII_I", "2024-11-26", "候选：中韩半导体实际份额类别待确认"),
    ("022459", "易方达中证A500ETF联接A", "2024-11-11", "已记录A类"),
    ("006663", "易方达安悦超短债C", "2018-12-05", "已记录C类"),
    ("006485", "广发中债1-3年国开行债券指数C", "2018-11-14", "已记录C类"),
]


def fetch(url):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=30) as response:
                return response.read()
        except Exception:
            if attempt == 3:
                raise
            time.sleep(attempt + 1)


def number(value):
    if value in (None, "", "--", "---"):
        return None
    result = Decimal(str(value))
    if not result.is_finite():
        raise ValueError("Non-finite public NAV")
    return str(result)


def chart_rows(raw):
    text = raw.decode("utf-8-sig")
    def variable(name):
        match = re.search(r"var\s+" + name + r"\s*=\s*(\[.*?\]);", text, re.S)
        if not match:
            raise ValueError(f"Missing chart variable {name}")
        return json.loads(match.group(1))
    units = variable("Data_netWorthTrend")
    accum = {int(x): y for x, y in variable("Data_ACWorthTrend")}
    rows = []
    for item in units:
        stamp = int(item["x"])
        rows.append({
            "date": dt.datetime.fromtimestamp(stamp / 1000, TZ).date().isoformat(),
            "nav": number(item["y"]),
            "accumulated_nav": number(accum.get(stamp)),
            "daily_growth_pct": number(item.get("equityReturn")),
            "event": item.get("unitMoney", ""),
            "source": "天天基金 pingzhongdata",
        })
    return rows


def merge(target, rows):
    for row in rows:
        day = row["date"]
        previous = target.get(day)
        if previous and Decimal(previous["nav"]) != Decimal(row["nav"]):
            raise ValueError(f"Public NAV conflict on {day}")
        if previous:
            for key, value in row.items():
                if value is not None and value != "":
                    previous[key] = value
        else:
            target[day] = dict(row)


def load_local(directory, code):
    rows = {}
    sources = []
    if not directory.exists():
        return rows, sources
    for path in sorted(directory.glob("*.csv")):
        if "全部历史净值" not in path.name and path.name.startswith(code + "_"):
            continue
        with path.open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if "净值日期" not in (reader.fieldnames or []):
                continue
            batch = [{
                "date": r["净值日期"], "nav": number(r["单位净值"]),
                "accumulated_nav": number(r.get("累计净值")),
                "daily_growth_pct": number(r.get("日增长率(%)")),
                "event": r.get("分红送配", ""), "source": r.get("数据来源", "既有公开CSV"),
            } for r in reader]
        merge(rows, batch)
        sources.append(str(path.relative_to(ROOT)).replace("\\", "/"))
    for path in sorted(directory.glob("*公开净值原始数据*.js")):
        merge(rows, chart_rows(path.read_bytes()))
        sources.append(str(path.relative_to(ROOT)).replace("\\", "/"))
    for path in sorted(directory.glob(code + "_全部历史净值_截至*.json")):
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        if data.get("schema") == "public-fund-nav-v1":
            merge(rows, data["rows"])
            sources.append(str(path.relative_to(ROOT)).replace("\\", "/"))
    return rows, sources


def history_page(code, page=1, start="", end=""):
    url = API + "?" + urllib.parse.urlencode({
        "fundCode": code, "pageIndex": page, "pageSize": 20,
        "startDate": start, "endDate": end, "_": str(time.time_ns()),
    })
    raw = fetch(url)
    data = json.loads(raw)
    if data.get("ErrCode") != 0 or not isinstance(data.get("Data"), dict):
        raise ValueError(f"Invalid public history response: {code} page {page}")
    return data, {"url": url, "response": data}


def api_rows(data):
    return [{
        "date": row["FSRQ"], "nav": number(row["DWJZ"]),
        "accumulated_nav": number(row.get("LJJZ")),
        "daily_growth_pct": number(row.get("JZZZL")),
        "event": row.get("FHSP") or row.get("FHFCZ") or "",
        "source": "天天基金 f10/lsjz",
    } for row in data["Data"]["LSJZList"]]


def process(config):
    code, dirname, expected_first, holding_status = config
    matches = list((ROOT / "基金").glob("*/" + code + "_*"))
    if len(matches) > 1:
        raise ValueError(f"Duplicate fund directories: {code}")
    fund_dir = matches[0] if matches else ROOT / "基金" / "观察基金" / (code + "_" + dirname)
    directory = fund_dir / "历史净值"
    rows, reused = load_local(directory, code)
    previous_count = len(rows)
    head, raw_head = history_page(code)
    latest = head["Data"]["LSJZList"][0]["FSRQ"]
    # Pin queries to the same NAV date so intraday publication cannot shift pages.
    pinned, raw_pinned = history_page(code, end=latest)
    total = int(pinned["TotalCount"])
    pagesize = int(pinned["PageSize"])
    raws = [raw_head, raw_pinned]
    downloaded_rows = 0
    chart_archive = None
    if rows:
        last_local = max(rows)
        if last_local < latest:
            start = (dt.date.fromisoformat(last_local) + dt.timedelta(days=1)).isoformat()
            delta, raw = history_page(code, start=start, end=latest)
            raws.append(raw)
            delta_rows = api_rows(delta)
            count = int(delta["TotalCount"])
            for page in range(2, math.ceil(count / int(delta["PageSize"])) + 1):
                data, raw = history_page(code, page, start, latest)
                raws.append(raw)
                delta_rows.extend(api_rows(data))
            if len(delta_rows) != count:
                raise ValueError(f"Incremental count mismatch: {code}")
            downloaded_rows = len(delta_rows)
            merge(rows, delta_rows)
        action = "复用本地全历史，仅补新增日期" if downloaded_rows else "已有完整数据，跳过历史下载"
    else:
        chart_url = f"https://fund.eastmoney.com/pingzhongdata/{code}.js"
        chart_archive = fetch(chart_url)
        merge(rows, [r for r in chart_rows(chart_archive) if r["date"] <= latest])
        downloaded_rows = len(rows)
        action = "首次保存全历史"
    merge(rows, api_rows(pinned))
    # Check complete source count and representative historical pages.
    sample_pages = sorted({1, math.ceil(total / pagesize), max(1, math.ceil(total / pagesize / 2))})
    sample_count = 0
    for page in sample_pages:
        data, raw = history_page(code, page, end=latest)
        raws.append(raw)
        if int(data["TotalCount"]) != total:
            raise ValueError(f"History changed within pinned period: {code}")
        for sample in api_rows(data):
            if sample["date"] not in rows:
                merge(rows, [sample])
            elif Decimal(rows[sample["date"]]["nav"]) != Decimal(sample["nav"]):
                raise ValueError(f"Historical sample mismatch: {code} {sample['date']}")
            merge(rows, [sample])
            sample_count += 1
    if len(rows) != total:
        # The chart is not always complete (270023 is a known example).
        # Fetch the paginated source only when counts expose an actual gap.
        for page in range(1, math.ceil(total / pagesize) + 1):
            data, raw = history_page(code, page, end=latest)
            raws.append(raw)
            merge(rows, api_rows(data))
        action += "；按全量分页复核缺口"
    ordered = [rows[day] for day in sorted(rows)]
    if len(ordered) != total or ordered[0]["date"] != expected_first or ordered[-1]["date"] != latest:
        raise ValueError(f"Full-history coverage mismatch: {code}")
    if any(not r["nav"] or Decimal(r["nav"]) <= 0 for r in ordered):
        raise ValueError(f"Missing or invalid unit NAV: {code}")
    for row in ordered:
        if row.get("accumulated_nav") is None:
            data, raw = history_page(code, start=row["date"], end=row["date"])
            raws.append(raw)
            for found in api_rows(data):
                if found["date"] == row["date"]:
                    merge(rows, [found])
    search_url = "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=" + code
    search_raw = fetch(search_url)
    search = json.loads(search_raw)
    identity = next(r for r in search["Datas"] if r.get("CODE") == code)
    name = identity["NAME"]
    now = dt.datetime.now(TZ).isoformat(timespec="seconds")
    payload = {
        "schema": "public-fund-nav-v1", "code": code, "name": name,
        "holding_identity_status": holding_status, "downloaded_at": now,
        "first_date": ordered[0]["date"], "last_date": latest, "count": len(ordered),
        "source": "天天基金（东方财富），第三方公开基金净值，非管理人官方主档",
        "source_urls": [API + "?fundCode=" + code, f"https://fund.eastmoney.com/pingzhongdata/{code}.js", search_url],
        "reuse": {"files": reused, "previous_unique_dates": previous_count, "added_unique_dates": len(rows) - previous_count, "action": action},
        "validation": {"api_total_count": total, "unique_date_count": len(rows),
                       "duplicate_dates": 0, "sample_rows_checked": sample_count,
                       "earliest_date_checked": expected_first, "latest_pinned_date": latest,
                       "missing_accumulated_nav_count": sum(r.get("accumulated_nav") is None for r in ordered),
                       "note": "走势与F10为同一供应商的不同接口，属于同源交叉核验；不填充自然日，不插值，不把未披露日期视为缺失。"},
        "field_notes": {"nav": "公开单位净值，十进制原值字符串", "accumulated_nav": "公开累计净值；null表示来源缺失，不推算",
                        "daily_growth_pct": "来源日增长率的百分数原值，不代表用户账户收益率", "event": "来源分红等事件文字，不从单位净值推算总回报"},
        "rows": ordered,
    }
    directory.mkdir(parents=True, exist_ok=True)
    raw_dir = directory / "原始数据"
    raw_dir.mkdir(exist_ok=True)
    raw_path = raw_dir / f"{code}_净值接口核验与新增日期_{TODAY}.json"
    raw_path.write_text(json.dumps({"code": code, "downloaded_at": now, "requests": raws, "identity": identity}, ensure_ascii=False, indent=2), encoding="utf-8")
    if chart_archive is not None:
        (raw_dir / f"{code}_天天基金全历史净值走势_抓取{TODAY}.js").write_bytes(chart_archive)
    output = directory / f"{code}_全部历史净值_截至{latest}.json"
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    saved = json.loads(output.read_text(encoding="utf-8"))
    if saved["count"] != len(saved["rows"]):
        raise ValueError("Saved count mismatch")
    result = {"code": code, "name": name, "holding_identity_status": holding_status,
              "count": len(ordered), "first_date": ordered[0]["date"], "last_date": latest,
              "action": action, "reused_dates": previous_count,
              "added_dates": len(rows) - previous_count,
              "missing_accumulated_nav_count": payload["validation"]["missing_accumulated_nav_count"],
              "json_file": str(output.relative_to(ROOT)).replace("\\", "/"),
              "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codes", nargs="*", help="Only update these public fund codes")
    args = parser.parse_args()
    selected = [config for config in FUNDS if args.codes is None or config[0] in args.codes]
    if args.codes and set(args.codes) - {c[0] for c in FUNDS}:
        raise ValueError("Unknown fund code")
    SUMMARY.mkdir(parents=True, exist_ok=True)
    output = SUMMARY / f"持仓基金全历史净值归档清单_{TODAY}.json"
    previous = json.loads(output.read_text(encoding="utf-8")) if output.exists() else {}
    selected_codes = {config[0] for config in selected}
    allowed_codes = {config[0] for config in FUNDS}
    results = [r for r in previous.get("results", []) if r["code"] in allowed_codes and r["code"] not in selected_codes]
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(process, config): config[0] for config in selected}
        for future in concurrent.futures.as_completed(futures):
            code = futures[future]
            try:
                results.append(future.result())
            except Exception as exc:
                failures.append({"code": code, "error": str(exc)})
                print(json.dumps({"code": code, "error": str(exc)}, ensure_ascii=False), flush=True)
    # Preserve the already synced official archive and its separately sourced supplements.
    gf_path = next((ROOT / "基金").glob("*/270023*/历史净值/270023_全部历史净值_截至*.json"))
    gf = json.loads(gf_path.read_text(encoding="utf-8-sig"))
    results.append({"code": "270023", "name": gf["name"], "holding_identity_status": "已记录人民币A类",
                    "count": gf["count"], "first_date": gf["first_date"], "last_date": gf["last_date"],
                    "action": "复用云端同步的管理人全历史主档；未重复下载", "added_dates": 0,
                    "json_file": str(gf_path.relative_to(ROOT)).replace("\\", "/"),
                    "supplement_note": "另有10条既有第三方记录单独留存；不混入官网主表",
                    "sha256": hashlib.sha256(gf_path.read_bytes()).hexdigest()})
    results.sort(key=lambda x: x["code"])
    manifest = {**previous, "checked_at": dt.datetime.now(TZ).isoformat(timespec="seconds"),
                "holdings_snapshot_date": "2026-09-20", "holdings_last_partial_update": "2026-09-28",
                "holdings_product_count": 14,
                "included_product_count": 12,
                "excluded_products": [
                    {"code": "019736", "name": "宝盈纳斯达克100指数发起(QDII)A人民币"},
                    {"code": "019547", "name": "招商纳斯达克100ETF发起式联接(QDII)A"},
                ],
                "exclusion_reason": "用户2026-10-16明确：纳指的都不用",
                "scope_note": "依据同步后的既有14个基金产品记录，按用户要求排除2个纳指产品后覆盖12个产品，不代表2026-10-16账户已重新核对。国富与中韩半导体份额类别仍未确认，候选类别各自单独归档，不改变实际持仓身份。",
                "series_count": len(results), "results": results, "failures": failures}
    output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"completed_series": len(results), "failures": failures, "manifest": str(output)}, ensure_ascii=False))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
