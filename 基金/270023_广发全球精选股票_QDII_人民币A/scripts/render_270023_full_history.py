"""Render the normalized public-data backtest report and static research figure."""

import json
from datetime import datetime
from pathlib import Path

FUND = Path(__file__).resolve().parents[1]
OUT = FUND / "研究"
STEM = "270023_全历史涨跌15重置基准回测_截至2026-10-14"


def main():
    data = json.loads((OUT / (STEM + ".json")).read_text(encoding="utf-8"))
    cases = data["cases"]
    primary = cases[0]
    summary = primary["summary"]
    matched = primary["matched_cashflow_buy_hold"]["summary"]
    hold = data["initial_only_buy_hold"]["summary"]
    reinvest = data["initial_only_dividend_reinvest_buy_hold"]["summary"]
    def pct(value):
        return f"{value:+.2f}%"
    def ratio(value):
        return f"{value:.4f}倍"
    lines = [
        "# 广发全球精选（270023）全历史规则回测研究报告", "",
        "研究日期：2026-10-16（北京时间）。净值区间：2010-08-18—2026-10-14，管理人主档3,892条，现金分红6次；另对10条第三方补充估值做敏感性复核。", "",
        "按用户指定的假设初始投入建立模拟，不读取真实账户。本报告中的金额统一表示为初始假设投入的倍数或百分比。", "",
        "## 规则与资金口径", "",
        "1. 在首个净值日全部买入基金，初始备用现金为零。", 
        "2. 相对上次主动成交的净值上涨达到15%，卖出当时剩余基金市值的10%。不是卖出初始本金的10%，也不是把总资产降到某个仓位。",
        "3. 相对上次主动成交的净值下跌达到15%，买入**上次成交后基准基金市值的15%**。不是按已经下跌后的市值计算。",
        "4. 每次实际成交后，同时重置净值基准和成交后基金市值基准。等待成交期间不重复下单；每天最多一次主动成交。",
        "5. 先使用卖出及现金分红留存的现金；不足部分在买入成交日从外部追加。追加不计投资收益。卖出资金及现金不计利息。",
        "6. 主情景用原始单位净值触发、现金分红：除息日按交易前份额计应收，公开发放日后首个观察日才转为可用现金。应收分红始终计入总资产。除息会影响价格触发阈值，另给分红调整信号对照。",
        "7. 主结果为无交易费用、同一净值触发并成交的理想数学模型；它含前视偏差。滞后1—3个净值日另列敏感性，均不冒充已经还原的历史真实成交。", "",
        "## 主结果：少回撤，也少赚", "",
        f"在这段历史中，规则的资金年化收益率（XIRR）为 **{summary['xirr_pct']:.2f}%**，相同入金持续持有为 **{matched['xirr_pct']:.2f}%**；剔除追加资金影响的最大回撤分别为 **{summary['max_drawdown_pct']:.2f}%** 和 **{matched['max_drawdown_pct']:.2f}%**。", "",
        "| 指标 | 涨跌15%规则 | 相同入金持续持有 | 仅初始买入后持有 |",
        "|---|---:|---:|---:|",
    ]
    metrics = [
        ("累计投入／初始投入", "total_contributed_norm", ratio),
        ("期末总资产／初始投入", "end_total_norm", ratio),
        ("期末基金／初始投入", "end_fund_norm", ratio),
        ("期末现金／初始投入", "end_cash_norm", ratio),
        ("净收益／初始投入", "net_profit_norm", ratio),
        ("净收益／累计投入（非年化）", "profit_over_total_contributed_pct", pct),
        ("时间加权累计收益TWR", "twr_return_pct", pct),
        ("时间加权年化收益", "twr_annualized_pct", pct),
        ("资金年化收益XIRR", "xirr_pct", pct),
        ("最大回撤（TWR净值）", "max_drawdown_pct", lambda v: f"{v:.2f}%"),
        ("期末基金占总资产", "end_fund_weight_pct", lambda v: f"{v:.1f}%"),
    ]
    for title, key, formatter in metrics:
        lines.append(f"| {title} | {formatter(summary[key])} | {formatter(matched[key])} | {formatter(hold[key])} |")
    lines += ["", f"主情景主动买入{summary['buy_count']}次、卖出{summary['sell_count']}次。只在2011-09-22追加一次，追加量为初始投入的15%；此后买入均由已有现金覆盖。最大回撤从{summary['drawdown_peak_date']}至{summary['drawdown_trough_date']}。", "",
        "相同入金基准在2011-09-22也投入同等追加资金并全部买入，之后不主动择时；两者均现金分红。因此不能用期末资产直接除以最初投入，把追加本金也当作收益。", "",
        f"期末规则持有基金约{summary['end_fund_weight_pct']:.1f}%、现金约{100-summary['end_fund_weight_pct']:.1f}%。较多现金降低了下跌暴露，也牺牲了长期上涨阶段的参与度。", "",
        "![全历史收益与回撤](<" + (STEM + ".png") + ">)", "",
        "## 执行与分红敏感性", "",
        "| 情景 | 期末总资产／初始投入 | 资金年化XIRR | 时间加权年化 | 最大回撤 | 买／卖次数 |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for case in cases:
        item = case["summary"]
        lines.append(f"| {item['label']} | {ratio(item['end_total_norm'])} | {item['xirr_pct']:.2f}% | {item['twr_annualized_pct']:.2f}% | {item['max_drawdown_pct']:.2f}% | {item['buy_count']}／{item['sell_count']} |")
    lines += ["",
        "滞后2日这次样本结果高于同日情景，滞后1日和3日则较低：延迟会改变成交价格、基准重置和后续触发路径，不是统一扣减一个固定数值。不能挑选事后最好的延迟作为可保证的交易方式。", "",
        "费用情景仅将目前已核验的平台规则静态套用到全历史：申购费0.16%，赎回按FIFO和持有自然日分档。15%按含费申购预算计算，初始预算同样含费；实际净买入额会略低。持有期用成交日近似确认日。本情景没有证明过去十余年都适用今天的费率。基金管理、托管等已反映在公布净值中，不重复扣减。", "",
        f"若仅初始投入并全程红利再投资、不主动择时，期末为初始投入的{reinvest['end_total_norm']:.4f}倍、年化{reinvest['xirr_pct']:.2f}%、最大回撤{reinvest['max_drawdown_pct']:.2f}%。这与现金分红持有是不同分红安排，不能拿一种口径与另一种混比。红利再投资敏感性按除息日净值计价，未还原份额确认前的可赎回限制。", "",
        "## 全部主动交易", "",
        "下表金额仅为初始假设投入的百分比；不包含任何真实账户金额或份额。", "",
        "| 成交日 | 方向 | 成交单位净值 | 交易额／初始投入 | 外部追加／初始投入 | 交易后现金／初始投入 |",
        "|---|---|---:|---:|---:|---:|",
    ]
    for trade in primary["trades"]:
        lines.append(f"| {trade['execution_date']} | {'卖出10%' if trade['side']=='sell' else '按基准加15%'} | {trade['execution_nav']:.4f} | {trade['trade_value_norm']*100:.2f}% | {trade['external_added_norm']*100:.2f}% | {trade['cash_norm_after']*100:.2f}% |")
    lines += ["", "## 可信范围与复核", "",
        "- 全历史主档日期唯一、升序且单位净值均为正；6次分红与累计净值减单位净值的变化逐次一致，合计每份0.439。未发现其他拆分迹象，但没有取得独立的全历史拆分登记。",
        "- 另一套独立Decimal账本复算主情景：期末资产、追加资金、37次主动交易、TWR及最大回撤均一致；每日交易前后资产变动等于外部入金减费用，现金及应收非负。",
        "- 10条第三方补充记录仅参与估值敏感性，不作为可交易日或增加观察日滞后计数；加入后主情景期末资产不变。原始官方主档和第三方补充档均未改动。",
        "- 时间加权收益逐日剔除外部入金后连乘；最大回撤基于该时间加权净值；TWR年化一年按365.2425天。XIRR按每笔实际模拟入金日期和期末总资产计算，遵循实际天数／365的标准约定。净收益／累计投入不是年化收益。",
        "- 尚未还原历史暂停申赎、限购、海外及境内开市日、每次净值准确公布时点、确认与赎回到账等待，现金收益设零。公开净值日不保证当天所有渠道均能按模型交易；成立日净值建立初始仓位也属理论设定。",
        "- 基金2014-06-09由广发亚太（除日本）精选转型，全部历史包含早期亚太策略阶段。回测说明样本内取舍，不证明未来长期胜率。", "",
        "## 数据与复算文件", "",
        "- [广发基金产品页](https://www.gffunds.com.cn/funds/?fundcode=270023)",
        "- [管理人分红接口](https://www.gffunds.com.cn/apistore/JsonService?service=Equity&method=Dividend&op=queryDividendByFundcode&fundcode=270023)",
        "- [2017分红公告：除息日申购不享分红、赎回享分红](https://www.gffunds.com.cn/jjgg/zdsj/201706/t20170627_109735.shtml)",
        "- [2018分红公告：再投资定价及现金发放日](https://www.gffunds.com.cn/jjgg/zdsj/201805/t20180522_271855.shtml)",
        "- [官方转型日期说明](https://www.gffunds.com.cn/jjgg/zdsj/202211/t20221116_379230.shtml)",
        "- 主档：`../历史净值/270023_全部历史净值_截至2026-10-14.json`；分红原始响应在同目录`原始数据/`。",
        f"- 详细结果与全部逐日序列：`{STEM}.json`。",
        "- 复算脚本：`../scripts/backtest_270023_full_history.py`；报告及图表生成：`../scripts/render_270023_full_history.py`。", "",
    ]
    (OUT / (STEM + ".md")).write_text("\n".join(lines), encoding="utf-8")

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    from matplotlib import font_manager
    font_path = Path("C:/Windows/Fonts/msyh.ttc")
    if font_path.exists():
        font_manager.fontManager.addfont(str(font_path))
        plt.rcParams["font.family"] = font_manager.FontProperties(fname=str(font_path)).get_name()
    else:
        plt.rcParams["font.family"] = "sans-serif"
        plt.rcParams["font.sans-serif"] = ["Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False
    dates = [datetime.fromisoformat(x["date"]) for x in primary["daily"]]
    fig, axes = plt.subplots(2, 1, figsize=(13.8, 8.8), sharex=True,
                             gridspec_kw={"height_ratios": [2.1, 1]})
    fig.set_facecolor("#f6f7f9")
    for ax in axes:
        ax.set_facecolor("white")
        ax.spines[["top", "right"]].set_visible(False)
        ax.spines[["left", "bottom"]].set_color("#d2d9df")
        ax.grid(axis="y", color="#e4e9ee", lw=.7)
        ax.tick_params(colors="#566572", labelsize=9)
    plots = [(primary, "规则：理想同日成交", "#137b75", "-"),
             (primary["matched_cashflow_buy_hold"], "相同入金持续持有", "#cc833b", "-"),
             (cases[2], "规则：滞后2个净值日", "#7c709e", "--")]
    for case, label, color, style in plots:
        values = case["daily"]
        axes[0].plot(dates, [x["twr_index"] * 100 for x in values], color=color,
                     ls=style, lw=1.8, label=f"{label} · 年化TWR {case['summary']['twr_annualized_pct']:.2f}%")
        axes[1].plot(dates, [x["drawdown_pct"] for x in values], color=color,
                     ls=style, lw=1.5, label=f"{label} · 最大回撤 {case['summary']['max_drawdown_pct']:.2f}%")
    axes[0].set_ylabel("剔除外部入金影响的净值（初始=100）", fontsize=10, color="#334a59")
    axes[1].set_ylabel("距历史高点回撤（%）", fontsize=10, color="#334a59")
    axes[0].legend(frameon=False, loc="upper left", fontsize=9)
    axes[1].legend(frameon=False, loc="lower left", fontsize=8.7)
    axes[1].xaxis.set_major_locator(mdates.YearLocator(2))
    axes[1].xaxis.set_major_formatter(mdates.DateFormatter("%Y"))
    fig.suptitle("广发全球精选 · 涨跌15%重置基准的全历史回测", x=.08, y=.97,
                 ha="left", fontsize=19, fontweight="bold", color="#253d4b")
    fig.text(.08, .921, "270023 人民币A  |  2010-08-18—2026-10-14  |  3,892条官方净值、6次分红",
             fontsize=10.5, color="#5a6d7a")
    fig.text(.08, .028, "允许现金不足时外部追加；现金分红，闲置现金收益设零。图为时间加权净值，追加本金不计收益。\n"
             "同日成交含前视偏差；滞后为敏感性假设，未还原历史限购与结算。图中均未扣交易费用。数据：广发基金。",
             fontsize=8.7, color="#647684")
    fig.subplots_adjust(left=.08, right=.975, top=.88, bottom=.12, hspace=.12)
    chart = OUT / (STEM + ".png")
    fig.savefig(chart, dpi=150, facecolor=fig.get_facecolor())
    plt.close(fig)
    print(json.dumps({"report": str(OUT / (STEM + ".md")), "chart": str(chart),
                      "trades": len(primary["trades"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
