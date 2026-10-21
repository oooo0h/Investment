"""Apply one local transaction registration to a six-column workbook.

The request arrives on stdin (amounts included), the response contains only
status, row and hashes. The original workbook is copied to the central
temporary archive and replaced atomically. Never print account values.
"""
import datetime as dt
import hashlib
import json
import os
import pathlib
import shutil
import sys
import uuid

from openpyxl import load_workbook
from openpyxl.workbook.properties import CalcProperties

HEADERS = ["成交日期", "成交净值", "确认份额", "交易类型", "金额", "手续费（元）"]
SHEET = "交易记录"
KINDS = ("买入", "卖出", "转入", "转换转入")


def fail(message):
    raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def parse_date(value):
    if not isinstance(value, str):
        fail("Invalid date")
    try:
        parsed = dt.date.fromisoformat(value)
    except ValueError:
        fail("Invalid date")
    if parsed.isoformat() != value:
        fail("Invalid date")
    return parsed


def normalized(value):
    if isinstance(value, dt.datetime):
        return value.date().isoformat()
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, str):
        return value
    return None


def find_target(ws):
    for row in range(2, ws.max_row + 1):
        values = [ws.cell(row, column).value for column in range(1, 7)]
        # Pre-filled gray formula rows are reusable; a draft with any literal
        # value (for example an amount but no date) must never be overwritten.
        if all(value is None or value == "" or (isinstance(value, str) and value.startswith("="))
               for value in values):
            return row
    fail("No free transaction row")


def validate_target(ws, row, expect):
    if not isinstance(row, int) or row < 2 or row > ws.max_row:
        fail("Invalid row")
    date = normalized(ws.cell(row, 1).value)
    kind = ws.cell(row, 4).value
    if not isinstance(kind, str) or kind not in KINDS:
        fail("Target row is not a transaction")
    if expect:
        if date != expect.get("date") or kind != expect.get("kind"):
            fail("Target row changed")
        shares = expect.get("shares")
        if shares is not None:
            current = ws.cell(row, 3).value
            if not isinstance(current, (int, float)) or abs(float(current) - float(shares)) > 1e-6:
                fail("Target row shares changed")


def write_cells(ws, row, cells):
    for column, value in cells.items():
        if column not in ("A", "B", "C", "D", "E", "F"):
            fail("Unknown column")
        cell = ws[f"{column}{row}"]
        if column == "A":
            cell.value = parse_date(value)
            cell.number_format = "yyyy-mm-dd"
        elif column == "D":
            if value not in KINDS:
                fail("Invalid type")
            cell.value = value
        else:
            cell.value = None if value is None else float(value)
            if column in ("E", "F"):
                cell.number_format = "#,##0.00"
            elif column in ("B", "C"):
                cell.number_format = "0.0000########" if column == "B" else "0.00######"


def extend_type_validation(ws, row):
    try:
        for validation in ws.data_validations.dataValidation:
            if validation.type == "list" and "D" in str(validation.sqref):
                validation.sqref = f"D2:D{max(ws.max_row, row)}"
    except Exception:
        # Validation metadata is cosmetic; never fail the write for it.
        pass


def main():
    request = json.load(sys.stdin)
    workspace = pathlib.Path(request["workspace"]).resolve()
    code = str(request.get("code", ""))
    relative = request.get("path")
    if not isinstance(relative, str) or not relative:
        fail("Missing workbook path")
    if len(code) != 6 or not code.isdigit():
        fail("Invalid fund code")
    file = (workspace / relative).resolve()
    held = (workspace / "基金" / "持仓基金").resolve()
    if not file.is_relative_to(held) or not file.name.startswith(f"{code}_") or file.suffix.lower() != ".xlsx":
        fail("Workbook outside fund archive")

    data = file.read_bytes()
    before = digest(data)
    expected = request.get("expected_sha256")
    if expected and before != expected:
        fail("Workbook changed before writing")

    book = load_workbook(file, data_only=False)
    if SHEET not in book.sheetnames:
        fail("Missing transaction sheet")
    ws = book[SHEET]
    header = [ws.cell(1, column).value for column in range(1, 7)]
    if len(header) != 6 or header[0] not in ("交易日期", "成交日期") or header[1:] != HEADERS[1:]:
        fail("Header mismatch")

    action = request.get("action")
    if action == "append":
        row = find_target(ws)
    elif action == "update":
        row = request.get("row")
        validate_target(ws, row, request.get("expect"))
    elif action == "read":
        row = request.get("row")
        validate_target(ws, row, request.get("expect"))
        values = {}
        for column in ("A", "B", "C", "D", "E", "F"):
            value = ws[f"{column}{row}"].value
            if isinstance(value, dt.datetime):
                value = value.date().isoformat()
            elif isinstance(value, dt.date):
                value = value.isoformat()
            values[column] = value
        sys.stdout.write(json.dumps({"ok": True, "row": row, "values": values}, ensure_ascii=False))
        book.close()
        return
    else:
        fail("Unknown action")

    write_cells(ws, row, request.get("cells") or {})
    extend_type_validation(ws, row)
    try:
        book.calculation = CalcProperties(calcMode="auto", fullCalcOnLoad=True)
    except Exception:
        pass

    backup_dir = workspace / "临时文件" / "交易登记备份"
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = backup_dir / f"{code}_{stamp}_{uuid.uuid4().hex[:8]}.xlsx"
    shutil.copyfile(file, backup)

    temporary = file.with_name(f".{file.stem}.{uuid.uuid4().hex}.tmp.xlsx")
    try:
        book.save(temporary)
        book.close()
        os.replace(temporary, file)
    finally:
        try:
            if temporary.exists():
                temporary.unlink()
        except OSError:
            pass
    after = digest(file.read_bytes())
    sys.stdout.write(json.dumps({
        "ok": True, "row": row, "sha256": after,
        "backup": str(backup.relative_to(workspace)).replace("\\", "/"),
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("Transaction workbook write failed.\n")
        sys.exit(1)
