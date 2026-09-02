from __future__ import annotations

import html
import json
import math
import re
import statistics
import sys
import urllib.request
from collections import Counter, defaultdict
from datetime import date, datetime
from html.parser import HTMLParser
from pathlib import Path

from pypdf import PdfReader


FUND_CODE = "005698"
BASE_DIR = Path(__file__).resolve().parents[1]
ROOT = BASE_DIR / "定期报告"
CACHE = BASE_DIR / "临时资料" / "报告分析" / "005698_extracted"
OUTPUT = BASE_DIR / "临时资料" / "报告分析" / "005698_analysis.json"
HEADERS = {
    "Referer": "https://fundf10.eastmoney.com/",
    "User-Agent": "Mozilla/5.0",
}


def fetch_text(url: str) -> str:
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read().decode("utf-8", "ignore")


class TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.tables: list[list[list[str]]] = []
        self.table: list[list[str]] | None = None
        self.row: list[str] | None = None
        self.cell: list[str] | None = None

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag == "table":
            self.table = []
        elif tag == "tr" and self.table is not None:
            self.row = []
        elif tag in {"td", "th"} and self.row is not None:
            self.cell = []
        elif tag == "br" and self.cell is not None:
            self.cell.append(" ")

    def handle_data(self, data: str) -> None:
        if self.cell is not None:
            self.cell.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"td", "th"} and self.cell is not None and self.row is not None:
            self.row.append(re.sub(r"\s+", " ", "".join(self.cell)).strip())
            self.cell = None
        elif tag == "tr" and self.row is not None and self.table is not None:
            if any(self.row):
                self.table.append(self.row)
            self.row = None
        elif tag == "table" and self.table is not None:
            if self.table:
                self.tables.append(self.table)
            self.table = None


def parse_tables(markup: str) -> list[list[list[str]]]:
    parser = TableParser()
    parser.feed(html.unescape(markup))
    return parser.tables


def extract_js_content(source: str) -> str:
    match = re.search(r"content:\"(.*?)\"\s*,\s*(?:summary|arryear|data|curyear)", source, re.S)
    if not match:
        match = re.search(r"content:\"(.*?)\"\s*}\s*;?\s*$", source, re.S)
    if not match:
        raise ValueError("无法提取 FundArchivesDatas content")
    return match.group(1).replace(r'\"', '"').replace(r"\/", "/")


def number(value: str | None) -> float | None:
    if value is None:
        return None
    cleaned = value.replace(",", "").replace("%", "").strip()
    if cleaned in {"", "---", "--", "-"}:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def get_nav_history() -> list[dict[str, object]]:
    requested_page_size = 20
    first = json.loads(
        fetch_text(
            "https://api.fund.eastmoney.com/f10/lsjz"
            f"?fundCode={FUND_CODE}&pageIndex=1&pageSize={requested_page_size}&startDate=&endDate="
        )
    )
    total = first["TotalCount"]
    page_size = first.get("PageSize") or len(first["Data"]["LSJZList"])
    pages = math.ceil(total / page_size)
    rows = list(first["Data"]["LSJZList"])
    for page in range(2, pages + 1):
        payload = json.loads(
            fetch_text(
                "https://api.fund.eastmoney.com/f10/lsjz"
                f"?fundCode={FUND_CODE}&pageIndex={page}&pageSize={requested_page_size}&startDate=&endDate="
            )
        )
        rows.extend(payload["Data"]["LSJZList"])
    return sorted(
        (
            {
                "date": row["FSRQ"],
                "nav": float(row["DWJZ"]),
                "daily_pct": number(row.get("JZZZL")),
            }
            for row in rows
            if row.get("DWJZ")
        ),
        key=lambda item: item["date"],
    )


def performance_stats(nav_rows: list[dict[str, object]]) -> dict[str, object]:
    values = [(datetime.strptime(row["date"], "%Y-%m-%d").date(), row["nav"]) for row in nav_rows]
    returns = [values[i][1] / values[i - 1][1] - 1 for i in range(1, len(values))]
    annualized_vol = statistics.stdev(returns) * math.sqrt(250) if len(returns) > 1 else None

    peak_value = values[0][1]
    peak_date = values[0][0]
    max_dd = 0.0
    max_dd_peak = peak_date
    max_dd_trough = peak_date
    for current_date, current_value in values:
        if current_value > peak_value:
            peak_value = current_value
            peak_date = current_date
        drawdown = current_value / peak_value - 1
        if drawdown < max_dd:
            max_dd = drawdown
            max_dd_peak = peak_date
            max_dd_trough = current_date

    recovery_date: date | None = None
    peak_nav = next(v for d, v in values if d == max_dd_peak)
    for current_date, current_value in values:
        if current_date > max_dd_trough and current_value >= peak_nav:
            recovery_date = current_date
            break

    by_year: dict[int, list[tuple[date, float]]] = defaultdict(list)
    for item in values:
        by_year[item[0].year].append(item)
    calendar: dict[str, dict[str, object]] = {}
    prior_nav = values[0][1]
    for year in sorted(by_year):
        series = by_year[year]
        year_return = series[-1][1] / prior_nav - 1
        intra_peak = series[0][1]
        intra_peak_date = series[0][0]
        year_dd = 0.0
        year_dd_peak = intra_peak_date
        year_dd_trough = intra_peak_date
        for current_date, current_value in series:
            if current_value > intra_peak:
                intra_peak = current_value
                intra_peak_date = current_date
            dd = current_value / intra_peak - 1
            if dd < year_dd:
                year_dd = dd
                year_dd_peak = intra_peak_date
                year_dd_trough = current_date
        calendar[str(year)] = {
            "return_pct": round(year_return * 100, 2),
            "max_drawdown_pct": round(year_dd * 100, 2),
            "drawdown_peak": str(year_dd_peak),
            "drawdown_trough": str(year_dd_trough),
            "year_end_nav": series[-1][1],
        }
        prior_nav = series[-1][1]

    cagr = (values[-1][1] / values[0][1]) ** (365.25 / (values[-1][0] - values[0][0]).days) - 1
    return {
        "start": str(values[0][0]),
        "end": str(values[-1][0]),
        "start_nav": values[0][1],
        "end_nav": values[-1][1],
        "cumulative_pct": round((values[-1][1] / values[0][1] - 1) * 100, 2),
        "cagr_pct": round(cagr * 100, 2),
        "annualized_vol_pct": round(annualized_vol * 100, 2),
        "max_drawdown_pct": round(max_dd * 100, 2),
        "max_drawdown_peak": str(max_dd_peak),
        "max_drawdown_trough": str(max_dd_trough),
        "max_drawdown_recovery": str(recovery_date) if recovery_date else None,
        "best_day_pct": round(max(returns) * 100, 2),
        "best_day_date": str(values[returns.index(max(returns)) + 1][0]),
        "worst_day_pct": round(min(returns) * 100, 2),
        "worst_day_date": str(values[returns.index(min(returns)) + 1][0]),
        "calendar_year": calendar,
    }


def get_scale() -> list[dict[str, object]]:
    source = fetch_text(
        "https://fundf10.eastmoney.com/FundArchivesDatas.aspx"
        f"?type=gmbd&mode=0&code={FUND_CODE}"
    )
    match = re.search(r',\s*"?data"?\s*:\s*(\[.*\])\s*};\s*$', source, re.S)
    if not match:
        raise ValueError("无法提取规模变动数据")
    rows = json.loads(match.group(1))
    output = []
    for row in rows:
        if not re.fullmatch(r"20\d{2}-\d{2}-\d{2}", str(row.get("FSRQ", ""))):
            continue
        combined = row.get("QMJZC")
        if not isinstance(combined, (int, float)):
            combined = row.get("NETNAV")
        output.append(
            {
                "date": row["FSRQ"],
                "subscriptions_shares": row.get("QJSG"),
                "redemptions_shares": row.get("QJSH"),
                "end_shares_a": row.get("QMZFE"),
                "net_assets_a": row.get("NETNAV"),
                "net_assets_combined": combined,
                "net_asset_change_pct": number(str(row.get("CHANGE", ""))),
            }
        )
    return output


def get_asset_allocation() -> list[dict[str, object]]:
    markup = fetch_text(f"https://fundf10.eastmoney.com/zcpz_{FUND_CODE}.html")
    tables = parse_tables(markup)
    target = next(table for table in tables if table and table[0] and table[0][0] == "报告期")
    headers = target[0]
    output = []
    for row in target[1:]:
        item = dict(zip(headers, row))
        output.append(
            {
                "date": item["报告期"],
                "equity_pct_nav": number(item.get("股票占净比")),
                "bond_pct_nav": number(item.get("债券占净比")),
                "cash_pct_nav": number(item.get("现金占净比")),
                "depositary_receipt_pct_nav": number(item.get("存托凭证占净比")),
                "net_assets_100m": number(item.get("净资产（亿元）")),
            }
        )
    return output


def get_holder_structure() -> list[dict[str, object]]:
    source = fetch_text(
        "https://fundf10.eastmoney.com/FundArchivesDatas.aspx"
        f"?type=cyrjg&code={FUND_CODE}"
    )
    tables = parse_tables(extract_js_content(source))
    target = tables[0]
    headers = target[0]
    output = []
    for row in target[1:]:
        item = dict(zip(headers, row))
        output.append(
            {
                "date": item["公告日期"],
                "institution_pct": number(item.get("机构持有比例")),
                "individual_pct": number(item.get("个人持有比例")),
                "insider_pct": number(item.get("内部持有比例")),
                "shares_100m": number(item.get("总份额（亿份）")),
            }
        )
    return output


def get_turnover() -> list[dict[str, object]]:
    payload = json.loads(
        fetch_text(
            "https://api.fund.eastmoney.com/f10/JJHSL/"
            f"?fundcode={FUND_CODE}&pageindex=1&pagesize=100"
        )
    )
    return [
        {"date": row["REPORTDATE"], "stock_turnover_pct": row["STOCKTURNOVER"]}
        for row in payload["Data"]
    ]


def get_industry_allocation() -> list[dict[str, object]]:
    output = []
    for year in range(2018, 2027):
        payload = json.loads(
            fetch_text(
                "https://api.fund.eastmoney.com/f10/HYPZ/"
                f"?fundCode={FUND_CODE}&year={year}"
            )
        )
        for quarter in payload["Data"]["QuarterInfos"]:
            output.append(
                {
                    "date": quarter["JZRQ"],
                    "industries": {
                        item["HYMC"]: number(item["ZJZBLDesc"])
                        for item in quarter["HYPZInfo"]
                    },
                }
            )
    return sorted(output, key=lambda item: item["date"], reverse=True)


def get_quarter_returns() -> list[dict[str, object]]:
    source = fetch_text(
        "https://fundf10.eastmoney.com/FundArchivesDatas.aspx"
        f"?type=jdndzf&code={FUND_CODE}"
    )
    tables = parse_tables(extract_js_content(source))
    target = tables[0]
    headers = target[0]
    output = []
    for row in target[1:]:
        item = dict(zip(headers, row))
        year = re.search(r"20\d{2}", item["时间"]).group(0)
        for quarter in range(1, 5):
            value = number(item.get(f"{quarter}季度涨幅"))
            if value is not None:
                output.append({"year": int(year), "quarter": quarter, "return_pct": value})
    return output


def get_top_holdings() -> list[dict[str, object]]:
    output = []
    for year in range(2018, 2027):
        source = fetch_text(
            "https://fundf10.eastmoney.com/FundArchivesDatas.aspx"
            f"?type=jjcc&code={FUND_CODE}&topline=10&year={year}&month="
        )
        markup = extract_js_content(source)
        pattern = re.compile(
            r"截止至[:：]<font[^>]*>(20\d{2}-\d{2}-\d{2})</font>.*?"
            r"(<table.*?</table>)",
            re.S,
        )
        for match in pattern.finditer(markup):
            report_date = match.group(1)
            table = parse_tables(match.group(2))[0]
            headers = table[0]
            holdings = []
            for row in table[1:]:
                item = dict(zip(headers, row))
                holdings.append(
                    {
                        "rank": number(item.get("序号")),
                        "code": item.get("股票代码"),
                        "name": item.get("股票名称"),
                        "nav_pct": number(item.get("占净值比例")),
                        "market_value_10k": number(
                            item.get("持仓市值（万元人民币）")
                            or item.get("持股市值（万元）")
                        ),
                    }
                )
            output.append({"date": report_date, "holdings": holdings})
    dedup = {item["date"]: item for item in output}
    return [dedup[key] for key in sorted(dedup, reverse=True)]


def extract_pdf_corpus() -> list[dict[str, object]]:
    CACHE.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((ROOT / "定期报告目录.json").read_text(encoding="utf-8"))
    reports = []
    for item in manifest["报告"]:
        if item["是否摘要版"] == "是":
            continue
        pdf_path = ROOT / item["相对路径"]
        text_path = CACHE / f"{item['公告ID']}.txt"
        if text_path.exists():
            text = text_path.read_text(encoding="utf-8")
        else:
            reader = PdfReader(pdf_path)
            text = "\n".join(page.extract_text() or "" for page in reader.pages)
            text_path.write_text(text, encoding="utf-8")

        normalized = re.sub(r"[ \t]+", " ", text)
        strategy_match = re.search(
            r"(?:4\.4\.1|4\.4)\s*报告期内基金(?:的)?投资策略和运作分析(.*?)"
            r"(?:4\.4\.2\s*报告期内基金(?:的)?业绩表现|4\.5\s)",
            normalized,
            re.S,
        )
        period_return_match = re.search(
            r"本报告期份额净值增长率为\s*([-\d.]+)%.*?"
            r"同期业绩比较基准(?:增长率|收益率)为\s*([-\d.]+)%",
            normalized,
            re.S,
        )
        one_year_match = re.search(
            r"过去一年\s+([-\d.]+)%\s+[-\d.]+%\s+([-\d.]+)%",
            normalized,
        )
        country_section = ""
        country_match = re.search(
            r"在各个国家（地区）证券市场(?:的股票及存托凭证|的权益|的股票)投资分布(.*?)"
            r"(?:按行业分类|期末按行业分类)",
            normalized,
            re.S,
        )
        if country_match:
            country_section = country_match.group(1)[:2500]
        reports.append(
            {
                "title": item["公告标题"],
                "publish_date": item["公告日期"],
                "report_year": item["报告年度"],
                "announcement_id": item["公告ID"],
                "relative_path": item["相对路径"],
                "pages": item["页数"],
                "period_return_pct": number(period_return_match.group(1)) if period_return_match else None,
                "period_benchmark_pct": number(period_return_match.group(2)) if period_return_match else None,
                "one_year_return_pct": number(one_year_match.group(1)) if one_year_match else None,
                "one_year_benchmark_pct": number(one_year_match.group(2)) if one_year_match else None,
                "strategy_text": strategy_match.group(1).strip() if strategy_match else "",
                "country_section": country_section.strip(),
                "mentions_leveraged_funds": bool(
                    re.search(r"Direxion|Bull 3X|2x Leveraged|3x Leveraged", normalized, re.I)
                ),
            }
        )
    return reports


def strategy_topics(reports: list[dict[str, object]]) -> dict[str, object]:
    topics = {
        "云计算": ["云计算", "云端"],
        "半导体": ["半导体", "芯片"],
        "人工智能": ["人工智能", "AI"],
        "大平台/互联网": ["平台", "互联网"],
        "新能源车": ["电动车", "新能源车", "新能源汽车"],
        "软件/SaaS": ["软件", "SaaS"],
        "光通信": ["光通信", "光模块"],
        "存储": ["存储", "HBM"],
        "现金/仓位管理": ["现金", "仓位"],
        "估值": ["估值"],
    }
    counts: Counter[str] = Counter()
    by_year: dict[str, Counter[str]] = defaultdict(Counter)
    for report in reports:
        text = report["strategy_text"]
        for topic, words in topics.items():
            count = sum(text.lower().count(word.lower()) for word in words)
            if count:
                counts[topic] += count
                by_year[report["report_year"]][topic] += count
    return {
        "total_mentions": dict(counts.most_common()),
        "by_year": {year: dict(counter.most_common()) for year, counter in sorted(by_year.items())},
    }


def main() -> int:
    ROOT.mkdir(exist_ok=True)
    nav_history = get_nav_history()
    reports = extract_pdf_corpus()
    result = {
        "fund_code": FUND_CODE,
        "report_files": 55,
        "non_summary_reports": len(reports),
        "nav_performance": performance_stats(nav_history),
        "quarter_returns": get_quarter_returns(),
        "scale": get_scale(),
        "asset_allocation": get_asset_allocation(),
        "holder_structure": get_holder_structure(),
        "turnover": get_turnover(),
        "industry_allocation": get_industry_allocation(),
        "top_holdings": get_top_holdings(),
        "report_extracts": reports,
        "strategy_topics": strategy_topics(reports),
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "output": str(OUTPUT.resolve()),
        "non_summary_reports": len(reports),
        "nav_performance": result["nav_performance"],
        "turnover": result["turnover"],
        "latest_scale": result["scale"][0],
        "latest_asset_allocation": result["asset_allocation"][0],
        "latest_holdings": result["top_holdings"][0],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
