"""Registered finite-grid annual-budget research on public fund NAV only.

The scalar accounting engine is shared with earlier research. A chronological
choice is frozen and checked before any full-history descriptive search. A
second share class may evaluate the frozen A-class parameters, never reselect.
All cash figures are hypothetical normalized budgets, not investor accounts.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import itertools
import json
import math
from pathlib import Path

from annual_threshold_backtest import prepare, simulate

THRESHOLDS = (.05, .10, .15, .20, .25, .30, .40, .50, .60)
FRACTIONS = (0., .05, .10, .15, .20, .30, .50)
REFERENCE = (.40, .30, .20, .30)
ORIGINAL = (.15, .15, .10, .15)
FIXED = {'annual_original': ORIGINAL, 'annual_40_30': REFERENCE,
         'huaxia_calmar': (.50, .15, .50, .10),
         'huaxia_min_drawdown': (.20, .30, .20, .30)}
SCORE_TOL = 1e-12


def canonical(config):
    up, down, sell, buy = config
    return (up if sell else .40, down if buy else .30, sell, buy)


def configurations():
    return sorted({canonical(x) for x in itertools.product(
        THRESHOLDS, THRESHOLDS, FRACTIONS, FRACTIONS)})


def distance(rule):
    return sum(abs(a-b) for a, b in zip(rule, REFERENCE))


def neighbors(config):
    result = set()
    for axis, options in enumerate((THRESHOLDS, THRESHOLDS, FRACTIONS, FRACTIONS)):
        pos = options.index(config[axis])
        for nextpos in (pos-1, pos+1):
            if 0 <= nextpos < len(options):
                c = list(config)
                c[axis] = options[nextpos]
                result.add(canonical(c))
    result.discard(tuple(config))
    return sorted(result)


def eligible(record, floor, cap):
    return (not record.get('pruned') and record['calmar'] is not None
            and record['twr_annualized_pct'] > 0
            and record['twr_annualized_pct'] >= floor-1e-10
            and record['peak_extra_over_regular_pct'] <= cap*100+1e-9)


def ranking(records, floor, cap):
    return sorted((r for r in records if eligible(r, floor, cap)), key=lambda r: (
        -round(r['calmar'], 12), r['tactical_buy_count']+r['tactical_sell_count'],
        r['extra_contributed_norm'], distance(r['rule']), r['rule']))


def tie_summary(ranked):
    if not ranked:
        return {'primary_count': 0, 'primary_rules': [], 'primary_path_count': 0,
                'minimum_drawdown_count': 0, 'minimum_drawdown_rules': [],
                'minimum_drawdown_path_count': 0}
    score = ranked[0]['calmar']
    top = [r for r in ranked if abs(r['calmar']-score) <= SCORE_TOL]
    dd = min(r['max_drawdown_pct'] for r in ranked)
    low = [r for r in ranked if abs(r['max_drawdown_pct']-dd) <= 1e-10]
    return {'primary_count': len(top), 'primary_rules': [r['rule'] for r in top],
            'primary_path_count': len({r['path_signature'] for r in top}),
            'minimum_drawdown_count': len(low),
            'minimum_drawdown_rules': [r['rule'] for r in low],
            'minimum_drawdown_path_count': len({r['path_signature'] for r in low})}


def pareto(records):
    ordered = sorted((r for r in records if not r.get('pruned')), key=lambda r: (
        r['max_drawdown_pct'], -r['twr_annualized_pct']))
    output, best = [], -math.inf
    for record in ordered:
        if record['twr_annualized_pct'] > best+1e-10:
            output.append(record)
            best = record['twr_annualized_pct']
    return output


class Study:
    def __init__(self, fund, config):
        self.fund = Path(fund)
        self.config = config
        self.code = config['code']
        self.cutoff = config.get('cutoff', '2026-10-15')
        self.out = self.fund/'研究'
        self.stem = self.code+'_年度投入规则优化_截至'+self.cutoff
        self.source = self.fund/'历史净值'/(self.code+'_全部历史净值_截至'+self.cutoff+'.json')
        self.cap = float(config.get('funding_cap', .50))
        self.tiers = tuple(tuple(x) for x in config['redemption_tiers'])
        self.buy_fee = float(config['buy_fee'])
        self.raw = json.loads(self.source.read_text(encoding='utf-8-sig'))
        self.source_sha = hashlib.sha256(self.source.read_bytes()).hexdigest()
        original = self.raw['rows']
        assert original and original == sorted(original, key=lambda r: r['date'])
        assert len(original) == len({r['date'] for r in original})
        assert all(r['date'] <= self.cutoff for r in original), 'Pinned cutoff exceeded'
        assert all(math.isfinite(float(r['nav'])) and float(r['nav']) > 0 for r in original)
        self.all_rows = [{'date': r['date'], 'nav': float(r['nav'])} for r in original]
        self.weekend_dates = [r['date'] for r in self.all_rows
                              if dt.date.fromisoformat(r['date']).weekday() >= 5]
        self.rows = [r for r in self.all_rows if not config.get('weekdays_only_main', False)
                     or dt.date.fromisoformat(r['date']).weekday() < 5]
        self.dividends = self.raw.get('dividend_events', [])
        for row in self.dividends:
            assert {'exdate', 'paydate', 'per_unit'} <= row.keys()
        self.full = prepare(self.rows, self.dividends)
        self.periods = config.get('periods', {
            'development': (self.rows[0]['date'], '2024-12-31'),
            'validation': ('2025-01-01', '2025-12-31'),
            'recent': ('2026-01-01', self.cutoff)})
        self.period_data = {key: self.period(first, last)
                            for key, (first, last) in self.periods.items()}

    def period(self, first, last, rows=None):
        selected = [r for r in (self.rows if rows is None else rows) if first <= r['date'] <= last]
        assert len(selected) > 1, (first, last, 'Insufficient NAV observations')
        return prepare(selected, self.dividends)

    def evaluate(self, data, rule=None, **kwargs):
        return simulate(data, rule, buy_fee=self.buy_fee, redemption_tiers=self.tiers, **kwargs)

    def write(self, suffix, payload):
        path = self.out/(self.stem+suffix+'.json')
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
        return path

    def grid(self, data, label):
        result = []
        configs = configurations()
        for index, config in enumerate(configs):
            result.append(self.evaluate(data, config, max_extra_ratio=self.cap))
            if (index+1) % 750 == 0:
                print(json.dumps({'phase': label, 'completed': index+1, 'total': len(configs)}), flush=True)
        return result

    def protocol(self, mode):
        config = self.config
        return {
            'created_at': dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec='seconds'),
            'fund_code': self.code, 'fund_name': config['name'], 'study_mode': mode,
            'source_sha256': self.source_sha, 'source_scope': self.raw.get('source'),
            'source_rows': len(self.all_rows), 'analysis_rows': len(self.rows),
            'weekend_accounting_dates': self.weekend_dates,
            'weekdays_only_main': config.get('weekdays_only_main', False),
            'normalization': 'Hypothetical full annual budget=1; no investor account data read',
            'funding': 'Annual budget at first NAV date of year. Startup year prorated by remaining calendar months; later full years, including current unfinished year, budget=1',
            'annual_reset': 'Buy the new annual budget first; reset price and full fund-value anchors; cancel pending signal; no other signal that day',
            'signal': 'Raw NAV relative to preceding actual trade; sale fraction of execution fund value; buy gross budget fraction of previous anchor value',
            'lag': 2, 'cash': 'Zero interest; cash dividends; fund service/management fees already embedded in NAV',
            'fees': {'subscription': self.buy_fee, 'redemption_tiers': self.tiers,
                     'meaning': 'Static sensitivity using FIFO; execution date proxies confirmation',
                     'verification': config.get('fee_verification')},
            'grid': {'up': THRESHOLDS, 'down': THRESHOLDS, 'sell': FRACTIONS, 'buy': FRACTIONS,
                     'canonical_count': len(configurations())},
            'funding_cap': 'At EVERY observation cumulative extra contribution / cumulative regular annual budget <= '+str(self.cap),
            'primary_objective': 'Maximize annualized TWR / maximum TWR drawdown; positive CAGR and CAGR>=max(0,in-period annual40/30 CAGR), funding cap',
            'secondary_objective': 'Minimum drawdown under the identical return and funding constraints',
            'tie_break': 'Score rounded to12 decimals, fewer tactical trades, lower extra, L1distance to40/30, lexicographic; disclose all tied scores and paths',
            'chronological': 'FIRST development grid and lock -> fixed validation/recent diagnostics -> LAST full-history descriptive grid; never revise chronological choice',
            'periods': self.periods,
            'validation_scope': 'Retrospective chronological diagnostics; very short NAV history, not independent market cycles; A/C classes are same portfolio, not independent samples',
            'robustness': 'Lag1/2/3; zero fees; complete2024-2025; ordinary subscription opening; neighboring parameters; weekend accounting date sensitivity',
            'subscription_open_date': config['subscription_open_date'],
            'execution_limit': 'NAV observation dates proxy transaction dates; public holidays, fund-opening/limits, publication/settlement delays not fully reconstructed; inception-date primary run may predate ordinary subscriptions',
            'source_validation': self.raw.get('validation', {})}

    def fixed_diagnostics(self, rules):
        return {key: {period: [self.evaluate(data, rule, lag=lag, compute_xirr=True)
                               for lag in (1, 2, 3)]
                      for period, data in self.period_data.items()}
                for key, rule in rules.items()}

    def detailed_outputs(self, rules):
        cases = {key: self.evaluate(self.full, rule, detail=True) for key, rule in rules.items()}
        for key, schedule in [('annual_hold', 'annual'), ('monthly', 'monthly'), ('daily', 'daily')]:
            cases[key] = self.evaluate(self.full, schedule=schedule, detail=True)
        cases['initial_hold'] = self.evaluate(self.full, initial_only=True, detail=True)
        complete = self.period('2024-01-01', '2025-12-31')
        subscription_open = self.period(self.config['subscription_open_date'], self.cutoff)
        weekdays = prepare([r for r in self.all_rows if dt.date.fromisoformat(r['date']).weekday() < 5], self.dividends)
        accounting_dates = prepare(self.all_rows, self.dividends)
        sensitivity = {key: {
            'full_lags': [self.evaluate(self.full, rule, lag=lag, compute_xirr=True) for lag in (1, 2, 3)],
            'zero_fee': simulate(self.full, rule, buy_fee=0., redemption_tiers=(), compute_xirr=True),
            'complete2024_2025': self.evaluate(complete, rule, compute_xirr=True),
            'subscription_open': self.evaluate(subscription_open, rule, compute_xirr=True),
            'weekdays_only': self.evaluate(weekdays, rule, compute_xirr=True),
            'full_accounting_dates': self.evaluate(accounting_dates, rule, compute_xirr=True),
            'neighbors': [self.evaluate(self.full, neighbor, compute_xirr=True) for neighbor in neighbors(rule)]}
            for key, rule in rules.items()}
        matched = {key: self.evaluate(self.full, forced_extras={
            row['date']: row['extra_today_norm'] for row in case['daily'] if row['extra_today_norm']}, compute_xirr=True)
            for key, case in cases.items() if key in rules}
        return cases, sensitivity, matched

    def run_primary(self, resume_after_error=False):
        self.out.mkdir(exist_ok=True)
        protocol = self.protocol('A_class_primary_finite_grid')
        for suffix in ('_时序锁定', '_锁定后验证', '_开发期网格', '_全历史网格', ''):
            if (self.out/(self.stem+suffix+'.json')).exists():
                raise FileExistsError('Registered experiment already exists; preserve it: '+suffix)
        preset = self.out/(self.stem+'_预设.json')
        if preset.exists():
            if not resume_after_error:
                raise FileExistsError('Registered protocol exists; technical restart requires explicit resume flag')
            registered = json.loads(preset.read_text(encoding='utf-8'))
            assert {k:v for k,v in registered.items() if k!='created_at'} == json.loads(json.dumps({
                k:v for k,v in protocol.items() if k!='created_at'})), 'Cannot change registered experiment on restart'
            protocol = registered
        else:
            self.write('_预设', protocol)
        dev = self.period_data['development']
        dev_reference = self.evaluate(dev, REFERENCE)
        dev_grid = self.grid(dev, 'development')
        dev_floor = max(0., dev_reference['twr_annualized_pct'])
        dev_ranking = ranking(dev_grid, dev_floor, self.cap)
        assert dev_ranking, 'No feasible development rule; do not relax criteria automatically'
        frozen = dev_ranking[0]
        self.write('_时序锁定', {'scope': self.periods['development'], 'reference': dev_reference,
            'return_floor_pct': dev_floor, 'selected': frozen, 'eligible_count': len(dev_ranking),
            'score_ties': tie_summary(dev_ranking),
            'different_trading_path_count': len({r['path_signature'] for r in dev_grid if not r.get('pruned')}),
            'full_grid_not_evaluated_before_lock': True})
        self.write('_开发期网格', dev_grid)
        print(json.dumps({'phase': 'development_locked', 'rule': frozen['rule']}), flush=True)
        # Save the locked rule and fixed references on later periods BEFORE
        # inspecting the descriptive full-history parameter search.
        pregrid_rules = dict(FIXED, chronological_frozen=tuple(frozen['rule']))
        pregrid_diagnostics = self.fixed_diagnostics(pregrid_rules)
        locked_check_path = self.write('_锁定后验证', {
            'full_grid_not_evaluated_before_checks': True, 'diagnostics': pregrid_diagnostics})
        locked_check_sha = hashlib.sha256(locked_check_path.read_bytes()).hexdigest()
        baseline = self.evaluate(self.full, REFERENCE)
        full_grid = self.grid(self.full, 'full_history_descriptive')
        floor = max(0., baseline['twr_annualized_pct'])
        full_ranking = ranking(full_grid, floor, self.cap)
        assert full_ranking, 'No feasible full-history rule; report failure without relaxing criteria'
        winner = full_ranking[0]
        low = min(full_ranking, key=lambda r: (r['max_drawdown_pct'], -r['twr_annualized_pct'],
                                              distance(r['rule']), r['rule']))
        rules = dict(FIXED, hindsight_best=tuple(winner['rule']),
                     chronological_frozen=tuple(frozen['rule']), minimum_drawdown=tuple(low['rule']))
        cases, sensitivities, matched = self.detailed_outputs(rules)
        diagnostics = dict(pregrid_diagnostics)
        diagnostics.update(self.fixed_diagnostics({key: rule for key, rule in rules.items()
                                                   if key not in pregrid_diagnostics}))
        dominators = [r for r in full_ranking if
            r['twr_annualized_pct'] >= baseline['twr_annualized_pct']-1e-10 and
            r['max_drawdown_pct'] <= baseline['max_drawdown_pct']+1e-10 and
            r['extra_contributed_norm'] <= baseline['extra_contributed_norm']+1e-10 and
            (r['twr_annualized_pct'] > baseline['twr_annualized_pct']+1e-8 or
             r['max_drawdown_pct'] < baseline['max_drawdown_pct']-1e-8)]
        payload = {'protocol': protocol, 'study_mode': protocol['study_mode'],
            'source_sha256': self.source_sha, 'locked_checks_sha256': locked_check_sha,
            'start': self.rows[0]['date'], 'end': self.rows[-1]['date'],
            'source_row_count': len(self.all_rows), 'analysis_row_count': len(self.rows),
            'return_floor_pct': floor, 'selected_rule': winner['rule'],
            'chronological_frozen_rule': frozen['rule'], 'minimum_drawdown_rule': low['rule'],
            'complete_grid_count': sum(not r.get('pruned') for r in full_grid),
            'pruned_count': sum(bool(r.get('pruned')) for r in full_grid),
            'eligible_count': len(full_ranking), 'score_ties': tie_summary(full_ranking),
            'different_full_trading_path_count': len({r['path_signature'] for r in full_grid if not r.get('pruned')}),
            'full_ranking_top20': full_ranking[:20], 'full_pareto': pareto(full_grid),
            'dominators_of40_30': dominators, 'cases': cases, 'diagnostics': diagnostics,
            'sensitivities': sensitivities, 'matched_actual_cashflow_hold': matched}
        self.write('_全历史网格', full_grid)
        output = self.write('', payload)
        print(json.dumps({'output': str(output), 'selected_rule': winner['rule'],
                          'score_ties': payload['score_ties'], 'minimum_drawdown_rule': low['rule'],
                          'chronological_frozen_rule': frozen['rule']}, ensure_ascii=False), flush=True)
        return payload

    def run_fixed_reference(self, primary_path):
        """Evaluate A-class chosen parameters on C NAV; never optimize C."""
        self.out.mkdir(exist_ok=True)
        if (self.out/(self.stem+'.json')).exists():
            raise FileExistsError('Existing C fixed-parameter study preserved')
        primary_path = Path(primary_path)
        primary = json.loads(primary_path.read_text(encoding='utf-8'))
        protocol = self.protocol('fixed_A_parameter_sensitivity')
        protocol['primary_parameter_source_sha256'] = hashlib.sha256(primary_path.read_bytes()).hexdigest()
        protocol['C_class_not_separately_optimized'] = True
        self.write('_预设', protocol)
        rules = dict(FIXED, hindsight_best=tuple(primary['selected_rule']),
                     chronological_frozen=tuple(primary['chronological_frozen_rule']),
                     minimum_drawdown=tuple(primary['minimum_drawdown_rule']))
        cases, sensitivities, matched = self.detailed_outputs(rules)
        payload = {'protocol': protocol, 'study_mode': protocol['study_mode'],
            'source_sha256': self.source_sha, 'start': self.rows[0]['date'], 'end': self.rows[-1]['date'],
            'source_row_count': len(self.all_rows), 'analysis_row_count': len(self.rows),
            'selected_rule': primary['selected_rule'],
            'chronological_frozen_rule': primary['chronological_frozen_rule'],
            'minimum_drawdown_rule': primary['minimum_drawdown_rule'],
            'return_floor_pct': max(0., cases['annual_40_30']['summary']['twr_annualized_pct']),
            'complete_grid_count': None, 'pruned_count': None, 'eligible_count': None,
            'different_full_trading_path_count': None, 'score_ties': None,
            'full_ranking_top20': [], 'full_pareto': [], 'dominators_of40_30': [],
            'cases': cases, 'diagnostics': self.fixed_diagnostics(rules),
            'sensitivities': sensitivities, 'matched_actual_cashflow_hold': matched}
        output = self.write('', payload)
        print(json.dumps({'output': str(output), 'C_class_not_separately_optimized': True}, ensure_ascii=False), flush=True)
        return payload


def run(fund, config_path, primary_path=None, resume_after_error=False):
    config = json.loads(Path(config_path).read_text(encoding='utf-8-sig'))
    if not config.get('fees_verified') or not config.get('subscription_open_date'):
        raise ValueError('Fee tiers and ordinary subscription opening must be confirmed before experiment')
    study = Study(fund, config)
    return study.run_fixed_reference(primary_path) if primary_path else study.run_primary(resume_after_error)
