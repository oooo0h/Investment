"""Read the six-column business workbooks. JSON goes only to the parent pipe.

Never invoke this as a diagnostic command: the parent captures stdout in memory.
No original workbook, plaintext cache, or account log is written.
"""
import datetime as dt
import hashlib
import io
import json
import math
import pathlib
import re
import sys
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation

from openpyxl import load_workbook
from openpyxl.utils.datetime import from_excel

HEADERS = ["交易日期", "成交净值", "确认份额", "交易类型", "金额", "手续费（元）"]


def number(value):
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("Invalid numeric field")
    return value


def fee_adjusted_formula_shares(formula, index, kind, nav, cached_shares, amount, fee):
    """Correct only the known same-row gross-cash/share formula, never literal fills.

    Do not evaluate arbitrary Excel formulas or replace missing/error caches.
    Amount means purchase total cash outlay or sale net proceeds in this format.
    """
    if kind not in ('买入', '卖出', '转入', '转换转入') or not isinstance(formula, str):
        return None
    normalized = re.sub(r'\s+', '', formula).upper().replace('$', '')
    if normalized != f'=E{index}/B{index}':
        return None
    if not all(type(value) in (int, float) and math.isfinite(value)
               for value in (nav, cached_shares, amount, fee)):
        return None
    if nav <= 0 or cached_shares <= 0 or amount <= 0 or fee <= 0:
        return None
    try:
        cash = Decimal(str(amount)) + Decimal(str(fee)) * (1 if kind == '卖出' else -1)
        if cash <= 0:
            return None
        shares = float((cash / Decimal(str(nav))).quantize(Decimal('0.000001'), rounding=ROUND_HALF_UP))
        return shares if math.isfinite(shares) and shares > 0 else None
    except (InvalidOperation, ZeroDivisionError):
        return None


def read_book(data, code, estimated=False, provenance=None, allow_drafts=False):
    book = load_workbook(io.BytesIO(data), read_only=True, data_only=False)
    calculated_book = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        sheet = book["交易记录"]
        rows = iter(sheet.iter_rows(values_only=True))
        calculated_rows = iter(calculated_book["交易记录"].iter_rows(values_only=True))
        if list(next(rows)) != HEADERS:
            raise ValueError("Six-column header mismatch")
        next(calculated_rows)
        transactions = []
        provenance = {entry['row']: entry for entry in (provenance or [])}
        for index, row in enumerate(rows, 2):
            calculated_row = next(calculated_rows)
            if all(value is None for value in row):
                continue
            if len(row) != 6:
                raise ValueError("Six-column row mismatch")
            # Read Excel's saved calculation results without executing formulas.
            # Missing/error results stay unknown, never zero or a new estimate.
            formula_columns = [column for column in (1, 2, 4, 5)
                               if isinstance(row[column], str) and row[column].startswith('=')]
            share_formula = row[2] if 2 in formula_columns else None
            row = list(row)
            for column in formula_columns:
                cached = calculated_row[column]
                row[column] = cached if type(cached) in (int, float) and math.isfinite(cached) else None
            date, nav, shares, kind, amount, fee = row
            if type(date) in (int, float) and math.isfinite(date):
                try:
                    serial_date = from_excel(date, book.epoch)
                    if not isinstance(serial_date, (dt.date, dt.datetime)):
                        raise ValueError('Invalid transaction date')
                    date = serial_date
                except (ValueError, OverflowError):
                    raise ValueError('Invalid transaction date') from None
            if isinstance(date, (dt.date, dt.datetime)):
                date = date.date().isoformat() if isinstance(date, dt.datetime) else date.isoformat()
            draft = allow_drafts and (date is None or date == "" or kind is None or kind == "")
            if allow_drafts and (date is None or date == ""):
                date = None
            elif not isinstance(date, str) or dt.date.fromisoformat(date).isoformat() != date:
                raise ValueError("Invalid transaction date")
            if kind not in ("买入", "卖出", "转入", "转换转入") and not (allow_drafts and kind in (None, "")):
                raise ValueError("Invalid transaction type")
            nav, shares, amount, fee = map(number, (nav, shares, amount, fee))
            if any(value is not None and value < 0 for value in (nav, shares, amount, fee)):
                raise ValueError("Negative transaction field")
            if nav == 0 or shares == 0 or amount == 0:
                raise ValueError("Nonpositive transaction field")
            complete = not draft and all(value is not None for value in (nav, shares, amount, fee))
            detail = provenance.get(index, {})
            historical_status = detail.get('status', 'estimated' if estimated else 'confirmed')
            if formula_columns:
                historical_status = 'estimated'
            conflict = detail.get('conflict') is True
            adjusted = None if conflict else fee_adjusted_formula_shares(
                share_formula, index, kind, nav, shares, amount, fee)
            if adjusted is not None:
                shares = adjusted
            transaction = {
                "id": f"{code}-workbook-{index}", "date": date,
                "submittedAt": date, "dateBasis": "order", "navDate": detail.get('nav_date'),
                "type": "buy" if kind == "买入" else "sell" if kind == "卖出" else "transfer-in" if kind in ("转入", "转换转入") else "unknown",
                "nav": nav, "shares": shares, "amount": amount, "fee": fee,
                "status": historical_status if complete and not conflict else "pending",
                "sourceStatus": "draft" if draft else "unverified" if conflict else "formula-calculated" if formula_columns else "incomplete" if not complete else "historical-estimate" if historical_status == 'estimated' else "complete",
            }
            if adjusted is not None:
                transaction['formulaAdjustment'] = 'sale-gross-shares' if kind == '卖出' else 'purchase-net-shares'
                transaction['calculationNote'] = (
                    '原份额公式未计手续费，已按买入总支出扣除手续费后重新估算份额；请以实际确认份额为准。'
                    if kind != '卖出' else
                    '原份额公式未计手续费，已按卖出到账加上手续费后重新估算份额；请以实际确认份额为准。')
            transactions.append(transaction)
        # Stable order for multiple orders on the same date.
        return sorted(transactions, key=lambda tx: tx["date"] or "9999-12-31")
    finally:
        book.close()
        calculated_book.close()


def main():
    request = json.load(sys.stdin)
    workspace = pathlib.Path(request["workspace"]).resolve()
    result = {}
    for source in request["sources"]:
        file = (workspace / source["path"]).resolve()
        if not file.is_relative_to(workspace / "基金"):
            raise ValueError("Workbook outside fund archive")
        data = file.read_bytes()
        checksum = hashlib.sha256(data).hexdigest()
        matched_provenance = checksum == source.get('workbook_sha256')
        estimated = True if source.get('workbook_sha256') and not matched_provenance else source.get('estimated', True)
        result[source["code"]] = {
            "transactions": read_book(data, source["code"], estimated,
                                      source.get('row_provenance') if matched_provenance else None,
                                      source.get('allow_drafts', False)),
            "sha256": checksum,
        }
    sys.stdout.write(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("Transaction workbook validation failed.\n")
        sys.exit(1)
