"""Compare public RMB A NAVs only. No personal account inputs or amounts."""

import sys
sys.dont_write_bytecode = True
import calendar
import json
import statistics
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CODES = ("006373", "005698")
FETCH_DATE = "2026-09-28"
data = {}
for code in CODES:
    path = next((ROOT / "基金").glob(f"*/{code}*/历史净值/{code}_公开日净值_抓取{FETCH_DATE}.json"))
    rows = json.loads(path.read_text(encoding="utf-8"))
    assert all(r["nav"] > 0 and not r["event"] for r in rows), "Reinvestment adjustment required"
    data[code] = {r["date"]: r["nav"] for r in rows}
    assert len(data[code]) == len(rows), "Duplicate NAV dates"
    for previous, row in zip(rows, rows[1:]):
        if row["date"] >= "2021-09-23":
            assert abs((row["nav"] / previous["nav"] - 1) * 100 - row["growth_pct"]) < 0.03

common = sorted(set(data[CODES[0]]) & set(data[CODES[1]]))
end = common[-1]


def anniversary(value, years):
    d = date.fromisoformat(value)
    y = d.year - years
    return date(y, d.month, min(d.day, calendar.monthrange(y, d.month)[1])).isoformat()


def at_or_before(value):
    return max(d for d in common if d <= value)


def metrics(code, start, finish):
    rows = sorted((d, v) for d, v in data[code].items() if start <= d <= finish)
    peak_date, peak = rows[0]
    drawdown = 0.0
    worst_peak, trough, worst_peak_value = peak_date, peak_date, peak
    for d, value in rows:
        if value > peak:
            peak_date, peak = d, value
        decline = value / peak - 1
        if decline < drawdown:
            drawdown = decline
            worst_peak, trough, worst_peak_value = peak_date, d, peak
    recovery = next((d for d, v in rows if d > trough and v >= worst_peak_value), None)
    growth = rows[-1][1] / rows[0][1] - 1
    years = (date.fromisoformat(finish) - date.fromisoformat(start)).days / 365.25
    return {
        "start": start, "end": finish,
        "return_pct": round(growth * 100, 4),
        "annualized_pct": round(((1 + growth) ** (1 / years) - 1) * 100, 4),
        "maximum_drawdown_pct": round(drawdown * 100, 4),
        "peak_date": worst_peak, "trough_date": trough, "recovery_date": recovery,
        "nav_observations": len(rows),
    }


windows = {str(n): {c: metrics(c, at_or_before(anniversary(end, n)), end) for c in CODES}
           for n in (1, 3, 5, 7)}
annual = {}
for y in range(2019, 2027):
    start, finish = at_or_before(f"{y - 1}-12-31"), at_or_before(f"{y}-12-31")
    annual[str(y)] = {c: round((data[c][finish] / data[c][start] - 1) * 100, 4) for c in CODES}

# Independent checks against the funds' disclosed 2025 annual and 2026 interim reports.
checks = [("2025-12-31", 3, 142.46, 146.00), ("2025-12-31", 5, 104.79, 44.83),
          ("2026-06-30", 3, 245.60, 224.71), ("2026-06-30", 5, 235.79, 160.64)]
for finish, n, expected_guofu, expected_huaxia in checks:
    start = at_or_before(anniversary(finish, n))
    for c, expected in zip(CODES, (expected_guofu, expected_huaxia)):
        actual = (data[c][finish] / data[c][start] - 1) * 100
        assert abs(actual - expected) < 0.02, (c, finish, n, actual, expected)

month_ends = {d[:7]: d for d in common}
rolling = {}
for n in (3, 5):
    samples = []
    for finish in month_ends.values():
        if finish[:7] == end[:7]:
            continue  # Exclude the unfinished current month.
        target = anniversary(finish, n)
        if target < common[0]:
            continue
        start = at_or_before(target)
        samples.append({"start": start, "end": finish,
                        "funds": {c: metrics(c, start, finish) for c in CODES}})
    rolling[str(n)] = {
        "count": len(samples),
        "guofu_outperformance_percent": round(100 * sum(
            s["funds"]["006373"]["return_pct"] > s["funds"]["005698"]["return_pct"]
            for s in samples) / len(samples), 2),
        "median_annualized_pct": {c: round(statistics.median(
            s["funds"][c]["annualized_pct"] for s in samples), 2) for c in CODES},
        "samples": samples,
    }

out = ROOT / "公共资料" / "投资研究"
result = {"data_as_of": end, "fetched_at": FETCH_DATE, "share_classes": "人民币A",
          "sources": {c: f"https://fund.eastmoney.com/pingzhongdata/{c}.js" for c in CODES},
          "method": "NAV ratio; no distribution/split events found; annualization uses actual days/365.25; maximum drawdown from own daily observations within the common date range; net of fund expenses, before investor subscription/redemption fees.",
          "windows": windows, "calendar_returns": annual, "rolling_month_end": rolling}
(out / f"006373_005698_公开净值比较_截至{end}.json").write_text(
    json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

lines = [f"# 006373 与 005698 长期回报比较：截至 {end}", "",
         "核验日期：2026-09-28。仅比较公开基金人民币A类净值，不涉及个人账户收益或金额。",
         "最新共同净值日为2026-09-23，不代表9月28日已公布净值。", "",
         "| 期间 | 国富累计 | 国富年化 | 华夏累计 | 华夏年化 |", "|---|---:|---:|---:|---:|"]
for n in (1, 3, 5, 7):
    a, b = (windows[str(n)][c] for c in CODES)
    lines.append(f"| 近{n}年 | {a['return_pct']:.2f}% | {a['annualized_pct']:.2f}% | {b['return_pct']:.2f}% | {b['annualized_pct']:.2f}% |")
lines += ["", "三年实际区间为2023-09-22至2026-09-23；其他区间起止日均为相应年份9月23日。",
          "年化为复合年化，按实际天数/365.25计算；不是累计收益简单除以年数。",
          "净值已扣基金运作费用，未扣投资者申购赎回费。原始净值无分红拆分事件，且与年度、中期报告的3年及5年收益交叉核验一致。", "",
          "| 最大回撤观察窗口 | 国富 | 华夏 |", "|---|---:|---:|"]
for n in (1, 5, 7):
    a, b = (windows[str(n)][c] for c in CODES)
    lines.append(f"| 近{n}年 | {a['maximum_drawdown_pct']:.2f}% | {b['maximum_drawdown_pct']:.2f}% |")
lines += ["", "最大回撤是所选区间内基金净值从此前高点到低点的最大跌幅，不是全年收益或个人损失。近5年起点不包含华夏2021年2月高点，故不能将其近5年回撤视为全部历史最深回撤。", "",
          "| 年度 | 国富 | 华夏 |", "|---|---:|---:|"]
for y in range(2021, 2026):
    lines.append(f"| {y} | {annual[str(y)]['006373']:.2f}% | {annual[str(y)]['005698']:.2f}% |")
lines += ["", "国富5年及7年同区间回报更高、最大回撤较小，但不是每年或所有区间领先。华夏2023、2024年更强；截至2025年底的3年累计为华夏146.00%、国富142.46%。",
          "这比较的是产品整体结果，不能将差异全部归因于地区配置，也不能拆分为基金经理个人贡献。国富历史结果主要属于双经理阶段；2026-09-19起狄星华单独管理。",
          "用户本轮明确优先降低A股地区暴露。结合6月底披露的地区结构，国富更贴合该目标；其合同并不保证永久低A股仓位，历史收益也不构成未来3—5年收益预测。", "",
          "## 月末滚动持有期检验", "",
          "滚动起点以相应周年日或之前最近共同净值日为准，排除2026年9月未完成月份。"]
for n in (3, 5):
    r = rolling[str(n)]
    lines.append(f"- {n}年：{r['count']}个重叠样本，国富回报高于华夏的样本占比约{r['guofu_outperformance_percent']:.0f}%；年化中位数分别约{r['median_annualized_pct']['006373']:.1f}%、{r['median_annualized_pct']['005698']:.1f}%。")
lines += ["", "样本高度重叠、历史长度有限，以上样本占比不是未来胜率；未进行前瞻回测。", "",
          "## 来源与复核", "",
          "- 原始日净值：东方财富公开净值脚本，两个基金分别归档于各自历史净值目录。",
          "- 国富2025年报：https://www.ftsfund.com/ftp/upload/file/202603/30/JzlR7ZoIt3tT9pxi.pdf",
          "- 华夏2025年报：https://www.chinaamc.com/upload/resources/file/2026/03/31/912d5837f27547eebe0628e1a5d8b8c2.pdf",
          "- 国富2026中报：https://www.niuniufund.com/fund-notice-info.aspx?nid=750168",
          "- 华夏2026中报：本地2026-08-31原始PDF。",
          "- 最新华夏官网净值与3、5年收益：https://m.chinaamc.com/fund/005698/index.shtml",
          "- 计算脚本：工具脚本/compare_006373_005698.py。",
          "- 两份年报的收益表、年度表现图经原PDF渲染核对；八项定期报告累计收益核验通过。", ""]
report = out / f"006373_005698_长期回报比较_截至{end}.md"
report.write_text("\n".join(lines), encoding="utf-8")
print(json.dumps({"report": str(report), "data_as_of": end, "validation_checks": 8,
                  "rolling_samples": {n: r["count"] for n, r in rolling.items()}}, ensure_ascii=False))
