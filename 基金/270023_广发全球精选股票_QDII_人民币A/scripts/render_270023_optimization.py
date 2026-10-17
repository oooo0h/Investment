"""Report both the useful hindsight frontier and failed robustness evidence."""

import json
import os
import tempfile
from datetime import datetime
from pathlib import Path

from optimize_270023_rules import OUT, STEM
from render_270023_scheduled import build_section


def main():
    initial = json.loads((OUT / (STEM + ".json")).read_text(encoding="utf-8"))
    strict = json.loads((OUT / (STEM + "_双指标探索.json")).read_text(encoding="utf-8"))
    hindsight = json.loads((OUT / (STEM + "_全历史事后前沿.json")).read_text(encoding="utf-8"))
    selected = hindsight["selected"]
    candidate = selected["full_history"]["summary"]
    original = hindsight["original_summary_same_assumptions"]
    hold = selected["matched_cashflow_hold"]["summary"]
    config = selected["config"]
    definition = f"涨{config[0]*100:.0f}%卖{config[2]*100:.0f}%，跌{config[1]*100:.0f}%加{config[3]*100:.0f}%"
    chart_path = OUT / (STEM + "_研究图.png")
    report_path = OUT / (STEM + "_研究报告.md")
    lines = [
        "# 广发全球精选（270023）规则优化与定投对比研究报告", "",
        "研究日：2026-10-16。单位净值区间：2010-08-18—2026-10-14；管理人公开数据3,892条、现金分红6次。仅归一化模拟，不读取真实账户交易或金额。", "",
        "## 结论与适用范围", "",
        "新增每年等额预算比较中，年度一次投入的历史资金年化最高，日定投与月定投几乎相同；原15/15年度版回撤最低，40/30年度版处于较高收益、较高回撤的取舍位置。年度版每年买入新预算并重置基准，不能沿用单笔模型的回撤结论。", "",
        f"在仅初始投入模型的预设有限网格及已知全历史内，**{definition}**是“时间加权年化不低于原规则、累计追加不超过初始投入50%时，最大回撤最低”的事后候选。它改善的是模型内的收益与回撤取舍，没有通过严格的跨阶段全面改进检验，不能称未来最优或已验证的实盘升级。", "",
        "## 数学目标", "",
        "令参数θ=(上涨阈值u、下跌阈值d、卖出比例s、加仓比例b)，初始投入归一化为1。以原15%/15%、卖10%、买15%为对照θ₀，求有限网格内：", "",
        "```text", "最小化：全历史TWR净值的最大回撤 MDD(θ)",
        "约束：TWR年化(θ) ≥ TWR年化(θ₀)", "      累计外部追加(θ) ≤ 0.50 × 初始投入", "```", "",
        "上涨和下跌阈值各取5%、10%、15%、20%、25%、30%、40%；卖出和加仓比例各取0%、5%、10%、15%、20%、30%、50%。比例为零则禁用该方向，零交易不重置基准。合并禁用方向的冗余参数后，共1,849组参数组合。参数组合不等于独立策略或独立统计样本。", "",
        f"其中{len(hindsight['all_fifo_full_history_results']):,}组完成全历史FIFO计算，{len(hindsight['budget_pruned']):,}组因累计补款已超50%提前淘汰；累计外部入金单调不减，剪枝不损失预算内可行解。符合原规则收益底线的候选为{hindsight['feasible_count']}组；{len(hindsight['full_history_pareto'])}个参数点位于事后收益—回撤前沿。所选组合是收益底线下的唯一最小回撤点。", "",
        "这个优化问题刻画一种明确的平衡偏好，不代表所有投资者都会选择同一点。它是样本内、有限网格的最优，不是连续参数空间或未来路径上的最优。上涨40%处于本轮网格上界，更高阈值未被检验。", "",
        "## 规则怎样执行", "",
        "1. 初始全部买入；主情景现金不足时允许外部追加，不借款。", 
        "2. 相对上次主动成交净值上涨达到40%，卖出成交时基金市值的20%。",
        "3. 相对上次主动成交净值下跌达到30%，用**上次成交后基准基金市值的30%**作为加仓总预算；不是跌后市值的30%，也不是相对历史最高点的回撤。",
        "4. 每次实际成交后同时重置净值和成交后基金市值基准。先用留存现金，不足部分才外部补足。",
        "5. 主动阈值买卖统一滞后2个可用净值观察日执行；挂单期间不重复触发。现金分红除息日计应收，公开发放日后首个观察日才可用；现金收益为零。新增固定日历买入的执行约定另见年度比较节。",
        "6. 申购费按目前平台0.16%静态计算，买入比例为含费预算；赎回按FIFO和持有自然日费档。成交日近似确认日。这是统一成本情景，未还原全历史实际费率、申赎限制或结算日历。", "",
        *build_section(),
        "## 保留：仅初始投入的同口径全历史结果", "",
        "本表统一滞后2个净值观察日并计静态费用。上一轮主表是同净值、无交易费模型，不能把两个口径的数字直接横比。", "",
        "| 指标 | 原15/15、卖10/买15 | 事后40/30、卖20/买30 | 标准对照：期初买入长期不动 |",
        "|---|---:|---:|---:|",
    ]
    for title, key, fmt in [
        ("TWR年化收益", "twr_annualized_pct", lambda x:f"{x:.2f}%"),
        ("资金年化XIRR", "xirr_pct", lambda x:f"{x:.2f}%"),
        ("最大回撤（剔除入金影响）", "max_drawdown_pct", lambda x:f"{x:.2f}%"),
        ("累计追加／初始投入", "external_added_norm", lambda x:f"{x*100:.1f}%"),
        ("期末基金占资产", "end_fund_weight_pct", lambda x:f"{x:.1f}%"),
    ]:
        lines.append(f"| {title} | {fmt(original[key])} | {fmt(candidate[key])} | {fmt(hold[key])} |")
    lines += [f"| 主动买／卖次数 | {original['buy_count']}／{original['sell_count']} | {candidate['buy_count']}／{candidate['sell_count']} | 0／0 |", "",
        f"候选TWR年化较原规则高{candidate['twr_annualized_pct']-original['twr_annualized_pct']:.2f}个百分点，回撤低{original['max_drawdown_pct']-candidate['max_drawdown_pct']:.2f}个百分点；XIRR则低{original['xirr_pct']-candidate['xirr_pct']:.2f}个百分点。TWR剔除补款本身及其时点对资金权重的影响；XIRR描述模拟投资人实际入金时点的资金年化。不能笼统称“资金收益更高”，更不能仅按期末资产排名。", "",
        "候选历史中没有额外补款，属于这一条价格路径的结果；研究预算过滤没有定义未来现金不足时如何拒单，也不能保证未来不需追加。", "",
        "![规则组合优化研究图](<" + chart_path.name + ">)", "",
        "## 为什么不能把它当可靠升级", "",
        f"先进行开发（2010—2018）、验证（2019—2023）、本轮保留段（2024—2026）研究。首轮最差分段Calmar规则偏向持续持有，但其回撤更高，不能等同于用户希望的低回撤平衡。首轮37个复核参数中19个对应完全相同的零交易持有路径，因此不能称37种独立策略。原参数锁定文件未更改。", "",
        f"另按独立命名的探索性预设，复核{strict['screening_pool_count']}组参数、{strict['path_group_count']}组不同开发验证交易路径：要求开发/验证×滞后1/2/3的六格中，收益与回撤逐格不弱于原规则、补款受限、每格实际买卖均发生，并至少有一格年化提高0.5个百分点或回撤改善2个百分点。**通过者为{strict['strict_path_count']}组**；没有降低标准去制造赢家。", "",
        "随后才做本文的全历史事后优化。因此以下分段诊断已经参与候选选择，不能重新包装为独立样本外证据：", "",
        "| 独立重置的分段 | 候选TWR年化 | 原规则TWR年化 | 候选最大回撤 | 原规则最大回撤 | 候选买入次数 |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    old = next(x for x in initial["shortlist"] if x["config"] == [.15,.15,.10,.15])
    for period, label in (("development","2010—2018"),("validation","2019—2023"),("reserved_test","2024—2026")):
        new = selected["period_diagnostics_not_independent_test"][period][1]
        previous = initial["final"]["original"]["reserved_test"][1] if period=="reserved_test" else old["results"][period][1]
        lines.append(f"| {label} | {new['twr_annualized_pct']:.2f}% | {previous['twr_annualized_pct']:.2f}% | {new['max_drawdown_pct']:.2f}% | {previous['max_drawdown_pct']:.2f}% | {new['buy_count']} |")
    lines += ["",
        "最近分段候选回撤约20.74%，原规则约18.04%，已经显示它并非跨阶段全面占优。各分段重新以基金1、现金0开始，不应拼接成一条连续账户曲线；全历史曲线另以连续状态计算。", "",
        "全历史仅两次加仓：2022-01-20、2022-10-13，属于同一轮熊市。开发和最近分段均未触发买入，不能据此验证“跌30%加30%”的跨周期可靠性。7个轴向相邻参数中仅3个仍符合原年化收益底线，证据不足以称宽阔稳健区间。", "",
        "## 延迟与邻近参数", "",
        "| 候选执行延迟（观察日） | TWR年化 | 最大回撤 |",
        "|---|---:|---:|",
    ]
    for item in selected["full_lag_sensitivity"]:
        lines.append(f"| {item['lag_nav_observations']} | {item['twr_annualized_pct']:.2f}% | {item['max_drawdown_pct']:.2f}% |")
    lines += ["", "这些属于同一已知历史的敏感性，未还原QDII各日实际净值公布与可成交时点。滞后0仍含同日净值前视偏差。", "",
        "| 涨／跌阈值 | 卖／买比例 | TWR年化 | 最大回撤 |",
        "|---|---|---:|---:|",
    ]
    for item in selected["full_history_neighbors"]:
        c = item["config"]
        if not item.get("budget_pruned"):
            lines.append(f"| {c[0]*100:.0f}%／{c[1]*100:.0f}% | {c[2]*100:.0f}%／{c[3]*100:.0f}% | {item['twr_annualized_pct']:.2f}% | {item['max_drawdown_pct']:.2f}% |")
    lines += ["", "邻点说明收益与回撤仍存在取舍，不应把整数阈值的差异当作精确的市场规律。", "",
        "## 候选全部交易", "",
        "交易额仅为初始假设投入的百分比，不是实际账户金额。", "",
        "| 成交日 | 方向 | 单位净值 | 交易额／初始投入 |",
        "|---|---|---:|---:|",
    ]
    for trade in selected["full_history"]["trades"]:
        lines.append(f"| {trade['execution_date']} | {'卖出' if trade['side']=='sell' else '加仓'} | {trade['execution_nav']:.4f} | {trade['trade_value_norm']*100:.2f}% |")
    lines += ["", "## 最后的判断", "",
        "这次找到的是“在限定历史目标下可复算的取舍点”。若只把它用作下一阶段跟踪的研究候选，40/30、卖20/买30比随意猜参数有依据；若要求可靠证明未来同时提高收益、降低回撤，这次数据不支持。当前没有据此修改持仓、设置定投或生成交易指令。", "",
        "数据账本通过独立Decimal逐日复算，候选9笔交易及原规则主要指标一致；1,849组参数覆盖、439组单调预算剪枝及279个收益约束可行点通过独立审计。计算准确性不等于参数的投资确定性。", "",
        "基金2014-06-09由亚太除日本策略转型，全部历史包含不同投资阶段。限购、暂停申赎、历史费率、结算及现金利息均未完整还原；没有把累计净值直接当作红利再投资指数。", "",
        "## 来源与文件", "",
        "- [广发基金官方产品页](https://www.gffunds.com.cn/funds/?fundcode=270023)；单位净值与分红来自本地已核验的管理人全历史主档。",
        "- [Bailey等：回测过拟合概率](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)：大量参数试验会提高偶然胜出的风险；不能把多次搜索当作单次独立检验。",
        "- [Harvey与Liu：Backtesting](https://people.duke.edu/~charvey/Research/Published_Papers/P120_Backtesting.PDF)：多重测试及研究者反复查看结果会削弱简单样本外检验的可信度。本项目历史走势已经看过，本次不声称拥有完全未接触的数据。",
        f"- 事后完整网格与逐日候选：`{STEM}_全历史事后前沿.json`；严格跨阶段失败证据：`{STEM}_双指标探索.json`。",
        "- 脚本位于同基金`scripts/`：`optimize_270023_rules.py`、`threshold_grid_engine.py`、`refine_270023_balanced.py`、`describe_270023_hindsight_frontier.py`。", "",
    ]
    report_path.write_text("\n".join(lines),encoding="utf-8")

    os.environ.setdefault("MPLCONFIGDIR", os.path.join(tempfile.gettempdir(), "codex-270023-mpl"))
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import font_manager
    font_path = Path("C:/Windows/Fonts/msyh.ttc")
    if font_path.is_file():
        font_manager.fontManager.addfont(str(font_path))
        plt.rcParams["font.family"] = font_manager.FontProperties(fname=str(font_path)).get_name()
    else:
        plt.rcParams["font.family"] = "sans-serif"
        plt.rcParams["font.sans-serif"] = ["Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False
    fig, axes = plt.subplots(1,2,figsize=(14.5,6.5),gridspec_kw={"width_ratios":[1,1.18]})
    fig.set_facecolor("#f6f7f9")
    for ax in axes:
        ax.set_facecolor("white");ax.spines[["top","right"]].set_visible(False)
        ax.grid(axis="y",color="#e5ebee",lw=.7);ax.tick_params(labelsize=9,colors="#526773")
    records=hindsight["all_fifo_full_history_results"]
    axes[0].scatter([r["max_drawdown_pct"] for r in records],[r["twr_annualized_pct"] for r in records],s=9,color="#b2bec8",alpha=.45,label="预算内全历史结果")
    frontier=sorted(hindsight["full_history_pareto"],key=lambda r:r["max_drawdown_pct"])
    axes[0].plot([r["max_drawdown_pct"] for r in frontier],[r["twr_annualized_pct"] for r in frontier],color="#547b8b",lw=1.2,ls="--",label="事后收益—回撤前沿")
    axes[0].axhline(original["twr_annualized_pct"],color="#bb7168",lw=1,ls=":")
    for summary,label,color,offset in [(original,"原规则", "#ba645b",(7,-20)),(candidate,"40/30候选（事后）","#167c73",(-110,10)),(hold,"持续持有","#cc8b43",(-75,10))]:
        axes[0].scatter(summary["max_drawdown_pct"],summary["twr_annualized_pct"],s=55,color=color,zorder=6)
        axes[0].annotate(label,(summary["max_drawdown_pct"],summary["twr_annualized_pct"]),xytext=offset,textcoords="offset points",fontsize=9,color=color)
    axes[0].set_xlabel("最大回撤（%）",fontsize=10);axes[0].set_ylabel("TWR年化收益（%）",fontsize=10)
    axes[0].legend(frameon=False,fontsize=8,loc="lower right")
    oldfull=initial["final"]["original"]["full_history"]
    for case,label,color in [(selected["full_history"],"40/30候选（事后）","#167c73"),(oldfull,"原15/15规则","#ba645b"),(selected["matched_cashflow_hold"],"持续持有","#cc8b43")]:
        axes[1].plot([datetime.fromisoformat(r["date"]) for r in case["daily"]],[r["twr_index"]*100 for r in case["daily"]],lw=1.5,color=color,label=label)
    axes[1].set_ylabel("剔除补款影响的净值（初始=100）",fontsize=10)
    axes[1].legend(frameon=False,fontsize=9,loc="upper left")
    fig.suptitle("广发全球精选 · 收益与回撤的事后取舍",x=.07,y=.97,ha="left",fontsize=19,fontweight="bold",color="#294553")
    fig.text(.07,.90,"1,849组参数评估  |  2010-08-18—2026-10-14  |  统一滞后2个净值观察日、静态交易费用",fontsize=10.5,color="#5b707d")
    fig.text(.07,.035,"候选来自已知全历史，未通过严格跨阶段全面改进检验；图中前沿不能代表未来最优。\n现金分红、现金零息；资金预算为研究过滤条件，历史限购与结算未完整还原。数据：广发基金。",fontsize=9,color="#5e7582")
    fig.subplots_adjust(left=.07,right=.97,top=.83,bottom=.17,wspace=.27)
    fig.savefig(chart_path,dpi=150,facecolor=fig.get_facecolor());plt.close(fig)
    print(json.dumps({"report":str(report_path),"chart":str(chart_path)},ensure_ascii=False))


if __name__=="__main__":main()
