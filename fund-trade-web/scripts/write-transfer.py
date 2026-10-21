"""Write both sides of a transfer, saving both temporary files before replacing.

Uses the single-workbook helpers from write-workbook.py. The response contains
only row numbers and hashes, never amounts or shares.
"""
import datetime as dt
import importlib.util
import json
import os
import pathlib
import shutil
import sys
import uuid

spec = importlib.util.spec_from_file_location("workbook_writer", pathlib.Path(__file__).with_name("write-workbook.py"))
writer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(writer)


def main():
    request = json.load(sys.stdin)
    workspace = pathlib.Path(request["workspace"]).resolve()
    action = request.get("action")
    items = request.get("items")
    if action not in ("append_pair", "update_pair") or not isinstance(items, list) or len(items) != 2:
        writer.fail("Invalid pair request")
    held = (workspace / "基金" / "持仓基金").resolve()
    prepared = []
    try:
        for item in items:
            code = str(item.get("code", ""))
            relative = item.get("path")
            if len(code) != 6 or not code.isdigit() or not isinstance(relative, str) or not relative:
                writer.fail("Invalid fund")
            file = (workspace / relative).resolve()
            if not file.is_relative_to(held) or not file.name.startswith(f"{code}_") or file.suffix.lower() != ".xlsx":
                writer.fail("Workbook outside fund archive")
            data = file.read_bytes()
            before = writer.digest(data)
            expected = item.get("expected_sha256")
            if expected and before != expected:
                writer.fail("Workbook changed before writing")
            book = writer.load_workbook(file, data_only=False)
            if writer.SHEET not in book.sheetnames:
                writer.fail("Missing transaction sheet")
            ws = book[writer.SHEET]
            header = [ws.cell(1, column).value for column in range(1, 7)]
            if len(header) != 6 or header[0] not in ("交易日期", "成交日期") or header[1:] != writer.HEADERS[1:]:
                writer.fail("Header mismatch")
            if action == "append_pair":
                row = writer.find_target(ws)
            else:
                row = item.get("row")
                writer.validate_target(ws, row, item.get("expect"))
            writer.write_cells(ws, row, item.get("cells") or {})
            writer.extend_type_validation(ws, row)
            try:
                book.calculation = writer.CalcProperties(calcMode="auto", fullCalcOnLoad=True)
            except Exception:
                pass
            temporary = file.with_name(f".{file.stem}.{uuid.uuid4().hex}.tmp.xlsx")
            book.save(temporary)
            book.close()
            prepared.append({"file": file, "temporary": temporary, "row": row, "code": code})
        backup_dir = workspace / "临时文件" / "交易登记备份"
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        backups = []
        for item in prepared:
            backup = backup_dir / f"{item['code']}_{stamp}_{uuid.uuid4().hex[:8]}.xlsx"
            shutil.copyfile(item["file"], backup)
            backups.append(str(backup.relative_to(workspace)).replace("\\", "/"))
        for item in prepared:
            os.replace(item["temporary"], item["file"])
        result = [{"row": item["row"], "sha256": writer.digest(item["file"].read_bytes())} for item in prepared]
        sys.stdout.write(json.dumps({"ok": True, "items": result, "backups": backups}, ensure_ascii=False))
    finally:
        for item in prepared:
            try:
                if item["temporary"].exists():
                    item["temporary"].unlink()
            except OSError:
                pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("Transfer workbook write failed.\n")
        sys.exit(1)
