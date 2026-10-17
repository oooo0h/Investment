"""Vectorized, public-NAV-only threshold screening; initial budget is 1.

The fixed subscription/redemption rates are screening assumptions, NOT verified
historical fees. In particular, the fixed redemption rate does not model FIFO or
holding-period tiers. Final candidates require a separate detailed fee engine.
No personal account data is read, and this module performs no file I/O.

``grid_simulate`` returns a NumPy structured array, in input configuration order.
Access summary columns with, for example, ``result['twr_annualized_pct']``.
"""

from __future__ import annotations

import numpy as np


YEAR_DAYS = 365.2425
FEE_MODEL_NOTE = (
    "Fixed-fee screening approximation; not historical actual fees and not FIFO."
)
SUMMARY_DTYPE = np.dtype([
    ("end_total_norm", "f8"),
    ("external_added_norm", "f8"),
    ("twr_annualized_pct", "f8"),
    ("max_drawdown_pct", "f8"),
    ("trade_count", "i8"),
])


def _day(value):
    text = str(value)
    if len(text) == 8 and text.isdigit():
        text = f"{text[:4]}-{text[4:6]}-{text[6:8]}"
    return np.datetime64(text[:10], "D")


def grid_simulate(rows, dividends, configs, lag=2,
                  buy_fee=0.0016, sell_fee=0.005):
    """Screen Nx4 ``[up, down, sell_fraction, buy_fraction]`` configurations.

    All four parameters are fractions, not percentages. A zero trade fraction
    disables that direction, including signals and anchor resets. Rows must be
    strictly date-ascending, with positive ``nav`` and ISO ``date``. Optional
    ``official=False`` observations are valued but cannot signal or execute.

    Dividends accept either ``exdate/paydate/per_unit`` dictionaries or official
    ``EXDATE/DISTRIBUTEDATE/UNITAMOUNT`` dictionaries. Entitlement uses holdings
    before that observation's trade; cash becomes usable on the first observed
    date on/after payment. Ex-dates before the segment start confer no entitlement
    on this independently initialized segment.

    Initial budget and later buy budgets include subscription fees. A pending
    buy freezes the previous post-trade holding value times its buy fraction;
    any cash shortfall is externally contributed only at execution. Sells use
    execution-date holdings. Every actual trade resets both price/value anchors.
    A pending order prevents another signal; at most one trade executes per day.

    TWR removes external contributions, includes cash and dividend receivables,
    and includes transaction costs. Drawdown uses that TWR index, starting at 1
    before the initial subscription fee. Annualization uses 365.2425 days.
    """
    if isinstance(lag, bool) or int(lag) != lag or lag < 0:
        raise ValueError("lag must be a nonnegative integer")
    lag = int(lag)
    if not (np.isfinite(buy_fee) and buy_fee >= 0
            and np.isfinite(sell_fee) and 0 <= sell_fee < 1):
        raise ValueError("invalid fixed fee assumptions")
    if len(rows) == 0:
        raise ValueError("rows must not be empty")

    cfg = np.asarray(configs, dtype=np.float64)
    if cfg.ndim != 2 or cfg.shape[1] != 4:
        raise ValueError("configs must have shape (N, 4)")
    if not np.isfinite(cfg).all():
        raise ValueError("configs must be finite")
    if (cfg < 0).any() or (cfg[:, 2] > 1).any():
        raise ValueError("parameters must be nonnegative; sell fraction <= 1")
    if ((cfg[:, 2] > 0) & (cfg[:, 0] <= 0)).any():
        raise ValueError("enabled selling requires a positive up threshold")
    if ((cfg[:, 3] > 0) & (cfg[:, 1] <= 0)).any():
        raise ValueError("enabled buying requires a positive down threshold")

    dates = np.array([_day(r["date"]) for r in rows], dtype="datetime64[D]")
    prices = np.array([r["nav"] for r in rows], dtype=np.float64)
    eligible = np.array([r.get("official", True) for r in rows], dtype=bool)
    if np.isnat(dates).any() or (np.diff(dates) <= np.timedelta64(0, "D")).any():
        raise ValueError("row dates must be valid, unique and strictly ascending")
    if not (np.isfinite(prices).all() and (prices > 0).all()):
        raise ValueError("all NAV values must be positive and finite")

    count = len(cfg)
    answer = np.empty(count, dtype=SUMMARY_DTYPE)
    if count == 0:
        return answer
    up, down, sell_fraction, buy_fraction = cfg.T
    quantity = np.full(count, 1.0 / (1.0 + buy_fee) / prices[0])
    cash = np.zeros(count)
    receivable = np.zeros(count)
    external_total = np.zeros(count)
    anchor_nav = np.full(count, prices[0])
    anchor_value = np.full(count, 1.0 / (1.0 + buy_fee))
    previous_equity = np.ones(count)
    twr_index = np.ones(count)
    twr_peak = np.ones(count)
    max_drawdown = np.zeros(count)
    trade_count = np.zeros(count, dtype=np.int64)
    pending_side = np.zeros(count, dtype=np.int8)  # +1 sell; -1 buy.
    due = np.full(count, -1, dtype=np.int64)
    pending_budget = np.zeros(count)

    accrue_on = [[] for _ in rows]
    pay_on = [[] for _ in rows]
    per_unit = []
    for dividend in dividends:
        exdate = _day(dividend.get("exdate", dividend.get("EXDATE")))
        paydate = _day(dividend.get("paydate", dividend.get("DISTRIBUTEDATE")))
        amount = float(dividend.get("per_unit", dividend.get("UNITAMOUNT")))
        if (np.isnat(exdate) or np.isnat(paydate) or paydate < exdate
                or not np.isfinite(amount) or amount < 0):
            raise ValueError("invalid public dividend event")
        if exdate < dates[0] or exdate > dates[-1]:
            continue
        event = len(per_unit)
        per_unit.append(amount)
        accrue_on[int(np.searchsorted(dates, exdate))].append(event)
        payment_index = int(np.searchsorted(dates, paydate))
        if payment_index < len(rows):
            pay_on[payment_index].append(event)
    entitlements = np.zeros((len(per_unit), count))

    observation = -1
    for i, price in enumerate(prices):
        # Public distributions are internal portfolio transfers, not deposits.
        for event in accrue_on[i]:
            entitlements[event] = quantity * per_unit[event]
            receivable += entitlements[event]
        for event in pay_on[i]:
            cash += entitlements[event]
            receivable -= entitlements[event]
        # Remove only negative roundoff from sums of nonnegative receivables.
        np.maximum(receivable, 0.0, out=receivable)
        external_today = np.zeros(count)

        if eligible[i]:
            observation += 1
            idle = pending_side == 0
            relative = price / anchor_nav - 1.0
            sell_signal = (idle & (sell_fraction > 0) & (quantity > 0)
                           & (relative >= up - 1e-12))
            buy_signal = (idle & ~sell_signal & (buy_fraction > 0)
                          & (anchor_value > 0)
                          & (relative <= -down + 1e-12))
            pending_side[sell_signal] = 1
            pending_side[buy_signal] = -1
            new_signal = sell_signal | buy_signal
            due[new_signal] = observation + lag
            pending_budget[buy_signal] = (
                anchor_value[buy_signal] * buy_fraction[buy_signal]
            )

            execute = (pending_side != 0) & (due <= observation)
            selling = execute & (pending_side == 1)
            buying = execute & (pending_side == -1)
            sold = quantity[selling] * sell_fraction[selling]
            quantity[selling] -= sold
            cash[selling] += sold * price * (1.0 - sell_fee)
            budget = pending_budget[buying]
            extra = np.maximum(0.0, budget - cash[buying])
            external_today[buying] = extra
            cash[buying] += extra - budget
            quantity[buying] += budget / (1.0 + buy_fee) / price
            anchor_nav[execute] = price
            anchor_value[execute] = quantity[execute] * price
            trade_count[execute] += 1
            pending_side[execute] = 0
            due[execute] = -1
            pending_budget[execute] = 0.0

        equity = quantity * price + cash + receivable
        twr_index *= (equity - external_today) / previous_equity
        np.maximum(twr_peak, twr_index, out=twr_peak)
        np.maximum(max_drawdown, 1.0 - twr_index / twr_peak,
                   out=max_drawdown)
        external_total += external_today
        previous_equity = equity

    days = int((dates[-1] - dates[0]) / np.timedelta64(1, "D"))
    answer["end_total_norm"] = previous_equity
    answer["external_added_norm"] = external_total
    answer["twr_annualized_pct"] = (
        np.expm1(np.log(twr_index) * (YEAR_DAYS / days)) * 100.0
        if days else np.nan
    )
    answer["max_drawdown_pct"] = max_drawdown * 100.0
    answer["trade_count"] = trade_count
    return answer
