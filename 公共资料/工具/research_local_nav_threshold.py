"""Reproducible finite-grid research using public NAV and normalized budgets only.

This entry point never reads investor positions, trades, screenshots or amounts.
Each fund owns its configuration, frozen protocol, results and rule entry.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
from pathlib import Path

from annual_threshold_backtest import YEAR, prepare, simulate
from annual_threshold_study import configurations, neighbors, pareto, ranking, tie_summary
from annual_threshold_settlement import simulate_settlement

ROOT = Path(__file__).resolve().parents[2]
ENGINE = Path(__file__).with_name('annual_threshold_backtest.py')
GRID_TOOL = Path(__file__).with_name('annual_threshold_study.py')
SETTLEMENT_TOOL = Path(__file__).with_name('annual_threshold_settlement.py')
REFERENCE = (.40, .30, .20, .30)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def put(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise FileExistsError('Preserve existing research: ' + str(path))
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')


def window_result(case, start):
    """TWR slice of a continuous simulation; preserve pre-test holdings and cash."""
    before = [r for r in case['daily'] if r['date'] < start]
    rows = [r for r in case['daily'] if r['date'] >= start]
    assert rows and before
    base = before[-1]['twr_index']
    peak = 1.
    drawdown = 0.
    for row in rows:
        value = row['twr_index'] / base
        peak = max(peak, value)
        drawdown = max(drawdown, 1-value/peak)
    factor = rows[-1]['twr_index']/base
    years = (dt.date.fromisoformat(rows[-1]['date'])-dt.date.fromisoformat(before[-1]['date'])).days/YEAR
    return {'start': rows[0]['date'], 'end': rows[-1]['date'],
            'twr_return_pct': (factor-1)*100,
            'twr_annualized_pct': (factor**(1/years)-1)*100,
            'max_drawdown_pct': drawdown*100,
            'end_fund_weight_pct': rows[-1]['fund_weight_pct'],
            'tactical_trades': sum(t['kind'] in ('buy', 'sell') and t['date'] >= start for t in case['trades']),
            'holding_and_cash_carried_from_training': True}


class Research:
    def __init__(self, config_path, resume=False):
        self.config_path = Path(config_path).resolve()
        self.c = load(self.config_path)
        self.code = self.c['code']
        folders = list((ROOT/'基金').glob(self.code+'_*'))
        assert len(folders) == 1, 'One existing folder per code required'
        self.fund = folders[0]
        self.out = self.fund/'研究'
        self.stem = self.code+'_年度阈值量化研究_截至'+self.c['cutoff']
        self.source = self.fund/'历史净值'/(self.code+'_全部历史净值_截至'+self.c['cutoff']+'.json')
        self.raw = load(self.source)
        source_rows = self.raw['rows']
        assert source_rows == sorted(source_rows, key=lambda r:r['date'])
        assert len({r['date'] for r in source_rows}) == len(source_rows)
        assert all(math.isfinite(float(r['nav'])) and float(r['nav']) > 0 for r in source_rows)
        assert source_rows[-1]['date'] == self.c['cutoff']
        assert all(not r.get('event') for r in source_rows), 'Adjust distributions/splits explicitly first'
        assert all(r.get('accumulated_nav') is None or abs(float(r['nav'])-float(r['accumulated_nav']))<1e-10
                   for r in source_rows), 'Possible distributions/splits: stop unadjusted research'
        self.all_rows = [{'date':r['date'], 'nav':float(r['nav'])} for r in source_rows]
        self.rows = [r for r in self.all_rows if dt.date.fromisoformat(r['date']).weekday()<5]
        self.full = prepare(self.rows)
        self.cap = float(self.c.get('funding_cap', .5))
        self.tiers = tuple(tuple(x) for x in self.c['redemption_tiers'])
        assert self.c['fees_verified'], 'Official fee evidence required before registered search'
        assert self.c.get('subscription_open_date'), 'Ordinary subscription opening must be documented'
        self.protocol = {
            'schema':'public-nav-threshold-research-v1', 'fund_code':self.code, 'fund_name':self.c['name'],
            'created_at':dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec='seconds'),
            'source_path':self.source.relative_to(ROOT).as_posix(), 'source_sha256':sha(self.source),
            'engine_sha256':sha(ENGINE), 'grid_library_sha256':sha(GRID_TOOL),
            'settlement_stress_tool_sha256':sha(SETTLEMENT_TOOL),
            'research_tool_sha256':sha(Path(__file__)), 'config_sha256':sha(self.config_path),
            'source_start':self.rows[0]['date'], 'source_end':self.rows[-1]['date'], 'source_rows':len(self.all_rows),
            'analysis_rows':len(self.rows), 'weekdays_only_main':True,
            'weekend_observations':[r['date'] for r in self.all_rows if dt.date.fromisoformat(r['date']).weekday()>4],
            'missing_accumulated_nav_dates':[r['date'] for r in source_rows if r.get('accumulated_nav') is None],
            'data_scope':'Local archived public third-party NAV; no new independent official full-series reconstruction',
            'normalization':'Hypothetical annual budget=1; no investor account data or amounts',
            'funding':'Year-first NAV buy; startup budget=(13-start_month)/12, later years=1, including unfinished final year. Annual purchases reset anchors and cancel pending signals.',
            'rule_order':['up_threshold','down_threshold','sell_fraction','buy_fraction'],
            'signal':'Unit NAV relative to preceding executed trade NAV. Sell fraction of execution fund value. Buy gross budget fraction of preceding post-trade fund value. Both anchors reset only after execution.',
            'cash':'Zero interest; no borrowing. Base accounting treats sale proceeds available at execution; real redemption settlement is not reconstructed. Extra cash supplied externally if needed; not returns.',
            'fee_assumptions':{'subscription':self.c['buy_fee'], 'redemption_FIFO':self.tiers,
                               'source':self.c['fee_evidence'], 'execution_date_proxies_confirmation':True},
            'lag_NAV_observations':2, 'canonical_grid_count':len(configurations()),
            'threshold_grid_pct':[5,10,15,20,25,30,40,50,60],
            'trade_fraction_grid_pct':[0,5,10,15,20,30,50],
            'constraints':{'at_every_observation_extra_to_cumulative_annual_budget_max':self.cap,
                           'CAGR_floor':'max(0, same-period annual-buy-and-hold TWR CAGR)', 'CAGR_must_be_positive':True},
            'objective':'Maximize annualized TWR / maximum TWR drawdown (Calmar) among eligible finite-grid rules',
            'alternatives':'Maximum CAGR and minimum drawdown in identical eligible set; all feasible Pareto frontier disclosed',
            'tie_break':'Calmar rounded12 decimals, fewer tactical trades, lower normalized extra, distance to40/30 reference, lexicographic',
            'chronology':'Expanding annual training with >=730 calendar days; freeze each rule and test following calendar year. Main train through2025, test2026. Full-history descriptive search LAST.',
            'validation_scope':'Retrospective chronological diagnostics, not prospectively untouched data; current partial2026 is a short regime sample',
            'robustness':'Fixed winners only: lag1/2/3/5, no fees, official standard subscription, all accounting dates, ordinary subscription start, redemption settlement weekday approximation, grid neighbors; no reselection.',
            'limitations':'NAV observation days are not fully reconstructed dealing days. Historical suspension, purchase limits, publication/confirmation/settlement dates, historical discounts are not modeled. Inception buy is idealized; ordinary-open-start sensitivity reported.',
        }
        path = self.path('_预设')
        if path.exists():
            if not resume:
                raise FileExistsError('Use --resume only for identical registered experiment')
            old = load(path)
            assert {k:v for k,v in old.items() if k!='created_at'} == json.loads(json.dumps({
                k:v for k,v in self.protocol.items() if k!='created_at'})), 'Registered inputs/protocol changed'
            self.protocol = old
        else:
            put(path, self.protocol)

    def path(self, suffix):
        return self.out/(self.stem+suffix+'.json')

    def evaluate(self, data, rule=None, **kwargs):
        return simulate(data, rule, buy_fee=self.c['buy_fee'], redemption_tiers=self.tiers, **kwargs)

    def grid(self, data, suffix):
        path = self.path(suffix)
        if path.exists():
            return load(path)
        records=[]
        for i, rule in enumerate(configurations(), 1):
            records.append(self.evaluate(data, rule, max_extra_ratio=self.cap))
            if i%1000==0:
                print(json.dumps({'code':self.code,'phase':suffix,'completed':i,'total':len(configurations())}),flush=True)
        put(path, records)
        return records

    def fold(self, year):
        path = self.path('_时序检验'+str(year))
        if path.exists():
            return load(path)
        start=str(year)+'-01-01'
        train=prepare([r for r in self.rows if r['date']<start])
        test=prepare([r for r in self.rows if r['date']>=start and r['date']<str(year+1)+'-01-01'])
        train_hold=self.evaluate(train)
        floor=max(0.,train_hold['twr_annualized_pct'])
        grid=self.grid(train, '_训练网格'+str(year-1))
        ranked=ranking(grid,floor,self.cap)
        lock={'train_start':train['rows'][0]['date'],'train_end':train['rows'][-1]['date'],
              'test_start':test['rows'][0]['date'],'test_end':test['rows'][-1]['date'],
              'train_hold':train_hold,'return_floor_pct':floor,'eligible_count':len(ranked),
              'selected':ranked[0] if ranked else None,'score_ties':tie_summary(ranked),
              'no_candidate_fallback':'annual_buy_and_hold', 'test_not_evaluated_before_lock':True,
              'full_grid_not_evaluated_before_lock':True}
        lockpath=self.path('_参数锁定'+str(year))
        if not lockpath.exists():
            put(lockpath,lock)
        else:
            assert load(lockpath)==json.loads(json.dumps(lock))
        rule=tuple(ranked[0]['rule']) if ranked else None
        upto=prepare([r for r in self.rows if r['date']<str(year+1)+'-01-01'])
        carried=self.evaluate(upto,rule,detail=True)
        carry_hold=self.evaluate(upto,detail=True)
        result={'lock_sha256':sha(lockpath),'lock':lock,
                'standalone_test':self.evaluate(test,rule,compute_xirr=True),
                'standalone_hold':self.evaluate(test,compute_xirr=True),
                'continuous_test':window_result(carried,start),
                'continuous_hold':window_result(carry_hold,start),
                'continuous_peak_extra_over_regular_pct':carried['summary']['peak_extra_over_regular_pct'],
                'funding_cap_breached_after_lock':carried['summary']['peak_extra_over_regular_pct']>self.cap*100+1e-9,
                'deployable_rule_claim':False}
        put(path,result)
        print(json.dumps({'code':self.code,'phase':'fold_locked_tested','year':year,
                          'rule':rule,'funding_cap_breached':result['funding_cap_breached_after_lock']}),flush=True)
        return result

    def run(self):
        if self.path('').exists():
            raise FileExistsError('Final research already exists; inspect without overwriting')
        first=dt.date.fromisoformat(self.rows[0]['date'])
        lastyear=int(self.rows[-1]['date'][:4])
        folds=[]
        for year in range(first.year+1,lastyear+1):
            training_end=dt.date(year-1,12,31)
            if (training_end-first).days>=730:
                folds.append(self.fold(year))
        assert folds and folds[-1]['lock']['test_start'].startswith('2026')
        frozen=folds[-1]['lock']['selected']
        # All chronological diagnostics above are immutable before hindsight grid.
        baseline=self.evaluate(self.full,compute_xirr=True)
        floor=max(0.,baseline['twr_annualized_pct'])
        grid=self.grid(self.full,'_全历史网格')
        ranked=ranking(grid,floor,self.cap)
        assert ranked,'No positive feasible rule beating passive return; report no candidate, never relax criteria'
        primary=ranked[0]
        high=max(ranked,key=lambda r:(r['twr_annualized_pct'],-r['max_drawdown_pct'],-r['extra_contributed_norm']))
        low=min(ranked,key=lambda r:(r['max_drawdown_pct'],-r['twr_annualized_pct'],r['rule']))
        rules={'hindsight_calmar':tuple(primary['rule']), 'hindsight_max_return':tuple(high['rule']),
               'hindsight_min_drawdown':tuple(low['rule']), 'reference40_30':REFERENCE}
        if frozen:
            rules['chronological_frozen']=tuple(frozen['rule'])
        cases={name:self.evaluate(self.full,rule,detail=True) for name,rule in rules.items()}
        cases['annual_hold']=self.evaluate(self.full,detail=True)
        cases['monthly']=self.evaluate(self.full,schedule='monthly',detail=True)
        cases['initial_hold']=self.evaluate(self.full,initial_only=True,detail=True)
        accounting=prepare(self.all_rows)
        opened=prepare([r for r in self.rows if r['date']>=self.c['subscription_open_date']])
        sensitivities={}
        matched={}
        for name,rule in rules.items():
            if name=='reference40_30':
                continue
            sensitivities[name]={
                'lag':[self.evaluate(self.full,rule,lag=lag,compute_xirr=True) for lag in (1,2,3,5)],
                'zero_fees':simulate(self.full,rule,buy_fee=0.,redemption_tiers=(),compute_xirr=True),
                'standard_subscription':simulate(self.full,rule,buy_fee=self.c['standard_buy_fee'],redemption_tiers=self.tiers,compute_xirr=True),
                'all_accounting_dates':self.evaluate(accounting,rule,compute_xirr=True),
                'ordinary_subscription_open':self.evaluate(opened,rule,compute_xirr=True),
                'redemption_settlement_stress':simulate_settlement(self.full,rule,buy_fee=self.c['buy_fee'],
                    redemption_tiers=self.tiers,redemption_settlement_workdays=self.c['redemption_settlement_workdays'],compute_xirr=True),
                'neighbors':[self.evaluate(self.full,r,compute_xirr=True) for r in neighbors(rule)]}
            extras={row['date']:row['extra_today_norm'] for row in cases[name]['daily'] if row['extra_today_norm']}
            matched[name]=self.evaluate(self.full,forced_extras=extras,compute_xirr=True)
        result={'protocol':self.protocol,'source_sha256':sha(self.source),'main_selected_rule':primary['rule'],
                'main_training_selected_rule':frozen['rule'] if frozen else None,
                'full_history_return_floor_pct':floor,'eligible_count':len(ranked),
                'grid_count':len(grid),'funding_pruned_count':sum(bool(r.get('pruned')) for r in grid),
                'score_ties':tie_summary(ranked),'top20':ranked[:20], 'pareto':pareto(grid),
                'cases':cases,'chronological_folds':folds,'sensitivities':sensitivities,
                'matched_external_cashflow_hold':matched,
                'status':'Historical finite-grid candidates; not accepted rules or automatic trading instructions'}
        put(self.path(''),result)
        assert sha(self.source)==self.protocol['source_sha256']
        self.report(result)
        print(json.dumps({'code':self.code,'phase':'complete','selected':primary['rule'],
                          'CAGR_pct':primary['twr_annualized_pct'],'MDD_pct':primary['max_drawdown_pct']},ensure_ascii=False),flush=True)

    def report(self,r):
        cases=r['cases']
        winner=cases['hindsight_calmar']['summary']
        hold=cases['annual_hold']['summary']
        rule=winner['rule']
        fold=r['chronological_folds'][-1]
        frozen=fold['lock']['selected']
        pct=lambda x:f'{x:.2f}%'
        ruletext=lambda x: ('无合格阈值规则；预先约定回退为年度买入持有' if x is None else
                            f'涨{x[0]*100:g}%卖{x[2]*100:g}%；跌{x[1]*100:g}%加{x[3]*100:g}%')
        header=f'# {self.code} {self.c["name"]}：年度阈值量化研究\n\n'
        text=header+f'研究日期：2026-10-18。输入为本地冻结净值 **{self.rows[0]["date"]}—{self.rows[-1]["date"]}**，源文件共 **{len(self.all_rows)}** 条；剔除周末会计净值后主样本 **{len(self.rows)}** 条，另测全日期口径。全部使用假设归一化预算，未读取真实账户。\n\n'
        text+='## 数学目标与边界\n\n'
        text+='本研究沿用年度投入＋成交后重置的四参数阈值策略。完整穷举3025组互不重复的有限网格规则；上涨/下跌阈值取5、10、15、20、25、30、40、50、60%，卖出/加仓比例取0、5、10、15、20、30、50%。零比例使相应阈值失效并合并重复配置。\n\n'
        text+='以扣除费用和分离外部入金后的TWR序列为基础：`CAGR = TWR末值^(365.2425/实际天数) - 1`；`MDD = max(1 - TWR_t / 历史最高TWR)`；`Calmar = CAGR / MDD`。最大化Calmar，同时要求CAGR为正、至少达到同期间年度买入持有的CAGR，且任一时点累计计划外补款不超过累计年度预算的50%。并列按交易次数少、补款少、接近原40/30参考规则、参数字典顺序依次选择。\n\n'
        text+='参数上限、收益底线和资金上限属于明确研究假设；“最优”仅指该模型、该网格、该历史窗口的数学最优，不能推及全部策略或未来。\n\n'
        text+='## 全历史事后结果\n\n| 方案 | 规则 | TWR年化 | 最大回撤 | Calmar | XIRR | 补款峰值占累计年度预算 | 主动买/卖次数 |\n|---|---|---:|---:|---:|---:|---:|---:|\n'
        for key,label in [('hindsight_calmar','收益回撤比最优'),('hindsight_max_return','收益最高'),('hindsight_min_drawdown','回撤最低'),('annual_hold','年度买入持有'),('monthly','年度到账预算按月投入'),('reference40_30','原40/30参考'),('chronological_frozen','2025年底选定参数回看全历史')]:
            if key not in cases:continue
            s=cases[key]['summary']
            text+=f'| {label} | {ruletext(s["rule"]) if s["rule"] else "无阈值调仓"} | {pct(s["twr_annualized_pct"])} | {pct(s["max_drawdown_pct"])} | {s["calmar"]:.4f} | {pct(s["xirr_pct"])} | {pct(s["peak_extra_over_regular_pct"])} | {s["tactical_buy_count"]}/{s["tactical_sell_count"]} |\n'
        text+=f'\n合格规则{r["eligible_count"]}组；因资金约束提前淘汰{r["funding_pruned_count"]}组。Calmar并列{r["score_ties"]["primary_count"]}组，实际交易路径{r["score_ties"]["primary_path_count"]}条。未发生的阈值不能据此视为已经得到独立验证。\n\n'
        text+='## 冻结参数后的2026年时序检验\n\n'
        text+=f'仅用截至2025年底的资料选择：**{ruletext(frozen["rule"] if frozen else None)}**。锁定文件和验证文件先于全历史搜索保存，之后不因验证失败而换参数。\n\n'
        text+='| 检验口径 | 冻结规则TWR收益 | 年度持有TWR收益 | 冻结规则最大回撤 | 持有最大回撤 |\n|---|---:|---:|---:|---:|\n'
        a,b=fold['continuous_test'],fold['continuous_hold']
        text+=f'| 延续训练期仓位和现金的2026年区间 | {pct(a["twr_return_pct"])} | {pct(b["twr_return_pct"])} | {pct(a["max_drawdown_pct"])} | {pct(b["max_drawdown_pct"])} |\n'
        a,b=fold['standalone_test'],fold['standalone_hold']
        text+=f'| 2026年重新启动的诊断 | {pct((1+a["twr_annualized_pct"]/100)**prepare([x for x in self.rows if x["date"]>="2026-01-01"])["years"]*100-100)} | {pct((1+b["twr_annualized_pct"]/100)**prepare([x for x in self.rows if x["date"]>="2026-01-01"])["years"]*100-100)} | {pct(a["max_drawdown_pct"])} | {pct(b["max_drawdown_pct"])} |\n'
        text+=f'\n延续状态下，历史至检验结束的补款峰值为{pct(fold["continuous_peak_extra_over_regular_pct"])}；锁定后资金上限是否失效：**{"是" if fold["funding_cap_breached_after_lock"] else "否"}**。重启和延续状态是不同实验，不相互替代。该检验是事后按时间切割，2026年尚不足完整年度。\n\n'
        text+='## 逐年滚动时序诊断\n\n每次仅用之前至少730天历史选参，次年检验；各年可重新选择，但全年参数冻结。下表分别保存每个年度诊断，不拼接成未经会计处理的组合收益。\n\n| 检验年 | 当年前冻结规则 | 延续状态TWR收益 | 持有收益 | 最大回撤 | 资金上限失效 |\n|---|---|---:|---:|---:|---|\n'
        for f in r['chronological_folds']:
            x=f['lock']['selected']
            text+=f'| {f["lock"]["test_start"][:4]} | {ruletext(x["rule"] if x else None)} | {pct(f["continuous_test"]["twr_return_pct"])} | {pct(f["continuous_hold"]["twr_return_pct"])} | {pct(f["continuous_test"]["max_drawdown_pct"])} | {"是" if f["funding_cap_breached_after_lock"] else "否"} |\n'
        text+='\n## 固定全历史候选的敏感性\n\n以下均不重新选参；不能把这些结果当作样本外验证。\n\n| 情景 | TWR年化 | 最大回撤 | 补款峰值 |\n|---|---:|---:|---:|\n'
        sens=r['sensitivities']['hindsight_calmar']
        scenarios=[(f'延迟{x["lag"]}个净值观察日',x) for x in sens['lag']]+[(f'标准申购费{self.c["standard_buy_fee"]*100:g}%',sens['standard_subscription']),("零交易费",sens['zero_fees']),("包括周末会计净值",sens['all_accounting_dates']),("从日常申购开放起算",sens['ordinary_subscription_open']),(f'赎回款延后{self.c["redemption_settlement_workdays"]}个周一至周五到账',sens['redemption_settlement_stress'])]
        for label,s in scenarios:
            text+=f'| {label} | {pct(s["twr_annualized_pct"])} | {pct(s["max_drawdown_pct"])} | {pct(s["peak_extra_over_regular_pct"])} |\n'
        text+='\n到账压力情景将未到账赎回款计入应收资产，但禁止用于申购，现金不足时计外部补款；仅按周一至周五近似工作日，未还原节假日、境外休市和实际确认日，不能据此保证真实结算可行。\n'
        ns=sens['neighbors']
        text+=f'\n相邻一档参数共{len(ns)}组：TWR年化{pct(min(x["twr_annualized_pct"] for x in ns))}—{pct(max(x["twr_annualized_pct"] for x in ns))}，最大回撤{pct(min(x["max_drawdown_pct"] for x in ns))}—{pct(max(x["max_drawdown_pct"] for x in ns))}；逐组结果及其资金约束状态见JSON，不能把区间都视为合格策略。\n\n'
        m=r['matched_external_cashflow_hold']['hindsight_calmar']
        text+=f'把该候选所有年度入金和额外补款，在完全相同日期全部买入并持有，资金年化XIRR为{pct(m["xirr_pct"])}，该候选为{pct(winner["xirr_pct"])}；此比较防止把更多外部投入误认为策略收益。\n\n'
        text+='## 执行、数据与费用说明\n\n'+execution_text(self.c)
        text+=f'\n源文件SHA-256：`{r["source_sha256"]}`。全部原始净值和旧研究保持原样。\n\n'
        text+=f'- [输入净值](../历史净值/{self.source.name})\n- [全部结果与逐日路径]({self.stem}.json)\n- [研究预设]({self.stem}_预设.json)\n- [3025组全历史搜索]({self.stem}_全历史网格.json)\n- [2026参数锁定]({self.stem}_参数锁定2026.json)\n- [2026锁定后检验]({self.stem}_时序检验2026.json)\n- [公开费率核验]({self.c["fee_evidence"]})\n'
        report=self.out/(self.stem+'_研究报告.md')
        if report.exists():raise FileExistsError(report)
        report.write_text(text,encoding='utf-8')
        entry=self.out/(self.code+'_量化规则_截至'+self.c['cutoff']+'.md')
        assert not entry.exists()
        entry.write_text(header.replace('年度阈值量化研究','独立量化规则')+
            f'\n数据截至：{self.c["cutoff"]}；研究日期：2026-10-18；适用份额：{self.code}。\n\n'+
            '**状态：全历史有限网格事后候选，尚未采纳或执行。**\n\n'+
            f'在本研究收益、回撤、费用和资金约束下的候选为：**{ruletext(rule)}**。TWR年化{pct(winner["twr_annualized_pct"])}，最大回撤{pct(winner["max_drawdown_pct"])}。\n\n'+
            f'截至2025年底选出的另一组参数为：{ruletext(frozen["rule"] if frozen else None)}。2026年延续仓位检验的TWR收益为{pct(fold["continuous_test"]["twr_return_pct"])}，持有基准为{pct(fold["continuous_hold"]["twr_return_pct"])}；锁定后资金上限是否失效：{"是" if fold["funding_cap_breached_after_lock"] else "否"}。\n\n'+
            '## 完整执行口径\n\n'+execution_text(self.c)+
            f'\n主规则含网格边界或未触发的阈值时，参数不能解释为连续空间的全局最优。研究区间和参数均已事后可见，未来有效性仍需前瞻记录。\n\n[完整研究报告]({report.name}) · [复算结果]({self.stem}.json) · [冻结研究预设]({self.stem}_预设.json)\n',encoding='utf-8')


def execution_text(c):
    tiers='；'.join(f'持有不足{days}自然日的对应档费率{rate*100:g}%' for days,rate in c['redemption_tiers'])
    return ('1. 年首首个净值观察日一次买入当年计划预算，老仓继续持有；启动年度按剩余月份折算，之后每年完整年度预算。年首买入优先，撤销旧待执行信号。\n'
            '2. 每次实际成交后，把该成交单位净值和成交后全部基金市值设为新基准。涨跌均相对这个净值基准，卖出比例按执行当时基金市值，加仓含费预算按前次成交后基准基金市值计算。\n'
            '3. 信号产生后延迟2个净值观察日执行，期间不重复下单，即使价格回归仍执行；成交后再重置。现金优先用于加仓，不足部分是计划外补款。研究筛选要求每个时点累计补款不超过累计年度预算50%；这是回测约束，尚未定义未来的自动拒单机制。\n'
            f'4. 现金零息，期末估值不强制赎回；赎回按FIFO。含费申购预算使用0.15%优惠费假设，并另测{c["standard_buy_fee"]*100:g}%普通费率；不重复扣净值已反映的管理费和托管费。\n'
            f'5. 赎回分档按最先满足的自然日上界适用：{tiers}；最后一档上界起为零。静态费率不等于全历史真实渠道折扣。\n'
            f'6. 日常申购开放起点核验为{c["subscription_open_date"]}，主样本从净值首日理想化买入，并另测开放日起算。主样本剔除周末；净值观察日仍并非完整交易日历，暂停、限购、QDII净值公布时差及确认/结算等待未完整重建。基础模型将赎回款在成交后立即计入可用现金，这比真实到账乐观，因此候选不能直接当作可执行指令。\n'
            '7. 本地已知累计净值与单位净值一致，事件列无分红拆分；缺失累计净值不填造，不把累计净值当作另加收益。完整官方全历史净值并未在本轮重建。\n')


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('config',type=Path)
    parser.add_argument('--resume',action='store_true')
    args=parser.parse_args()
    Research(args.config,args.resume).run()
