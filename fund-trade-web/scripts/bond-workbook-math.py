"""Reconstruct a provisional bond lot distribution from provided ledger rows.

Only public NAVs and private in-memory rows enter this module. No account values
are logged or persisted here. A reconstructed history is explicitly provisional:
it cannot establish that an earlier opening balance did not exist.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP


class ReconstructionError(ValueError):
    def __init__(self, reason):
        super().__init__("Bond reconstruction unavailable.")
        self.reason = reason


def dec(value):
    result = Decimal(str(value))
    if not result.is_finite():
        raise ReconstructionError("invalid-number")
    return result


def rounded(value):
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def redemption_rate(code, days):
    if days < 0:
        raise ReconstructionError("negative-holding-period")
    if days < 7:
        return Decimal("0.015")
    return Decimal("0.001") if code == "006485" and days < 30 else Decimal(0)


def execution(row, navs):
    if row.get("nav") and row.get("navDate"):
        return row["navDate"], dec(row["nav"]), False
    if row.get("navDate"):
        day = row["navDate"]
        if day not in navs:
            raise ReconstructionError("missing-nav")
        return day, dec(navs[day]), True
    application = row.get("date")
    if not application:
        raise ReconstructionError("missing-application-date")
    eligible = date.fromisoformat(application)
    submitted = row.get("submittedAt")
    # No timestamp means the T day is not knowable at the cutoff boundary.
    if not submitted:
        raise ReconstructionError("missing-application-time")
    if submitted[11:19] >= "15:00:00":
        eligible += timedelta(days=1)
    matches = [day for day in navs if day >= eligible.isoformat()]
    if not matches:
        raise ReconstructionError("missing-nav")
    day = min(matches)
    # The NAV calendar is a complete published window, not a sparse lookup.
    if eligible.isoformat() < min(navs):
        raise ReconstructionError("nav-window-incomplete")
    return day, dec(row["nav"] if row.get("nav") else navs[day]), True


def next_confirmation(day, navs):
    matches = [candidate for candidate in navs if candidate > day]
    if not matches:
        raise ReconstructionError("missing-confirmation-calendar")
    return min(matches)


def consume(lots, shares, trade_day):
    remaining = shares
    for lot in lots:
        if lot["date"] > trade_day:
            continue
        take = min(lot["shares"], remaining)
        lot["shares"] -= take
        remaining -= take
        if remaining <= 0:
            return
    # Half a share-cent is the maximum rounding residue, never an opening lot.
    if remaining > Decimal("0.005"):
        raise ReconstructionError("history-shortfall")


def shares_from_net(code, net, nav, redemption_confirmation_day, lots, *, trade_day=None):
    """Invert a cash redemption using FIFO fee tiers per acquisition lot."""
    remaining, shares, fee = net, Decimal(0), Decimal(0)
    for lot in lots:
        if lot["shares"] <= 0 or (trade_day and lot["date"] > trade_day):
            continue
        days = (date.fromisoformat(redemption_confirmation_day) - date.fromisoformat(lot["date"])).days
        rate = redemption_rate(code, days)
        cash_per_share = nav * (1 - rate)
        take = min(lot["shares"], remaining / cash_per_share)
        shares += take
        fee += take * nav * rate
        remaining -= take * cash_per_share
        if remaining <= Decimal("0.00000001"):
            break
    if remaining > Decimal("0.01"):
        raise ReconstructionError("history-shortfall")
    return rounded(shares), rounded(fee)


def reconstruct(code, transactions, navs, *, as_of):
    """Return calculated fields plus FIFO lots without rewriting reported data.

    Rows explicitly marked processing remain untouched and never alter lots.
    Missing economics of completed screenshot rows may be inferred. Existing
    reported shares/NAV/fee always win. A failure leaves the whole distribution
    unknown; partial lots are never normalized to a full current holding.
    """
    if code not in ("006485", "006663") or not navs:
        raise ReconstructionError("invalid-source")
    today = date.fromisoformat(as_of)
    prepared, active = [], []
    for source in transactions:
        row = deepcopy(source)
        if row.get("sourceStatus") == "processing" or row.get("status") == "cancelled":
            prepared.append(row)
            continue
        day, nav, calculated_nav = execution(row, navs)
        if date.fromisoformat(day) > today:
            raise ReconstructionError("future-execution")
        active.append((day, row.get("submittedAt") or row["date"], row["id"], row, nav, calculated_nav))
    lots = []
    for day, _submitted, _identifier, row, nav, calculated_nav in sorted(active, key=lambda item: item[:3]):
        kind = row["type"]
        actual_shares = row.get("shares")
        calculated_shares = not actual_shares
        fee = dec(row["fee"]) if row.get("fee") is not None else None
        if kind in ("buy", "transfer-in"):
            if actual_shares:
                shares = dec(actual_shares)
            else:
                if row.get("amount") is None:
                    raise ReconstructionError("missing-amount")
                # A transfer-in list amount is already the incoming investment;
                # an ordinary buy deducts its actual fee if one is supplied.
                net = dec(row["amount"]) - (fee or 0) if kind == "buy" else dec(row["amount"])
                shares = rounded(net / nav)
            if fee is None:
                fee = Decimal(0)  # Both user-specified purchase rates are zero.
            start = row.get("confirmedDate") or next_confirmation(day, navs)
            if date.fromisoformat(start) > today:
                raise ReconstructionError("future-confirmation")
            lots.append({"date": start, "shares": shares})
            lots.sort(key=lambda lot: lot["date"])
            if calculated_shares or calculated_nav:
                row["confirmedDate"] = start
        elif kind in ("sell", "transfer-out"):
            if actual_shares:
                shares = dec(actual_shares)
            elif row.get("requestedShares"):
                shares = dec(row["requestedShares"])
            elif row.get("amount") is not None:
                # The application list displays cash received for a redemption.
                if fee is not None:
                    shares = rounded((dec(row["amount"]) + fee) / nav)
                else:
                    end = row.get("confirmedDate") or next_confirmation(day, navs)
                    shares, calculated_fee = shares_from_net(code, dec(row["amount"]), nav, end, lots, trade_day=day)
                    fee = calculated_fee
            else:
                raise ReconstructionError("missing-redemption")
            consume(lots, shares, day)
            # For transfers, actual conversion charges remain separate from the
            # ordinary redemption schedule and are never guessed as zero.
        else:
            raise ReconstructionError("invalid-type")
        if shares <= 0 or nav <= 0:
            raise ReconstructionError("invalid-execution")
        calculated = calculated_shares or calculated_nav
        row.update(shares=float(shares), nav=float(nav), navDate=day,
                   fee=float(fee) if fee is not None else None, status="confirmed",
                   sharesBasis="calculated" if calculated_shares else "reported")
        if calculated:
            row["sourceStatus"] = "calculated"
            note = (row.get("note") or "").strip()
            row["note"] = (note + " 按所提供流水及对应净值日的公开净值推算，份额保留两位；买入费率按用户设置；卖出按FIFO及持有期费率反推。买入/转入的缺失确认日按T+1推算。未证明不存在更早期初持仓。").strip()
        prepared.append(row)
    remaining = [{"confirmedDate": lot["date"], "remainingShares": float(lot["shares"]), "status": "confirmed"}
                 for lot in lots if lot["shares"] > 0]
    if not remaining:
        raise ReconstructionError("no-remaining-lots")
    return {
        "transactions": sorted(prepared, key=lambda row: (row["date"], row.get("submittedAt") or "", row["id"])),
        "holdingLots": {"complete": False, "basis": "calculated", "lots": remaining},
    }
