"""Optional public-NAV redemption-settlement sensitivity, separate from main engine.

For delay=0, the original engine is called and its result returned unchanged.
For a positive delay, redemption proceeds stay in receivables (part of portfolio
value, unavailable for purchases) until the Nth following Monday-Friday date.
Payments are released on the first observed NAV date on/after that date.

This is an approximate stress test, not an actual confirmation/settlement
calendar. Public holidays and fund-specific rules are NOT reconstructed;
weekday-only dates can release cash too soon around public holidays. No investor
account files are read. All contribution values use hypothetical research units.
"""
from __future__ import annotations

import sys
sys.dont_write_bytecode = True

import datetime as dt
import hashlib
import math

from annual_threshold_backtest import YEAR, prepare, xirr, simulate as _original_simulate


def following_weekday(day, count):
    """Return the Nth Monday-Friday strictly after day; no holiday calendar."""
    remaining=count
    while remaining:
        day+=dt.timedelta(days=1)
        if day.weekday()<5:
            remaining-=1
    return day


def simulate_settlement(data,rule=None,schedule='annual',initial_only=False,lag=2,
             buy_fee=.0015,redemption_tiers=((7,.015),(365,.005),(730,.003)),
             detail=False,compute_xirr=False,max_extra_ratio=None,forced_extras=None,
             redemption_settlement_workdays=0):
    """A year-start planned buy resets anchors and cancels prior pending signal.

    max_extra_ratio constrains cumulative extra/regular budget at EVERY date.
    A violation prunes irreversibly because the historic violation cannot vanish.
    """
    if (not isinstance(redemption_settlement_workdays, int)
            or isinstance(redemption_settlement_workdays, bool)
            or redemption_settlement_workdays < 0):
        raise ValueError("redemption_settlement_workdays must be a nonnegative integer")
    if redemption_settlement_workdays == 0:
        return _original_simulate(data, rule, schedule=schedule, initial_only=initial_only,
            lag=lag, buy_fee=buy_fee, redemption_tiers=redemption_tiers,
            detail=detail, compute_xirr=compute_xirr, max_extra_ratio=max_extra_ratio,
            forced_extras=forced_extras)
    units=cash=receivable=regular_total=external_total=fees=twr_sumweight=0.
    peak_extra_ratio=0.
    previous_equity=None
    twr=peak=1.
    mdd=0.
    anchor_price=anchor_value=None
    lots=[]
    payments=[]
    pending=None
    active_buy=active_sell=scheduled_count=cancelled=0
    flows=[];events=[];daily=[]
    signature=hashlib.sha256()
    dividend_total=0.
    for index,(row,day) in enumerate(zip(data['rows'],data['dates'])):
        price=row['nav'];daystr=row['date']
        dividend=data['dividends'].get(daystr)
        if dividend:
            entitlement=units*dividend['per_unit']
            receivable+=entitlement;dividend_total+=entitlement
            payments.append((dividend['paydate'],entitlement))
        remaining=[]
        for payday,entitlement in payments:
            if payday<=daystr:
                cash+=entitlement;receivable-=entitlement
            else:remaining.append((payday,entitlement))
        payments=remaining
        preflow=units*price+cash+receivable
        before=preflow/previous_equity if previous_equity is not None else 1.
        regular=(1. if index==0 else 0.) if initial_only else data['annual'][index]
        scheduled=regular if initial_only else data[schedule][index]
        extra=(forced_extras or {}).get(daystr,0.)
        scheduled+=extra
        cash+=regular+extra;regular_total+=regular
        today_fee=0.
        if scheduled:
            assert cash+1e-10>=scheduled
            net=scheduled/(1+buy_fee)
            acquired=net/price
            units+=acquired;cash-=scheduled
            lots.append([acquired,day.toordinal()])
            today_fee+=scheduled-net;scheduled_count+=1
            if detail:events.append({'date':daystr,'kind':'scheduled_buy','budget_norm':scheduled})
            if rule is not None:
                anchor_price=price;anchor_value=units*price
                cancelled+=pending is not None
                pending=None
        elif rule is not None and anchor_price is not None:
            up,down,sell,buy=rule
            relative=price/anchor_price-1
            if pending is None and ((sell>0 and relative>=up-1e-12) or (buy>0 and relative<=-down+1e-12)):
                pending=(index+lag,'sell' if relative>0 else 'buy',anchor_value*buy,daystr)
            if pending is not None and index>=pending[0]:
                side=pending[1]
                if side=='sell':
                    sold=units*sell;budget=sold*price
                    left=sold
                    while left>1e-12:
                        available,acquired=lots[0]
                        used=min(left,available)
                        age=day.toordinal()-acquired
                        rate=next((rate for threshold,rate in redemption_tiers if age<threshold),0.)
                        today_fee+=used*price*rate
                        left-=used;lots[0][0]-=used
                        if lots[0][0]<1e-12:lots.pop(0)
                    units-=sold
                    proceeds=budget-today_fee
                    receivable+=proceeds
                    release_day=following_weekday(day, redemption_settlement_workdays)
                    payments.append((release_day.isoformat(), proceeds))
                    active_sell+=1
                else:
                    budget=pending[2]
                    extra=max(0.,budget-cash)
                    cash+=extra
                    net=budget/(1+buy_fee)
                    acquired=net/price
                    units+=acquired;lots.append([acquired,day.toordinal()]);cash-=budget
                    today_fee+=budget-net;active_buy+=1
                anchor_price=price;anchor_value=units*price
                signature.update(f'{daystr}:{side}:{budget:.10f}:{anchor_value:.10f}|'.encode())
                if detail:events.append({'date':daystr,'kind':side,'signal_date':pending[3],
                    'budget_norm':budget,'extra_norm':extra,'fee_norm':today_fee,
                    'new_anchor_value_norm':anchor_value})
                pending=None
        external_total+=extra
        current_ratio=external_total/regular_total
        peak_extra_ratio=max(peak_extra_ratio,current_ratio)
        if max_extra_ratio is not None and current_ratio>max_extra_ratio+1e-12:
            return {'pruned':True,'rule':rule,'violation_date':daystr,
                    'peak_extra_to_regular_ratio':peak_extra_ratio,
                    'external_lower_bound_norm':external_total}
        equity=units*price+cash+receivable
        totalflow=regular+extra
        assert math.isclose(equity,preflow+totalflow-today_fee,abs_tol=1e-9,rel_tol=1e-11)
        tol=1e-11*max(1.,equity)
        assert cash>=-tol and receivable>=-tol
        cash=max(0.,cash);receivable=max(0.,receivable)
        twr*=before*equity/(preflow+totalflow)
        peak=max(peak,twr);mdd=max(mdd,1-twr/peak)
        weight=units*price/equity
        twr_sumweight+=weight
        fees+=today_fee
        if totalflow and (compute_xirr or detail):flows.append((day,-totalflow))
        if detail:daily.append({'date':daystr,'nav':price,'total_norm':equity,
            'fund_value_norm':units*price,'cash_norm':cash,'receivable_norm':receivable,
            'regular_today_norm':regular,'extra_today_norm':extra,'twr_index':twr,
            'drawdown_pct':(twr/peak-1)*100,'fund_weight_pct':weight*100})
        previous_equity=equity
    cagr=(twr**(1/data['years'])-1)*100
    summary={'rule':list(rule) if rule else None,'schedule':schedule,'initial_only':initial_only,
        'twr_annualized_pct':cagr,'max_drawdown_pct':mdd*100,
        'calmar':cagr/(mdd*100) if mdd>1e-8 else None,
        'regular_contributed_norm':regular_total,'extra_contributed_norm':external_total,
        'extra_over_regular_pct':external_total/regular_total*100,
        'peak_extra_over_regular_pct':peak_extra_ratio*100,'end_total_norm':equity,
        'end_fund_weight_pct':weight*100,'average_fund_weight_pct':twr_sumweight/len(data['rows'])*100,
        'scheduled_buy_count':scheduled_count,'tactical_buy_count':active_buy,'tactical_sell_count':active_sell,
        'cancelled_pending':cancelled,'path_signature':signature.hexdigest(),
        'transaction_fees_norm':fees,'dividends_norm':dividend_total,'lag':lag,
        'pending_order':pending}
    if compute_xirr or detail:
        flows.append((data['dates'][-1],equity))
        summary['xirr_pct']=xirr(flows)
    if detail:return {'summary':summary,'daily':daily,'trades':events,
                      'cashflows':[{'date':day.isoformat(),'value':value} for day,value in flows]}
    return summary
