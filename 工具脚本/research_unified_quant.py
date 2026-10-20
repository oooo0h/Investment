"""Unified public-NAV quant research: no total topup cap; explicit daily buy cap.

Budgets are hypothetical normalized units; no investor account inputs are read.
Annual schedules, chronological selection and grid reuse the frozen research
procedure. Dividend events and daily purchase capacity are explicitly modeled.
"""
from __future__ import annotations

import sys
sys.dont_write_bytecode = True
import argparse
import datetime as dt
import json
import math
from pathlib import Path
from annual_threshold_backtest import YEAR, prepare
from annual_threshold_daily_cap import simulate_capped
from annual_threshold_study import configurations, neighbors, pareto, ranking, tie_summary
from research_local_nav_threshold import put, load, sha, window_result
ROOT=Path(__file__).resolve().parents[1]
REFERENCE=(.40,.30,.20,.30)

class UnifiedResearch:
    def __init__(self, config_path):
        self.config_path=Path(config_path).resolve()
        self.c=load(self.config_path)
        assert self.c['funding_cap'] is None
        self.code=self.c['code']
        folders=list((ROOT/'基金').glob('*/'+self.code+'_*'))
        assert len(folders)==1
        self.fund=folders[0]
        self.out=self.fund/'研究'
        self.stem=self.code+'_统一量化研究_截至'+self.c['cutoff']
        self.source=ROOT/self.c['source_path']
        assert self.source.resolve().is_relative_to((self.fund/'历史净值').resolve())
        self.raw=load(self.source)
        rows=self.raw['rows']
        assert rows==sorted(rows,key=lambda r:r['date']) and len(rows)==len({r['date'] for r in rows})
        assert rows[-1]['date']==self.c['cutoff']
        assert all(math.isfinite(float(r['nav'])) and float(r['nav'])>0 for r in rows)
        if self.c.get('source_sha256'): assert sha(self.source)==self.c['source_sha256']
        divfile=self.c.get('dividend_events_file')
        self.dividends=load(ROOT/divfile) if divfile else self.c.get('dividend_events',self.raw.get('dividend_events',[]))
        assert len(self.dividends)==len({d['exdate'] for d in self.dividends})
        assert all({'exdate','paydate','per_unit'}<=d.keys() and d['paydate']>=d['exdate'] and float(d['per_unit'])>0 for d in self.dividends)
        if not self.dividends:
            assert all(not r.get('event') for r in rows)
            assert all(r.get('accumulated_nav') is None or float(r['nav'])==float(r['accumulated_nav']) for r in rows)
        else:
            gaps=[(r['date'],float(r['accumulated_nav'])-float(r['nav'])) for r in rows if r.get('accumulated_nav') is not None]
            for date,gap in gaps:
                expected=sum(float(d['per_unit']) for d in self.dividends if d['exdate']<=date)
                assert abs(gap-expected)<0.00051,(date,gap,expected,'Distribution reconciliation failed')
        self.all_rows=[{'date':r['date'],'nav':float(r['nav'])} for r in rows]
        self.rows=[r for r in self.all_rows if dt.date.fromisoformat(r['date']).weekday()<5]
        self.full=self.prepared(self.rows)
        self.cap=math.inf
        self.daily_cap=self.c['daily_buy_cap_norm']
        assert self.daily_cap is None or self.daily_cap>0
        self.tiers=tuple(tuple(x) for x in self.c['redemption_tiers'])
        assert self.c['fees_verified'] and self.c['subscription_open_date']
        self.protocol={
            'schema':'unified-public-nav-quant-v1','fund_code':self.code,'fund_name':self.c['name'],
            'created_at':dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec='seconds'),
            'source_path':self.source.relative_to(ROOT).as_posix(),'source_sha256':sha(self.source),
            'source_start':self.rows[0]['date'],'source_end':self.rows[-1]['date'],'source_rows':len(self.all_rows),'analysis_rows':len(self.rows),
            'source_scope':self.raw.get('source_type',self.raw.get('source','See archived source validation')),
            'source_validation':self.raw.get('validation',{}),
            'config_path':self.config_path.relative_to(ROOT).as_posix(),'config_sha256':sha(self.config_path),
            'engine_sha256':sha(Path(__file__).with_name('annual_threshold_backtest.py')),
            'daily_cap_engine_sha256':sha(Path(__file__).with_name('annual_threshold_daily_cap.py')),
            'settlement_engine_sha256':sha(Path(__file__).with_name('annual_threshold_settlement.py')),
            'grid_library_sha256':sha(Path(__file__).with_name('annual_threshold_study.py')),
            'research_tool_sha256':sha(Path(__file__)),
            'dividend_events':self.dividends,'dividend_events_file':divfile,
            'dividend_events_sha256':sha(ROOT/divfile) if divfile else None,
            'weekdays_only_main':True,'weekend_observations':[r['date'] for r in self.all_rows if dt.date.fromisoformat(r['date']).weekday()>4],
            'normalization':'User-specified hypothetical annual budget=1, not actual investor amounts. Startup year=(13-start_month)/12; every later year full budget including partial final year.',
            'funding_cap':None,'daily_buy_cap_norm':self.daily_cap,
            'user_authorization':'2026-10-18 user explicitly: no cumulative topup cap; daily subscription cap is half of hypothetical annual budget for270023/005698/016701/006373; no daily cap for018124/015789.',
            'daily_cap_execution':'Per-fund all purchases per observed date combined. Unfilled planned/tactical budgets queued to later dates. Annual budget credited first; annual buy takes priority, cancels old tactical remainder. No new signals during queue. Actual fills reset anchors; outstanding tactical gross budget fixed at signal.',
            'outside_funding':'No cumulative limit. Only cash shortage for each actual fill supplied externally; future unfilled orders are not prefunded. No borrowing. External inflows excluded from returns.',
            'fee_assumptions':{'subscription':self.c['buy_fee'],'redemption_FIFO':self.tiers,'standard_subscription_stress':self.c['standard_buy_fee'],'evidence':self.c['fee_evidence']},
            'lag_NAV_observations':2,'cash':'Zero interest; base sale proceeds immediately available; separate delayed-settlement stress. Cash dividends receivable on exdate, available on paydate.',
            'rule_order':['up_threshold','down_threshold','sell_fraction','buy_fraction'],
            'canonical_grid_count':len(configurations()),'threshold_grid_pct':[5,10,15,20,25,30,40,50,60],'trade_fraction_grid_pct':[0,5,10,15,20,30,50],
            'objective':'Maximum Calmar=CAGR/MDD, positive CAGR and CAGR>=max(0,same-period annual-hold CAGR with identical daily cap). No cumulative funding constraint.',
            'tie_break':'Calmar rounded12 decimals, fewer tactical fills, lower normalized external contribution, distance to40/30, lexicographic',
            'chronology':'Each expanding annual training has>=730calendar days; save lock before following-year test; all tests before full-history hindsight grid. Main train<=2025, test2026.',
            'validation_scope':'Retrospective chronological diagnostics, not prospective independent validation;2026partialyear',
            'robustness':'Fixed selections only:lag1/2/3/5, zero fee, standard subscription, fullaccountingdates, ordinaryopeningstart, delayedredemption, axialneighbors',
            'limitations':'NAV observations proxy dealing/announcement/confirmation days; holidays/pauses/actual platform restrictions not fully reconstructed. Inception buy idealized; sensitivity starts ordinary opening. Fund-specific fees/distributions retained.',
            'previous_rule':self.c['previous_rule'],'previous_rule_source':self.c.get('previous_rule_source'),
        }
        put(self.path('_预设'),self.protocol)

    def prepared(self,rows):
        return prepare(rows,self.dividends)

    def evaluate(self,data,rule=None,**kwargs):
        return simulate_capped(data,rule,buy_fee=self.c['buy_fee'],redemption_tiers=self.tiers,
                               daily_buy_cap_norm=self.daily_cap,**kwargs)

    def path(self, suffix):
        return self.out/(self.stem+suffix+'.json')

    def grid(self, data, suffix):
        path = self.path(suffix)
        if path.exists():
            return load(path)
        records=[]
        for i, rule in enumerate(configurations(), 1):
            records.append(self.evaluate(data, rule, max_extra_ratio=None))
            if i%1000==0:
                print(json.dumps({'code':self.code,'phase':suffix,'completed':i,'total':len(configurations())}),flush=True)
        put(path, records)
        return records

    def fold(self, year):
        path = self.path('_时序检验'+str(year))
        if path.exists():
            return load(path)
        start=str(year)+'-01-01'
        train=self.prepared([r for r in self.rows if r['date']<start])
        test=self.prepared([r for r in self.rows if r['date']>=start and r['date']<str(year+1)+'-01-01'])
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
        upto=self.prepared([r for r in self.rows if r['date']<str(year+1)+'-01-01'])
        carried=self.evaluate(upto,rule,detail=True)
        carry_hold=self.evaluate(upto,detail=True)
        result={'lock_sha256':sha(lockpath),'lock':lock,
                'standalone_test':self.evaluate(test,rule,compute_xirr=True),
                'standalone_hold':self.evaluate(test,compute_xirr=True),
                'continuous_test':window_result(carried,start),
                'continuous_hold':window_result(carry_hold,start),
                'continuous_peak_extra_over_regular_pct':carried['summary']['peak_extra_over_regular_pct'],
                'funding_cap_breached_after_lock':None,
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
        rules['previous_rule']=tuple(self.c['previous_rule'])
        if frozen:
            rules['chronological_frozen']=tuple(frozen['rule'])
        cases={name:self.evaluate(self.full,rule,detail=True) for name,rule in rules.items()}
        cases['annual_hold']=self.evaluate(self.full,detail=True)
        cases['monthly']=self.evaluate(self.full,schedule='monthly',detail=True)
        cases['initial_hold']=self.evaluate(self.full,initial_only=True,detail=True)
        accounting=self.prepared(self.all_rows)
        opened=self.prepared([r for r in self.rows if r['date']>=self.c['subscription_open_date']])
        sensitivities={}
        matched={}
        for name,rule in rules.items():
            if name=='reference40_30':
                continue
            sensitivities[name]={
                'lag':[self.evaluate(self.full,rule,lag=lag,compute_xirr=True) for lag in (1,2,3,5)],
                'zero_fees':simulate_capped(self.full,rule,daily_buy_cap_norm=self.daily_cap,buy_fee=0.,redemption_tiers=(),compute_xirr=True),
                'standard_subscription':simulate_capped(self.full,rule,daily_buy_cap_norm=self.daily_cap,buy_fee=self.c['standard_buy_fee'],redemption_tiers=self.tiers,compute_xirr=True),
                'all_accounting_dates':self.evaluate(accounting,rule,compute_xirr=True),
                'ordinary_subscription_open':self.evaluate(opened,rule,compute_xirr=True),
                'redemption_settlement_stress':simulate_capped(self.full,rule,daily_buy_cap_norm=self.daily_cap,buy_fee=self.c['buy_fee'],
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
        # Report rendering is separate from numerical registration; source JSON
        # is immutable and can be checked/rendered without recomputing grids.
        print(json.dumps({'code':self.code,'registered_result':str(self.path(''))},ensure_ascii=False),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('config',type=Path)
    UnifiedResearch(p.parse_args().config).run()
