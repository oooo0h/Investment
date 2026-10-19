"""Daily gross subscription-cap accounting in hypothetical normalized units.

No-cap calls delegate unchanged to the immutable earlier engines. With a daily
cap, planned and tactical buy budgets are queued and filled at most once per NAV
observation. Unfilled tactical budgets keep the original signal budget; every
actual fill resets price/value anchors. New planned purchases take priority and
cancel any tactical remainder. Annual cash is credited up front; queued planned
money earns zero until invested. Only actual fill cash shortfalls create extra
external funding. The daily subscription cap is NOT an outside-funding cap.

Optional settlement delay counts Monday-Friday, without a holiday calendar.
No real account, holding, transaction, or monetary amount is read.
"""
from __future__ import annotations

import hashlib
import math

from annual_threshold_backtest import YEAR, prepare, xirr, simulate as _original_simulate
from annual_threshold_settlement import following_weekday, simulate_settlement


def simulate_capped(data, rule=None, schedule='annual', initial_only=False, lag=2,
                    buy_fee=.0015, redemption_tiers=((7,.015),(365,.005),(730,.003)),
                    detail=False, compute_xirr=False, max_extra_ratio=None,
                    forced_extras=None, daily_buy_cap_norm=None,
                    redemption_settlement_workdays=0):
    """Simulate a cap on gross subscriptions per observed NAV date.

    Research with unlimited outside funding passes max_extra_ratio=None. The
    optional legacy parameter is retained only for API compatibility/comparison.
    Cap=None and settlement=0 return the original result exactly, including
    dictionary fields, trade events, signatures, and cash-flow accounting.
    """
    if daily_buy_cap_norm is None:
        arguments = dict(schedule=schedule, initial_only=initial_only, lag=lag,
                         buy_fee=buy_fee, redemption_tiers=redemption_tiers,
                         detail=detail, compute_xirr=compute_xirr,
                         max_extra_ratio=max_extra_ratio, forced_extras=forced_extras)
        if redemption_settlement_workdays == 0:
            return _original_simulate(data, rule, **arguments)
        return simulate_settlement(data, rule, redemption_settlement_workdays=
                                   redemption_settlement_workdays, **arguments)
    cap = float(daily_buy_cap_norm)
    if not math.isfinite(cap) or cap <= 0.:
        raise ValueError('daily_buy_cap_norm must be finite and positive, or None')
    if (not isinstance(redemption_settlement_workdays, int)
            or isinstance(redemption_settlement_workdays, bool)
            or redemption_settlement_workdays < 0):
        raise ValueError('redemption_settlement_workdays must be a nonnegative integer')
    units = cash = receivable = regular_total = external_total = fees = 0.
    peak_extra_ratio = sum_weight = 0.
    previous_equity = None
    twr = peak = 1.
    mdd = 0.
    anchor_price = anchor_value = None
    lots, payments, flows, events, daily = [], [], [], [], []
    pending = None
    scheduled_backlog = 0.
    scheduled_backlog_since = None
    active_buy = active_sell = scheduled_count = cancelled = 0
    buy_orders = completed_buy_orders = partial_buy_fills = 0
    cancelled_tactical_budget = 0.
    dividend_total = 0.
    signature = hashlib.sha256()
    tolerance = 1e-12

    for index, (row, day) in enumerate(zip(data['rows'], data['dates'])):
        price, daystr = row['nav'], row['date']
        dividend = data['dividends'].get(daystr)
        if dividend:
            entitlement = units * dividend['per_unit']
            receivable += entitlement
            dividend_total += entitlement
            payments.append((dividend['paydate'], entitlement))
        remaining_payments = []
        for payday, entitlement in payments:
            if payday <= daystr:
                cash += entitlement
                receivable -= entitlement
            else:
                remaining_payments.append((payday, entitlement))
        payments = remaining_payments
        preflow = units * price + cash + receivable
        before = preflow / previous_equity if previous_equity is not None else 1.

        regular = ((1. if index == 0 else 0.) if initial_only else data['annual'][index])
        scheduled = regular if initial_only else data[schedule][index]
        extra_today = (forced_extras or {}).get(daystr, 0.)
        assert regular >= 0. and scheduled >= 0. and extra_today >= 0.
        scheduled += extra_today
        cash += regular + extra_today
        regular_total += regular
        today_fee = buy_today = 0.
        fill_kind = signal_date = None
        remaining_buy_budget = 0.

        if regular > 0. or scheduled > 0.:
            if pending is not None:
                cancelled += 1
                if pending['side'] == 'buy':
                    cancelled_tactical_budget += pending['remaining_budget_norm']
                pending = None
            if scheduled > 0.:
                if scheduled_backlog <= tolerance:
                    scheduled_backlog_since = daystr
                scheduled_backlog += scheduled

        # Any scheduled backlog owns this date. Even its final partial fill
        # does not allow a second tactical order or fresh signal on that date.
        if scheduled_backlog > tolerance:
            buy_today = min(scheduled_backlog, cap)
            scheduled_backlog -= buy_today
            if scheduled_backlog <= tolerance:
                scheduled_backlog = 0.
                scheduled_backlog_since = None
            remaining_buy_budget = scheduled_backlog
            fill_kind = 'scheduled_buy'
        elif rule is not None and anchor_price is not None:
            up, down, sell, buy = rule
            relative = price / anchor_price - 1.
            if pending is None and ((sell > 0. and relative >= up - tolerance)
                                    or (buy > 0. and relative <= -down + tolerance)):
                side = 'sell' if relative > 0. else 'buy'
                budget = anchor_value * buy if side == 'buy' else 0.
                pending = {'side': side, 'due_index': index + lag,
                           'signal_date': daystr, 'original_budget_norm': budget,
                           'remaining_budget_norm': budget}
                buy_orders += side == 'buy'
            if pending is not None and index >= pending['due_index']:
                signal_date = pending['signal_date']
                if pending['side'] == 'buy':
                    buy_today = min(pending['remaining_budget_norm'], cap)
                    pending['remaining_budget_norm'] -= buy_today
                    remaining_buy_budget = max(0., pending['remaining_budget_norm'])
                    fill_kind = 'buy'
                    if remaining_buy_budget <= tolerance:
                        pending = None
                        completed_buy_orders += 1
                    else:
                        partial_buy_fills += 1
                else:
                    sold = units * sell
                    gross_sale = sold * price
                    left = sold
                    while left > tolerance:
                        available, acquired = lots[0]
                        used = min(left, available)
                        age = day.toordinal() - acquired
                        rate = next((rate for threshold, rate in redemption_tiers
                                     if age < threshold), 0.)
                        today_fee += used * price * rate
                        left -= used
                        lots[0][0] -= used
                        if lots[0][0] < tolerance:
                            lots.pop(0)
                    units -= sold
                    proceeds = gross_sale - today_fee
                    if redemption_settlement_workdays:
                        receivable += proceeds
                        payments.append((following_weekday(day, redemption_settlement_workdays).isoformat(), proceeds))
                    else:
                        cash += proceeds
                    active_sell += 1
                    anchor_price, anchor_value = price, units * price
                    signature.update(f'{daystr}:sell:{gross_sale:.10f}:{anchor_value:.10f}|'.encode())
                    if detail:
                        events.append({'date': daystr, 'kind': 'sell', 'signal_date': signal_date,
                                       'budget_norm': gross_sale, 'extra_norm': 0., 'fee_norm': today_fee,
                                       'new_anchor_value_norm': anchor_value})
                    pending = None

        if buy_today > 0.:
            needed = max(0., buy_today - cash)
            cash += needed
            extra_today += needed
            net = buy_today / (1. + buy_fee)
            acquired = net / price
            units += acquired
            cash -= buy_today
            lots.append([acquired, day.toordinal()])
            today_fee += buy_today - net
            if fill_kind == 'scheduled_buy':
                scheduled_count += 1
            else:
                active_buy += 1
            if rule is not None:
                anchor_price, anchor_value = price, units * price
            if fill_kind == 'buy':
                signature.update(f'{daystr}:buy:{buy_today:.10f}:{anchor_value:.10f}|'.encode())
            if detail:
                event = {'date': daystr, 'kind': fill_kind, 'budget_norm': buy_today,
                         'extra_norm': needed, 'fee_norm': today_fee,
                         'remaining_budget_norm': remaining_buy_budget}
                if fill_kind == 'buy':
                    event.update(signal_date=signal_date, new_anchor_value_norm=anchor_value)
                events.append(event)

        assert buy_today <= cap + tolerance
        external_total += extra_today
        current_ratio = external_total / regular_total
        peak_extra_ratio = max(peak_extra_ratio, current_ratio)
        if max_extra_ratio is not None and current_ratio > max_extra_ratio + tolerance:
            return {'pruned': True, 'rule': rule, 'violation_date': daystr,
                    'peak_extra_to_regular_ratio': peak_extra_ratio,
                    'external_lower_bound_norm': external_total}
        equity = units * price + cash + receivable
        totalflow = regular + extra_today
        assert math.isclose(equity, preflow + totalflow - today_fee, abs_tol=1e-9, rel_tol=1e-11)
        tol = 1e-11 * max(1., equity)
        assert cash >= -tol and receivable >= -tol
        cash, receivable = max(0., cash), max(0., receivable)
        twr *= before * equity / (preflow + totalflow)
        peak = max(peak, twr)
        mdd = max(mdd, 1. - twr/peak)
        weight = units * price / equity
        sum_weight += weight
        fees += today_fee
        if totalflow and (compute_xirr or detail):
            flows.append((day, -totalflow))
        if detail:
            daily.append({'date': daystr, 'nav': price, 'total_norm': equity,
                          'fund_value_norm': units*price, 'cash_norm': cash, 'receivable_norm': receivable,
                          'regular_today_norm': regular, 'extra_today_norm': extra_today,
                          'twr_index': twr, 'drawdown_pct': (twr/peak-1.)*100.,
                          'fund_weight_pct': weight*100., 'gross_buy_today_norm': buy_today,
                          'scheduled_buy_backlog_norm': scheduled_backlog,
                          'pending_tactical_budget_norm': (pending['remaining_budget_norm']
                                                           if pending and pending['side']=='buy' else 0.)})
        previous_equity = equity

    cagr = (twr**(1./data['years']) - 1.) * 100.
    scheduled_pending = ({'side': 'scheduled_buy', 'remaining_budget_norm': scheduled_backlog,
                          'since': scheduled_backlog_since} if scheduled_backlog else None)
    summary = {'rule': list(rule) if rule else None, 'schedule': schedule, 'initial_only': initial_only,
               'twr_annualized_pct': cagr, 'max_drawdown_pct': mdd*100.,
               'calmar': cagr/(mdd*100.) if mdd > 1e-8 else None,
               'regular_contributed_norm': regular_total, 'extra_contributed_norm': external_total,
               'extra_over_regular_pct': external_total/regular_total*100.,
               'peak_extra_over_regular_pct': peak_extra_ratio*100., 'end_total_norm': equity,
               'end_fund_weight_pct': weight*100., 'average_fund_weight_pct': sum_weight/len(data['rows'])*100.,
               'scheduled_buy_count': scheduled_count, 'tactical_buy_count': active_buy,
               'tactical_sell_count': active_sell, 'cancelled_pending': cancelled,
               'path_signature': signature.hexdigest(), 'transaction_fees_norm': fees,
               'dividends_norm': dividend_total, 'lag': lag,
               'pending_order': scheduled_pending or pending,
               'pending_scheduled_order': scheduled_pending, 'pending_tactical_order': pending,
               'daily_buy_cap_norm': cap, 'redemption_settlement_workdays': redemption_settlement_workdays,
               'tactical_buy_signal_count': buy_orders, 'completed_tactical_buy_order_count': completed_buy_orders,
               'partial_tactical_buy_fill_count': partial_buy_fills,
               'cancelled_tactical_buy_budget_norm': cancelled_tactical_budget}
    if compute_xirr or detail:
        flows.append((data['dates'][-1], equity))
        summary['xirr_pct'] = xirr(flows)
    if detail:
        return {'summary': summary, 'daily': daily, 'trades': events,
                'cashflows': [{'date': day.isoformat(), 'value': value} for day,value in flows]}
    return summary
