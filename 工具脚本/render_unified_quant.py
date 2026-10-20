"""Read-only independent accounting/ranking audit and scientific PNG renderer.

Only public NAV, hypothetical normalized flows and registered research are read.
All registered sources, configurations, protocols, locks and results stay intact.
"""
from __future__ import annotations

import sys
sys.dont_write_bytecode = True

import argparse
import datetime as dt
import hashlib
import itertools
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CODES = ['270023','005698','016701','006373','018124','015789']
CAPPED_CODES = {'270023','005698','016701','006373'}
REFERENCE = (.4,.3,.2,.3)


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def close(actual, expected, label=''):
    assert math.isclose(actual, expected, rel_tol=2e-10, abs_tol=2e-8), (label, actual, expected)


def ranked(records, floor):
    choices = [r for r in records if not r.get('pruned') and r['calmar'] is not None
               and r['twr_annualized_pct'] > 0. and r['twr_annualized_pct'] >= floor-1e-10]
    return sorted(choices, key=lambda r: (-round(r['calmar'],12),
        r['tactical_buy_count']+r['tactical_sell_count'], r['extra_contributed_norm'],
        sum(abs(a-b) for a,b in zip(r['rule'],REFERENCE)), r['rule']))


def rule_text(rule):
    if rule is None:
        return '年度买入持有'
    up,down,sell,buy = rule
    return (f'涨{up*100:g}%卖{sell*100:g}%' if sell else '不上涨卖出') + '；' + (
        f'跌{down*100:g}%加{buy*100:g}%' if buy else '不下跌加仓')


def report_rule_text(rule):
    if isinstance(rule,dict):
        rule = rule.get('rule')
    if not rule or not (rule[2] or rule[3]):
        return '年度买入持有，无阈值调仓'
    return rule_text(rule)


def audit_report(path,r,c):
    if not path.exists():
        return 'PENDING'
    text = path.read_text(encoding='utf-8')
    rows = [('hindsight_calmar','收益回撤比最优'),('hindsight_max_return','收益最高'),
            ('hindsight_min_drawdown','回撤最低'),('annual_hold','年度买入持有'),
            ('monthly','年度预算按月投入'),('previous_rule','原参数按本次模型重放'),
            ('reference40_30','40/30参考'),('chronological_frozen','2025年底参数回看全历史')]
    for key,label in rows:
        if key not in r['cases']:
            continue
        s = r['cases'][key]['summary']
        calmar = f'{s["calmar"]:.4f}' if s['calmar'] is not None else '—'
        expected = (f'| {label} | {report_rule_text(s["rule"])} | {s["twr_annualized_pct"]:.2f}% | '
                    f'{s["max_drawdown_pct"]:.2f}% | {calmar} | {s["xirr_pct"]:.2f}% | '
                    f'{s["extra_over_regular_pct"]:.2f}% | {s["peak_extra_over_regular_pct"]:.2f}% | '
                    f'{s["tactical_buy_count"]}/{s["tactical_sell_count"]} |')
        assert expected in text, ('report main numeric/rule row',label)
    for fold in r['chronological_folds']:
        expected = (f'| {fold["lock"]["test_start"][:4]} | {report_rule_text(fold["lock"]["selected"])} | '
                    f'{fold["continuous_test"]["twr_return_pct"]:.2f}% | '
                    f'{fold["continuous_hold"]["twr_return_pct"]:.2f}% | '
                    f'{fold["continuous_test"]["max_drawdown_pct"]:.2f}% | '
                    f'{fold["continuous_peak_extra_over_regular_pct"]:.2f}% |')
        assert expected in text, ('report chronological row',fold['lock']['test_start'])
    sens = r['sensitivities']['hindsight_calmar']
    scenarios = [(f'延迟{x["lag"]}个净值观察日',x) for x in sens['lag']] + [
        (f'标准申购费{c["standard_buy_fee"]*100:g}%',sens['standard_subscription']),
        ('零交易费',sens['zero_fees']),('包括周末会计净值',sens['all_accounting_dates']),
        ('从日常申购开放日起算',sens['ordinary_subscription_open']),
        (f'赎回延后{c["redemption_settlement_workdays"]}个周一至周五到账',sens['redemption_settlement_stress'])]
    for label,s in scenarios:
        expected = (f'| {label} | {s["twr_annualized_pct"]:.2f}% | {s["max_drawdown_pct"]:.2f}% | '
                    f'{s["extra_over_regular_pct"]:.2f}% | {s["peak_extra_over_regular_pct"]:.2f}% |')
        assert expected in text,('report sensitivity',label)
    last = r['chronological_folds'][-1]
    frozen_case = r['cases'].get('chronological_frozen',r['cases']['annual_hold'])
    selected_dates = [x for x in frozen_case['daily'] if last['lock']['test_start']<=x['date']<=last['lock']['test_end']]
    demand = sum(x['extra_today_norm'] for x in selected_dates)/sum(x['regular_today_norm'] for x in selected_dates)*100.
    assert f'该检验区间新增补款/区间到账年度计划预算为{demand:.2f}%' in text
    expected_grid = '涨跌阈值为5、10、15、20、25、30、40、50、60%'
    return 'PASS' if expected_grid in text else 'NUMERIC_PASS_GRID_PARAGRAPH_FORMAT_PENDING'


def audit_ledger(case, protocol):
    """Reconstruct units, FIFO fees, cash, dividends, flows and TWR from fills."""
    daily, summary = case['daily'], case['summary']
    dividend_map = {x['exdate']:x for x in protocol['dividend_events']}
    buy_fee = protocol['fee_assumptions']['subscription']
    tiers = protocol['fee_assumptions']['redemption_FIFO']
    cap = protocol['daily_buy_cap_norm']
    trades = {}
    for trade in case['trades']:
        trades.setdefault(trade['date'],[]).append(trade)
    units = cash = receivable = regular = extra = fees = dividends = 0.
    previous_equity = None
    twr = peak = 1.
    mdd = peak_extra = 0.
    payments, lots, expected_flows = [], [], []
    max_buy = 0.
    for row in daily:
        date = row['date']
        day = dt.date.fromisoformat(date)
        price = row['nav']
        entitlement = units*float(dividend_map[date]['per_unit']) if date in dividend_map else 0.
        if entitlement:
            receivable += entitlement
            dividends += entitlement
            payments.append((dividend_map[date]['paydate'],entitlement))
        still_due = []
        for paydate,value in payments:
            if paydate <= date:
                cash += value
                receivable -= value
            else:
                still_due.append((paydate,value))
        payments = still_due
        preflow = units*price+cash+receivable
        market_factor = preflow/previous_equity if previous_equity is not None else 1.
        flow = row['regular_today_norm']+row['extra_today_norm']
        regular += row['regular_today_norm']
        extra += row['extra_today_norm']
        cash += flow
        fee_today = gross_buys = 0.
        for trade in trades.get(date,[]):
            gross = trade['budget_norm']
            if trade['kind'] in ('scheduled_buy','buy'):
                gross_buys += gross
                net = gross/(1.+buy_fee)
                lot_units = net/price
                units += lot_units
                lots.append([lot_units,day])
                cash -= gross
                trade_fee = gross-net
            else:
                assert trade['kind']=='sell'
                sold = gross/price
                units -= sold
                remaining = sold
                trade_fee = 0.
                while remaining > 1e-12:
                    amount,acquired = lots[0]
                    used = min(amount,remaining)
                    age = (day-acquired).days
                    rate = next((fee for limit,fee in tiers if age<limit),0.)
                    trade_fee += used*price*rate
                    remaining -= used
                    lots[0][0] -= used
                    if lots[0][0]<1e-12:
                        lots.pop(0)
                cash += gross-trade_fee
            if 'fee_norm' in trade:
                close(trade['fee_norm'],trade_fee,'FIFO/fill fee')
            fee_today += trade_fee
        max_buy = max(max_buy,gross_buys)
        if cap is not None:
            assert gross_buys <= cap+1e-10, (date,gross_buys,cap)
            close(row['gross_buy_today_norm'],gross_buys,'gross daily buys')
        close(row['fund_value_norm'],units*price,'units ledger')
        close(row['cash_norm'],cash,'cash ledger')
        close(row['receivable_norm'],receivable,'dividend receivables')
        equity = units*price+cash+receivable
        close(row['total_norm'],equity,'equity decomposition')
        close(equity,preflow+flow-fee_today,'equity flow/fee identity')
        twr *= market_factor*equity/(preflow+flow)
        close(row['twr_index'],twr,'independent daily TWR')
        peak = max(peak,twr)
        mdd = max(mdd,1.-twr/peak)
        close(row['drawdown_pct'],(twr/peak-1.)*100.,'daily drawdown')
        peak_extra = max(peak_extra,extra/regular)
        fees += fee_today
        if flow:
            expected_flows.append({'date':date,'value':-flow})
        previous_equity = equity
    expected_flows.append({'date':daily[-1]['date'],'value':equity})
    assert len(expected_flows)==len(case['cashflows'])
    for actual,expected in zip(case['cashflows'],expected_flows):
        assert actual['date']==expected['date']
        close(actual['value'],expected['value'],'external cashflow')
    years = (dt.date.fromisoformat(daily[-1]['date'])-dt.date.fromisoformat(daily[0]['date'])).days/365.2425
    close(summary['twr_annualized_pct'],(twr**(1./years)-1.)*100.,'CAGR')
    close(summary['max_drawdown_pct'],mdd*100.,'MDD')
    close(summary['regular_contributed_norm'],regular,'planned contributions')
    close(summary['extra_contributed_norm'],extra,'unlimited external contributions')
    close(summary['peak_extra_over_regular_pct'],peak_extra*100.,'external peak ratio')
    close(summary['transaction_fees_norm'],fees,'total FIFO/buy fees')
    close(summary['dividends_norm'],dividends,'cash dividend entitlement')
    if summary['calmar'] is not None:
        close(summary['calmar'],summary['twr_annualized_pct']/summary['max_drawdown_pct'],'Calmar')
    origin = dt.date.fromisoformat(expected_flows[0]['date'])
    rate = summary['xirr_pct']/100.
    npv = sum(x['value']/(1.+rate)**((dt.date.fromisoformat(x['date'])-origin).days/365.)
              for x in expected_flows)
    assert abs(npv)<1e-7, ('XIRR residual',npv)
    return max_buy


def audit(result_path):
    r = read(result_path)
    p = r['protocol']
    assert p['schema']=='unified-public-nav-quant-v1'
    stem = result_path.with_suffix('')
    sibling = lambda suffix: Path(str(stem)+suffix+'.json')
    assert p==read(sibling('_预设'))
    source,config = ROOT/p['source_path'],ROOT/p['config_path']
    assert sha(source)==p['source_sha256']==r['source_sha256']
    assert sha(config)==p['config_sha256']
    c = read(config)
    assert c['funding_cap'] is None and p['funding_cap'] is None
    expected_cap = .5 if p['fund_code'] in CAPPED_CODES else None
    assert c['daily_buy_cap_norm']==p['daily_buy_cap_norm']==expected_cap
    for key,name in [('engine_sha256','annual_threshold_backtest.py'),
                     ('daily_cap_engine_sha256','annual_threshold_daily_cap.py'),
                     ('settlement_engine_sha256','annual_threshold_settlement.py'),
                     ('grid_library_sha256','annual_threshold_study.py'),
                     ('research_tool_sha256','research_unified_quant.py')]:
        assert sha(Path(__file__).with_name(name))==p[key],name
    dividends = p['dividend_events']
    if p['dividend_events_file']:
        dividend_path = ROOT/p['dividend_events_file']
        assert sha(dividend_path)==p['dividend_events_sha256']
        assert read(dividend_path)==dividends
    rows = read(source)['rows']
    assert len(rows)==p['source_rows']
    weekdays = [x for x in rows if dt.date.fromisoformat(x['date']).weekday()<5]
    assert len(weekdays)==p['analysis_rows']
    assert p['source_start']==weekdays[0]['date'] and p['source_end']==weekdays[-1]['date']
    assert all(d['exdate'] in {x['date'] for x in weekdays} for d in dividends)
    for row in rows:
        if row.get('accumulated_nav') is not None:
            expected = sum(float(d['per_unit']) for d in dividends if d['exdate']<=row['date'])
            assert abs(float(row['accumulated_nav'])-float(row['nav'])-expected)<.00051
    grid = read(sibling('_全历史网格'))
    thresholds = [.05,.1,.15,.2,.25,.3,.4,.5,.6]
    fractions = [0.,.05,.1,.15,.2,.3,.5]
    expected_rules = {(a if c else .4,b if d else .3,c,d)
                      for a,b,c,d in itertools.product(thresholds,thresholds,fractions,fractions)}
    assert len(grid)==len(expected_rules)==3025==r['grid_count']==p['canonical_grid_count']
    assert {tuple(x['rule']) for x in grid}==expected_rules
    assert not any(x.get('pruned') for x in grid) and r['funding_pruned_count']==0
    floor = max(0.,r['cases']['annual_hold']['summary']['twr_annualized_pct'])
    close(r['full_history_return_floor_pct'],floor,'annual hold return floor')
    ranking = ranked(grid,floor)
    assert len(ranking)==r['eligible_count'] and ranking[:20]==r['top20']
    assert ranking[0]['rule']==r['main_selected_rule']
    ties = [x for x in ranking if abs(x['calmar']-ranking[0]['calmar'])<=1e-12]
    assert len(ties)==r['score_ties']['primary_count']
    assert [x['rule'] for x in ties]==r['score_ties']['primary_rules']
    assert len({x['path_signature'] for x in ties})==r['score_ties']['primary_path_count']
    max_return = max(ranking,key=lambda x:(x['twr_annualized_pct'],-x['max_drawdown_pct'],-x['extra_contributed_norm']))
    min_dd = min(ranking,key=lambda x:(x['max_drawdown_pct'],-x['twr_annualized_pct'],x['rule']))
    assert max_return['rule']==r['cases']['hindsight_max_return']['summary']['rule']
    assert min_dd['rule']==r['cases']['hindsight_min_drawdown']['summary']['rule']
    max_buy = max(audit_ledger(case,p) for case in r['cases'].values())
    years = []
    full_grid_time = sibling('_全历史网格').stat().st_mtime_ns
    for fold in r['chronological_folds']:
        year = int(fold['lock']['test_start'][:4])
        lock_path,test_path = sibling('_参数锁定'+str(year)),sibling('_时序检验'+str(year))
        assert sha(lock_path)==fold['lock_sha256']
        assert read(lock_path)==fold['lock'] and read(test_path)==fold
        assert lock_path.stat().st_mtime_ns<=test_path.stat().st_mtime_ns<=full_grid_time
        train_grid = read(sibling('_训练网格'+str(year-1)))
        assert len(train_grid)==3025 and not any(x.get('pruned') for x in train_grid)
        choices = ranked(train_grid,fold['lock']['return_floor_pct'])
        assert (choices[0] if choices else None)==fold['lock']['selected']
        assert fold['lock']['train_end']<fold['lock']['test_start']
        assert fold['lock']['full_grid_not_evaluated_before_lock'] and fold['lock']['test_not_evaluated_before_lock']
        assert fold['funding_cap_breached_after_lock'] is None
        years.append(year)
    final_fold = r['chronological_folds'][-1]
    frozen = final_fold['lock']['selected']
    assert r['main_training_selected_rule']==(frozen['rule'] if frozen else None)
    report_status = audit_report(Path(str(stem)+'_研究报告.md'),r,c)
    return r, {'code':p['fund_code'],'audit':'PASS','source_config_driver_engine_dividend_hashes':'PASS',
               'complete_nonpruned_grid':len(grid),'independent_ranking_and_floor':'PASS',
               'daily_cap_norm':expected_cap,'maximum_gross_buy_per_observation_norm':max_buy,
               'all_detail_cases_independent_FIFO_cash_dividend_flow_TWR_ledger':'PASS',
               'chronological_lock_hash_and_save_order_years':years,
               '2026_frozen_peak_extra_over_regular_pct':final_fold['continuous_peak_extra_over_regular_pct'],
               'report_numeric_tables_and_rule_order':report_status}


def render(result_path,r):
    try:
        import matplotlib
    except ModuleNotFoundError:
        import sys,tempfile
        cache = Path(tempfile.gettempdir())/'codex-nav-plot-dependencies'
        if not cache.is_dir():
            raise RuntimeError('PNG rendering requires matplotlib; --audit-only needs stdlib only.')
        sys.path.insert(0,str(cache))
        import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    from matplotlib import font_manager
    from matplotlib.ticker import FuncFormatter
    font_manager.fontManager.addfont('C:/Windows/Fonts/msyh.ttc')
    plt.rcParams.update({'font.family':'Microsoft YaHei','axes.unicode_minus':False,
                         'font.size':10,'figure.facecolor':'white','savefig.facecolor':'white'})
    p = r['protocol']
    fig,axes = plt.subplots(2,1,figsize=(11.8,8.2),sharex=True,
                            gridspec_kw={'height_ratios':[1.55,1.],'hspace':.12})
    specs = [('hindsight_calmar','全历史事后候选','#B74347','-'),
             ('annual_hold','年度买入持有：相同每日限制','#246B9A','-'),
             ('chronological_frozen','2025年底冻结参数：全历史回放','#6F6789','--')]
    for key,label,color,style in specs:
        if key not in r['cases']:
            continue
        rows = r['cases'][key]['daily']
        dates = [dt.date.fromisoformat(x['date']) for x in rows]
        axes[0].plot(dates,[(x['twr_index']-1.)*100. for x in rows],color=color,
                     linestyle=style,label=label,linewidth=1.7 if style=='-' else 1.25)
        axes[1].plot(dates,[x['drawdown_pct'] for x in rows],color=color,linestyle=style,linewidth=1.4)
    for ax in axes:
        ax.axvspan(dt.date(2026,1,1),dt.date.fromisoformat(p['source_end']),color='#DFE9E2',alpha=.38,zorder=-5)
        ax.axhline(0.,color='#7D858C',linewidth=.7)
        ax.grid(axis='y',color='#DDE2E6',linewidth=.65)
        ax.spines[['top','right']].set_visible(False)
        ax.spines[['left','bottom']].set_color('#A6AEB5')
        ax.yaxis.set_major_formatter(FuncFormatter(lambda value,_:f'{value:.0f}%'))
    axes[0].set_ylabel('累计 TWR 收益率')
    axes[1].set_ylabel('相对历史高点回撤')
    axes[0].legend(loc='upper left',frameon=False,fontsize=9)
    span = (dt.date.fromisoformat(p['source_end'])-dt.date.fromisoformat(p['source_start'])).days
    axes[1].xaxis.set_major_locator(mdates.YearLocator(2) if span>6*365 else mdates.MonthLocator(bymonth=(1,7)))
    axes[1].xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m'))
    axes[1].set_xlim(dt.date.fromisoformat(p['source_start']),dt.date.fromisoformat(p['source_end']))
    fig.suptitle(f'{p["fund_code"]}  {p["fund_name"]}：统一量化研究',x=.09,y=.975,ha='left',fontsize=16)
    daily_note = '每日申购≤假设年度预算的50%' if p['daily_buy_cap_norm'] is not None else '不设每日申购限制'
    w,h = r['cases']['hindsight_calmar']['summary'],r['cases']['annual_hold']['summary']
    subtitle = (f'{p["source_start"]} — {p["source_end"]}  |  累计外部补款不限；{daily_note}\n'
                f'事后候选：{rule_text(w["rule"])}  |  年化 {w["twr_annualized_pct"]:.2f}% / 回撤 {w["max_drawdown_pct"]:.2f}%'
                f'    年度持有年化 {h["twr_annualized_pct"]:.2f}% / 回撤 {h["max_drawdown_pct"]:.2f}%')
    fig.text(.09,.93,subtitle,ha='left',va='top',fontsize=10,linespacing=1.65,color='#3A4248')
    funding_peak = r['chronological_folds'][-1]['continuous_peak_extra_over_regular_pct']
    fig.text(.09,.864,f'2025年底冻结规则：过程补款比例峰值 {funding_peak:.2f}%（分母为当时累计年度预算）',
             ha='left',va='top',fontsize=9,color='#545D64')
    fig.text(.09,.035,
             '输入：本地公开净值；扣交易费并计现金分红，分离外部入金。所有曲线为归一化收益，不含账户金额。\n'
             '浅色区为2026年；冻结规则训练期也为历史回放。事后择参和时序切割并非前瞻实盘验证；净值日期近似交易日。',
             fontsize=9,color='#545D64',va='bottom',linespacing=1.6)
    fig.subplots_adjust(left=.09,right=.98,top=.82,bottom=.13)
    output = result_path.with_name(result_path.stem+'_研究图.png')
    fig.savefig(output,dpi=190)
    plt.close(fig)
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--audit-only',action='store_true')
    parser.add_argument('--codes',nargs='+',default=CODES)
    parser.add_argument('--skip-pending',action='store_true')
    args = parser.parse_args()
    for code in args.codes:
        folder = next((ROOT/'基金').glob('*/'+code+'_*'))/'研究'
        matches = list(folder.glob(code+'_统一量化研究_截至????-??-??.json'))
        if not matches and args.skip_pending:
            print(json.dumps({'code':code,'audit':'PENDING'},ensure_ascii=False),flush=True)
            continue
        assert len(matches)==1,(code,len(matches))
        result,findings = audit(matches[0])
        if not args.audit_only:
            findings['chart'] = str(render(matches[0],result))
        print(json.dumps(findings,ensure_ascii=False),flush=True)


if __name__=='__main__':
    main()
