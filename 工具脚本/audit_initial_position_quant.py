"""Independent Decimal reconstruction of an initial-position research artifact.

Reads only public NAV/dividend inputs and normalized backtest details. Writes
privacy-safe checks, percentages and relative numerical errors; no currency
amounts, account data, share balances or per-trade values are emitted.
"""
from __future__ import annotations

import sys
sys.dont_write_bytecode = True

import argparse
import datetime as dt
import hashlib
import json
from collections import defaultdict
from decimal import Decimal, getcontext
from pathlib import Path

getcontext().prec = 50
D = lambda value: Decimal(str(value))
ZERO, ONE, HUNDRED = D(0), D(1), D(100)
TOL = D('0.00000002')
ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def day(value):
    return dt.date.fromisoformat(str(value))


def weekday_after(value, count):
    value = day(value) if isinstance(value, str) else value
    for _ in range(count):
        value += dt.timedelta(days=1)
        while value.weekday() > 4:
            value += dt.timedelta(days=1)
    return value


class Checks:
    def __init__(self):
        self.count = 0
        self.failures = []
        self.max_errors = defaultdict(lambda: ZERO)

    def check(self, condition, label, date=None):
        self.count += 1
        if not condition and len(self.failures) < 30:
            self.failures.append({'check': label, **({'date': date} if date else {})})

    def close(self, actual, expected, label, date=None):
        error = abs(D(actual)-D(expected)) / max(ONE, abs(D(expected)))
        self.max_errors[label] = max(error, self.max_errors[label])
        self.check(error <= TOL, label, date)

    def result(self):
        return {'passed': not self.failures, 'checks': self.count,
                'failures': self.failures,
                'maximum_relative_errors': {k: float(v) for k, v in sorted(self.max_errors.items())}}


def audit_case(result, protocol, dividends, public_nav, forced_funding=False):
    checks = Checks()
    rows, summary = result['daily'], result['summary']
    dates = [day(row['date']) for row in rows]
    indexes = {row['date']: i for i, row in enumerate(rows)}
    prices = [D(public_nav[row['date']]) for row in rows]
    start, end = protocol['main_window']
    expected_dates = sorted(value for value in public_nav if start <= value <= end and day(value).weekday() < 5)
    checks.check([row['date'] for row in rows] == expected_dates, 'complete_declared_nav_window')
    initial = D(summary['initial_position_norm'])
    buy_fee = D(protocol['subscription_fee'])
    tiers = [(int(limit), D(rate)) for limit, rate in protocol['redemption_tiers']]
    confirm_lag = int(summary.get('confirm_lag', protocol['confirmation_lag_NAV_observations']))
    sellability_lag = int(summary.get('sellability_lag', protocol['sellability_lag_NAV_observations']))
    signal_lag = int(summary.get('signal_lag', protocol['signal_lag_NAV_observations']))
    redemption_confirm_lag = int(summary.get('redemption_confirm_lag', protocol.get('redemption_confirmation_lag_NAV_observations', confirm_lag)))
    settlement_days = int(summary['redemption_settlement_workdays'])
    cap = summary.get('daily_buy_cap_norm', protocol['daily_gross_subscription_cap_to_annual_budget'])
    cap = None if cap is None else D(cap)
    rule = summary['rule']
    divmap = {row['exdate']: row for row in dividends}
    signal_prices = [prices[0]]
    for i in range(1, len(rows)):
        distribution = D(divmap.get(rows[i]['date'], {}).get('per_unit', 0))
        signal_prices.append(signal_prices[-1]*(prices[i]+distribution)/prices[i-1])

    units = initial/prices[0]
    # Each lot is independently reconstructed from gross budget, fee and NAV.
    lots = [[units, dates[0]-dt.timedelta(days=int(summary['initial_age_days'])), dates[0]]]
    cash = div_receivable = red_receivable = ZERO
    payments = []
    events_by_day = defaultdict(list)
    for event in result['trades']:
        events_by_day[event['date']].append(event)
    flows_by_day = defaultdict(lambda: defaultdict(lambda: ZERO))
    for flow in result['cashflows']:
        if flow['kind'] in ('regular', 'extra'):
            flows_by_day[flow['date']][flow['kind']] += abs(D(flow.get('amount_norm', flow['value_norm'])))
    twr = peak = ONE
    mdd = total_fees = regular_total = extra_total = div_total = ZERO
    previous_equity = initial
    anchor_index, anchor_value = 0, initial
    seen_signals = set()
    seen_years = set()

    for i, row in enumerate(rows):
        date, current_day, price = row['date'], dates[i], prices[i]
        checks.close(row['nav'], price, 'public_nav', date)
        if i and date in divmap:
            entitlement = units*D(divmap[date]['per_unit'])
            div_receivable += entitlement
            div_total += entitlement
            payments.append((day(divmap[date]['paydate']), entitlement, 'dividend'))
        outstanding = []
        for payday, value, kind in payments:
            if payday <= current_day:
                cash += value
                if kind == 'dividend':
                    div_receivable -= value
                else:
                    red_receivable -= value
            else:
                outstanding.append((payday, value, kind))
        payments = outstanding
        preflow = units*price+cash+div_receivable+red_receivable
        before = preflow/previous_equity
        regular, extra = D(row['regular_today_norm']), D(row['extra_today_norm'])
        expected_regular = ZERO
        if not summary['initial_only'] and current_day.year not in seen_years:
            expected_regular = D(13-dates[0].month)/D(12) if current_day.year == dates[0].year else ONE
        seen_years.add(current_day.year)
        checks.close(regular, expected_regular, 'annual_deposit_schedule', date)
        checks.close(regular, flows_by_day[date]['regular'], 'regular_flow_ledger', date)
        checks.close(extra, flows_by_day[date]['extra'], 'extra_flow_ledger', date)
        regular_total += regular
        extra_total += extra
        available_without_extra = cash+regular
        cash += regular+extra
        today_fee = gross_buy = gross_sell = ZERO
        checks.check(len(events_by_day[date]) <= 1, 'single_execution_branch', date)
        for event in events_by_day[date]:
            kind, budget = event['kind'], D(event['budget_norm'])
            if kind in ('buy', 'sell'):
                signal_date, known_date = event['signal_date'], event['known_nav_date']
                signal_index, known_index = indexes[signal_date], indexes[known_date]
                checks.check(known_index+signal_lag <= signal_index <= i, 'causal_signal_information', date)
                key = (kind, signal_date, known_date)
                if key not in seen_signals:
                    checks.check(known_index >= anchor_index, 'known_execution_anchor', date)
                    relative = signal_prices[known_index]/signal_prices[anchor_index]-ONE
                    checks.check(relative >= D(rule[0])-TOL if kind == 'sell' else relative <= -D(rule[1])+TOL,
                                 'threshold_trigger', date)
                    if kind == 'buy':
                        checks.close(event['original_budget_norm'], anchor_value*D(rule[3]), 'signal_purchase_budget', date)
                    seen_signals.add(key)
            if kind in ('buy', 'scheduled_buy'):
                fee = budget-budget/(ONE+buy_fee)
                acquired = (budget-fee)/price
                confirm_index = i+confirm_lag
                confirm_date = dates[confirm_index] if confirm_index < len(rows) else None
                sell_index = max(i+sellability_lag, confirm_index)
                sellable_date = dates[sell_index] if sell_index < len(rows) else None
                checks.check(event.get('confirmation_date') == (confirm_date.isoformat() if confirm_date else None),
                             'purchase_confirmation_date', date)
                checks.check(event.get('sellable_date') == (sellable_date.isoformat() if sellable_date else None),
                             'purchase_sellable_date', date)
                cash -= budget
                units += acquired
                lots.append([acquired, confirm_date, sellable_date])
                gross_buy += budget
            else:
                checks.check(kind == 'sell', 'recognized_trade_type', date)
                target = budget/price
                fee = ZERO
                left = target
                confirmation_index = i+redemption_confirm_lag
                expected_confirmation = dates[confirmation_index] if confirmation_index < len(rows) else weekday_after(current_day, redemption_confirm_lag)
                reported_confirmation = event.get('redemption_confirmation_date', event.get('holding_end_date'))
                if reported_confirmation:
                    checks.check(day(reported_confirmation) == expected_confirmation, 'redemption_confirmation_date', date)
                fee_date = expected_confirmation
                components = []
                while left > D('1e-25') and lots:
                    available, confirmation, sellable = lots[0]
                    checks.check(confirmation is not None and sellable is not None and sellable <= current_day,
                                 'confirmed_sellable_FIFO_lot', date)
                    if confirmation is None:
                        break
                    used = min(left, available)
                    age = (fee_date-confirmation).days
                    rate = next((rate for limit, rate in tiers if age < limit), ZERO)
                    component = used*price*rate
                    fee += component
                    components.append((age, rate, component))
                    lots[0][0] -= used
                    left -= used
                    if lots[0][0] <= D('1e-25'):
                        lots.pop(0)
                checks.check(left < D('1e-8'), 'FIFO_inventory_sufficient', date)
                for actual, expected in zip(event.get('fee_components', []), components):
                    checks.check(int(actual['holding_age_days']) == expected[0], 'FIFO_holding_natural_days', date)
                    checks.close(actual['fee_rate'], expected[1], 'FIFO_fee_tier', date)
                    checks.close(actual['fee_norm'], expected[2], 'FIFO_component_fee', date)
                checks.check(len(event.get('fee_components', [])) == len(components), 'FIFO_component_count', date)
                units -= target
                gross_sell += budget
                proceeds = budget-fee
                payday = weekday_after(current_day, settlement_days)
                checks.check(event['settlement_date'] == payday.isoformat(), 'redemption_settlement_date', date)
                if settlement_days:
                    red_receivable += proceeds
                    payments.append((payday, proceeds, 'redemption'))
                else:
                    cash += proceeds
            checks.close(event['fee_norm'], fee, 'trade_fee', date)
            today_fee += fee
            anchor_index, anchor_value = i, units*price
            checks.close(event['new_anchor_value_norm'], anchor_value, 'execution_anchor_value', date)
        if cap is not None:
            checks.check(gross_buy <= cap+TOL, 'combined_daily_subscription_cap', date)
        if not forced_funding:
            checks.close(extra, max(ZERO, gross_buy-available_without_extra), 'extra_only_for_execution_cash_shortage', date)
        checks.check(min(cash, div_receivable, red_receivable) >= -TOL, 'cash_and_receivables_nonnegative', date)
        equity = units*price+cash+div_receivable+red_receivable
        checks.close(equity, preflow+regular+extra-today_fee, 'daily_equity_conservation', date)
        twr *= before*equity/(preflow+regular+extra)
        peak = max(peak, twr)
        mdd = max(mdd, ONE-twr/peak)
        total_fees += today_fee
        for field, expected in [('total_norm', equity), ('fund_value_norm', units*price), ('cash_norm', cash),
                                ('dividend_receivable_norm', div_receivable), ('redemption_receivable_norm', red_receivable),
                                ('twr_index', twr), ('drawdown_pct', (twr/peak-ONE)*HUNDRED),
                                ('gross_buy_today_norm', gross_buy), ('gross_sell_today_norm', gross_sell)]:
            checks.close(row[field], expected, 'daily_'+field, date)
        expected_known = rows[i-signal_lag]['date'] if i >= signal_lag else None
        checks.check(row['latest_known_nav_date'] == expected_known, 'daily_information_cutoff', date)
        checks.check(row['anchor_trade_date'] == rows[anchor_index]['date'], 'daily_anchor_date', date)
        previous_equity = equity
    years = D((dates[-1]-dates[0]).days)/D('365.2425')
    cagr = (twr**(ONE/years)-ONE)*HUNDRED
    for field, expected in [('twr_annualized_pct', cagr), ('twr_total_pct', (twr-ONE)*HUNDRED),
                            ('mdd_pct', mdd*HUNDRED), ('transaction_fees_norm', total_fees),
                            ('regular_total_norm', regular_total), ('extra_total_norm', extra_total),
                            ('dividends_norm', div_total), ('ending_equity_norm', equity)]:
        checks.close(summary[field], expected, 'summary_'+field)
    if mdd:
        checks.close(summary['calmar'], cagr/(mdd*HUNDRED), 'summary_calmar')
    answer = checks.result()
    answer.update({'observation_count': len(rows), 'trade_count': len(result['trades']),
                   'decimal_reconstructed_metrics': {'twr_annualized_pct': float(cagr),
                                                     'max_drawdown_pct': float(mdd*HUNDRED),
                                                     'calmar': float(cagr/(mdd*HUNDRED)) if mdd else None}})
    return answer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('result_path', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    artifact = read(args.result_path)
    protocol = artifact['protocol']
    source_path = ROOT/protocol['source_path']
    source = read(source_path)
    provenance = Checks()
    provenance.check(hashlib.sha256(source_path.read_bytes()).hexdigest() == protocol['source_sha256'], 'public_nav_source_fingerprint')
    engine_path = ROOT/'公共资料'/'工具'/'initial_position_quant_engine.py'
    provenance.check(hashlib.sha256(engine_path.read_bytes()).hexdigest() == protocol['engine_sha256'], 'declared_engine_fingerprint')
    public_nav = {row['date']: row['nav'] for row in source['rows']}
    dividends = read(args.result_path.parent/'270023_官方现金分红事件_核验2026-10-18.json')
    audited = {}
    for section in ('cases', 'matched_hold'):
        for name, result in artifact.get(section, {}).items():
            audited[section+'/'+name] = audit_case(result, protocol, dividends, public_nav, forced_funding=section == 'matched_hold')
    matching = Checks()
    for name, matched in artifact.get('matched_hold', {}).items():
        actual = {row['date']: row['extra_today_norm'] for row in artifact['cases'][name]['daily']}
        baseline = {row['date']: row['extra_today_norm'] for row in matched['daily']}
        matching.check(actual.keys() == baseline.keys(), 'matched_observation_dates')
        for date in actual.keys() & baseline.keys():
            matching.close(actual[date], baseline[date], 'identical_daily_extra_deposits', date)
    output = {'audit': 'Independent 50-digit Decimal ledger reconstruction',
              'privacy': 'Only public prices, normalized simulation inputs and aggregate numerical checks read; no account amounts emitted.',
              'passed': all(result['passed'] for result in audited.values()) and matching.result()['passed'] and provenance.result()['passed'],
              'case_results': audited, 'matched_funding_checks': matching.result(), 'input_fingerprint_checks': provenance.result(),
              'scope': ['Public NAV matching; dividend entitlements and payment dates; FIFO share inventory and fee tiers.',
                        'Purchase confirmation and sale eligibility; redemption confirmation and cash settlement.',
                        'Daily balances, equity conservation, TWR, drawdown, terminal CAGR and Calmar.',
                        'Signal information cutoff, thresholds, purchase budget, execution anchors and daily subscription cap.',
                        'Same-date supplemental inflows in matched buy-and-hold benchmark.'],
              'limitations': ['Does not validate actual historical holidays, suspension, announcement timestamps or channel service promises.',
                              'Does not independently recompute XIRR or the complete parameter-grid search.',
                              'Uses declared observation-calendar confirmation assumptions and weekday settlement proxy.']}
    target = args.output or args.result_path.with_name(args.result_path.stem+'_核验.json')
    target.write_text(json.dumps(output, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    print(json.dumps({'passed': output['passed'], 'audited_cases': len(audited),
                      'failed_cases': [name for name, result in audited.items() if not result['passed']],
                      'output': str(target)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
