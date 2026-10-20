"""Public NAV-only backtest. Never reads or stores private account amounts.

Initial fund value is normalized to 1. Sale proceeds remain as zero-yield cash.
Lag scenarios are sensitivity assumptions, not reconstructed historical fills.
Run with Python; matplotlib is optional and only needed for the chart.
"""

import json
import math
from datetime import datetime
from pathlib import Path

FUND_DIR = Path(__file__).resolve().parents[1]
INPUT = FUND_DIR / "历史净值/270023_2026官网公开净值_核验2026-10-16.json"
OUT = FUND_DIR / "研究"
STEM = "270023_涨跌15重置基准回测_截至2026-10-14"


def drawdowns(values):
    peak = values[0]
    result = []
    for value in values:
        peak = max(peak, value)
        result.append(value / peak - 1)
    return result


def simulate(rows, lag=0):
    quantity = 1 / rows[0]["nav"]
    cash = 0.0
    anchor_nav = rows[0]["nav"]
    anchor_value = 1.0
    pending = None
    trades, equity, weights, anchors = [], [], [], []

    def execute(order, row):
        nonlocal quantity, cash, anchor_nav, anchor_value
        previous_nav, previous_value = anchor_nav, anchor_value
        pre_equity = quantity * row["nav"] + cash
        if order["side"] == "sell":
            trade_value = quantity * row["nav"] * .10
            quantity *= .90
            cash += trade_value
        else:
            trade_value = anchor_value * .15
            # No implicit borrowing or undisclosed external cash flow.
            if trade_value > cash + 1e-10:
                raise ValueError("Insufficient strategy cash; needs explicit financing model")
            quantity += trade_value / row["nav"]
            cash -= trade_value
        assert math.isclose(quantity * row["nav"] + cash, pre_equity, abs_tol=1e-10)
        anchor_nav = row["nav"]
        anchor_value = quantity * row["nav"]
        trades.append({
            "signal_date": order["date"], "execution_date": row["date"],
            "direction": order["side"], "signal_nav": order["nav"],
            "execution_nav": row["nav"], "previous_anchor_nav": previous_nav,
            "signal_return_pct": round((order["nav"] / previous_nav - 1) * 100, 4),
            "trade_value_pct_of_initial": round(trade_value * 100, 4),
            "previous_anchor_holding_pct_of_initial": round(previous_value * 100, 4),
            "new_anchor_holding_pct_of_initial": round(anchor_value * 100, 4),
            "new_anchor_nav": anchor_nav,
        })

    for i, row in enumerate(rows):
        executed = False
        if pending and pending["due"] == i:
            execute(pending, row)
            pending, executed = None, True
        if pending is None and not executed:
            change = row["nav"] / anchor_nav - 1
            if change >= .15 - 1e-12 or change <= -.15 + 1e-12:
                pending = {"date": row["date"], "nav": row["nav"],
                           "side": "sell" if change > 0 else "buy", "due": i + lag}
                if lag == 0:
                    execute(pending, row)
                    pending = None
        total = quantity * row["nav"] + cash
        equity.append(total)
        weights.append(quantity * row["nav"] / total)
        anchors.append(anchor_nav)

    dd = drawdowns(equity)
    trough = min(range(len(dd)), key=dd.__getitem__)
    peak = max(range(trough + 1), key=equity.__getitem__)
    assert all(0 <= w <= 1 + 1e-10 for w in weights)
    assert sum(t["direction"] == "sell" for t in trades) == 3
    assert sum(t["direction"] == "buy" for t in trades) == 1
    return {
        "lag_nav_observations": lag, "return_pct": round((equity[-1] - 1) * 100, 4),
        "maximum_drawdown_pct": round(-min(dd) * 100, 4),
        "max_drawdown_peak_date": rows[peak]["date"],
        "max_drawdown_trough_date": rows[trough]["date"],
        "end_fund_weight_pct": round(weights[-1] * 100, 4),
        "end_cash_weight_pct": round((1 - weights[-1]) * 100, 4),
        "end_fund_value_pct_of_initial": round(quantity * rows[-1]["nav"] * 100, 4),
        "end_cash_pct_of_initial": round(cash * 100, 4),
        "external_capital_added": False, "trades": trades,
        "pending_order": pending,
        "daily": [{"date": r["date"], "nav": r["nav"],
                   "return_pct": round((v - 1) * 100, 4),
                   "drawdown_pct": round(d * 100, 4),
                   "fund_weight_pct": round(w * 100, 4), "anchor_nav": a}
                  for r, v, d, w, a in zip(rows, equity, dd, weights, anchors)],
    }


def make_chart(rows, cases, hold, hold_dd, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    from matplotlib import font_manager
    font_path = Path("C:/Windows/Fonts/msyh.ttc")
    if font_path.exists():
        font_manager.fontManager.addfont(str(font_path))
        plt.rcParams["font.family"] = font_manager.FontProperties(fname=str(font_path)).get_name()
    plt.rcParams["axes.unicode_minus"] = False
    dates = [datetime.fromisoformat(r["date"]) for r in rows]
    fig, axes = plt.subplots(2, 1, figsize=(13.5, 8.5), sharex=True,
                             gridspec_kw={"height_ratios": [2, 1]})
    fig.set_facecolor("#f6f7f9")
    colors = ["#17706b", "#92a4b5", "#7955a0"]
    for ax in axes:
        ax.set_facecolor("#ffffff")
        ax.spines[["top", "right"]].set_visible(False)
        ax.spines[["left", "bottom"]].set_color("#d7dce3")
        ax.tick_params(colors="#596775", labelsize=10)
        ax.grid(axis="y", color="#e7ebef", lw=.8)
    axes[0].plot(dates, [(v - 1) * 100 for v in hold], color="#da8b3c", lw=2,
                 label=f"持续持有  +{(hold[-1]-1)*100:.2f}%")
    for index in [0, 2]:
        case = cases[index]
        label = "规则：理想同净值成交" if index == 0 else "规则：滞后2个净值日"
        axes[0].plot(dates, [r["return_pct"] for r in case["daily"]], color=colors[index],
                     lw=2.3 if index == 0 else 1.5, ls="-" if index == 0 else "--",
                     label=f"{label}  +{case['return_pct']:.2f}%")
    by_date = {r["date"]: r["return_pct"] for r in cases[0]["daily"]}
    for k, trade in enumerate(cases[0]["trades"]):
        x = datetime.fromisoformat(trade["execution_date"])
        y = by_date[trade["execution_date"]]
        sell = trade["direction"] == "sell"
        axes[0].scatter(x, y, marker="v" if sell else "^", s=68,
                        color="#b9544d" if sell else "#17706b", zorder=5)
        text = trade["execution_date"][5:] + (" 减仓10%" if sell else " 加仓15%")
        axes[0].annotate(text, (x, y), xytext=(0, 15 if k != 1 else -24),
                         textcoords="offset points", ha="center", fontsize=9, color="#344553")
    axes[0].set_ylabel("含现金的累计收益（%）", color="#344553")
    axes[0].legend(frameon=False, fontsize=9.5, loc="upper left")
    axes[1].fill_between(dates, [d * 100 for d in hold_dd], 0, color="#da8b3c", alpha=.15)
    axes[1].plot(dates, [d * 100 for d in hold_dd], color="#da8b3c", lw=1.6,
                 label=f"持续持有最大回撤 {min(hold_dd)*-100:.2f}%")
    axes[1].plot(dates, [r["drawdown_pct"] for r in cases[0]["daily"]], color=colors[0], lw=2,
                 label=f"规则理想模型最大回撤 {cases[0]['maximum_drawdown_pct']:.2f}%")
    axes[1].set_ylabel("距历史高点回撤（%）", color="#344553")
    axes[1].legend(frameon=False, fontsize=9, loc="lower left")
    axes[1].xaxis.set_major_locator(mdates.MonthLocator())
    axes[1].xaxis.set_major_formatter(mdates.DateFormatter("%m月"))
    fig.suptitle("广发全球精选人民币A · 涨跌15%后重置基准", x=.08, y=.97,
                 ha="left", fontsize=19, fontweight="bold", color="#253744")
    fig.text(.08, .923, f"270023   |   {rows[0]['date']} — {rows[-1]['date']}   |   186个净值日",
             fontsize=11, color="#596775")
    fig.text(.08, .026, "归一化模拟，含赎回现金；不含年内新增定投、手续费、现金利息。\n"
             "同净值成交仅为理想规则验证；滞后情景不等同于历史真实成交。数据：广发基金官网。",
             fontsize=9, color="#687785")
    fig.subplots_adjust(left=.08, right=.97, top=.88, bottom=.115, hspace=.13)
    fig.savefig(path, dpi=150, facecolor=fig.get_facecolor())
    plt.close(fig)


def main():
    source = json.loads(INPUT.read_text(encoding="utf-8-sig"))
    rows = source["rows"]
    assert len(rows) == len({r["date"] for r in rows}) == 186
    assert rows == sorted(rows, key=lambda r: r["date"])
    assert rows[0]["date"] == "2026-01-05" and rows[-1]["date"] == "2026-10-14"
    assert all(math.isfinite(r["nav"]) and r["nav"] > 0 for r in rows)
    assert source["dividend_check"]["records_in_2026"] == 0
    cases = [simulate(rows, lag) for lag in [0, 1, 2, 3]]
    hold = [r["nav"] / rows[0]["nav"] for r in rows]
    hold_dd = drawdowns(hold)
    hold_return, hold_mdd = (hold[-1] - 1) * 100, -min(hold_dd) * 100
    ideal = cases[0]
    assert [t["execution_date"] for t in ideal["trades"]] == [
        "2026-04-10", "2026-05-11", "2026-06-18", "2026-07-17"]
    assert math.isclose(ideal["return_pct"], 29.1422, abs_tol=.0001)
    OUT.mkdir(parents=True, exist_ok=True)
    payload = {"fund_code": "270023", "share_class": "人民币A", "account_amounts_stored": False,
               "current_platform_rule_update": {
                   "synced_at": "2026-10-16", "primary_source": "user_platform_rule_screenshots",
                   "current_lowest_amount_tier_subscription_fee_pct": 0.16,
                   "historical_initial_value_estimation_fee_assumption_pct": 0.15,
                   "historical_actual_fees_verified": False,
                   "note": "Current screenshot rules do not establish historical actual fees; no fee-adjusted backtest was performed."
               },
               "initial_basis": "2026年首个净值日；仅归一化比例，未读取账户",
               "start_date": rows[0]["date"], "end_date": rows[-1]["date"],
               "nav_source_file": str(INPUT), "sources": source["sources"],
               "assumptions": ["初始全部持有基金，无额外备用金", "零手续费、零现金收益",
                               "不含年内后续真实定投", "成交后立即重设基准，挂单期间不重复触发",
                               "滞后模型未还原历史公布时刻与确认等待"],
               "buy_and_hold": {"return_pct": round(hold_return, 4),
                                "maximum_drawdown_pct": round(hold_mdd, 4)}, "cases": cases}
    (OUT / f"{STEM}.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    table = []
    for trade in ideal["trades"]:
        direction = "减仓：当前持仓10%" if trade["direction"] == "sell" else "加仓：上轮基准持仓15%"
        table.append(f"| {trade['execution_date']} | {trade['previous_anchor_nav']:.4f} | "
                     f"{trade['execution_nav']:.4f} | {trade['signal_return_pct']:+.2f}% | "
                     f"{direction} | {trade['trade_value_pct_of_initial']:.2f}% |")
    summary = [f"| 持续持有 | {hold_return:+.2f}% | {hold_mdd:.2f}% |"]
    for c in cases:
        name = "规则：同净值成交（理想化）" if c["lag_nav_observations"] == 0 else f"规则：滞后{c['lag_nav_observations']}个净值日成交"
        summary.append(f"| {name} | {c['return_pct']:+.2f}% | {c['maximum_drawdown_pct']:.2f}% |")
    report = f"""# 270023 涨跌15%重置基准回测

数据核验日：2026-10-16（北京时间）；净值区间：{rows[0]['date']}—{rows[-1]['date']}，共186条。

后续规则同步：用户于2026-10-16提供平台截图并指定以截图为主，本基金普通金额档优惠申购费为0.160%。本报告的0.15%仅为此前重建年初持仓时经用户同意采用的估算假设；本次未按现行截图费率重跑历史回测，现行费率也不能直接证明过去每笔实际收费。当前规则见`270023_申购赎回费率与办理规则_核验2026-10-16.md`。

理想规则模型收益 **{ideal['return_pct']:+.2f}%**，持续持有 **{hold_return:+.2f}%**，相差 **{ideal['return_pct']-hold_return:.2f}个百分点**；最大回撤分别为 **{ideal['maximum_drawdown_pct']:.2f}%** 和 **{hold_mdd:.2f}%**。本年样本不足以证明规则长期胜出。真实执行收益不能用同净值模型替代。

## 初始基准和口径

- 基金：广发全球精选股票（QDII）人民币A，270023；年初首个可用净值日2026-01-05，净值4.7337；期末净值2026-10-14，6.0497。
- 初始基金价值归一化；这是年初持仓此后按规则操作的模拟，年内后续真实定投未加入，也不复现真实买卖。
- 用户选择按已有有效申购记录及项目约定0.15%申购费估算年初市值。实际金额仅在内存换算、经二次确认后仅限当次对话展示；本报告、图和数据均不保存账户金额。
- 估算年初持仓不等于已核验成交份额；依赖已有交易记录完整、申请日适用净值无顺延的假设。年初市值包括1月5日已有有效申购对应的估计份额。
- 主回测忽略全部新增交易费用，赎回款留存为零收益现金；期末财富=剩余基金市值+现金。不做年化，不作投资建议或交易授权。
- 这不是平台“今年以来”标准收益（通常以去年末净值为起点）。

## 图中规则的实现

1. 每天将净值与上次主动成交的净值比较，上涨达到15%时卖出当前剩余份额的10%。
2. 下跌达到15%时，买入上次主动操作**成交后、作为新基准时的基金持仓价值**的15%，不使用跌后持仓价值，也不使用总财富作基数。
3. 每次成交后同时重设基准净值和基准持仓价值；普通定投不应重置。本次无年内新增定投输入。
4. 有待成交指令时不重复生成交易；滞后模型按既定指令成交后重设基准。为隔离净值公布影响，成交确认等待另外简化为立即确认。
5. 各情景加仓均由先前赎回现金覆盖，未引入额外本金，也未借款。

## 结果与执行延迟敏感性

| 情景 | 区间收益（含现金） | 最大回撤 |
| --- | ---: | ---: |
{chr(10).join(summary)}

同净值模型在得知当天最终净值后又按当天净值成交，含前视偏差，仅验证规则的数学效果。滞后1—3个净值日分别模拟之后第几个有效净值观察日成交；它们不是T+1/T+2真实交收日历，也不能替代历史公布时点、开放日及确认记录。成交延迟会改变后续基准和触发日期，因此逐情景独立运行，没有只把原买卖点机械后移。

## 理想规则模型的四次操作

| 日期 | 旧基准净值 | 触发及新基准净值 | 相对旧基准涨跌 | 规则动作 | 操作规模/年初本金 |
| --- | ---: | ---: | ---: | --- | ---: |
{chr(10).join(table)}

期末基金约占总财富 **{ideal['end_fund_weight_pct']:.1f}%**、现金约 **{ideal['end_cash_weight_pct']:.1f}%**。对比持有路径时已把现金计入，未把现金误当损失。最大回撤按每日基金加现金的总财富计算。

## 数据与局限

全年186条净值来自管理人公开接口；与既有185个相同日期的本地数据逐条一致。官方分红记录未见2026年分红；累计净值与单位净值全年恒差0.439，未见拆分迹象，未取得独立官方拆分登记。

未纳入历史限购、暂停申赎、赎回到账等待、份额确认等待、交易手续费和现金利息。既有记录重建的年初本金是估算，不能称为精确账户余额；比例结果不受本金规模影响。单一年内回测不能覆盖长期单边下跌所需的追加资金风险。

- [广发基金产品页](https://www.gffunds.com.cn/funds/?fundcode=270023)
- [管理人官方净值接口（第1页）]({source['sources'][0]})
- [管理人分红接口](https://www.gffunds.com.cn/apistore/JsonService?service=Equity&method=Dividend&op=queryDividendByFundcode&fundcode=270023)
- [2026年更新招募说明书](https://www.gffunds.com.cn/jjgg/flwj/202606/P020260605334112485983.pdf)

复算脚本：`../scripts/backtest_270023_rebase15.py`；详细输出：`{STEM}.json`。可选走势图需安装matplotlib后重新运行脚本生成。脚本仅读取公开净值，不读取任何账户交易文件。
"""
    (OUT / f"{STEM}.md").write_text(report, encoding="utf-8")
    try:
        make_chart(rows, cases, hold, hold_dd, OUT / f"{STEM}.png")
    except ModuleNotFoundError:
        print("Chart skipped: install matplotlib to generate the optional chart.")
    print(json.dumps({"report": str(OUT / f"{STEM}.md"), "cases": [
        {k: c[k] for k in ["lag_nav_observations", "return_pct", "maximum_drawdown_pct"]}
        for c in cases], "buy_and_hold": payload["buy_and_hold"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
