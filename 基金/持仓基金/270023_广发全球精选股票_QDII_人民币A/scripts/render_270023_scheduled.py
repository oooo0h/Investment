"""Render the annual-funded extension alongside the preserved original study."""

import json
import os
import tempfile
from pathlib import Path

from compare_270023_scheduled import OUT, STEM

ORDER = ("annual","monthly","daily","original","candidate")
LABELS = {"initial_hold":"标准：期初买入，长期不动",
          "annual":"每年年初买入并持有", "monthly":"每月定投", "daily":"每日定投",
          "original":"年度版：涨15%卖10%，跌15%加15%",
          "candidate":"年度版：涨40%卖20%，跌30%加30%"}
COLORS = {"initial_hold":"#485b6d","annual":"#bd873c","monthly":"#6889ab","daily":"#8a73a2",
          "original":"#bc665f","candidate":"#177e76"}


def build_section(draw=True):
    data=json.loads((OUT/(STEM+".json")).read_text(encoding="utf-8"))
    sums={k:v["summary"] for k,v in data["cases"].items()}
    chart=OUT/(STEM+".png")
    if draw:
        render_chart(data,chart)
    baseline=data["initial_buy_hold_benchmark"]["summary"]
    lines=["## 标准持有、年度投入与定投总览", "",
        "标准对照为**期初一次买入，之后不追加、不卖出，现金分红留在账户**。它与“每年年初继续买入”的年度策略不同。以下统一展示，并明确资金计划；仅期初投入与逐年新增预算不能按期末资产或年化高低直接评定策略优劣。", "",
        "这组回答“每年都有一笔新增预算，年初一次买还是分批买”的问题。三种计划投入与原规则、候选的**年度注资扩展版**放在同一表中；此前只投入初始本金的回测仍在下一节保留。年度扩展不是把旧收益率直接搬过来。", "",
        "五种年度预算策略每年首个可用净值观察日获得同样的年度预算，未买入部分为零息现金并计入资产和资金年化；标准期初持有对照不再获得年度预算。原规则触发加仓若不足，仍允许从外部补足，因此它的总投入略高，单列追加比例。", "",
        "| 策略 | 资金计划 | 资金年化XIRR | TWR年化 | 最大回撤 | 额外追加／计划总预算 | TWR年化／回撤 |",
        "|---|---|---:|---:|---:|---:|---:|",
        f"| {LABELS['initial_hold']} | 仅期初一次 | {baseline['xirr_pct']:.2f}% | {baseline['twr_annualized_pct']:.2f}% | {baseline['max_drawdown_pct']:.2f}% | 0.00% | {baseline['twr_annualized_pct']/baseline['max_drawdown_pct']:.3f} |"]
    for key in ORDER:
        s=sums[key]
        lines.append(f"| {LABELS[key]} | 每年新增预算 | {s['xirr_pct']:.2f}% | {s['twr_annualized_pct']:.2f}% | {s['max_drawdown_pct']:.2f}% | {s['extra_over_regular_pct']:.2f}% | {s['twr_annualized_pct']/s['max_drawdown_pct']:.3f} |")
    lines += ["", "回撤按剔除外部入金影响的完整策略净值计算，包含待投现金；TWR年化／回撤为同一窗口Calmar式比值，越高表示该历史窗口内单位回撤对应的年化收益越高，不能解释为获胜概率。XIRR同时反映各年资金在场时间，不能用它替代TWR衡量纯策略回报。", "",
        "年度一次投入的历史资金年化最高，但最大回撤约一半；日定投与月定投的资金年化几乎相同，分批买入没有消除长期重仓后的权益回撤。原15/15年度版的回撤在这五种方案中最低，代价是较低收益。", "",
        f"40/30年度版相对年度一次投入，XIRR少{(sums['annual']['xirr_pct']-sums['candidate']['xirr_pct']):.2f}个百分点、回撤少{(sums['annual']['max_drawdown_pct']-sums['candidate']['max_drawdown_pct']):.2f}个百分点；相对原15/15年度版，XIRR高{(sums['candidate']['xirr_pct']-sums['original']['xirr_pct']):.2f}个百分点，但回撤也高{(sums['candidate']['max_drawdown_pct']-sums['original']['max_drawdown_pct']):.2f}个百分点。这是收益与风险取舍，不能称同时全面改善。它在本表的收益／回撤比值略高，完整日历年诊断中与原规则接近，并不足以证明未来更优。", "",
        "![年度与定投策略对比](<"+chart.name+">)", "",
        "### 图中两种阈值规则是什么意思", "",
        "| 年度版名称 | 上涨触发 | 下跌触发 |",
        "|---|---|---|",
        "| 原15/15规则 | 净值比基准涨15%，卖出成交时全部基金市值的10% | 净值比基准跌15%，加仓预算为前次成交后基准基金市值的15% |",
        "| 40/30候选 | 净值比基准涨40%，卖出成交时全部基金市值的20% | 净值比基准跌30%，加仓预算为前次成交后基准基金市值的30% |", "",
        "这里的基准是前次实际买卖成交后的净值及基金市值，年度版的年初计划买入也会重置基准。涨跌不是每天的涨跌幅，也不是相对历史最高点的回撤。触发后的主动单按本模型滞后2个观察日成交，成交后再重置基准；先用留存现金加仓，不足再外部补足。", "",
        "“年度投入＋”表示每年首个观察日把当年新增预算买入后，再执行上述规则。年初买入与重置是为年度资金比较加入的扩展约定，原先单笔初始投入策略没有每年强制买入。图表已展开阈值和买卖比例，不再仅以15/15、40/30代替全部定义。", "",
        "### 具体日历与资金规则", "",
        "1. 年度一次：每年首个可用官方净值观察日，用当年新预算一次买入，已有基金继续持有。每年不清仓。",
        "2. 月定投：每月首个可用观察日投入全年预算的1/12。日定投：将每月1/12预算按该月日历天数均分，非观察日额度顺延到下一个观察日合并买入。因此这里的“每日”是按日历日累积，不是每个交易日固定金额。它只用已知日历，不用截至日或事后全年净值数量倒推金额。",
        "3. 2010启动年按8—12月共5个月预算投入；月定投首笔为8月额度，日定投首笔合并8月1日至首次观察日的额度。2011起每年都是全年预算，**2026也已年初入足，10月14日以后未到期的定投预算仍为现金**。首年约定通过2011—2025完整年诊断检查。",
        "4. 两种阈值年度版都在年初把新增预算买入，重置净值及买入后全部基金市值基准，取消上一年未执行的模拟信号，当天不再触发；其他时间沿用各自阈值。年度强制买入优先是本扩展模型的明确约定，本段实际取消挂单次数均为零。",
        "5. 涨时卖出当时基金市值的指定比例；跌时按前次实际成交后基准基金市值计算含费加仓预算。原规则为涨15%卖10%、跌15%加15%；候选为涨40%卖20%、跌30%加30%。主动信号滞后2个观察日执行；固定日期计划买入无需先知道当日净值。",
        "6. 现金分红不自动再投资，分红发放后与卖出留存现金可用于阈值加仓；固定定投只花计划额度。费用与此前相同：申购0.16%静态敏感性、赎回按持有期FIFO。不计现金利息，末期为估值，不模拟全部赎回。",
        "7. 官方净值观察日仅作为假设可申购日，未重建真实开放日、限购、份额确认、到账及税费；成立初期可能存在封闭建仓期。主档含7个周末观察日，日投也按这些观察日合并买入，因此这是观察日成交的理想模型，不能视为真实每日交易路径。真实渠道可能采用不同顺延方式。", "",
        "### 首尾年份与费用敏感性", "",
        "以下从2011首个观察日重新开始，到2025最后一个观察日结束，避免2010启动年及2026未完成年度影响。它是同一已知历史上的稳健性诊断，并非独立样本外检验。", "",
        "| 策略 | 2011—2025资金年化 | 2011—2025最大回撤 | 2011—2025年化／回撤 | 全历史零交易费资金年化 |",
        "|---|---:|---:|---:|---:|"]
    for key in ORDER:
        s=data["complete_calendar_years_2011_2025"][key]
        nofee=data["zero_fee_sensitivity"][key]
        lines.append(f"| {LABELS[key]} | {s['xirr_pct']:.2f}% | {s['max_drawdown_pct']:.2f}% | {s['twr_annualized_pct']/s['max_drawdown_pct']:.3f} | {nofee['xirr_pct']:.2f}% |")
    lines += ["", "主动交易少的40/30年度版仅有一次阈值买入和三次阈值卖出；2011—2025为一次买入、两次卖出。不能把少数交易的事后取舍当作普遍规律，也不能把上一轮单笔模型的最优参数视为年度注资模型的最优参数。本次没有重新调参去追逐新表赢家。", "",
        "### 同实际入金的持有基准", "",
        "原规则年度版发生少量计划外补款，以下基准在完全相同日期收到完全相同的实际现金流并立即买入持有。它用于比较同样资金条件下的机会成本；主表不按期末资产规模排序。", "",
        "| 对照资金流 | 阈值版资金年化／回撤 | 同实际入金持有资金年化／回撤 |",
        "|---|---:|---:|"]
    for key in ("original","candidate"):
        s=sums[key];h=data["matched_actual_cashflow_annual_hold"][key]
        lines.append(f"| {LABELS[key]} | {s['xirr_pct']:.2f}%／{s['max_drawdown_pct']:.2f}% | {h['xirr_pct']:.2f}%／{h['max_drawdown_pct']:.2f}% |")
    lines += ["", "新年度模型在每次入金对应净值处分段链接TWR：先计算入金前的市场变动，再计算入金后的交易费用影响；入金本身不产生收益。旧单笔模型沿用原存档的日末入金扣除约定，两组表的资金计划与计算细节均有区别，应分别解读。", "",
        "五种策略的逐日权益、TWR、4,174个计划或阈值成交事件、FIFO费用、现金分红及入金已通过独立Decimal复算；提前截断样本确认定投金额不随终点改变。原始净值主档未改变。准确复算不等于未来投资优势。", "",
        f"新增逐日结果与计划预设：`{STEM}.json`、`{STEM}_预设.json`；可复算脚本：`compare_270023_scheduled.py`。全部金额仅为假设预算比值，不含真实账户金额。", ""]
    return lines


def render_chart(data,path):
    os.environ.setdefault("MPLCONFIGDIR",os.path.join(tempfile.gettempdir(),"codex-270023-mpl"))
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import font_manager
    font=Path("C:/Windows/Fonts/msyh.ttc")
    if font.is_file():
        font_manager.fontManager.addfont(str(font))
        plt.rcParams["font.family"]=font_manager.FontProperties(fname=str(font)).get_name()
    else:
        plt.rcParams["font.family"]="sans-serif"
        plt.rcParams["font.sans-serif"]=["Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"]=False
    display_order=("initial_hold",)+ORDER
    summaries={k:v["summary"] for k,v in data["cases"].items()}
    summaries["initial_hold"]=data["initial_buy_hold_benchmark"]["summary"]
    fig,axes=plt.subplots(1,2,figsize=(15,7.5),sharey=True)
    fig.set_facecolor("#f6f7f9")
    for ax,key,title in zip(axes,("xirr_pct","max_drawdown_pct"),("资金年化 XIRR（%）","最大回撤（%，越低越好）")):
        ax.set_facecolor("white")
        ax.spines[["top","right","left"]].set_visible(False)
        ax.grid(axis="x",color="#e1e8eb",lw=.7,zorder=0)
        values=[summaries[k][key] for k in display_order]
        ax.barh(range(len(display_order)),values,height=.53,color=[COLORS[k] for k in display_order],zorder=3)
        for index,value in enumerate(values):
            ax.text(value+.01*max(values),index,f"{value:.2f}%",va="center",fontsize=11,color="#304c59")
        ax.set_yticks(range(len(display_order)),[LABELS[k] for k in display_order],fontsize=10)
        ax.axhline(.5,color="#aebbc3",lw=1,ls="--")
        ax.set_xlim(0,max(values)*1.22)
        ax.tick_params(axis="y",length=0)
        ax.tick_params(axis="x",labelsize=9,colors="#5b737d")
        ax.set_title(title,loc="left",fontsize=12,pad=15,color="#304c59")
    axes[0].invert_yaxis()
    fig.suptitle("广发全球精选 · 长期持有、定投与阈值调仓",x=.28,y=.96,ha="left",fontsize=18,fontweight="bold",color="#294553")
    fig.text(.28,.88,"2010-08-18—2026-10-14  |  首行仅期初投入；其余各行每年新增预算",fontsize=10.5,color="#5b707d")
    fig.text(.28,.035,"年度阈值版：年初买入新预算并重置基准；卖出按当时市值，加仓按前次成交后基准市值。\n资金计划不同，应分组解读。静态费用、现金零息、分红留现金；原规则额外补款已计入XIRR。",fontsize=9,color="#5e7582")
    fig.subplots_adjust(left=.28,right=.98,top=.78,bottom=.17,wspace=.20)
    fig.savefig(path,dpi=150,facecolor=fig.get_facecolor())
    plt.close(fig)


if __name__=="__main__":
    section=build_section()
    print(json.dumps({"chart":str(OUT/(STEM+".png")),"section_lines":len(section)},ensure_ascii=False))
