"""Public A-class NAV research with an inherited position and normalized budgets.

No account amounts or private positions are read, stored, or printed.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import hashlib
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / '公共资料' / '工具'
sys.path.insert(0, str(TOOLS))
from initial_position_quant_engine import prepare, simulate
from annual_threshold_study import configurations, neighbors

FUND = Path(__file__).resolve().parents[1]
OUT = FUND / '研究'
STEM = '270023_初始持仓收益回撤优化_截至2026-10-15'
SOURCE = FUND / '历史净值' / '270023_全部历史净值_截至2026-10-15.json'
DIVIDENDS = OUT / '270023_官方现金分红事件_核验2026-10-18.json'
WORK_DATA = None


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def save(suffix, payload):
    path = OUT / (STEM + suffix + '.json')
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    return path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def initialize(data):
    global WORK_DATA
    WORK_DATA = data


def evaluate_rule(rule):
    return simulate(WORK_DATA, rule=rule, compute_xirr=False)


def score(record):
    return (-round(record['calmar'], 12), record['extra_total_norm'],
            record['tactical_buy_count'] + record['tactical_sell_count'], tuple(record['rule']))


def rank(records):
    eligible = [r for r in records if r['twr_annualized_pct'] > 0 and r['calmar'] is not None]
    return sorted(eligible, key=score)


def frontier(records):
    result, best = [], -math.inf
    for r in sorted(records, key=lambda r: (r['mdd_pct'], -r['twr_annualized_pct'])):
        if r['twr_annualized_pct'] > best + 1e-10:
            result.append(r)
            best = r['twr_annualized_pct']
    return result


def grid(data, label, workers):
    path = OUT / (STEM + label + '.json')
    fingerprint = sha(TOOLS / 'initial_position_quant_engine.py')
    input_fingerprint = hashlib.sha256(json.dumps({
        'rows': data['rows'], 'dividends': data['dividends'],
        'driver_sha256': sha(Path(__file__)), 'source_sha256': sha(SOURCE),
        'dividend_sha256': sha(DIVIDENDS),
    }, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    if path.exists():
        old = read(path)
        if old.get('engine_sha256') == fingerprint and old.get('input_sha256') == input_fingerprint:
            return old['records']
    rules = configurations()
    records = []
    with cf.ProcessPoolExecutor(max_workers=workers, initializer=initialize, initargs=(data,)) as pool:
        for i, result in enumerate(pool.map(evaluate_rule, rules, chunksize=24), 1):
            records.append(result)
            if i % 500 == 0:
                print(json.dumps({'phase': label, 'completed': i, 'total': len(rules)}), flush=True)
    save(label, {'engine_sha256': fingerprint, 'input_sha256': input_fingerprint, 'records': records})
    return records


def data_window(rows, dividends, start, end='2026-10-15'):
    return prepare([r for r in rows if start <= r['date'] <= end], dividends)


def detail_summary(result):
    return result['summary']


def get_day(row):
    return str(row.get('date', row.get('day')))


def get_twr(row):
    for key in ('twr', 'twr_nav', 'twr_index', 'unitized_nav'):
        if key in row:
            return float(row[key])
    raise KeyError('No TWR index in detail')


def window_stats(detail, start, end):
    rows = detail['daily']
    indexes = [i for i, r in enumerate(rows) if start <= get_day(r) <= end]
    if not indexes:
        return None
    first, last = indexes[0], indexes[-1]
    base = get_twr(rows[first-1]) if first else 1.
    levels = [base] + [get_twr(rows[i]) for i in indexes]
    peak, mdd = levels[0], 0.
    for value in levels:
        peak = max(peak, value)
        mdd = max(mdd, 1. - value / peak)
    basedate = get_day(rows[first-1]) if first else get_day(rows[first])
    years = (dt.date.fromisoformat(get_day(rows[last])) - dt.date.fromisoformat(basedate)).days / 365.2425
    cumulative = levels[-1] / base - 1.
    cagr = (levels[-1] / base) ** (1. / years) - 1. if years else 0.
    return {'start': get_day(rows[first]), 'end': get_day(rows[last]),
            'twr_return_pct': cumulative * 100., 'twr_annualized_pct': cagr * 100.,
            'mdd_pct': mdd * 100., 'calmar': cagr / mdd if mdd else None}


def extra_flows(detail):
    """Map supplemental inflows only; leave inherited and annual capital alone."""
    result = {}
    for row in detail['cashflows']:
        if isinstance(row, dict):
            kind = row.get('kind', row.get('type'))
            if kind == 'extra':
                day = str(row['date'])
                value = abs(float(row.get('amount_norm', row.get('value_norm', row.get('amount')))))
                result[day] = result.get(day, 0.) + value
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    raw, dividends = read(SOURCE), read(DIVIDENDS)
    rows = [{'date': r['date'], 'nav': float(r['nav'])} for r in raw['rows']]
    full = data_window(rows, dividends, '2015-01-01')
    protocol = {
        'created_at': dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(),
        'code': '270023', 'share_class': 'RMB A', 'source_sha256': sha(SOURCE),
        'source_path': str(SOURCE.relative_to(ROOT)), 'cutoff': '2026-10-15',
        'main_window': ['2015-01-01', '2026-10-15'],
        'main_window_reason': 'Full calendar years after the 2014 mandate change; avoids fictional pre-inception aging.',
        'initial_position_to_annual_budget': 6., 'initial_holding_calendar_days': 365,
        'initial_mark': 'Inherited market value; earlier P/L excluded; no new subscription fee on old units.',
        'annual_budget': 1., 'annual_arrival': 'First observed NAV date of year; first partial year prorated by remaining months.',
        'flow_TWR_timing': 'Deposits at the date NAV valuation node: market move before deposits, transaction fee after deposits. Cash is available for that date order.',
        'daily_gross_subscription_cap_to_annual_budget': .5, 'external_topups': 'Unlimited only at actual cash shortage.',
        'subscription_fee': .0016, 'redemption_tiers': [[7,.015],[365,.005],[730,.003]],
        'signal_lag_NAV_observations': 3, 'confirmation_lag_NAV_observations': 2,
        'sellability_lag_NAV_observations': 3, 'redemption_settlement_weekdays': 2,
        'settlement_source': 'User expressly requested T+2 redemption cash availability; weekday approximation, not provider promise.',
        'dividends': 'Cash receivable at exdate; spendable from payment date; dividend-adjusted signal index only, raw NAV for units.',
        'objective': 'Largest positive TWR CAGR / TWR MDD over the declared finite grid; no unrequested return or funding floor.',
        'grid': {'count': len(configurations()), 'thresholds_pct': [5,10,15,20,25,30,40,50,60], 'trade_fractions_pct': [0,5,10,15,20,30,50]},
        'chronology': '2015-2020 selection frozen before 2021-2025 check; 2015-2025 selection frozen before 2026 check; descriptive full-window grid last.',
        'validation_note': 'Historical NAV and prior studies already accessible. Retrospective diagnostics, no claim of pristine unseen data.',
        'limitations': ['Observed NAV weekdays proxy actual QDII dealing/disclosure/confirmation calendars.',
                       'No complete historical suspension/limit/announcement-timestamp reconstruction.',
                       'Static current discounted subscription fee and current redemption tiers, no historical channel-fee replay.',
                       'Zero cash interest; terminal mark, no forced liquidation; parameter grid finite.'],
        'engine_sha256': sha(TOOLS / 'initial_position_quant_engine.py'),
    }
    save('_预设', protocol)
    hold = simulate(full, detail=True, compute_xirr=True)
    initial_hold = simulate(full, initial_only=True, detail=True, compute_xirr=True)
    locks = {}
    for cutoff, check_start, check_end in [('2020-12-31','2021-01-01','2025-12-31'),
                                            ('2025-12-31','2026-01-01','2026-10-15')]:
        train = data_window(rows, dividends, '2015-01-01', cutoff)
        records = grid(train, '_训练截至' + cutoff, args.workers)
        chosen = rank(records)[0]
        lock = {'train_end': cutoff, 'selected': chosen, 'test_start': check_start, 'test_end': check_end,
                'engine_sha256': protocol['engine_sha256']}
        save('_参数锁定' + check_start[:4], lock)
        follow = simulate(full, rule=tuple(chosen['rule']), detail=True, compute_xirr=True)
        lock['test_strategy'] = window_stats(follow, check_start, check_end)
        lock['test_annual_hold'] = window_stats(hold, check_start, check_end)
        test_data = data_window(rows, dividends, check_start, check_end)
        lock['test_reset_strategy'] = simulate(test_data, rule=tuple(chosen['rule']), compute_xirr=True)
        lock['test_reset_annual_hold'] = simulate(test_data, compute_xirr=True)
        lock['test_scope'] = 'test_strategy carries that fixed rule through training; test_reset_* starts a fresh inherited position at the test boundary. Do not splice different locks into one track record.'
        lock['continuous_full_summary'] = follow['summary']
        locks[check_start[:4]] = lock
        save('_时序检验' + check_start[:4], lock)
        print(json.dumps({'phase':'chronological_check', 'year':check_start[:4], 'rule':chosen['rule'],
                          'test':lock['test_strategy'], 'hold':lock['test_annual_hold']}), flush=True)
    records = grid(full, '_全历史网格', args.workers)
    ordered = rank(records)
    positive = [r for r in records if r['twr_annualized_pct'] > 0.]
    chosen = ordered[0]
    max_return = max(records, key=lambda r:r['twr_annualized_pct'])
    min_drawdown = min(positive, key=lambda r:r['mdd_pct'])
    no_return_loss = [r for r in ordered if r['twr_annualized_pct'] >= hold['summary']['twr_annualized_pct'] - 1e-10]
    rules = {'balanced_hindsight': chosen['rule'], 'highest_return_hindsight': max_return['rule'],
             'lowest_drawdown_positive_hindsight': min_drawdown['rule'],
             'locked_2026': locks['2026']['selected']['rule']}
    if no_return_loss:
        rules['calmar_with_hold_return_floor'] = no_return_loss[0]['rule']
    cases = {'annual_hold': hold, 'initial_hold': initial_hold}
    for name, rule in rules.items():
        cases[name] = simulate(full, rule=tuple(rule), detail=True, compute_xirr=True)
    matches = {}
    for name in ('balanced_hindsight', 'locked_2026', 'highest_return_hindsight'):
        flowmap = extra_flows(cases[name])
        matched = simulate(full, forced_extras=flowmap, detail=True, compute_xirr=True)
        matches[name] = matched
        assert abs(matched['summary']['extra_total_norm'] - cases[name]['summary']['extra_total_norm']) < 1e-8
    balanced_rule = tuple(chosen['rule'])
    sensitivity = {
        'signal_lags': [simulate(full, rule=balanced_rule, signal_lag=n, compute_xirr=True) for n in (2,3,5)],
        'redemption_delays': [simulate(full, rule=balanced_rule, redemption_settlement_workdays=n, compute_xirr=True) for n in (2,5,10)],
        'initial_ages': [simulate(full, rule=balanced_rule, initial_age_days=n, compute_xirr=True) for n in (0,365,730)],
        'standard_subscription': simulate(full, rule=balanced_rule, buy_fee=.016, compute_xirr=True),
        'neighbors': [simulate(full, rule=r, compute_xirr=True) for r in neighbors(balanced_rule)],
    }
    periods = {}
    for label, start, end in [('pre_global_aux','2011-09-29','2026-10-15'),
                             ('current_manager','2021-04-07','2026-10-15')]:
        data = data_window(rows, dividends, start, end)
        periods[label] = {'strategy': simulate(data, rule=balanced_rule, compute_xirr=True),
                          'annual_hold': simulate(data, compute_xirr=True)}
    rolling = []
    for years in (3,5):
        for year in range(2015,2027-years):
            start, end = f'{year}-01-01', f'{year+years-1}-12-31'
            data = data_window(rows, dividends, start, end)
            strategy = simulate(data, rule=balanced_rule, compute_xirr=True)
            benchmark = simulate(data, compute_xirr=True)
            rolling.append({'years': years, 'start': data['rows'][0]['date'], 'end': data['rows'][-1]['date'],
                            'strategy':strategy, 'annual_hold':benchmark})
    annual = []
    for year in range(2015,2027):
        start, end = f'{year}-01-01', f'{year}-12-31'
        annual.append({'year':year, 'strategy':window_stats(cases['balanced_hindsight'],start,end),
                       'annual_hold':window_stats(hold,start,end)})
    output = {'protocol': protocol, 'locks': locks, 'candidates':rules, 'cases':cases,
              'matched_hold':matches, 'pareto_frontier':frontier(records),
              'sensitivities':sensitivity, 'period_diagnostics':periods, 'rolling_windows':rolling,
              'annual_diagnostics':annual, 'grid_size':len(records)}
    save('', output)
    print(json.dumps({'phase':'complete', 'cases':{k:v['summary'] for k,v in cases.items()},
                      'matched':{k:v['summary'] for k,v in matches.items()}}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
