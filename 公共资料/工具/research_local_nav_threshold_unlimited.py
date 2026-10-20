"""User-authorized unconstrained-funding follow-up; preserve constrained records.

Only public NAV and hypothetical normalized cash flows are read. Inherits the
same accounting, finite grid and chronological procedure as the comparison run.
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import math
from pathlib import Path

from annual_threshold_backtest import prepare
from annual_threshold_study import configurations
from research_local_nav_threshold import Research, ROOT, ENGINE, GRID_TOOL, SETTLEMENT_TOOL, load, put, sha


class UnlimitedResearch(Research):
    def __init__(self, config_path):
        self.config_path=Path(config_path).resolve()
        self.c=load(self.config_path)
        assert self.c['funding_cap'] is None, 'User explicitly requested no funding cap'
        self.code=self.c['code']
        folders=list((ROOT/'基金').glob('*/'+self.code+'_*'))
        assert len(folders)==1
        self.fund=folders[0]
        self.out=self.fund/'研究'
        oldstem=self.code+'_年度阈值量化研究_截至'+self.c['cutoff']
        oldpreset=self.out/(oldstem+'_预设.json')
        self.comparison=load(self.out/(oldstem+'.json'))
        self.stem=self.code+'_无补款上限量化研究_截至'+self.c['cutoff']
        self.source=self.fund/'历史净值'/(self.code+'_全部历史净值_截至'+self.c['cutoff']+'.json')
        self.raw=load(self.source)
        rows=self.raw['rows']
        assert rows==sorted(rows,key=lambda r:r['date']) and len(rows)==len({r['date'] for r in rows})
        assert all(math.isfinite(float(r['nav'])) and float(r['nav'])>0 and not r.get('event') for r in rows)
        assert all(r.get('accumulated_nav') is None or float(r['nav'])==float(r['accumulated_nav']) for r in rows)
        self.all_rows=[{'date':r['date'],'nav':float(r['nav'])} for r in rows]
        self.rows=[r for r in self.all_rows if dt.date.fromisoformat(r['date']).weekday()<5]
        self.full=prepare(self.rows)
        # Infinity is used only for ranking and the inherited diagnostic flag;
        # simulation grid explicitly passes max_extra_ratio=None below. No
        # Infinity value is serialized or described as a user-selected limit.
        self.cap=math.inf
        self.tiers=tuple(tuple(x) for x in self.c['redemption_tiers'])
        self.protocol=copy.deepcopy(load(oldpreset))
        assert self.protocol['source_sha256']==sha(self.source)
        self.protocol.update({
            'schema':'public-nav-threshold-unlimited-funding-v1',
            'created_at':dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec='seconds'),
            'user_authorization':'2026-10-18 user explicitly said 没有补款上限设置',
            'research_tool_sha256':sha(Path(__file__)),
            'base_research_tool_sha256':sha(Path(__file__).with_name('research_local_nav_threshold.py')),
            'config_sha256':sha(self.config_path),'config_path':self.config_path.relative_to(ROOT).as_posix(),
            'constrained_comparison_preset_sha256':sha(oldpreset),
            'engine_sha256':sha(ENGINE),'grid_library_sha256':sha(GRID_TOOL),
            'settlement_stress_tool_sha256':sha(SETTLEMENT_TOOL),
            'constraints':{'funding_cap':None,'CAGR_floor':'max(0, same-period annual-buy-and-hold TWR CAGR)',
                           'CAGR_must_be_positive':True},
            'cash':'No cap on outside cash contributions, no borrowing. Insufficient cash is supplied externally and excluded from TWR; full funding ratios disclosed. Base sale proceeds immediately available; settlement stress separate.',
            'correction':'The previous50%cap was an assistant-added research assumption, never a user setting. It is retained solely as a comparison; unconstrained funding is now the main scenario.',
        })
        put(self.path('_预设'),self.protocol)

    def grid(self,data,suffix):
        path=self.path(suffix)
        assert not path.exists(), 'Registered unconstrained experiments are immutable'
        records=[]
        for i,rule in enumerate(configurations(),1):
            records.append(self.evaluate(data,rule,max_extra_ratio=None))
            if i%1000==0:
                print({'code':self.code,'phase':suffix,'completed':i,'total':len(configurations())},flush=True)
        put(path,records)
        return records

    def report(self,r):
        pct=lambda x:f'{x:.2f}%'
        def rt(x):
            if x is None:return '年度买入持有，无主动调仓'
            up,down,sell,buy=x
            parts=[]
            parts.append(f'涨{up*100:g}%卖{sell*100:g}%' if sell else '不上涨卖出')
            parts.append(f'跌{down*100:g}%加{buy*100:g}%' if buy else '不下跌加仓')
            return '；'.join(parts)
        w=r['cases']['hindsight_calmar']['summary']
        old=self.comparison['cases']['hindsight_calmar']['summary']
        f=r['chronological_folds'][-1]
        selected=f['lock']['selected']
        title=f'# {self.code} {self.c["name"]}：无补款上限量化研究\n\n'
        text=title+f'研究日期2026-10-18；净值区间{self.rows[0]["date"]}—{self.rows[-1]["date"]}；本地{len(self.all_rows)}条，主样本剔除周末后{len(self.rows)}条。全部是假设归一化资金，不读取实际账户。\n\n'
        text+='## 纠正补款假设\n\n用户明确没有补款上限。先前50%来自研究者自行采用的筛选假设，不能归为用户设置。本次**不设外部补款上限**；原50%结果保留为对照，未覆盖原预设、网格、锁定与结果。\n\n'
        text+='继续沿用此前的年度投入框架，年度预算归一化为1，仅用于比较；真实年度投入并未据此设定。加仓先用现金，差额全部作为外部新增资金，不借款；入金本身不算收益。无补款上限也不意味着所需资金一定可获得。\n\n'
        text+='## 数学定义\n\n3025组有限网格：涨跌阈值5、10、15、20、25、30、40、50、60%，交易比例0、5、10、15、20、30、50%；无效阈值合并。最大化 `Calmar = TWR年化收益 / TWR最大回撤`，要求年化为正且不低于同期间年度买入持有，**无补款约束**。并列优先交易次数少、额外投入少、接近40/30参考规则、参数字典顺序。\n\n'
        text+='`TWR年化 = TWR末值^(365.2425/区间自然日数)-1`；`最大回撤 = max(1-TWR_t/截至t历史最高TWR)`。TWR在外部入金处分段链接，包含现金和应收资产。XIRR独立反映资金流日期和权重。最优仅限定于这个模型、有限网格与历史窗口。\n\n'
        text+='## 主结果与对照\n\n| 方案 | 规则 | TWR年化 | 最大回撤 | Calmar | XIRR | 累计补款/累计年度预算 | 过程补款比例峰值 | 主动买/卖 |\n|---|---|---:|---:|---:|---:|---:|---:|---:|\n'
        table=[('无上限：收益回撤比最优',w),('无上限：收益最高',r['cases']['hindsight_max_return']['summary']),
               ('无上限：回撤最低',r['cases']['hindsight_min_drawdown']['summary']),
               ('年度买入持有',r['cases']['annual_hold']['summary']),('原50%约束对照',old)]
        for name,s in table:
            text+=f'| {name} | {rt(s["rule"])} | {pct(s["twr_annualized_pct"])} | {pct(s["max_drawdown_pct"])} | {s["calmar"]:.4f} | {pct(s["xirr_pct"])} | {pct(s["extra_over_regular_pct"])} | {pct(s["peak_extra_over_regular_pct"])} | {s["tactical_buy_count"]}/{s["tactical_sell_count"]} |\n'
        text+=f'\n合格{r["eligible_count"]}组；没有规则因补款上限被剔除。Calmar并列{r["score_ties"]["primary_count"]}组、交易路径{r["score_ties"]["primary_path_count"]}条。过程峰值的分母为当时累计已到账年度预算，不是期末总预算。\n\n'
        text+='## 先锁定、后检验\n\n每个年度只使用此前至少730天资料选参，保存锁定后检验下一年；2026年用截至2025年底的选择。所有时序结果先于全历史搜索保存。它们仍是事后时间切割诊断，2026年未满一年，不是前瞻独立验证。\n\n| 检验年 | 当年前冻结规则 | 延续状态TWR收益 | 持有收益 | 区间最大回撤 | 截至检验结束补款比例峰值 |\n|---|---|---:|---:|---:|---:|\n'
        for fold in r['chronological_folds']:
            x=fold['lock']['selected']
            text+=f'| {fold["lock"]["test_start"][:4]} | {rt(x["rule"] if x else None)} | {pct(fold["continuous_test"]["twr_return_pct"])} | {pct(fold["continuous_hold"]["twr_return_pct"])} | {pct(fold["continuous_test"]["max_drawdown_pct"])} | {pct(fold["continuous_peak_extra_over_regular_pct"])} |\n'
        text+='\n延续状态从训练期末仓位和现金继续，2026年区间重新设置TWR基期和回撤峰值；JSON另含2026年重新启动诊断，两者不同。逐年结果不拼接成一个未经会计处理的组合。训练无合格规则时，事先约定回退年度持有。资金比例只展示需求，不用于剔除规则。\n\n'
        text+='## 固定主候选的压力情景\n\n不重新选参，亦不将其称为样本外检验。\n\n| 情景 | TWR年化 | 最大回撤 | 补款比例峰值 |\n|---|---:|---:|---:|\n'
        sens=r['sensitivities']['hindsight_calmar']
        scenarios=[(f'延迟{s["lag"]}个净值观察日',s) for s in sens['lag']]+[
            (f'标准申购费{self.c["standard_buy_fee"]*100:g}%',sens['standard_subscription']),
            ('无交易费',sens['zero_fees']),('含周末会计净值',sens['all_accounting_dates']),
            ('从日常申购开放日起算',sens['ordinary_subscription_open']),
            (f'赎回延后{self.c["redemption_settlement_workdays"]}个周一至周五到账',sens['redemption_settlement_stress'])]
        for name,s in scenarios:
            text+=f'| {name} | {pct(s["twr_annualized_pct"])} | {pct(s["max_drawdown_pct"])} | {pct(s["peak_extra_over_regular_pct"])} |\n'
        ns=sens['neighbors']
        text+=f'\n相邻一档参数{len(ns)}组，年化区间{pct(min(s["twr_annualized_pct"] for s in ns))}—{pct(max(s["twr_annualized_pct"] for s in ns))}，最大回撤区间{pct(min(s["max_drawdown_pct"] for s in ns))}—{pct(max(s["max_drawdown_pct"] for s in ns))}。不因邻域或延迟结果再换主参数。\n\n'
        m=r['matched_external_cashflow_hold']['hindsight_calmar']
        text+=f'完全相同日期投入相同的年度预算和额外补款后买入持有，XIRR为{pct(m["xirr_pct"])}；候选为{pct(w["xirr_pct"])}，用于区分策略效果与追加资金。\n\n'
        text+='## 完整执行及限制\n\n'+execution(self.c)
        text+=f'\n输入SHA-256：`{r["source_sha256"]}`。\n\n- [逐日结果与全部诊断]({self.stem}.json)\n- [预设]({self.stem}_预设.json)\n- [2026锁定]({self.stem}_参数锁定2026.json)\n- [2026检验]({self.stem}_时序检验2026.json)\n- [全部3025组搜索]({self.stem}_全历史网格.json)\n- [公开数据与费率核验]({self.c["fee_evidence"]})\n- [原50%研究，仅作对照]({self.code}_年度阈值量化研究_截至{self.c["cutoff"]}_研究报告.md)\n'
        report=self.out/(self.stem+'_研究报告.md')
        assert not report.exists()
        report.write_text(text,encoding='utf-8')
        entry=self.out/(self.code+'_量化规则_截至'+self.c['cutoff']+'.md')
        entry.write_text(title.replace('无补款上限量化研究','独立量化规则（无补款上限）')+
            f'数据截至{self.c["cutoff"]}；研究日期2026-10-18。适用代码{self.code}。\n\n'+
            '**当前口径：不设补款上限。状态：有限网格全历史事后候选，尚未采纳或执行。**\n\n'+
            '原50%限制是研究者自行加入的假设，用户没有设置；旧结果仅保留为对照。本入口已替换为用户明确的无上限测算。\n\n'+
            f'收益回撤比最优候选：**{rt(w["rule"])}**。TWR年化{pct(w["twr_annualized_pct"])}，最大回撤{pct(w["max_drawdown_pct"])}；累计额外补款/年度预算{pct(w["extra_over_regular_pct"])}，过程比例峰值{pct(w["peak_extra_over_regular_pct"])}。补款比例是需求指标，不是限制。\n\n'+
            f'截至2025年底选择：{rt(selected["rule"] if selected else None)}。2026年延续状态收益{pct(f["continuous_test"]["twr_return_pct"])}，持有基准{pct(f["continuous_hold"]["twr_return_pct"])}；至检验结束补款比例峰值{pct(f["continuous_peak_extra_over_regular_pct"])}。\n\n'+
            '## 完整执行口径\n\n'+execution(self.c)+
            f'\n[完整研究报告]({report.name}) · [结果JSON]({self.stem}.json) · [公开费率依据]({self.c["fee_evidence"]})\n',encoding='utf-8')


def execution(c):
    return ('1. 归一化年度预算于每年首个净值观察日一次买入，旧仓继续持有；启动年按剩余月份折算，以后每年完整预算。仅为与前面研究一致的比较框架，不是用户真实投入安排。\n'
            '2. 每次实际成交后重置单位净值基准和成交后全部基金市值基准。涨跌阈值相对成交基准，卖出比例按执行时全部基金市值，加仓含费预算按前次成交后基准基金市值。\n'
            '3. 信号延迟2个净值观察日执行，期间不重复下单，价格回归也执行；年度买入优先并取消旧待单。未到期信号不假定成交。\n'
            '4. 先用留存现金买入，差额全部外部补足，**不设补款上限**；不融资。入金切分TWR，不作为投资收益。现金零息、期末不强制赎回。\n'
            f'5. 申购含费预算按0.15%研究假设，另测标准首档{c["standard_buy_fee"]*100:g}%。赎回FIFO：不足7自然日1.5%，7至不足30日0.75%，30至不足180日0.5%，180日起0。净值内费用不重复扣。\n'
            f'6. 日常申购开放日为{c["subscription_open_date"]}，主样本首日买入理想化，另测开放日起算。剔除周末仍未重建完整交易日历、暂停限购、净值公布时差与确认。\n'
            f'7. 基础模型赎回款立即可用；另测延后{c["redemption_settlement_workdays"]}个周一至周五到账，应收资产计值但不能买入。该情景未重建节假日和真实确认/到账，不能保证实盘可行。\n'
            '8. 本地单位净值完整，非缺失累计净值与之相同，事件列无分红拆分；不填造缺失累计值。主收益自行按单位净值复算，不使用附带日涨跌幅。数据、有限交易样本、网格边界及事后择参均限制未来推断。\n')


if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('config',type=Path)
    UnlimitedResearch(p.parse_args().config).run()
