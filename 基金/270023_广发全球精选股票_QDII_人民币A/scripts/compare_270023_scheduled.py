"""Equal annual funding comparison using public NAV and normalized budgets only.

Annual budgets enter the cash account before the scheduled purchase. Unspent
budgets are included in equity and XIRR. No actual account data is accessed.
"""

from __future__ import annotations

import calendar
import datetime as dt
import hashlib
import json
import math
from collections import defaultdict

from backtest_270023_full_history import SOURCE, OUT, YEAR, compact_date, date, risk, xirr, simulate as simulate_initial

STEM = "270023_年度与定投策略对比_截至2026-10-14"
CONFIGS = {
    "annual": {"label": "年度一次投入", "schedule": "annual"},
    "monthly": {"label": "每月定投", "schedule": "monthly"},
    "daily": {"label": "每日定投", "schedule": "daily"},
    "original": {"label": "年度投入＋原15/15规则", "schedule": "annual", "rule": [.15,.15,.10,.15]},
    "candidate": {"label": "年度投入＋40/30候选", "schedule": "annual", "rule": [.40,.30,.20,.30]},
}


def funding_plan(rows):
    """Predetermined calendar budgets; unfinished final year stays in cash.

    A month has budget 1/12, split over its known Gregorian calendar days.
    Non-observation days accrue and combine on the next observation. The first
    startup year funds only its starting month through December; every later
    year receives a FULL annual budget, independently of the backtest endpoint.
    """
    grouped = defaultdict(list)
    for row in rows:
        grouped[row["date"][:4]].append(row)
    plans = []
    deposits = {}
    orders = {kind: {} for kind in ("annual", "monthly", "daily")}
    for year, group in sorted(grouped.items()):
        months = {}
        for row in group:
            months.setdefault(row["date"][:7], row["date"])
        start_month = int(group[0]["date"][5:7]) if year == rows[0]["date"][:4] else 1
        budget = (13-start_month) / 12.0
        first = group[0]["date"]
        deposits[first] = budget
        orders["annual"][first] = budget
        for day in months.values():
            orders["monthly"][day] = 1/12.0
        plans.append({"year":year,"first_date":first,"last_date":group[-1]["date"],
                      "covered_months":len(months),"nav_observations":len(group),
                      "annual_budget_norm":budget})
    cursor=date(rows[0]["date"]).replace(day=1)
    for row in rows:
        observation=date(row["date"])
        amount=0.0
        while cursor <= observation:
            amount += 1.0 / (12*calendar.monthrange(cursor.year,cursor.month)[1])
            cursor += dt.timedelta(days=1)
        orders["daily"][row["date"]]=amount
    assert math.isclose(sum(orders["annual"].values()),sum(deposits.values()),abs_tol=1e-11)
    assert sum(orders["daily"].values()) <= sum(deposits.values())+1e-10
    assert sum(orders["monthly"].values()) <= sum(deposits.values())+1e-10
    return {"years":plans,"deposits":deposits,"orders":orders}


def simulate(rows, dividends, config, lag=2, fee=True, plan=None, forced_extra_flows=None):
    plan = funding_plan(rows) if plan is None else plan
    schedule = plan["orders"][config["schedule"]]
    deposits = plan["deposits"]
    subscription = .0016 if fee else 0.0
    rule = config.get("rule")
    by_exdate = {x["exdate"]:x for x in dividends}
    units = cash = receivable = regular_total = extra_total = fees = 0.0
    previous_equity, twr = None, 1.0
    anchor_nav = anchor_value = None
    lots, distributions, daily, trades, cashflows = [], [], [], [], []
    pending = None
    cancelled = 0
    cash_dividends = 0.0

    for index, row in enumerate(rows):
        day, price = row["date"], row["nav"]
        dividend = by_exdate.get(day)
        if dividend:
            entitlement = units * dividend["per_unit"]
            receivable += entitlement
            cash_dividends += entitlement
            distributions.append((dividend["paydate"],entitlement))
        remaining = []
        for paydate, entitlement in distributions:
            if paydate <= day:
                cash += entitlement
                receivable -= entitlement
            else:
                remaining.append((paydate,entitlement))
        distributions = remaining
        preflow = units * price + cash + receivable
        before_return = preflow / previous_equity if previous_equity is not None else 1.0
        regular = deposits.get(day,0.0)
        extra = (forced_extra_flows or {}).get(day,0.0)
        scheduled = schedule.get(day,0.0) + extra
        transaction_fee = 0.0
        cash += regular + extra
        regular_total += regular

        if scheduled:
            assert cash + 1e-10 >= scheduled
            net = scheduled / (1 + subscription)
            acquired = net / price
            units += acquired
            lots.append([acquired,day])
            cash -= scheduled
            transaction_fee += scheduled - net
            trades.append({"date":day,"kind":"scheduled_buy","budget_norm":scheduled})
            if rule:
                anchor_nav, anchor_value = price, units * price
                if pending:
                    cancelled += 1
                pending = None
        elif rule and anchor_nav is not None:
            up, down, sell_fraction, buy_fraction = rule
            relative = price / anchor_nav - 1
            if pending is None and (relative >= up - 1e-12 or relative <= -down + 1e-12):
                pending = {"signal_date":day,"side":"sell" if relative>0 else "buy",
                           "due_index":index+lag,"budget_norm":anchor_value*buy_fraction}
            if pending is not None and index >= pending["due_index"]:
                if pending["side"] == "sell":
                    sold = units * sell_fraction
                    gross = sold * price
                    left = sold
                    while left > 1e-12:
                        available, acquired = lots[0]
                        used = min(left,available)
                        age = (date(day)-date(acquired)).days
                        rate = (.015 if age < 7 else .005 if age < 365 else .003 if age < 730 else 0.) if fee else 0.
                        transaction_fee += used * price * rate
                        left -= used
                        lots[0][0] -= used
                        if lots[0][0] < 1e-12:
                            lots.pop(0)
                    units -= sold
                    cash += gross - transaction_fee
                    budget = gross
                else:
                    budget = pending["budget_norm"]
                    extra = max(0.0,budget-cash)
                    cash += extra
                    net = budget / (1 + subscription)
                    acquired = net / price
                    units += acquired
                    lots.append([acquired,day])
                    cash -= budget
                    transaction_fee += budget-net
                trades.append({"date":day,"kind":pending["side"],"signal_date":pending["signal_date"],
                               "budget_norm":budget,"extra_norm":extra,"fee_norm":transaction_fee})
                pending = None
                anchor_nav, anchor_value = price, units * price

        equity = units * price + cash + receivable
        flow = regular + extra
        assert math.isclose(equity,preflow+flow-transaction_fee,abs_tol=1e-10,rel_tol=1e-11)
        assert cash >= -1e-10 and receivable >= -1e-10
        cash, receivable = max(0.,cash),max(0.,receivable)
        equity = units * price + cash + receivable
        # Split at the known NAV flow valuation: market return before flow,
        # then transaction costs over ALL capital immediately after the flow.
        after_return = equity / (preflow+flow)
        twr *= before_return * after_return
        if flow:
            cashflows.append({"date":day,"value":-flow})
        extra_total += extra
        fees += transaction_fee
        daily.append({"date":day,"total_norm":equity,"fund_value_norm":units*price,
                      "cash_norm":cash,"receivable_norm":receivable,"twr_index":twr,
                      "regular_today_norm":regular,"extra_today_norm":extra,
                      "contributed_norm":regular_total+extra_total})
        previous_equity = equity

    cashflows.append({"date":rows[-1]["date"],"value":daily[-1]["total_norm"]})
    years = (date(rows[-1]["date"])-date(rows[0]["date"])).days / YEAR
    end = daily[-1]
    summary = {"label":config["label"],"schedule":config["schedule"],"rule":rule,
               "regular_contributed_norm":regular_total,"extra_contributed_norm":extra_total,
               "extra_over_regular_pct":extra_total/regular_total*100,
               "end_total_norm":end["total_norm"],
               "end_over_total_contributions_pct":(end["total_norm"]/(regular_total+extra_total)-1)*100,
               "twr_annualized_pct":(twr**(1/years)-1)*100,"xirr_pct":xirr(cashflows)*100,
               "end_fund_weight_pct":end["fund_value_norm"]/end["total_norm"]*100,
               "scheduled_buy_count":sum(x["kind"]=="scheduled_buy" for x in trades),
               "tactical_buy_count":sum(x["kind"]=="buy" for x in trades),
               "tactical_sell_count":sum(x["kind"]=="sell" for x in trades),
               "cancelled_pending_on_annual_buy":cancelled,"pending":pending,
               "transaction_fees_norm":fees,"cash_dividends_norm":cash_dividends,
               "lag":lag,"fee":fee,**risk(daily)}
    return {"summary":summary,"daily":daily,"trades":trades,"cashflows":cashflows}


def main():
    source = json.loads(SOURCE.read_text(encoding="utf-8-sig"))
    rows = source["rows"]
    dividends = [{"exdate":compact_date(x["EXDATE"]),"paydate":compact_date(x["DISTRIBUTEDATE"]),
                  "per_unit":float(x["UNITAMOUNT"])} for x in source["public_dividend_records"]]
    protocol = {"created_at":dt.datetime.now().isoformat(timespec="seconds"),
        "normalization":"Hypothetical full calendar annual budget=1; no account amounts",
        "partial_years":"Startup 2010 funds Aug-Dec=5/12; 2026 receives FULL budget with future instalments left as cash",
        "funding":"All strategies receive the same annual budget on first available NAV date",
        "cash":"Uninvested budgets and cash dividends included, zero interest",
        "schedules":"annual first NAV; monthly 1/12 at first NAV per month; calendar-daily budget 1/(12*days_in_month) accrues to next NAV",
        "daily_normalization":"Month budget split over known calendar days; unavailable dates combined on next observation, never normalized to cutoff",
        "rule_extension":"Each annual new budget is fully bought, resets NAV/value anchors, cancels pending order; then original thresholds",
        "flows":"Market movement before flow; flow at observed NAV; transaction fees after flow; TWR split at flow",
        "extras":"Threshold dips use cash then outside topup; report extra budgets separately",
        "fees":"Same static 0.16% purchase fee, FIFO redemption tier as previous study; not historical fees",
        "lag":"Scheduled orders planned independently of NAV; threshold orders lag two NAV observations",
        "configurations":CONFIGS,"selection":"No new parameter tuning; prior selected 40/30 candidate remains exploratory"}
    protocol_path=OUT/(STEM+"_预设.json")
    if not protocol_path.exists():
        protocol_path.write_text(json.dumps(protocol,ensure_ascii=False,indent=2),encoding="utf-8")
    plan=funding_plan(rows)
    cases={key:simulate(rows,dividends,value,plan=plan) for key,value in CONFIGS.items()}
    complete=[r for r in rows if "2011-01-01" <= r["date"] <= "2025-12-31"]
    full_years={key:simulate(complete,dividends,value)["summary"] for key,value in CONFIGS.items()}
    zero_fees={key:simulate(rows,dividends,value,fee=False)["summary"] for key,value in CONFIGS.items()}
    lags={key:[simulate(rows,dividends,CONFIGS[key],lag=lag)["summary"] for lag in (1,2,3)]
          for key in ("original","candidate")}
    matched={key:simulate(rows,dividends,CONFIGS["annual"],plan=plan,
                         forced_extra_flows={x["date"]:x["extra_today_norm"] for x in cases[key]["daily"] if x["extra_today_norm"]})["summary"]
             for key in ("original","candidate")}
    initial_hold=simulate_initial(rows,dividends,fee=True,fixed_flows={},
                                 label="标准对照：期初一次买入，长期持有不动（现金分红）")
    assert not initial_hold["trades"] and not initial_hold["external_cashflows"]
    payload={"fund_code":"270023","analysis_date":"2026-10-16","start":rows[0]["date"],
        "end":rows[-1]["date"],"source_sha256":hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "protocol":protocol,"funding_plan":{k:v for k,v in plan.items() if k!="orders"},
        "cases":cases,"complete_calendar_years_2011_2025":full_years,
        "zero_fee_sensitivity":zero_fees,"lag_sensitivity":lags,
        "matched_actual_cashflow_annual_hold":matched,
        "initial_buy_hold_benchmark":initial_hold,
        "benchmark_definition":{"added_at":"2026-10-16","funding":"Only initial contribution, no annual additions",
                                "actions":"One initial purchase; no subsequent buy/sell; dividends remain cash",
                                "scope":"Separate funding plan; not a sixth equal-annual-budget strategy"}}
    output=OUT/(STEM+".json")
    output.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({"output":str(output),"strategy_count":len(cases),
                      "initial_hold_summary":{k:initial_hold['summary'][k] for k in
                          ('twr_annualized_pct','xirr_pct','max_drawdown_pct')}},ensure_ascii=False))


if __name__=="__main__":main()
