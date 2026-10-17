"""Predeclared annual-funded comparison and finite-grid research for 005698."""
from __future__ import annotations

import datetime as dt
import hashlib
import itertools
import json
import math
import sys
from pathlib import Path

FUND=Path(__file__).resolve().parents[1]
ROOT=FUND.parents[1]
sys.path.insert(0,str(ROOT/'公共资料/工具'))
from annual_threshold_backtest import prepare,simulate

SOURCE=FUND/'历史净值/005698_全部历史净值_截至2026-10-15.json'
OUT=FUND/'研究'
STEM='005698_年度投入规则优化_截至2026-10-15'
THRESHOLDS=(.05,.10,.15,.20,.25,.30,.40,.50,.60)
FRACTIONS=(0.,.05,.10,.15,.20,.30,.50)
REFERENCE=(.40,.30,.20,.30)
ORIGINAL=(.15,.15,.10,.15)
CAP=.50
TIERS=((7,.015),(30,.0075),(365,.005))
PERIODS={'development':('2018-04-17','2021-12-31'),
         'validation':('2022-01-01','2023-12-31'),
         'recent':('2024-01-01','2026-10-15')}


def canonical(c):
    u,d,s,b=c
    return (u if s else .40,d if b else .30,s,b)


def configs():
    return sorted({canonical(c) for c in itertools.product(THRESHOLDS,THRESHOLDS,FRACTIONS,FRACTIONS)})


def evaluate(data,rule=None,**kwargs):
    return simulate(data,rule=rule,buy_fee=.0015,redemption_tiers=TIERS,**kwargs)


def write_json(name,data):
    path=OUT/(STEM+name+'.json')
    path.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    return path


def eligible(record,floor):
    return (not record.get('pruned') and record['calmar'] is not None
            and record['twr_annualized_pct']>0
            and record['twr_annualized_pct']>=floor-1e-10
            and record['peak_extra_over_regular_pct']<=CAP*100+1e-9)


def distance(rule):
    return sum(abs(a-b) for a,b in zip(rule,REFERENCE))


def ranked(records,floor):
    return sorted([r for r in records if eligible(r,floor)],key=lambda r:(
        -round(r['calmar'],12),r['tactical_buy_count']+r['tactical_sell_count'],
        r['extra_contributed_norm'],distance(r['rule']),r['rule']))


def grid(data,label):
    results=[]
    for index,config in enumerate(configs()):
        results.append(evaluate(data,config,max_extra_ratio=CAP))
        if (index+1)%750==0:
            print(json.dumps({'phase':label,'completed':index+1,'total':len(configs())}),flush=True)
    return results


def pareto(records):
    # A two-metric frontier within the disclosed funding cap. Actual extra
    # financing is separately tested as a third objective for dominance.
    ordered=sorted([r for r in records if not r.get('pruned')],
                   key=lambda r:(r['max_drawdown_pct'],-r['twr_annualized_pct']))
    out=[];best=-math.inf
    for record in ordered:
        if record['twr_annualized_pct']>best+1e-10:
            out.append(record);best=record['twr_annualized_pct']
    return out


def neighbors(config):
    out=set()
    for axis,options in enumerate((THRESHOLDS,THRESHOLDS,FRACTIONS,FRACTIONS)):
        value=config[axis]
        pos=options.index(value)
        for nextpos in (pos-1,pos+1):
            if 0<=nextpos<len(options):
                c=list(config);c[axis]=options[nextpos]
                out.add(canonical(c))
    out.discard(tuple(config))
    return sorted(out)


def main():
    OUT.mkdir(exist_ok=True)
    source=json.loads(SOURCE.read_text(encoding='utf-8-sig'))
    rows=[{'date':r['date'],'nav':float(r['nav'])} for r in source['rows']]
    assert len(rows)==1979 and rows[0]['date']=='2018-04-17'
    assert all(float(r['nav'])==float(r['accumulated_nav']) and not r['event'] for r in source['rows'])
    dividends=[]
    full=prepare(rows,dividends)
    periods={key:prepare([r for r in rows if first<=r['date']<=last],dividends)
             for key,(first,last) in PERIODS.items()}
    protocol={'created_at':dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec='seconds'),
        'fund_code':'005698','source_sha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        'source_scope':'1979 public third-party NAV records, not complete independent official reconstruction',
        'normalization':'Hypothetical full annual budget=1; no investor account data',
        'funding':'Each year first NAV receives new budget. Startup Apr-Dec 2018=9/12, later years full budget including2026',
        'annual_reset':'New annual budget bought first, resets NAV and full fund-value anchors; cancels prior pending; no new signal that day',
        'signal':'Raw unit NAV relative to preceding actual trade; sale fraction of execution fund value; buy gross budget fraction of previous anchor value',
        'lag':2,'cash':'Zero interest; dividends cash, currently no events documented',
        'fees':{'subscription':.0015,'redemption_tiers':TIERS,'meaning':'Static sensitivity, FIFO, execution date proxies confirmation'},
        'grid':{'up':THRESHOLDS,'down':THRESHOLDS,'sell':FRACTIONS,'buy':FRACTIONS,'canonical_count':len(configs())},
        'funding_cap':'At EVERY date cumulative outside topup <=50% of cumulative regular annual budgets; no borrowing',
        'primary_objective':'Maximize full-history annualized TWR / MDD, subject CAGR>=max(0,annual40/30 CAGR), positive CAGR and funding cap',
        'secondary_objective':'Minimum MDD subject same return and funding constraints; show Pareto frontier and strict 40/30 dominance',
        'tie_break':'Rounded12decimal score, fewer actual tactical trades, lower extra, L1distance to40/30, lexicographic',
        'chronological':'FIRST optimize2018-2021 by same objective and in-period reference return floor, lock before full-grid computation; never reselect',
        'periods':PERIODS,'validation_scope':'Retrospective chronological diagnostics, not pristine unseen market history',
        'robustness':'Lag1/2/3; zero fees; complete calendar years2019-2025; public subscription opening2018-06-11; axial neighboring parameters',
        'execution_limit':'NAV observation dates proxy subscription dates; first2018 inception-date buys not proven open subscriptions'}
    preset=OUT/(STEM+'_预设.json')
    if preset.exists():
        raise FileExistsError('Existing protocol preserved; do not silently rerun or change selection')
    write_json('_预设',protocol)
    # Do not evaluate the full-history grid until the development choice is saved.
    dev_reference=evaluate(periods['development'],REFERENCE)
    dev_grid=grid(periods['development'],'development')
    dev_floor=max(0.,dev_reference['twr_annualized_pct'])
    dev_ranking=ranked(dev_grid,dev_floor)
    assert dev_ranking
    frozen=dev_ranking[0]
    write_json('_时序锁定',{'scope':'2018-2021 only','reference':dev_reference,
        'return_floor_pct':dev_floor,'selected':frozen,'eligible_count':len(dev_ranking),
        'different_trading_path_count':len({r['path_signature'] for r in dev_grid if not r.get('pruned')}),
        'full_grid_not_evaluated_before_lock':True})
    write_json('_开发期网格',dev_grid)
    print(json.dumps({'phase':'development_locked','rule':frozen['rule']}),flush=True)
    baseline=evaluate(full,REFERENCE)
    full_grid=grid(full,'full_history_descriptive')
    floor=max(0.,baseline['twr_annualized_pct'])
    full_ranking=ranked(full_grid,floor)
    assert full_ranking
    winner=full_ranking[0]
    minrisk=min(full_ranking,key=lambda r:(r['max_drawdown_pct'],-r['twr_annualized_pct'],distance(r['rule'])))
    configs_to_present={'annual_40_30':REFERENCE,'annual_original':ORIGINAL,
                        'hindsight_best':tuple(winner['rule']),'chronological_frozen':tuple(frozen['rule']),
                        'minimum_drawdown':tuple(minrisk['rule'])}
    cases={key:evaluate(full,c,detail=True) for key,c in configs_to_present.items()}
    for key,schedule in [('annual_hold','annual'),('monthly','monthly'),('daily','daily')]:
        cases[key]=evaluate(full,None,schedule=schedule,detail=True)
    cases['initial_hold']=evaluate(full,None,initial_only=True,detail=True)
    diagnostics={key:{period:[evaluate(data,c,lag=lag,compute_xirr=True) for lag in (1,2,3)]
                      for period,data in periods.items()} for key,c in configs_to_present.items()}
    complete=prepare([r for r in rows if '2019-01-01'<=r['date']<='2025-12-31'])
    openperiod=prepare([r for r in rows if r['date']>='2018-06-11'])
    sensitivity={key:{'full_lags':[evaluate(full,c,lag=lag,compute_xirr=True) for lag in (1,2,3)],
        'zero_fee':simulate(full,c,buy_fee=0.,redemption_tiers=(),compute_xirr=True),
        'complete2019_2025':evaluate(complete,c,compute_xirr=True),
        'subscription_open2018_06_11':evaluate(openperiod,c,compute_xirr=True),
        'neighbors':[evaluate(full,c2,compute_xirr=True) for c2 in neighbors(c)]}
        for key,c in configs_to_present.items()}
    matched={key:evaluate(full,None,forced_extras={r['date']:r['extra_today_norm'] for r in case['daily'] if r['extra_today_norm']},compute_xirr=True)
             for key,case in cases.items() if key in configs_to_present}
    dominators=[r for r in full_ranking if
        r['twr_annualized_pct']>=baseline['twr_annualized_pct']-1e-10 and
        r['max_drawdown_pct']<=baseline['max_drawdown_pct']+1e-10 and
        r['extra_contributed_norm']<=baseline['extra_contributed_norm']+1e-10 and
        (r['twr_annualized_pct']>baseline['twr_annualized_pct']+1e-8 or r['max_drawdown_pct']<baseline['max_drawdown_pct']-1e-8)]
    payload={'protocol':protocol,'source_sha256':protocol['source_sha256'],
        'start':rows[0]['date'],'end':rows[-1]['date'],'return_floor_pct':floor,
        'selected_rule':winner['rule'],'chronological_frozen_rule':frozen['rule'],
        'complete_grid_count':sum(not r.get('pruned') for r in full_grid),
        'pruned_count':sum(bool(r.get('pruned')) for r in full_grid),
        'eligible_count':len(full_ranking),
        'different_full_trading_path_count':len({r['path_signature'] for r in full_grid if not r.get('pruned')}),
        'full_ranking_top20':full_ranking[:20],'full_pareto':pareto(full_grid),'dominators_of40_30':dominators,
        'cases':cases,'diagnostics':diagnostics,'sensitivities':sensitivity,
        'matched_actual_cashflow_hold':matched}
    write_json('_全历史网格',full_grid)
    output=write_json('',payload)
    print(json.dumps({'output':str(output),'winner':winner,'reference40_30':baseline,
        'minimum_drawdown':minrisk,'frozen':frozen,'dominators':len(dominators)},ensure_ascii=False),flush=True)


if __name__=='__main__':main()
