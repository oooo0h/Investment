"""Public-NAV annual-funding engine; all budgets are hypothetical ratios.

No investor account data is read. Calendar instalments do not depend on the
sample end date or on future observation counts. Cash flows split TWR at NAV.
"""
from __future__ import annotations

import calendar
import datetime as dt
import hashlib
import math

YEAR=365.2425


def xirr(flows):
    origin=flows[0][0]
    timed=[((day-origin).days/365.,value) for day,value in flows]
    def npv(rate):
        return sum(value/(1+rate)**years for years,value in timed)
    low,high=-.9999,1.
    while npv(high)>0:
        high=2*high+1
    if npv(low)<=0:
        raise ValueError("No conventional negative-investment/positive-terminal IRR root")
    for _ in range(120):
        mid=(low+high)/2
        if npv(mid)>0:low=mid
        else:high=mid
    answer=(low+high)/2
    assert abs(npv(answer))<1e-8
    return answer*100


def prepare(rows,dividends=()):
    rows=[{"date":x["date"],"nav":float(x["nav"])} for x in rows]
    assert rows and rows==sorted(rows,key=lambda r:r['date'])
    assert len(rows)==len({x['date'] for x in rows})
    days=[dt.date.fromisoformat(r['date']) for r in rows]
    firstyear,firstmonth=days[0].year,days[0].month
    cursor=days[0].replace(day=1)
    annual,monthly,daily=[],[],[]
    seenyear,seenmonth=set(),set()
    for day in days:
        amount=0.
        while cursor<=day:
            amount+=1/(12*calendar.monthrange(cursor.year,cursor.month)[1])
            cursor+=dt.timedelta(days=1)
        daily.append(amount)
        monthkey=(day.year,day.month)
        monthly.append(1/12 if monthkey not in seenmonth else 0.)
        annual.append(((13-firstmonth)/12 if day.year==firstyear else 1.) if day.year not in seenyear else 0.)
        seenmonth.add(monthkey);seenyear.add(day.year)
    divmap={x['exdate']:x for x in dividends}
    assert len(divmap)==len(dividends)
    return {'rows':rows,'dates':days,'annual':annual,'monthly':monthly,'daily':daily,
            'budget_total':sum(annual),'dividends':divmap,
            'years':(days[-1]-days[0]).days/YEAR}


def simulate(data,rule=None,schedule='annual',initial_only=False,lag=2,
             buy_fee=.0015,redemption_tiers=((7,.015),(365,.005),(730,.003)),
             detail=False,compute_xirr=False,max_extra_ratio=None,forced_extras=None):
    """A year-start planned buy resets anchors and cancels prior pending signal.

    max_extra_ratio constrains cumulative extra/regular budget at EVERY date.
    A violation prunes irreversibly because the historic violation cannot vanish.
    """
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
                    units-=sold;cash+=budget-today_fee;active_sell+=1
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
