"""Public NAV backtest; all money is normalized to a hypothetical initial value of 1.

No personal account data is read. External contributions are investor cash flows,
not returns. The existing single-year backtest and source archives stay intact.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
from pathlib import Path

FUND = Path(__file__).resolve().parents[1]
SOURCE = FUND / "历史净值/270023_全部历史净值_截至2026-10-14.json"
SUPPLEMENT = FUND / "历史净值/270023_既有公开净值补充_待官网复核_2026-10-16.json"
OUT = FUND / "研究"
STEM = "270023_全历史涨跌15重置基准回测_截至2026-10-14"
YEAR = 365.2425


class CapitalBudgetExceeded(ValueError):
    def __init__(self, value):
        self.external_lower_bound = value
        super().__init__("Monotone external contributions exceeded research budget")


def date(value):
    return dt.date.fromisoformat(value)


def compact_date(value):
    return dt.datetime.strptime(value, "%Y%m%d").date().isoformat()


def xirr(cashflows):
    first = date(cashflows[0]["date"])
    # Match the conventional/Excel XIRR actual-days-over-365 convention.
    timed = [((date(x["date"]) - first).days / 365.0, x["value"]) for x in cashflows]
    def npv(rate):
        return sum(value / (1 + rate) ** years for years, value in timed)
    low, high = -0.9999, 1.0
    while npv(high) > 0:
        high = 2 * high + 1
    if npv(low) <= 0:
        raise ValueError("No conventional positive-terminal cash-flow root")
    for _ in range(150):
        middle = (low + high) / 2
        if npv(middle) > 0:
            low = middle
        else:
            high = middle
    result = (low + high) / 2
    assert abs(npv(result)) < 1e-9
    return result


def risk(series):
    peak = 1.0
    peak_date = series[0]["date"]
    worst, worst_peak, worst_trough = 0.0, peak_date, peak_date
    for item in series:
        value = item["twr_index"]
        if value > peak:
            peak, peak_date = value, item["date"]
        dd = value / peak - 1
        item["drawdown_pct"] = 100 * dd
        if dd < worst:
            worst, worst_peak, worst_trough = dd, peak_date, item["date"]
    return {"max_drawdown_pct": -100 * worst, "drawdown_peak_date": worst_peak,
            "drawdown_trough_date": worst_trough}


def simulate(rows, dividends, lag=0, signal="nav", fee=False, fixed_flows=None,
             label="", reinvest=False, up=.15, down=.15, sell_fraction=.10,
             buy_fraction=.15, flat_sell_fee=None, capital_limit=None):
    """fixed_flows=None runs the rule; a dict runs matched cash-flow buy-and-hold."""
    subscription = .0016 if fee else 0.0
    quantity = 1 / (1 + subscription) / rows[0]["nav"]
    cash, receivable, external_total, fees = 0.0, 0.0, 0.0, 1 - 1 / (1 + subscription)
    lots = [[quantity, rows[0]["date"]]]
    by_exdate = {x["exdate"]: x for x in dividends}
    distributions = []
    anchor_nav, anchor_signal = rows[0]["nav"], 1.0 if signal == "total_return" else rows[0]["nav"]
    anchor_value = quantity * rows[0]["nav"]
    signal_index, previous_nav = 1.0, rows[0]["nav"]
    previous_equity, twr_index = 1.0, 1.0
    observation = -1
    pending = None
    trades, daily, additions = [], [], []
    cumulative_dividends = 0.0

    for index, row in enumerate(rows):
        day, price = row["date"], row["nav"]
        eligible = row.get("official", True)
        if eligible:
            observation += 1
        dividend = by_exdate.get(day)
        per_unit = dividend["per_unit"] if dividend else 0.0
        if index:
            signal_index *= (price + per_unit) / previous_nav
        signal_price = signal_index if signal == "total_return" else price
        if dividend:
            entitlement = quantity * per_unit
            cumulative_dividends += entitlement
            if reinvest:
                units = entitlement / price
                quantity += units
                lots.append([units, day])
            else:
                distributions.append([dividend["paydate"], entitlement])
                receivable += entitlement
        remaining = []
        for paydate, entitlement in distributions:
            if paydate <= day:
                receivable -= entitlement
                cash += entitlement
            else:
                remaining.append([paydate, entitlement])
        distributions = remaining
        pretrade = quantity * price + cash + receivable
        extra, transaction_fee = 0.0, 0.0
        executed = False

        if fixed_flows is not None:
            extra = fixed_flows.get(day, 0.0)
            if extra:
                net = extra / (1 + subscription)
                quantity += net / price
                transaction_fee += extra - net
        else:
            if pending is None and eligible:
                relative = signal_price / anchor_signal - 1
                if ((sell_fraction > 0 and relative >= up - 1e-12)
                        or (buy_fraction > 0 and relative <= -down + 1e-12)):
                    pending = {"signal_date": day, "signal_nav": price,
                               "signal_change_pct": relative * 100,
                               "side": "sell" if relative > 0 else "buy",
                               "due_observation": observation + lag,
                               "buy_budget_norm": anchor_value * buy_fraction,
                               "previous_anchor_value_norm": anchor_value,
                               "previous_anchor_nav": anchor_nav}
            if pending is not None and eligible and observation >= pending["due_observation"]:
                old_quantity = quantity
                if pending["side"] == "sell":
                    units = quantity * sell_fraction
                    gross = units * price
                    left = units
                    while left > 1e-12:
                        available, acquired = lots[0]
                        used = min(left, available)
                        age = (date(day) - date(acquired)).days
                        rate = (.015 if age < 7 else .005 if age < 365 else .003 if age < 730 else 0) if fee else 0
                        if fee and flat_sell_fee is not None:
                            rate = flat_sell_fee
                        transaction_fee += used * price * rate
                        left -= used
                        lots[0][0] -= used
                        if lots[0][0] < 1e-12:
                            lots.pop(0)
                    quantity -= units
                    cash += gross - transaction_fee
                    trade_value = gross
                else:
                    # Fee sensitivity treats 15% as the gross subscription budget.
                    trade_value = pending["buy_budget_norm"]
                    extra = max(0.0, trade_value - cash)
                    if capital_limit is not None and external_total + extra > capital_limit + 1e-12:
                        raise CapitalBudgetExceeded(external_total + extra)
                    cash += extra
                    net = trade_value / (1 + subscription)
                    units = net / price
                    quantity += units
                    lots.append([units, day])
                    cash -= trade_value
                    transaction_fee += trade_value - net
                anchor_nav, anchor_signal = price, signal_price
                anchor_value = quantity * price
                trades.append({k: v for k, v in pending.items() if k != "due_observation"} | {
                    "execution_date": day, "execution_nav": price,
                    "trade_value_norm": trade_value, "external_added_norm": extra,
                    "fee_norm": transaction_fee, "new_anchor_value_norm": anchor_value,
                    "fund_value_norm_after": quantity * price, "cash_norm_after": cash,
                    "receivable_norm_after": receivable,
                })
                assert quantity >= 0 and abs(quantity - old_quantity) > 0
                pending, executed = None, True

        equity = quantity * price + cash + receivable
        assert math.isclose(equity, pretrade + extra - transaction_fee, rel_tol=1e-11, abs_tol=1e-11)
        tolerance = 1e-12 * max(1.0, abs(equity))
        assert cash >= -tolerance and receivable >= -tolerance
        cash = max(0.0, cash)
        receivable = max(0.0, receivable)
        equity = quantity * price + cash + receivable
        if extra > 0:
            additions.append({"date": day, "value_norm": extra})
        external_total += extra
        fees += transaction_fee
        factor = (equity - extra) / previous_equity
        assert factor > 0
        twr_index *= factor
        daily.append({"date": day, "nav": price, "fund_value_norm": quantity * price,
                      "cash_norm": cash, "receivable_norm": receivable, "total_norm": equity,
                      "external_today_norm": extra, "contributed_norm": 1 + external_total,
                      "twr_index": twr_index, "signal_index": signal_index,
                      "fund_weight_pct": quantity * price / equity * 100})
        previous_equity, previous_nav = equity, price

    cashflows = [{"date": rows[0]["date"], "value": -1.0}]
    cashflows += [{"date": x["date"], "value": -x["value_norm"]} for x in additions]
    cashflows.append({"date": rows[-1]["date"], "value": daily[-1]["total_norm"]})
    years = (date(rows[-1]["date"]) - date(rows[0]["date"])).days / YEAR
    end = daily[-1]
    summary = {"label": label, "lag_nav_observations": lag, "signal": signal,
               "rule": {"up": up, "down": down, "sell_fraction": sell_fraction, "buy_fraction": buy_fraction},
               "fees": ("fixed_sell_fee_screening_proxy" if flat_sell_fee is not None else "current_platform_static_sensitivity") if fee else "zero_transaction_fees",
               "dividend_mode": "reinvest_at_exdate_NAV_economic_model" if reinvest else "cash_on_public_payment_date",
               "external_added_norm": external_total, "total_contributed_norm": 1 + external_total,
               "end_total_norm": end["total_norm"], "end_fund_norm": end["fund_value_norm"],
               "end_cash_norm": cash, "end_receivable_norm": receivable,
               "net_profit_norm": end["total_norm"] - 1 - external_total,
               "profit_over_total_contributed_pct": (end["total_norm"] / (1 + external_total) - 1) * 100,
               "twr_return_pct": (twr_index - 1) * 100,
               "twr_annualized_pct": (twr_index ** (1 / years) - 1) * 100,
               "xirr_pct": xirr(cashflows) * 100, "transaction_fees_norm": fees,
               "cash_dividends_norm": cumulative_dividends,
               "sell_count": sum(x["side"] == "sell" for x in trades),
               "buy_count": sum(x["side"] == "buy" for x in trades),
               "external_addition_count": len(additions), "pending_order": pending,
               "end_fund_weight_pct": end["fund_weight_pct"], **risk(daily)}
    annual = []
    previous_year_index = 1.0
    grouped = {}
    for item in daily:
        grouped[item["date"][:4]] = item
    for year, last in grouped.items():
        annual.append({"year": year, "twr_return_pct": (last["twr_index"] / previous_year_index - 1) * 100})
        previous_year_index = last["twr_index"]
    return {"summary": summary, "trades": trades, "external_cashflows": additions,
            "daily": daily, "annual_twr_returns": annual}


def main():
    source = json.loads(SOURCE.read_text(encoding="utf-8-sig"))
    rows = source["rows"]
    assert len(rows) == len({r["date"] for r in rows}) == 3892
    assert rows == sorted(rows, key=lambda r: r["date"])
    dividends = [{"exdate": compact_date(x["EXDATE"]),
                  "paydate": compact_date(x["DISTRIBUTEDATE"]),
                  "recorddate": compact_date(x["RECORDDATE"]),
                  "per_unit": float(x["UNITAMOUNT"])} for x in source["public_dividend_records"]]
    assert len(dividends) == 6 and math.isclose(sum(x["per_unit"] for x in dividends), .439)
    dividends.sort(key=lambda x: x["exdate"])
    cases = [simulate(rows, dividends, lag=lag, label="理想同净值成交" if lag == 0 else f"滞后{lag}个净值日") for lag in range(4)]
    cases.append(simulate(rows, dividends, lag=2, fee=True, label="滞后2日及当前平台静态费率"))
    cases.append(simulate(rows, dividends, signal="total_return", label="分红调整信号，理想同净值成交"))
    cases.append(simulate(rows, dividends, reinvest=True, label="红利再投资，原始净值触发"))
    for case in cases:
        flows = {x["date"]: x["value_norm"] for x in case["external_cashflows"]}
        benchmark = simulate(rows, dividends, fee=case["summary"]["fees"] != "zero_transaction_fees",
                             fixed_flows=flows, reinvest="reinvest" in case["summary"]["dividend_mode"],
                             label="相同入金日期与数额的买入持有")
        case["matched_cashflow_buy_hold"] = benchmark
    initial_hold = simulate(rows, dividends, fixed_flows={}, label="仅初始投入，现金分红持有")
    initial_reinvest = simulate(rows, dividends, fixed_flows={}, reinvest=True, label="仅初始投入，红利再投持有")
    extra = json.loads(SUPPLEMENT.read_text(encoding="utf-8-sig"))["rows"]
    expanded = sorted(rows + [{"date": x["date"], "nav": x["nav"], "official": False} for x in extra], key=lambda x: x["date"])
    supplemental = simulate(expanded, dividends, label="加10条第三方估值记录，仅管理人观察日触发及成交")
    payload = {
        "fund_code": "270023", "share_class": "人民币A", "analysis_date": "2026-10-16",
        "start_date": rows[0]["date"], "end_date": rows[-1]["date"], "official_rows": len(rows),
        "normalization": "初始假设投入=1；数值仅为模拟比例，不含任何真实账户金额或份额",
        "source_file": SOURCE.relative_to(FUND.parents[1]).as_posix(), "source_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "dividends": dividends, "assumptions": [
            "初始全部买入；现金不足在成交日追加外部资金，不融资、不把入金算收益",
            "每次成交后重置净值及成交后基金市值基准；加仓按上次基准市值15%",
            "主情景按原始单位净值触发，现金分红影响价格阈值；另有分红调整信号敏感性",
            "除息日前持有份额计应收红利，公开发放日后首次净值观察转可用现金；渠道到账差异未还原",
            "滞后1至3个净值观察日为公布/执行延迟敏感性，不是已核验历史真实成交",
            "忽略历史限购、暂停申赎、份额确认及赎回到账等待、现金收益；期末按市值估值而非全部赎回",
            "静态费用情景按0.16%申购费及FIFO赎回费；15%为含费申购预算，初始预算也含费；不代表历史实际费率",
            "费率情景用成交日近似确认日，赎回费率按自然日不足7日1.5%、不足365日0.5%、不足730日0.3%、其余0%",
            "2014-06-09由亚太除日本策略转型，历史不全属于现今全球投资策略",
        ], "cases": cases, "initial_only_buy_hold": initial_hold,
        "initial_only_dividend_reinvest_buy_hold": initial_reinvest,
        "supplemental_date_sensitivity": supplemental,
    }
    OUT.mkdir(exist_ok=True)
    output = OUT / (STEM + ".json")
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"file": str(output), "cases": [c["summary"] for c in cases],
                      "initial_only_hold": initial_hold["summary"],
                      "initial_only_reinvest_hold": initial_reinvest["summary"],
                      "matched_hold": cases[0]["matched_cashflow_buy_hold"]["summary"],
                      "supplement_end_difference_norm": supplemental["summary"]["end_total_norm"] - cases[0]["summary"]["end_total_norm"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
