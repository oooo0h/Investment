"""Explicit hindsight exploration over independent overlapping start windows.

Designed after the main study was inspected. This is parameter exploration,
not an independent or unseen-data validation. Uses only public NAVs and
hypothetical normalized units; never reads or emits investor account amounts.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import hashlib
import json
import math
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
TOOLS = ROOT / '公共资料' / '工具'
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(HERE))
from initial_position_quant_engine import prepare, simulate
from annual_threshold_study import configurations
from research_270023_initial_position import extra_flows

FUND = HERE.parent
OUT = FUND / '研究'
MAIN_STEM = '270023_初始持仓收益回撤优化_截至2026-10-15'
STEM = MAIN_STEM + '_多起点探索'
SOURCE = FUND / '历史净值' / '270023_全部历史净值_截至2026-10-15.json'
DIVIDENDS = OUT / '270023_官方现金分红事件_核验2026-10-18.json'
WINDOWS = None
TOL = 1e-10


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def save(suffix, payload):
    path = OUT / (STEM + suffix + '.json')
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    return path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def initialize(windows):
    global WINDOWS
    WINDOWS = windows


def mean(values):
    return statistics.mean(values) if values else None


def median(values):
    return statistics.median(values) if values else None


def aggregate(rule, windows):
    records = []
    for window in windows:
        records.append((window, simulate(window['data'], rule=rule)))
    calmars = [s['calmar'] for _, s in records if s['calmar'] is not None]
    differences = [s['calmar']-w['annual_hold']['calmar'] for w, s in records
                   if s['calmar'] is not None and w['annual_hold']['calmar'] is not None]
    excesses = [s['twr_annualized_pct']-w['annual_hold']['twr_annualized_pct'] for w, s in records]
    returns = [s['twr_annualized_pct'] for _, s in records]
    drawdowns = [s['mdd_pct'] for _, s in records]
    extras = [s['extra_total_norm'] for _, s in records]
    extra_ratios = [s['extra_to_regular_pct'] for _, s in records if s['extra_to_regular_pct'] is not None]
    trades = [s['tactical_buy_count']+s['tactical_sell_count'] for _, s in records]
    def counts(records):
        returns = sum(s['twr_annualized_pct'] > w['annual_hold']['twr_annualized_pct']+TOL for w, s in records)
        drawdowns = sum(s['mdd_pct'] < w['annual_hold']['mdd_pct']-TOL for w, s in records)
        dual = sum(s['twr_annualized_pct'] > w['annual_hold']['twr_annualized_pct']+TOL
                   and s['mdd_pct'] < w['annual_hold']['mdd_pct']-TOL for w, s in records)
        return {'window_count': len(records), 'return_win_window_count': returns,
                'drawdown_win_window_count': drawdowns, 'dual_win_window_count': dual}
    result = {
        'rule': list(rule), 'window_count': len(records),
        'valid_calmar_count': len(calmars), 'skipped_calmar_count': len(records)-len(calmars),
        'valid_calmar_difference_count': len(differences),
        'skipped_calmar_difference_count': len(records)-len(differences),
        'median_calmar': median(calmars), 'mean_calmar': mean(calmars),
        'worst_calmar_difference': min(differences) if differences else None,
        'median_calmar_difference': median(differences),
        'mean_calmar_difference': mean(differences),
        'median_twr_annualized_pct': median(returns), 'mean_twr_annualized_pct': mean(returns),
        'median_mdd_pct': median(drawdowns), 'worst_mdd_pct': max(drawdowns),
        'mean_annualized_excess_pct': mean(excesses), 'median_annualized_excess_pct': median(excesses),
        'worst_annualized_excess_pct': min(excesses),
        'mean_extra_total_norm': mean(extras), 'median_extra_total_norm': median(extras),
        'mean_extra_to_regular_pct': mean(extra_ratios), 'median_extra_to_regular_pct': median(extra_ratios),
        'mean_tactical_trade_count': mean(trades), 'median_tactical_trade_count': median(trades),
        **counts(records),
        'by_horizon': {str(years): counts([(w,s) for w,s in records if w['years']==years]) for years in (3,5)},
    }
    return result


def evaluate(rule):
    return aggregate(rule, WINDOWS)


def key_a(record):
    return (-round(record['median_calmar'], 12), -round(record['mean_annualized_excess_pct'], 12),
            record['mean_extra_total_norm'], record['mean_tactical_trade_count'], tuple(record['rule']))


def key_b(record):
    return (-round(record['worst_calmar_difference'], 12),
            -round(record['median_annualized_excess_pct'], 12), tuple(record['rule']))


def matching_case(data, rule, **overrides):
    strategy = simulate(data, rule=tuple(rule), detail=True, compute_xirr=True, **overrides)
    matched = simulate(data, forced_extras=extra_flows(strategy), detail=True, compute_xirr=True,
                       **overrides)
    if not math.isclose(strategy['summary']['extra_total_norm'], matched['summary']['extra_total_norm'], abs_tol=1e-8):
        raise AssertionError('Matched baseline external cashflows differ')
    return {'strategy': strategy, 'matched_hold': matched}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    raw, dividends = read(SOURCE), read(DIVIDENDS)
    rows = [{'date': row['date'], 'nav': float(row['nav'])} for row in raw['rows']]
    main_output = read(OUT / (MAIN_STEM+'.json'))
    definitions = [{'years': w['years'], 'start': w['start'], 'end': w['end']}
                   for w in main_output['rolling_windows']]
    rules = configurations()
    if len(definitions) != 16 or len(rules) != 3025:
        raise AssertionError('Unexpected declared window/grid size')
    protocol = {
        'created_at': dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(),
        'research_status': 'Retrospective parameter exploration designed after viewing the main study.',
        'not_independent_validation': True,
        'code': '270023', 'share_class': 'RMB A',
        'source_sha256': sha(SOURCE), 'dividends_sha256': sha(DIVIDENDS),
        'engine_sha256': sha(TOOLS/'initial_position_quant_engine.py'),
        'script_sha256': sha(Path(__file__)), 'main_result_sha256': sha(OUT/(MAIN_STEM+'.json')),
        'windows': definitions, 'window_count': 16,
        'overlap_warning': 'Nine 3-year and seven 5-year windows overlap heavily; counts are not independent observations.',
        'initialization': 'Every window restarts inherited market value=6 annual budgets, aged 365 natural days; annual budget=1, cap=.5, all engine defaults.',
        'main_full_window': ['2015-01-01','2026-10-15'],
        'grid_size': len(rules), 'grid_rules': [list(rule) for rule in rules],
        'negative_returns': 'Allowed without filtering for both objectives.',
        'undefined_calmar': 'Skip None Calmar in objective A; skip a pair if strategy or baseline Calmar is None for objective B. Save valid/skipped counts for every rule.',
        'objective_A': ['Maximize median strategy Calmar over windows',
                        'Then maximize mean annualized return minus annual-hold return',
                        'Then minimize mean actual extra funding in normalized units',
                        'Then minimize mean tactical trade count', 'Then lexical rule for determinism'],
        'objective_B': ['Maximize worst window of strategy Calmar minus annual-hold Calmar',
                        'Then maximize median annualized excess return', 'Then lexical rule for determinism'],
        'tie_precision_decimal_places': 12,
        'dual_win_definition': 'Strategy annualized return strictly exceeds annual-hold return AND maximum drawdown is strictly smaller, using absolute tolerance 1e-10.',
        'return_win_definition': 'Strategy annualized return strictly exceeds annual-hold return by >1e-10.',
        'funding_aggregation': 'Mean/median over distinct reset scenarios; never interpreted as cumulative real-world account funding.',
        'sensitivity': {'signal_lags': [2,5], 'redemption_settlement_weekdays': [10]},
        'all_outputs_normalized': True,
    }
    # Save the declared exploration objectives before running any new grid.
    save('_预设', protocol)
    windows = []
    for definition in definitions:
        data = prepare([r for r in rows if definition['start'] <= r['date'] <= definition['end']], dividends)
        windows.append({**definition, 'data': data, 'annual_hold': simulate(data)})
    records = []
    with cf.ProcessPoolExecutor(max_workers=args.workers, initializer=initialize, initargs=(windows,)) as pool:
        for i, result in enumerate(pool.map(evaluate, rules, chunksize=16), 1):
            records.append(result)
            if i % 500 == 0:
                print(json.dumps({'phase':'multi_start_hindsight_exploration','completed':i,'total':len(rules)}), flush=True)
    ranked_a = sorted([r for r in records if r['median_calmar'] is not None], key=key_a)
    ranked_b = sorted([r for r in records if r['worst_calmar_difference'] is not None], key=key_b)
    chosen_a, chosen_b = ranked_a[0], ranked_b[0]
    full = prepare([r for r in rows if '2015-01-01' <= r['date'] <= '2026-10-15'], dividends)
    selected = {}
    for name, chosen in (('A_median_calmar', chosen_a), ('B_worst_calmar_difference', chosen_b)):
        rule = chosen['rule']
        independent_windows = []
        for window in windows:
            strategy = simulate(window['data'], rule=tuple(rule), compute_xirr=True)
            independent_windows.append({key: window[key] for key in ('years','start','end')}
                                       | {'strategy': strategy, 'annual_hold': window['annual_hold']})
        case = matching_case(full, rule)
        sensitivities = {}
        for lag in (2,5):
            stress = matching_case(full, rule, signal_lag=lag)
            sensitivities['signal_lag_'+str(lag)] = {key: value['summary'] for key,value in stress.items()}
        stress = matching_case(full, rule, redemption_settlement_workdays=10)
        sensitivities['redemption_settlement_weekdays_10'] = {key:value['summary'] for key,value in stress.items()}
        selected[name] = {'aggregate': chosen, 'independent_reset_windows': independent_windows,
                          'full_window_case': case, 'sensitivities': sensitivities}
    no_action = next(r for r in records if r['rule'][2] == r['rule'][3] == 0.)
    if abs(no_action['worst_calmar_difference']) > TOL or abs(no_action['mean_annualized_excess_pct']) > TOL:
        raise AssertionError('No-action rule differs from annual-hold baseline')
    output = {'protocol': protocol, 'grid_size': len(records), 'window_count': len(windows),
              'windows': [{key:value for key,value in w.items() if key!='data'} for w in windows],
              'all_rules_aggregated': records, 'selected': selected,
              'objective_A_top_20': ranked_a[:20], 'objective_B_top_20': ranked_b[:20],
              'no_action_aggregate': no_action,
              'full_annual_hold': simulate(full, compute_xirr=True),
              'verification': {'full_rule_count': len(records), 'complete_window_count_for_every_rule': all(r['window_count']==16 for r in records),
                               'no_action_equals_baseline': True,
                               'selected_matched_external_flows_equal': True,
                               'not_independent_validation': True}}
    save('', output)
    print(json.dumps({'phase':'complete_hindsight_exploration', 'selected': {
        key:{'aggregate':value['aggregate'],
             'full_strategy':value['full_window_case']['strategy']['summary'],
             'matched_hold':value['full_window_case']['matched_hold']['summary']}
        for key,value in selected.items()}}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
