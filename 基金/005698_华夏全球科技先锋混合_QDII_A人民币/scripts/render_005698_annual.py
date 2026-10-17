"""Research report for public-NAV annual rules; no account data."""
import datetime as dt
import json
import os
import sys
import tempfile
from pathlib import Path

from optimize_005698_annual import FUND,OUT,STEM,REFERENCE,SOURCE,CAP

LABELS={'initial_hold':'标准：期初买入长期不动', 'annual_hold':'每年年初买入并持有',
        'monthly':'每月定投','daily':'每日定投','annual_original':'年度＋涨15卖10／跌15加15',
        'annual_40_30':'年度＋涨40卖20／跌30加30',
        'hindsight_best':'年度＋涨50卖50／跌15加10',
        'minimum_drawdown':'年度＋涨20卖20／跌30加30',
        'chronological_frozen':'训练期冻结：涨20卖30／跌10加30'}
ORDER=('initial_hold','annual_hold','monthly','daily','annual_original','annual_40_30','hindsight_best','minimum_drawdown')
COLORS={'annual_40_30':'#ba6259','hindsight_best':'#187e74','minimum_drawdown':'#456ea2','annual_hold':'#be8a40'}


def read(path):return json.loads(path.read_text(encoding='utf-8-sig'))


def continued_diagnostics(data):
    """Keep the state created BEFORE the development lock date."""
    from annual_threshold_backtest import xirr,YEAR
    results={}
    for key in ('annual_40_30','hindsight_best','minimum_drawdown','chronological_frozen'):
        case=data['cases'][key]
        before=[r for r in case['daily'] if r['date']<'2022-01-01'][-1]
        after=[r for r in case['daily'] if r['date']>='2022-01-01']
        anchor=before['twr_index'];peak=1.;worst=0.
        for row in after:
            value=row['twr_index']/anchor
            peak=max(peak,value);worst=max(worst,1-value/peak)
        first=dt.date.fromisoformat(before['date']);last=dt.date.fromisoformat(after[-1]['date'])
        cagr=((after[-1]['twr_index']/anchor)**(YEAR/(last-first).days)-1)*100
        flows=[(first,-before['total_norm'])]
        flows += [(dt.date.fromisoformat(r['date']),-r['regular_today_norm']-r['extra_today_norm']) for r in after if r['regular_today_norm']+r['extra_today_norm']>0]
        flows.append((last,after[-1]['total_norm']))
        results[key]={'start_valuation_date':before['date'],'end_date':after[-1]['date'],
                      'twr_annualized_pct':cagr,'max_drawdown_pct':worst*100,'xirr_pct':xirr(flows)}
    (OUT/(STEM+'_时序承接诊断.json')).write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
    return results


def main():
    data=read(OUT/(STEM+'.json'))
    summaries={k:v['summary'] for k,v in data['cases'].items()}
    benchmark=summaries['annual_40_30'];winner=summaries['hindsight_best'];defensive=summaries['minimum_drawdown']
    grid=read(OUT/(STEM+'_全历史网格.json'))
    chart=OUT/(STEM+'_研究图.png')
    report=OUT/(STEM+'_研究报告.md')
    carried=continued_diagnostics(data)
    audit_path=OUT/'005698_年度策略数据与费率核验_2026-10-16.json'
    audit=read(audit_path) if audit_path.exists() else None
    lines=['# 华夏全球科技先锋（005698）年度投入规则研究报告','',
        '研究日：2026-10-16。全历史单位净值：2018-04-17—2026-10-15，共1,979条；人民币A类。假设完整年度预算归一化为1，全部计算仅使用公开净值，不读取真实账户交易或金额。','',
        '本地第三方主档已与华夏官网99页历史净值逐条交叉核验：官网1,978条日期、单位净值、累计净值全部一致，零差异；本地另有2018-04-17成立面值记录，当前官网净值分页未列该日。这是发布渠道核验，不声称独立重算基金底层估值。','',
        '## 结论','',
        '**40/30在华夏不是本次有限网格内的收益回撤比最优。** 在预设的年化收益底线与资金约束下，全历史事后比值最高为“涨50%卖50%、跌15%加10%”；同一收益底线下，回撤最低为“涨20%卖20%、跌30%加30%”。二者是不同目标的事后取舍点。','',
        '比值冠军对成交时点敏感，提前一个净值观察日成交后，其回撤由约42.13%升至54.33%，资金需求也超出筛选上限。仅用2018—2021选择并冻结的另一规则，后续也未通过资金约束。**这次找到了新的历史候选，没有证明可靠的未来最优规则。**','',
        '## 全历史策略一起比较','',
        '除标准对照外，每种策略都在每年首个可用净值观察日收到相同的新年度预算。标准对照只在期初买入一次，之后不追加、不买卖；资金计划不同，不能只按期末资产或XIRR高低给所有行排同一种名次。','',
        '| 策略（比例均为%） | TWR年化 | 资金年化XIRR | 最大回撤 | 年化／回撤 | 额外追加／计划总预算 |',
        '|---|---:|---:|---:|---:|---:|']
    for key in ORDER:
        s=summaries[key]
        lines.append(f"| {LABELS[key]} | {s['twr_annualized_pct']:.2f}% | {s['xirr_pct']:.2f}% | {s['max_drawdown_pct']:.2f}% | {s['calmar']:.3f} | {s['extra_over_regular_pct']:.2f}% |")
    lines += ['', '最大回撤统一对剔除外部入金后的TWR策略净值计算，包含现金；它不是不断追加本金的账户市值曲线回撤，也不是对XIRR求回撤。','',
        f"比值冠军相对40/30：TWR年化高{winner['twr_annualized_pct']-benchmark['twr_annualized_pct']:.2f}个百分点，最大回撤低{benchmark['max_drawdown_pct']-winner['max_drawdown_pct']:.2f}个百分点；XIRR仅高{winner['xirr_pct']-benchmark['xirr_pct']:.2f}个百分点。TWR剔除入金本身，XIRR反映实际入金时间与资金权重。40/30在2022年大跌后补入较多外部资金，不能把它的资金年化等同于同样初始本金的策略收益。",'',
        f"回撤最低候选相对40/30：TWR年化高{defensive['twr_annualized_pct']-benchmark['twr_annualized_pct']:.2f}个百分点，回撤低{benchmark['max_drawdown_pct']-defensive['max_drawdown_pct']:.2f}个百分点，且历史中无计划外补款；但XIRR低{benchmark['xirr_pct']-defensive['xirr_pct']:.2f}个百分点。它降低基金敞口，不能说投资人的资金年化也全面改善。",'',
        '![华夏年度规则收益与回撤](<'+chart.name+'>)','',
        '## 新规则具体怎样执行','',
        '| 规则 | 涨幅触发及卖出 | 跌幅触发及加仓 |',
        '|---|---|---|',
        '| 40/30对照 | 相对基准涨40%，卖出当时全部基金市值20% | 相对基准跌30%，含费加仓预算为前次成交后基金市值30% |',
        '| 本次事后比值最高 | 相对基准涨50%，卖出当时全部基金市值50% | 相对基准跌15%，含费加仓预算为前次成交后基金市值10% |',
        '| 收益底线内回撤最低 | 相对基准涨20%，卖出当时全部基金市值20% | 相对基准跌30%，含费加仓预算为前次成交后基金市值30% |','',
        '每年新预算先买入，然后重置净值与买入后全部基金市值基准；年初买入优先，取消尚未执行的旧信号，当天不再产生新阈值信号。其他实际买卖成交后也重置。涨跌不是每日涨跌，也不是相对历史最高点。先用留存现金加仓，不足由外部补足；卖出现金留在账户。主动信号滞后2个净值观察日成交。','',
        '## 数学目标与搜索范围','',
        '```text',
        '主目标：最大化 全历史TWR年化 / 最大回撤',
        '收益约束：TWR年化 >= max(0, 同期年度40/30的TWR年化)，且年化为正',
        '资金约束：任一时点 累计计划外补款 / 累计已到账年度预算 <= 50%',
        '次目标：在相同收益、资金约束下，找最大回撤最低的参数',
        '```','',
        '上涨、下跌阈值各取5%、10%、15%、20%、25%、30%、40%、50%、60%；卖出、加仓比例各取0%、5%、10%、15%、20%、30%、50%。比例为零禁用该方向，合并冗余参数后共3,025组。50%卖出比例为本轮上界，因此不能把比值冠军称为连续参数空间的全局最优。','',
        f"其中{data['complete_grid_count']:,}组完成全历史，{data['pruned_count']:,}组因在某日补款比例超限提前淘汰；已发生的超限不会被之后年度入金抹掉。收益与资金约束内有{data['eligible_count']:,}组，跑完历史的{data['complete_grid_count']:,}组参数中有{data['different_full_trading_path_count']:,}种不同的实际阈值成交路径，提前淘汰者的完整路径未计算。参数组合不等于独立样本。",'',
        f"在约束内共有{len(data['dominators_of40_30']):,}组参数达到TWR年化不低于40/30、回撤不高于40/30且累计计划外补款总额不更多，并至少改善收益或回撤；这里未要求每个日期的补款需求也更低。它们高度相关，不能解释为这么多次独立胜出。",'',
        '回撤比最高不等于绝对收益最高。本研究增加收益底线，避免选择仅靠低仓位、低收益制造高比值的方案。50%补款是研究筛选假设，并非未来账户的自动拒单规则；敏感性及冻结规则即使超限也照原规则计算，并明确记为失败。','',
        '## 账户敞口与资金需求','',
        '| 年度规则 | 平均基金占比 | 期末基金占比 | 任一时点补款／已到账预算峰值 | 阈值买／卖次数 |',
        '|---|---:|---:|---:|---:|']
    for key in ('annual_40_30','hindsight_best','minimum_drawdown'):
        s=summaries[key]
        lines.append(f"| {LABELS[key]} | {s['average_fund_weight_pct']:.1f}% | {s['end_fund_weight_pct']:.1f}% | {s['peak_extra_over_regular_pct']:.2f}% | {s['tactical_buy_count']}／{s['tactical_sell_count']} |")
    lines += ['', '平均仓位按观察日简单平均；补款峰值使用当时已经到账的预算作分母，不借未来年度预算掩盖早期资金需求。较低回撤的一部分来自较低基金仓位与较多现金，不是无代价的超额收益。','',
        '## 成交延迟敏感性','',
        '| 规则 | 延迟观察日 | TWR年化 | 最大回撤 | 年化／回撤 | 补款峰值 |',
        '|---|---:|---:|---:|---:|---:|']
    for key in ('annual_40_30','hindsight_best','minimum_drawdown'):
        for s in data['sensitivities'][key]['full_lags']:
            lines.append(f"| {LABELS[key]} | {s['lag']} | {s['twr_annualized_pct']:.2f}% | {s['max_drawdown_pct']:.2f}% | {s['calmar']:.3f} | {s['peak_extra_over_regular_pct']:.2f}% |")
    lines += ['', '50/15候选在延迟1个观察日时跌出资金可行范围，并丢失大部分回撤改善；它只有3次阈值卖出，少数关键事件足以改变整条路径。20/30候选在这三档延迟下的回撤较低、无需计划外补款；但延迟3日时年化9.25%，低于主窗口约9.63%的收益底线，也低于同延迟40/30的9.79%，该档未通过收益约束，不能称各档收益都占优。它的邻近参数及其他分段也不能证明广泛稳健。','',
        '## 时序检验与失败证据','',
        '先仅用2018—2021数据跑网格，冻结“涨20%卖30%、跌10%加30%”，再运行全历史网格；原冻结文件保留。开发期年化／回撤约0.534，看起来很好，但它的全历史补款峰值约148.86%，显著突破50%的研究上限。不能用事后新冠军替换它，再声称原选择通过了验证。','',
        '| 重新起算的分段 | 40/30：TWR年化／回撤 | 事后比值冠军：TWR年化／回撤 | 原冻结规则：TWR年化／回撤 |',
        '|---|---:|---:|---:|']
    for period,label in [('development','2018—2021'),('validation','2022—2023'),('recent','2024—2026')]:
        row=[]
        for key in ('annual_40_30','hindsight_best','chronological_frozen'):
            s=data['diagnostics'][key][period][1]
            row.append(f"{s['twr_annualized_pct']:.2f}%／{s['max_drawdown_pct']:.2f}%")
        lines.append(f"| {label} | "+' | '.join(row)+' |')
    lines += ['', '分段表各自从基金仓位零、新预算开始，不应拼成一个连续账户。全历史冠军使用过所有分段，后两段对它只能称事后诊断；对于原冻结规则，2022—2023收益与资金需求均显示选择失效。历史走势本来可见，这也不是完全未接触过数据的前瞻检验。','',
        '另保留2018—2021结束时的真实模型状态，从2022起继续持有原仓位及现金，得到以下承接诊断；其中期初组合估值仅用于模拟资金年化，不代表实际账户。','',
        '| 保留状态到2022起 | 后续TWR年化 | 后续最大回撤 | 后续资金年化 |',
        '|---|---:|---:|---:|']
    for key,s in carried.items():
        lines.append(f"| {LABELS[key]} | {s['twr_annualized_pct']:.2f}% | {s['max_drawdown_pct']:.2f}% | {s['xirr_pct']:.2f}% |")
    lines += ['', '## 起点、完整年度与费用','',
        '| 规则 | 2019—2025年化／回撤 | 日常申购开放日起年化／回撤 | 零交易费全历史年化／回撤 |',
        '|---|---:|---:|---:|']
    for key in ('annual_40_30','hindsight_best','minimum_drawdown'):
        vals=[]
        for field in ('complete2019_2025','subscription_open2018_06_11','zero_fee'):
            s=data['sensitivities'][key][field]
            vals.append(f"{s['twr_annualized_pct']:.2f}%／{s['max_drawdown_pct']:.2f}%")
        lines.append(f"| {LABELS[key]} | "+' | '.join(vals)+' |')
    lines += ['', '完整2019—2025窗口中，50/15与20/30的收益回撤比约0.283和0.303，排名与主窗口不同。起点变化也改变第一年预算及初始状态，不能把它解释为对同一已持仓账户只少看几个日期。','',
        '成立日为2018-04-17，日常人民币申购、赎回和定投于2018-06-11才开放，开放前有9条观察。因此全历史首日模型属于成立时已持有／理想买入，不是已核验当日可日常申购。开放日起敏感性单独重新开始。净值主档还含5条周末会计估值，不应把每个净值观察日当作真实开放日。','',
        '另从2018-06-11起剔除所有周末观察，固定参数重算，三组关键候选的主要指标与开放日起敏感性在显示精度内一致；本次关键结论并非仅由这5条周末记录造成。此过滤仍未重建中外共同开放日、历史暂停、限购、确认及结算。','',
        '本模型申购按项目约定的0.15%静态优惠费率；官方标准申购普通档为1.5%，不能把折扣当作全历史真实费率。赎回按FIFO，持有自然日不足7日1.5%、7日至不足30日0.75%、30日至不足365日0.5%、365日起零；成交日近似确认日。这个阶梯与广发不同。','',
        '2018启动预算为4—12月共9个月；之后各年均为全年预算，2026未到期的日/月定投额度仍计现金，不按截至日提前花完。月投每月首观察日投1/12；日投把每月预算按日历天数均分，无观察日额度下次合并。现金零息，期末按净值估值而非全部赎回。','',
        '40/30在最后观察日触发了尚未到期的加仓信号，主结果未假设未来已经成交；截至日变化仍可能改变结果。官方分红表为空、单位净值及累计净值全程一致，截至截点未发现现金分红事件，未将累计净值误当额外收益。','',
        '## 同实际入金的持有对照','',
        '| 规则 | 规则资金年化／回撤 | 同日期同入金买入持有资金年化／回撤 |',
        '|---|---:|---:|']
    for key in ('annual_40_30','hindsight_best','minimum_drawdown'):
        s=summaries[key];h=data['matched_actual_cashflow_hold'][key]
        lines.append(f"| {LABELS[key]} | {s['xirr_pct']:.2f}%／{s['max_drawdown_pct']:.2f}% | {h['xirr_pct']:.2f}%／{h['max_drawdown_pct']:.2f}% |")
    lines += ['', '## 怎么理解这次结果','',
        '若只回答“华夏是否也应沿用广发40/30”：本次全历史模型不支持它是最优。若按预设收益回撤比目标，50/15、卖50/买10是样本内冠军；若更看重降低回撤和减少补款，可把20/30、卖20/买30作为另一研究候选，但它的资金年化更低。','',
        '不能把事后胜出直接等同于可执行升级：3,025组相关参数、少数关键卖点、成交延迟敏感，以及时序冻结规则的失败，都限制了投资确定性。保持原参数锁定与失败证据，没有降低筛选标准去制造稳健赢家。','',
        '## 来源与复算','',
        '- [华夏基金005698官方产品页](https://www.chinaamc.com/fund/005698/index.shtml)。本地公开净值主档来自天天基金；官网99页全量核验档案为`005698_年度策略数据与费率核验_2026-10-16.json`，原始响应已归档。',
        '- [华夏全球科技先锋混合型证券投资基金（QDII）招募说明书，2026-05-29](https://www.chinaamc.com/upload/resources/file/2026/05/29/928e507e97ae4998986f27e068688a4f.pdf)：成立与开放日期、费率，用作统一静态成本敏感性。',
        '- [Bailey等：回测过拟合概率](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)：大量历史参数试验可能产生事后赢家，计算正确不等于未来有效。',
        '- 原始净值主档只读，SHA-256记录于预设及结果JSON。新共享引擎逐日复现此前广发五种策略，主要指标误差低于2×10⁻¹³。华夏关键候选、买持及冻结失败案例已独立用Decimal复算，逐日权益、TWR与交易记录一致，误差约2×10⁻¹³；全网格配置覆盖、资金剪枝及择优规则亦已审计。并未独立重跑全部3,025组。',
        f'- 预设：`{STEM}_预设.json`；时序锁定：`{STEM}_时序锁定.json`；全网格：`{STEM}_全历史网格.json`；完整逐日结果：`{STEM}.json`。',
        '- 单基金入口：`scripts/optimize_005698_annual.py`；公共引擎：`公共资料/工具/annual_threshold_backtest.py`。','']
    report.write_text('\n'.join(lines),encoding='utf-8')
    draw(data,grid,chart)
    print(json.dumps({'report':str(report),'chart':str(chart),'official_audit_present':audit is not None},ensure_ascii=False))


def draw(data,grid,path):
    os.environ.setdefault('MPLCONFIGDIR',os.path.join(tempfile.gettempdir(),'codex-005698-mpl'))
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib import font_manager
    font=Path('C:/Windows/Fonts/msyh.ttc')
    if font.is_file():
        font_manager.fontManager.addfont(str(font))
        plt.rcParams['font.family']=font_manager.FontProperties(fname=str(font)).get_name()
    else:
        plt.rcParams['font.family']='sans-serif'
        plt.rcParams['font.sans-serif']=['Noto Sans CJK SC', 'Microsoft YaHei', 'PingFang SC', 'DejaVu Sans']
    plt.rcParams['axes.unicode_minus']=False
    fig,axes=plt.subplots(1,2,figsize=(15,7),gridspec_kw={'width_ratios':[1,1.15]})
    fig.set_facecolor('#f6f7f9')
    for ax in axes:
        ax.set_facecolor('white');ax.spines[['top','right']].set_visible(False)
        ax.grid(axis='y',color='#e3e9ed',lw=.7);ax.tick_params(labelsize=9,colors='#526c79')
    feasible=[r for r in grid if not r.get('pruned')]
    axes[0].scatter([r['max_drawdown_pct'] for r in feasible],[r['twr_annualized_pct'] for r in feasible],s=8,color='#b5c0c9',alpha=.35)
    front=data['full_pareto']
    axes[0].plot([r['max_drawdown_pct'] for r in front],[r['twr_annualized_pct'] for r in front],color='#638291',lw=1.2,ls='--')
    axes[0].axhline(data['return_floor_pct'],color='#ba6259',ls=':',lw=1)
    for key,label,offset in [('annual_40_30','40/30对照',(-65,-18)),('hindsight_best','50/15：事后比值最高',(-125,15)),('minimum_drawdown','20/30：收益底线内回撤最低',(-135,-30)),('annual_hold','年度买入持有',(-80,15))]:
        s=data['cases'][key]['summary'];color=COLORS[key]
        axes[0].scatter(s['max_drawdown_pct'],s['twr_annualized_pct'],color=color,s=55,zorder=5)
        axes[0].annotate(label,(s['max_drawdown_pct'],s['twr_annualized_pct']),xytext=offset,textcoords='offset points',fontsize=9,color=color)
    axes[0].set_xlabel('最大回撤（%）',fontsize=10);axes[0].set_ylabel('TWR年化（%）',fontsize=10)
    for key,label in [('annual_40_30','40/30对照'),('hindsight_best','50/15：卖50／买10'),('minimum_drawdown','20/30：卖20／买30'),('annual_hold','年度买入持有')]:
        rows=data['cases'][key]['daily']
        axes[1].plot([dt.datetime.fromisoformat(r['date']) for r in rows],[r['twr_index']*100 for r in rows],label=label,color=COLORS[key],lw=1.5)
    axes[1].set_ylabel('策略净值（剔除入金，初始=100）',fontsize=10)
    axes[1].legend(frameon=False,fontsize=9,loc='upper left')
    fig.suptitle('华夏全球科技先锋 · 年度规则的历史取舍',x=.07,y=.97,ha='left',fontsize=20,fontweight='bold',color='#294553')
    fig.text(.07,.90,'3,025组参数  |  2018-04-17—2026-10-15  |  年初新增预算买入并重置基准；统一静态费用',fontsize=10.5,color='#5e7582')
    fig.text(.07,.035,'全历史冠军属于事后选择；50/15候选提前一个观察日成交时，回撤改善明显减弱。\n官网1,978条净值交叉核验一致，另有成立面值记录；观察日代理成交日，历史申赎限制与结算未完整还原。',fontsize=9,color='#5e7582')
    fig.subplots_adjust(left=.07,right=.98,top=.83,bottom=.17,wspace=.28)
    fig.savefig(path,dpi=150,facecolor=fig.get_facecolor());plt.close(fig)


if __name__=='__main__':main()
