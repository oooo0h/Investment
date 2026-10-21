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

HEADERS = ["成交日期", "成交净值", "确认份额", "交易类型", "金额", "手续费（元）"]
NAV_SHEET = "全部历史净值"
PARAM_SHEET = "参数"


def iso_date(value, epoch):
    """Normalize a workbook date value for the public NAV lookup."""
    if isinstance(value, dt.datetime):
        return value.date().isoformat()
    if isinstance(value, dt.date):
        return value.isoformat()
    if type(value) in (int, float) and math.isfinite(value):
        try:
            converted = from_excel(value, epoch)
        except (ValueError, OverflowError):
            return None
        if isinstance(converted, dt.datetime):
            return converted.date().isoformat()
        if isinstance(converted, dt.date):
            return converted.isoformat()
        return None
    if isinstance(value, str):
        try:
            return dt.date.fromisoformat(value.strip()).isoformat()
        except ValueError:
            return None
    return None


def load_nav_map(book):
    if NAV_SHEET not in book.sheetnames:
        return {}
    result = {}
    for row in book[NAV_SHEET].iter_rows(min_row=2, values_only=True):
        date = iso_date(row[0], book.epoch) if row else None
        nav = row[1] if row and len(row) > 1 else None
        if date and type(nav) in (int, float) and math.isfinite(nav) and nav > 0:
            result[date] = nav
    return result


def load_fee_rate(book):
    if PARAM_SHEET not in book.sheetnames:
        return None
    for row in book[PARAM_SHEET].iter_rows(min_row=4, max_row=4, min_col=2, max_col=2, values_only=True):
        value = row[0] if row else None
        if type(value) in (int, float) and math.isfinite(value) and value >= 0:
            return value
    return None


def normalized_formula(value):
    return re.sub(r"\s+", "", str(value)).upper().replace("$", "").replace("'", "")


def is_nav_formula(value, row):
    expected = f'=IF(A{row}="","",IFERROR(VLOOKUP(A{row},全部历史净值!A:B,2,FALSE),""))'
    return isinstance(value, str) and normalized_formula(value) == normalized_formula(expected)


def is_share_formula(value, row):
    expected = (f'=IF(OR(A{row}="",B{row}="",D{row}="",E{row}=""),"",'
                f'IF(OR(D{row}="买入",D{row}="定投",D{row}="转入",D{row}="转换转入"),'
                f'ROUND((E{row}-F{row})/B{row},6),'
                f'IF(D{row}="卖出",ROUND((E{row}+F{row})/B{row},6),"")))')
    return isinstance(value, str) and normalized_formula(value) == normalized_formula(expected)


def fee_formula_rate(value, row):
    expected = f'=IF(E{row}="","",IF(D{row}="卖出","",ROUND(E{row}*参数!B4,2)))'
    return isinstance(value, str) and normalized_formula(value) == normalized_formula(expected)


def fee_formula_zero(value, row):
    expected = f'=IF(E{row}="","",IF(D{row}="卖出","",0))'
    return isinstance(value, str) and normalized_formula(value) == normalized_formula(expected)


def formula_fee_amount(value, row, kind, amount, rate):
    if amount is None or kind == "卖出" or kind not in ("买入", "定投", "转入", "转换转入"):
        return None
    if fee_formula_zero(value, row):
        return 0
    if fee_formula_rate(value, row) and rate is not None:
        return float((Decimal(str(amount)) * Decimal(str(rate))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
    return None


def formula_share_amount(value, row, kind, nav, amount, fee):
    if not is_share_formula(value, row) or nav is None or amount is None:
        return None
    fee_value = 0 if fee is None else fee
    if kind in ("买入", "定投", "转入", "转换转入"):
        cash = Decimal(str(amount)) - Decimal(str(fee_value))
    elif kind == "卖出":
        cash = Decimal(str(amount)) + Decimal(str(fee_value))
    else:
        return None
    if cash <= 0 or nav <= 0:
        return None
    return float((cash / Decimal(str(nav))).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP))


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
        nav_map = load_nav_map(book)
        fee_rate = load_fee_rate(book)
        sheet = book["交易记录"]
        rows = iter(sheet.iter_rows(values_only=True))
        calculated_rows = iter(calculated_book["交易记录"].iter_rows(values_only=True))
        header = list(next(rows))
        # "成交日期" is the current label; keep "交易日期" for older bond tables.
        if len(header) != 6 or header[0] not in ("交易日期", "成交日期") or header[1:] != HEADERS[1:]:
            raise ValueError("Six-column header mismatch")
        next(calculated_rows)
        transactions = []
        provenance = {entry['row']: entry for entry in (provenance or [])}
        for index, row in enumerate(rows, 2):
            calculated_row = next(calculated_rows)
            # Pre-filled gray formula rows are not transactions until a date,
            # type or amount is entered; their empty cached results stay blank.
            if all(value is None or value == "" for value in calculated_row):
                continue
            if len(row) != 6:
                raise ValueError("Six-column row mismatch")
            # Read Excel's saved calculation results without executing formulas.
            # Missing/error results stay unknown, never zero or a new estimate.
            formula_columns = [column for column in (1, 2, 4, 5)
                               if isinstance(row[column], str) and row[column].startswith('=')]
            raw_row = list(row)
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
            # openpyxl rewrites drop every cached formula result. Recompute only
            # the known six-column templates so new and historical rows stay
            # readable without executing arbitrary workbook formulas.
            formula_fallback = False
            if 1 in formula_columns and row[1] is None and is_nav_formula(raw_row[1], index) and isinstance(date, str):
                candidate = nav_map.get(date)
                if candidate is not None:
                    row[1] = candidate
                    formula_fallback = True
            if 5 in formula_columns and row[5] is None:
                candidate = formula_fee_amount(raw_row[5], index, kind, row[4], fee_rate)
                if candidate is not None:
                    row[5] = candidate
                    formula_fallback = True
            if 2 in formula_columns and row[2] is None:
                candidate = formula_share_amount(raw_row[2], index, kind, row[1], row[4], row[5])
                if candidate is not None:
                    row[2] = candidate
                    formula_fallback = True
            nav, shares, amount, fee = map(number, (row[1], row[2], row[4], row[5]))
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
            if formula_fallback:
                transaction['formulaFallback'] = True
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
