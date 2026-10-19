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
import sys

from openpyxl import load_workbook

HEADERS = ["交易日期", "成交净值", "确认份额", "交易类型", "金额", "手续费（元）"]


def number(value):
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("Invalid numeric field")
    return value


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
            row = list(row)
            for column in formula_columns:
                cached = calculated_row[column]
                row[column] = cached if type(cached) in (int, float) and math.isfinite(cached) else None
            date, nav, shares, kind, amount, fee = row
            if isinstance(date, (dt.date, dt.datetime)):
                date = date.date().isoformat() if isinstance(date, dt.datetime) else date.isoformat()
            draft = allow_drafts and (date is None or date == "" or kind is None or kind == "")
            if allow_drafts and (date is None or date == ""):
                date = None
            elif not isinstance(date, str) or dt.date.fromisoformat(date).isoformat() != date:
                raise ValueError("Invalid transaction date")
            if kind not in ("买入", "卖出") and not (allow_drafts and kind in (None, "")):
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
            transactions.append({
                "id": f"{code}-workbook-{index}", "date": date,
                "submittedAt": date, "dateBasis": "order", "navDate": detail.get('nav_date'),
                "type": "buy" if kind == "买入" else "sell" if kind == "卖出" else "unknown",
                "nav": nav, "shares": shares, "amount": amount, "fee": fee,
                "status": historical_status if complete and not conflict else "pending",
                "sourceStatus": "draft" if draft else "unverified" if conflict else "formula-calculated" if formula_columns else "historical-estimate" if historical_status == 'estimated' else ("complete" if complete else "incomplete"),
            })
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
