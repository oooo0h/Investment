"""Causal initial-position NAV backtest using hypothetical normalized budgets.

One annual budget is the unit of account. No account amounts are accepted,
stored or printed. Existing holdings enter at the first NAV without a new
subscription charge. Observation lags approximate the publication, confirmation
and sellability calendars; redemption cash uses a Monday-Friday proxy. These
are research assumptions, not promised service times.

Rule = (rise threshold, fall threshold, fraction sold, fraction bought). New
signals use only NAVs at least ``signal_lag`` observations old. An execution
price cannot become a signal anchor before that price has itself become known.
All NAV-dependent decisions precede use of the current execution NAV. Dividends
form an unpaid receivable on ex-date and usable cash only on payment date.
"""
from __future__ import annotations

import calendar
import datetime as dt
import hashlib
import math

YEAR = 365.2425
EPS = 1e-12


def following_weekday(day, count):
    for _ in range(count):
        day += dt.timedelta(days=1)
        while day.weekday() >= 5:
            day += dt.timedelta(days=1)
    return day


def prepare(rows, dividends=(), weekdays_only=True):
    """Prepare public rows {date, nav} and dividends {exdate,paydate,per_unit}.

    Compatible with annual_threshold_backtest.prepare. The first annual budget
    is prorated by remaining calendar months, independently of the sample end.
    Weekend observations can be removed before any lag is counted. Cash
    dividends adjust the signal-price chain, never the transaction NAV.
    """
    cleaned = []
    for row in rows:
        day = dt.date.fromisoformat(row['date'])
        nav = float(row['nav'])
        if not math.isfinite(nav) or nav <= 0:
            raise ValueError('NAV must be positive and finite')
        if not weekdays_only or day.weekday() < 5:
            cleaned.append({'date': day.isoformat(), 'nav': nav})
    if not cleaned or cleaned != sorted(cleaned, key=lambda row: row['date']):
        raise ValueError('Rows must be nonempty and chronological')
    if len(cleaned) != len({row['date'] for row in cleaned}):
        raise ValueError('Duplicate NAV dates')
    dates = [dt.date.fromisoformat(row['date']) for row in cleaned]
    divmap = {}
    for dividend in dividends:
        item = dict(dividend)
        ex = dt.date.fromisoformat(item['exdate'])
        pay = dt.date.fromisoformat(item['paydate'])
        per_unit = float(item['per_unit'])
        if pay < ex or per_unit < 0 or not math.isfinite(per_unit):
            raise ValueError('Invalid dividend dates or per-unit distribution')
        item['per_unit'] = per_unit
        if item['exdate'] in divmap:
            raise ValueError('Duplicate ex-date')
        divmap[item['exdate']] = item
    observation_dates = {row['date'] for row in cleaned}
    for exdate in divmap:
        if dates[0].isoformat() < exdate <= dates[-1].isoformat() and exdate not in observation_dates:
            raise ValueError('Ex-date inside the sample has no NAV observation')
    annual, monthly, daily = [], [], []
    seenyears, seenmonths = set(), set()
    cursor = dates[0].replace(day=1)
    for day in dates:
        accrued = 0.
        while cursor <= day:
            accrued += 1. / (12. * calendar.monthrange(cursor.year, cursor.month)[1])
            cursor += dt.timedelta(days=1)
        daily.append(accrued)
        key = (day.year, day.month)
        monthly.append(1. / 12. if key not in seenmonths else 0.)
        annual.append(((13. - dates[0].month) / 12. if day.year == dates[0].year else 1.)
                      if day.year not in seenyears else 0.)
        seenyears.add(day.year)
        seenmonths.add(key)
    signals = [cleaned[0]['nav']]
    for i in range(1, len(cleaned)):
        distribution = divmap.get(cleaned[i]['date'], {}).get('per_unit', 0.)
        signals.append(signals[-1] * (cleaned[i]['nav'] + distribution) / cleaned[i-1]['nav'])
    return {'rows': cleaned, 'dates': dates, 'annual': annual, 'monthly': monthly,
            'daily': daily, 'budget_total': sum(annual), 'dividends': divmap,
            'signal_prices': signals, 'years': (dates[-1]-dates[0]).days / YEAR,
            'weekdays_only': weekdays_only}


def xirr(flows):
    """Conventional investment-only flows followed by a terminal valuation."""
    origin = flows[0][0]
    timed = [((day-origin).days / YEAR, value) for day, value in flows]
    if not any(year > 0 and value > 0 for year, value in timed):
        return None
    def npv(rate):
        logbase = math.log1p(rate)
        return sum(value * math.exp(-years * logbase) for years, value in timed)
    low, high = -.999999, 1.
    if npv(low) <= 0:
        return None
    for _ in range(100):
        if npv(high) <= 0:
            break
        high = 2. * high + 1.
    else:
        return None
    for _ in range(85):
        mid = (low+high) / 2.
        if npv(mid) > 0:
            low = mid
        else:
            high = mid
    return (low+high) * 50.


def simulate(data, rule=None, schedule='annual', initial_ratio=6., initial_age_days=365,
             initial_only=False, forced_extras=None, signal_lag=3, confirm_lag=2,
             sellability_lag=3, redemption_settlement_workdays=2,
             daily_buy_cap_norm=.5, buy_fee=.0016,
             redemption_tiers=((7,.015),(365,.005),(730,.003)),
             detail=False, compute_xirr=False, max_extra_ratio=None):
    """Return a summary, or {summary,daily,trades,cashflows} with detail=True.

    ``initial_only`` disables all annual funding, leaving the already owned
    position untouched when rule=None. ``forced_extras`` maps ISO dates to
    normalized deposits and buys them subject to the same cap, for a baseline
    matched to another strategy's actual additional deposits. Extra funding for
    a tactical buy is created only for that day's filled cash shortfall.

    Each planned buy preempts and cancels a tactical remainder. A tactical buy
    retains its original normalized budget across partial fills. Holding age is
    redemption confirmation date minus subscription confirmation date, counting
    the former exclusively. Sellability is a separate index restriction.
    Unconfirmed units remain exposed to NAV changes. A confirmation beyond the
    sample end uses a weekday proxy because future NAV observations are absent.
    """
    if 'signal_prices' not in data:
        data = prepare(data['rows'], list(data.get('dividends', {}).values()))
    if schedule not in ('annual', 'monthly', 'daily'):
        raise ValueError('Unknown schedule')
    for value in (signal_lag, confirm_lag, sellability_lag, redemption_settlement_workdays):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError('Lags must be nonnegative integers')
    initial_ratio = float(initial_ratio)
    cap = math.inf if daily_buy_cap_norm is None else float(daily_buy_cap_norm)
    if initial_ratio <= 0 or not math.isfinite(initial_ratio) or cap <= 0 or buy_fee < 0:
        raise ValueError('Invalid initial ratio, subscription cap or fee')
    if not isinstance(initial_age_days, int) or initial_age_days < 0:
        raise ValueError('Initial age must be nonnegative natural days')
    if rule is not None:
        if len(rule) != 4 or not all(math.isfinite(x) for x in rule):
            raise ValueError('Rule must contain four finite values')
        up, down, sell_fraction, buy_fraction = rule
        if up <= 0 or down <= 0 or not 0 <= sell_fraction <= 1 or buy_fraction < 0:
            raise ValueError('Invalid thresholds or allocation fractions')
    forced_extras = forced_extras or {}
    if any(value < 0 or not math.isfinite(value) for value in forced_extras.values()):
        raise ValueError('Forced extra deposits must be finite and nonnegative')
    rows, dates = data['rows'], data['dates']
    signal_prices = data['signal_prices']
    count = len(rows)
    units = initial_ratio / rows[0]['nav']
    # [units, confirmation natural-day ordinal, first sellable index]
    lots = [[units, dates[0].toordinal()-initial_age_days, 0]]
    cash = dividend_receivable = redemption_receivable = 0.
    regular_total = extra_total = fees = dividends_total = 0.
    payments = []
    pending = None
    scheduled_backlog = 0.
    anchor_index, anchor_value = 0, initial_ratio
    twr = peak = 1.
    mdd = peak_extra_ratio = sum_weight = 0.
    previous_equity = initial_ratio
    scheduled_count = active_buy = active_sell = cancelled = 0
    buy_signals = sell_signals = completed_buy_orders = partial_buy_fills = 0
    cancelled_budget = 0.
    daily, events, flow_details, flows = [], [], [], []
    need_flows = compute_xirr or detail
    signature = hashlib.sha256()
    if need_flows:
        flows.append((dates[0], -initial_ratio))
    if detail:
        flow_details.append({'date': rows[0]['date'], 'value': -initial_ratio,
                             'value_norm': -initial_ratio, 'amount_norm': initial_ratio,
                             'kind': 'initial'})

    for i, (row, day) in enumerate(zip(rows, dates)):
        price, daystr = row['nav'], row['date']
        dividend = data['dividends'].get(daystr)
        # Entitlement attaches before ex-date purchases/redemptions. There is
        # no extra capital injection when an economic dividend is recognized.
        if dividend and i > 0:
            entitlement = units * dividend['per_unit']
            dividend_receivable += entitlement
            dividends_total += entitlement
            payments.append((dividend['paydate'], entitlement, 'dividend'))
        if payments:
            remaining = []
            for payday, value, kind in payments:
                if payday <= daystr:
                    cash += value
                    if kind == 'dividend':
                        dividend_receivable -= value
                    else:
                        redemption_receivable -= value
                else:
                    remaining.append((payday, value, kind))
            payments = remaining
        preflow = units * price + cash + dividend_receivable + redemption_receivable
        before = preflow / previous_equity
        regular = 0. if initial_only else data['annual'][i]
        scheduled = 0. if initial_only else data[schedule][i]
        forced = float(forced_extras.get(daystr, 0.))
        extra_today = forced
        cash += regular + forced
        regular_total += regular
        today_fee = buy_today = sell_today = 0.
        fill_kind = signal_date = None
        known_index = i-signal_lag

        if regular > EPS or scheduled > EPS or forced > EPS:
            if pending is not None:
                cancelled += 1
                if pending['side'] == 'buy':
                    cancelled_budget += pending['remaining_budget_norm']
                pending = None
            scheduled_backlog += scheduled + forced

        # This branch owns the entire date, even after the final partial fill.
        if scheduled_backlog > EPS:
            buy_today = min(scheduled_backlog, cap)
            scheduled_backlog = max(0., scheduled_backlog-buy_today)
            fill_kind = 'scheduled_buy'
        else:
            # Current execution NAV is never used to generate a decision.
            if (rule is not None and pending is None and known_index >= anchor_index):
                relative = signal_prices[known_index] / signal_prices[anchor_index] - 1.
                if sell_fraction > 0 and relative >= up-EPS:
                    requested = units * sell_fraction
                    if requested > EPS:
                        pending = {'side': 'sell', 'signal_date': daystr,
                                   'known_nav_date': rows[known_index]['date'],
                                   'original_units_norm': requested,
                                   'remaining_units_norm': requested}
                        sell_signals += 1
                elif buy_fraction > 0 and relative <= -down+EPS:
                    budget = anchor_value * buy_fraction
                    if budget > EPS:
                        pending = {'side': 'buy', 'signal_date': daystr,
                                   'known_nav_date': rows[known_index]['date'],
                                   'original_budget_norm': budget,
                                   'remaining_budget_norm': budget}
                        buy_signals += 1
            if pending is not None:
                signal_date = pending['signal_date']
                if pending['side'] == 'buy':
                    buy_today = min(pending['remaining_budget_norm'], cap)
                    pending['remaining_budget_norm'] = max(0., pending['remaining_budget_norm']-buy_today)
                    fill_kind = 'buy'
                else:
                    left = pending['remaining_units_norm']
                    fee_components = []
                    sold = 0.
                    sell_confirmation_index = i+confirm_lag
                    sell_confirmation_day = (dates[sell_confirmation_index]
                                             if sell_confirmation_index < count
                                             else following_weekday(day, confirm_lag))
                    while left > EPS and lots and lots[0][2] <= i:
                        available, confirmation_ordinal, _ = lots[0]
                        # A confirmation must exist before sale is allowed.
                        if confirmation_ordinal is None or confirmation_ordinal > day.toordinal():
                            break
                        used = min(left, available)
                        age = sell_confirmation_day.toordinal()-confirmation_ordinal
                        rate = next((rate for threshold, rate in redemption_tiers if age < threshold), 0.)
                        component_fee = used * price * rate
                        today_fee += component_fee
                        if detail:
                            fee_components.append({'holding_age_days': age, 'fee_rate': rate,
                                                   'subscription_confirmation_date': dt.date.fromordinal(confirmation_ordinal).isoformat(),
                                                   'redemption_confirmation_date': sell_confirmation_day.isoformat(),
                                                   'gross_norm': used*price, 'fee_norm': component_fee})
                        sold += used
                        left -= used
                        lots[0][0] -= used
                        if lots[0][0] < EPS:
                            lots.pop(0)
                    if sold > EPS:
                        units -= sold
                        sell_today = sold * price
                        proceeds = sell_today-today_fee
                        payday = following_weekday(day, redemption_settlement_workdays).isoformat()
                        if redemption_settlement_workdays:
                            redemption_receivable += proceeds
                            payments.append((payday, proceeds, 'redemption'))
                        else:
                            cash += proceeds
                        active_sell += 1
                        anchor_index, anchor_value = i, units*price
                        pending['remaining_units_norm'] = max(0., left)
                        signature.update(f'{daystr}:sell:{sell_today:.10f}:{anchor_value:.10f}|'.encode())
                        if detail:
                            events.append({'date': daystr, 'kind': 'sell', 'signal_date': signal_date,
                                           'known_nav_date': pending['known_nav_date'],
                                           'budget_norm': sell_today, 'fee_norm': today_fee,
                                           'extra_norm': 0., 'settlement_date': payday,
                                           'confirmation_date': sell_confirmation_day.isoformat(),
                                           'confirmation_uses_end_sample_weekday_proxy': sell_confirmation_index >= count,
                                           'fee_components': fee_components,
                                           'remaining_units_norm': max(0., left),
                                           'new_anchor_value_norm': anchor_value})
                        if left <= EPS:
                            pending = None

        if buy_today > EPS:
            needed = max(0., buy_today-cash)
            cash += needed
            extra_today += needed
            net = buy_today / (1.+buy_fee)
            acquired = net / price
            units += acquired
            cash -= buy_today
            confirm_index = i+confirm_lag
            confirmation_ordinal = dates[confirm_index].toordinal() if confirm_index < count else None
            lots.append([acquired, confirmation_ordinal, max(i+sellability_lag, confirm_index)])
            today_fee += buy_today-net
            if fill_kind == 'scheduled_buy':
                scheduled_count += 1
            else:
                active_buy += 1
                if pending['remaining_budget_norm'] <= EPS:
                    completed_buy_orders += 1
                else:
                    partial_buy_fills += 1
            anchor_index, anchor_value = i, units*price
            signature.update(f'{daystr}:{fill_kind}:{buy_today:.10f}:{anchor_value:.10f}|'.encode())
            if detail:
                event = {'date': daystr, 'kind': fill_kind, 'budget_norm': buy_today,
                         'fee_norm': today_fee, 'extra_norm': needed,
                         'confirmation_date': (dates[confirm_index].isoformat() if confirm_index < count else None),
                         'sellable_date': (dates[max(i+sellability_lag, confirm_index)].isoformat()
                                           if max(i+sellability_lag, confirm_index) < count else None),
                         'remaining_budget_norm': (scheduled_backlog if fill_kind == 'scheduled_buy'
                                                   else pending['remaining_budget_norm']),
                         'new_anchor_value_norm': anchor_value}
                if fill_kind == 'buy':
                    event.update(signal_date=signal_date, known_nav_date=pending['known_nav_date'],
                                 original_budget_norm=pending['original_budget_norm'])
                events.append(event)
            if fill_kind == 'buy' and pending['remaining_budget_norm'] <= EPS:
                pending = None

        extra_total += extra_today
        ratio = extra_total/regular_total if regular_total > EPS else (math.inf if extra_total > EPS else 0.)
        peak_extra_ratio = max(peak_extra_ratio, ratio)
        if max_extra_ratio is not None and ratio > max_extra_ratio+EPS:
            return {'pruned': True, 'rule': rule, 'violation_date': daystr,
                    'peak_extra_to_regular_ratio': ratio, 'external_lower_bound_norm': extra_total}
        equity = units*price + cash + dividend_receivable + redemption_receivable
        totalflow = regular+extra_today
        # All flow-dependent orders occur at this same endpoint NAV. Fees are
        # charged only after that order's deposit, giving exact segmented TWR.
        expected = preflow+totalflow-today_fee
        tolerance = 1e-9*max(1., equity)
        if abs(equity-expected) > tolerance:
            raise AssertionError('Equity conservation failed')
        if min(cash, dividend_receivable, redemption_receivable) < -tolerance:
            raise AssertionError('Unsettled assets were spent')
        if buy_today > cap+EPS:
            raise AssertionError('Daily gross subscription cap exceeded')
        cash = max(0., cash)
        dividend_receivable = max(0., dividend_receivable)
        redemption_receivable = max(0., redemption_receivable)
        twr *= before * equity/(preflow+totalflow)
        peak = max(peak, twr)
        mdd = max(mdd, 1.-twr/peak)
        weight = units*price/equity
        sum_weight += weight
        fees += today_fee
        if need_flows:
            if regular:
                flows.append((day, -regular))
            if extra_today:
                flows.append((day, -extra_today))
        if detail:
            for kind, value in (('regular', regular), ('extra', extra_today)):
                if value:
                    flow_details.append({'date': daystr, 'value': -value,
                                         'value_norm': -value, 'amount_norm': value, 'kind': kind})
            sellable_units = sum(lot[0] for lot in lots if lot[2] <= i)
            daily.append({'date': daystr, 'nav': price, 'total_norm': equity,
                          'fund_value_norm': units*price, 'cash_norm': cash,
                          'dividend_receivable_norm': dividend_receivable,
                          'redemption_receivable_norm': redemption_receivable,
                          'receivable_norm': dividend_receivable+redemption_receivable,
                          'regular_today_norm': regular, 'extra_today_norm': extra_today,
                          'twr_index': twr, 'drawdown_pct': (twr/peak-1.)*100.,
                          'fund_weight_pct': weight*100., 'gross_buy_today_norm': buy_today,
                          'gross_sell_today_norm': sell_today,
                          'sellable_fund_value_norm': sellable_units*price,
                          'scheduled_buy_backlog_norm': scheduled_backlog,
                          'pending_tactical_budget_norm': (pending['remaining_budget_norm']
                                                           if pending and pending['side']=='buy' else 0.),
                          'anchor_trade_date': rows[anchor_index]['date'],
                          'latest_known_nav_date': rows[known_index]['date'] if known_index >= 0 else None})
        previous_equity = equity

    years = data['years']
    annualized = math.expm1(math.log(twr)/years)*100. if years > 0 else None
    extra_pct = extra_total/regular_total*100. if regular_total > EPS else (None if extra_total > EPS else 0.)
    summary = {'rule': list(rule) if rule is not None else None, 'schedule': schedule,
               'initial_only': initial_only, 'initial_position_norm': initial_ratio,
               'initial_age_days': initial_age_days, 'twr_annualized_pct': annualized,
               'twr_total_pct': (twr-1.)*100., 'mdd_pct': mdd*100., 'max_drawdown_pct': mdd*100.,
               'calmar': annualized/(mdd*100.) if mdd > EPS and annualized is not None else None,
               'regular_total_norm': regular_total, 'extra_total_norm': extra_total,
               'regular_contributed_norm': regular_total, 'extra_contributed_norm': extra_total,
               'extra_to_regular_pct': extra_pct, 'extra_over_regular_pct': extra_pct,
               'peak_extra_to_regular_pct': peak_extra_ratio*100. if math.isfinite(peak_extra_ratio) else None,
               'ending_equity_norm': equity, 'end_total_norm': equity,
               'ending_fund_weight_pct': weight*100., 'end_fund_weight_pct': weight*100.,
               'average_fund_weight_pct': sum_weight/count*100.,
               'buy_count': scheduled_count+active_buy, 'sell_count': active_sell,
               'scheduled_buy_count': scheduled_count, 'tactical_buy_count': active_buy,
               'tactical_sell_count': active_sell, 'tactical_buy_signal_count': buy_signals,
               'tactical_sell_signal_count': sell_signals,
               'completed_tactical_buy_order_count': completed_buy_orders,
               'partial_tactical_buy_fill_count': partial_buy_fills,
               'cancelled_pending': cancelled, 'cancelled_tactical_buy_budget_norm': cancelled_budget,
               'transaction_fees_norm': fees, 'dividends_norm': dividends_total,
               'pending_scheduled_budget_norm': scheduled_backlog, 'pending_tactical_order': pending,
               'signal_lag': signal_lag, 'confirm_lag': confirm_lag, 'sellability_lag': sellability_lag,
               'redemption_settlement_workdays': redemption_settlement_workdays,
               'daily_buy_cap_norm': None if math.isinf(cap) else cap,
               'path_signature': signature.hexdigest(), 'xirr_pct': None}
    if need_flows:
        flows.append((dates[-1], equity))
        summary['xirr_pct'] = xirr(flows)
    if detail:
        flow_details.append({'date': rows[-1]['date'], 'value': equity,
                             'value_norm': equity, 'amount_norm': equity, 'kind': 'terminal'})
        return {'summary': summary, 'daily': daily, 'trades': events, 'cashflows': flow_details}
    return summary
