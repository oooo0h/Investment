"""Compute a FIFO redemption fee for a local sell or transfer-out row.

The workbook is read with the site reader so missing formula caches still yield
shares. The response contains fee figures for the local writer only and is
never logged.
"""
import datetime as dt
import importlib.util
import io
import json
import math
import pathlib
import sys
from decimal import Decimal, ROUND_HALF_UP

spec = importlib.util.spec_from_file_location("workbook_reader", pathlib.Path(__file__).with_name("local-workbooks.py"))
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


def fail(message):
    raise ValueError(message)


def number(value):
    if type(value) in (int, float) and math.isfinite(value) and value > 0:
        return value
    fail("Invalid number")


def main():
    request = json.load(sys.stdin)
    workspace = pathlib.Path(request["workspace"]).resolve()
    code = str(request.get("code", ""))
    relative = request.get("path")
    if len(code) != 6 or not code.isdigit() or not isinstance(relative, str) or not relative:
        fail("Invalid fund")
    file = (workspace / relative).resolve()
    held = (workspace / "基金" / "持仓基金").resolve()
    if not file.is_relative_to(held) or not file.name.startswith(f"{code}_") or file.suffix.lower() != ".xlsx":
        fail("Workbook outside fund archive")
    nav = Decimal(str(number(request.get("nav"))))
    shares = Decimal(str(number(request.get("shares"))))
    sale_date = request.get("sale_date")
    if not isinstance(sale_date, str):
        fail("Invalid sale date")
    sale = dt.date.fromisoformat(sale_date)
    tiers = request.get("tiers")
    if not isinstance(tiers, list) or not tiers:
        fail("Invalid fee tiers")
    normalized_tiers = []
    for tier in tiers:
        if not isinstance(tier, list) or len(tier) != 2:
            fail("Invalid fee tier")
        limit, rate = tier
        if limit is None:
            limit = 1e12
        if not isinstance(limit, (int, float)) or not math.isfinite(limit) or not isinstance(rate, (int, float)) or not math.isfinite(rate) or rate < 0:
            fail("Invalid fee tier")
        normalized_tiers.append((limit, Decimal(str(rate))))
        if limit < 0:
            fail("Invalid fee tier")
    exclude = request.get("exclude_row")
    exclude_id = f"{code}-workbook-{exclude}" if isinstance(exclude, int) else None

    rows = reader.read_book(file.read_bytes(), code, True, None, True)
    rows = [row for row in rows if row.get("id") != exclude_id
            and isinstance(row.get("date"), str)
            and row.get("shares") is not None]
    rows.sort(key=lambda row: (row["date"], int(row["id"].rsplit("-", 1)[-1])))
    lots = []
    for row in rows:
        row_shares = Decimal(str(row["shares"]))
        if row_shares <= 0:
            continue
        if row["type"] in ("buy", "sip", "transfer-in") and row.get("status") in ("estimated", "confirmed"):
            lots.append({"date": row["date"], "shares": row_shares})
        elif row["type"] == "sell" and row.get("status") in ("estimated", "confirmed", "pending"):
            # Pending sells are committed shares: they reduce what can be sold
            # again, but they are not charged a second fee here.
            remaining = row_shares
            for lot in lots:
                take = min(remaining, lot["shares"])
                if take > 0:
                    lot["shares"] -= take
                    remaining -= take
                if remaining <= 0:
                    break
            if remaining > Decimal("0.000001"):
                fail("Historical shares exceed available lots")
    available = sum((lot["shares"] for lot in lots), Decimal("0"))
    if shares > available + Decimal("0.000001"):
        sys.stdout.write(json.dumps({"ok": False, "error": "insufficient", "available": float(available)}, ensure_ascii=False))
        return
    remaining = shares
    gross = Decimal("0")
    fee = Decimal("0")
    for lot in lots:
        if remaining <= 0:
            break
        take = min(remaining, lot["shares"])
        if take <= 0:
            continue
        days = (sale - dt.date.fromisoformat(lot["date"])).days
        if days < 0:
            fail("Invalid holding period")
        rate = None
        for limit, candidate in normalized_tiers:
            if days < limit:
                rate = candidate
                break
        if rate is None:
            fail("Invalid fee tier")
        gross += take * nav
        fee += take * nav * rate
        remaining -= take
    if remaining > Decimal("0.000001"):
        fail("Insufficient shares")
    fee = fee.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    gross = gross.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    net = (gross - fee).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if net <= 0:
        fail("Invalid net amount")
    sys.stdout.write(json.dumps({"ok": True, "fee": float(fee), "gross": float(gross), "net": float(net), "available": float(available)}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("Redemption fee calculation failed.\n")
        sys.exit(1)
