"""Prepare and verify one complete NAV file per format; apply cleanup separately.

Only public NAV folders are read. Account records and portfolio state are not read.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import re
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / "公共资料/工具/tmp/净值目录整理"
HEADERS = ["日期", "净值", "日增长率"]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def number(value):
    if value is None or str(value).strip() in ("", "--", "---", "-", "None"):
        return None
    text = str(value).strip().removesuffix("%")
    if not Decimal(text).is_finite():
        raise ValueError("Non-finite public NAV")
    return text


def validate_csv(doc, saved):
    assert len(saved) == doc["count"]
    for item, row in zip(saved, doc["rows"]):
        assert list(item) == HEADERS
        assert item["日期"] == row["date"]
        assert item["净值"] == str(row["nav"])
        growth = row.get("daily_growth_pct")
        assert item["日增长率"] == ("" if growth is None else str(growth) + "%")


def validate(doc):
    rows = doc["rows"]
    assert re.fullmatch(r"\d{6}", doc["code"])
    assert rows and len(rows) == doc["count"]
    dates = [r["date"] for r in rows]
    assert dates == sorted(set(dates))
    assert dates[0] == doc["first_date"] and dates[-1] == doc["last_date"]
    for row in rows:
        dt.date.fromisoformat(row["date"])
        assert Decimal(row["nav"]) > 0
        for key in ("accumulated_nav", "daily_growth_pct"):
            number(row.get(key))


def prepare():
    STATE.mkdir(parents=True, exist_ok=True)
    funds = []
    for history in sorted((ROOT / "基金").glob("*/*/历史净值")):
        code = history.parent.name[:6]
        candidates = []
        for file in history.glob(code + "_全部历史净值*.json"):
            doc = json.loads(file.read_text(encoding="utf-8-sig"))
            if isinstance(doc, dict) and isinstance(doc.get("rows"), list):
                validate(doc)
                assert doc["code"] == code
                candidates.append((doc["last_date"], doc["count"], file.stat().st_mtime_ns, file, doc))
        if not candidates:
            raise ValueError(f"Full-history JSON must be acquired before cleanup: {code}")
        *_, selected, source = max(candidates, key=lambda x: x[:3])
        rows = {r["date"]: dict(r) for r in source["rows"]}
        for row in rows.values():
            for field in ("nav", "accumulated_nav", "daily_growth_pct"):
                row[field] = number(row.get(field))
        superseded = []
        # A complete, newer CSV can contain an additional published day (bond funds).
        for file in sorted(history.glob(code + "_全部历史净值*.csv")):
            with file.open(encoding="utf-8-sig", newline="") as handle:
                batch = list(csv.DictReader(handle))
            for item in batch:
                day = item.get("日期", item.get("净值日期"))
                value = number(item.get("净值", item.get("单位净值")))
                if day in rows:
                    if Decimal(str(rows[day]["nav"])) != Decimal(value):
                        dated = re.search(r"截至(\d{4}-\d{2}-\d{2})", file.name)
                        if not dated or dated[1] >= source["last_date"]:
                            raise ValueError(f"Conflicting current complete sources: {code} {day}")
                        superseded.append({"date": day, "prior_nav": value, "retained_nav": rows[day]["nav"],
                                           "prior_source_file": file.name, "retained_source_file": selected.name})
                    else:
                        # Preserve the original decimal precision, including trailing zeros.
                        for field, label in (("nav", "单位净值"), ("accumulated_nav", "累计净值"), ("daily_growth_pct", "日增长率(%)")):
                            old_value = number(rows[day].get(field))
                            csv_value = number(item.get(label, item.get({"nav": "净值", "daily_growth_pct": "日增长率"}.get(field, label))))
                            if old_value is not None and csv_value is not None and Decimal(old_value) == Decimal(csv_value) and len(csv_value) > len(old_value):
                                rows[day][field] = csv_value
                elif day > source["last_date"]:
                    rows[day] = {"date": day, "nav": value,
                                 "accumulated_nav": number(item.get("累计净值")),
                                 "daily_growth_pct": number(item.get("日增长率", item.get("日增长率(%)", item.get("官网单位净值日增长率（%）")))),
                                 "event": item.get("分红事件", ""),
                                 "source": item.get("数据来源", source.get("source", source.get("source_type", "既有完整公开净值CSV")))}
                else:
                    raise ValueError(f"Older complete CSV has an unexplained date: {code} {day}")
        # Prove that the retained master covers every date in earlier complete masters.
        for *_, file, old in candidates:
            assert {r["date"] for r in old["rows"]}.issubset(rows), f"Lost date: {file.name}"
        ordered = [rows[d] for d in sorted(rows)]
        keys = ("code", "name", "share_class", "holding_identity_status", "identity_status",
                "source", "source_type", "sources", "source_urls", "checked_at", "downloaded_at", "inception_date", "field_notes", "public_dividend_records")
        doc = {k: source[k] for k in keys if k in source}
        doc.update(schema="public-fund-nav-v1", first_date=ordered[0]["date"], last_date=ordered[-1]["date"], count=len(ordered), rows=ordered)
        doc["storage_policy"] = "本文件为该份额唯一全历史净值主档；更新时合并新日期、按日期去重，原子替换同名文件。"
        if superseded or source.get("superseded_values"):
            doc["superseded_values"] = source.get("superseded_values", []) + superseded
        doc["validation"] = {"unique_date_count": len(ordered), "duplicate_dates": 0,
                             "prior_full_history_dates_preserved": True,
                             "missing_accumulated_nav_count": sum(number(r.get("accumulated_nav")) is None for r in ordered),
                             "source_verification": source.get("validation", {}).get("source_verification", source.get("validation", {}))}
        # Supplemental third-party dates remain separate from the official main series.
        supplements = list(source.get("supplementary_rows", []))
        for file in history.glob(code + "_*补充*待官网复核*.json"):
            extra = json.loads(file.read_text(encoding="utf-8-sig"))
            if isinstance(extra.get("rows"), list):
                supplements.extend(extra["rows"])
        if supplements:
            doc["supplementary_rows"] = list({r["date"]: r for r in supplements}.values())
            doc["supplementary_note"] = "待官网复核的第三方记录，不混入rows主序列、主CSV或主表；不据此填补或推算官方净值。"
        validate(doc)
        stage = STATE / code
        stage.mkdir(exist_ok=True)
        filename = code + "_全部历史净值"
        staged_json = stage / (filename + ".json")
        staged_json.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        originals = {f.relative_to(ROOT).as_posix(): sha(f.read_bytes()) for f in history.rglob("*") if f.is_file()}
        funds.append({"code": code, "folder": history.parent.relative_to(ROOT).as_posix(),
                      "history": history.relative_to(ROOT).as_posix(), "json": str(staged_json),
                      "xlsx": any(history.glob("*.xlsx")), "selected_source": selected.relative_to(ROOT).as_posix(),
                      "count": doc["count"], "first_date": doc["first_date"], "last_date": doc["last_date"],
                      "original_files": originals})
    plan = {"schema": "nav-storage-cleanup-v1", "root": str(ROOT), "funds": funds}
    (STATE / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"funds": len(funds), "original_files": sum(len(f["original_files"]) for f in funds),
                      "retained_files": sum(2 + f["xlsx"] for f in funds), "xlsx": sum(f["xlsx"] for f in funds),
                      "plan": str(STATE / "plan.json")}, ensure_ascii=False))


def check_staged():
    plan = json.loads((STATE / "plan.json").read_text(encoding="utf-8"))
    for fund in plan["funds"]:
        file = Path(fund["json"])
        doc = json.loads(file.read_text(encoding="utf-8"))
        validate(doc)
        csv_file = file.with_suffix(".csv")
        assert csv_file.read_bytes().startswith(b"\xef\xbb\xbf")
        saved = list(csv.DictReader(io.StringIO(csv_file.read_text(encoding="utf-8-sig"))))
        validate_csv(doc, saved)
        if fund["xlsx"]:
            assert file.with_suffix(".xlsx").is_file()
        for rel, digest in fund["original_files"].items():
            original = ROOT / rel
            # Original folders may already have been replaced after a completed cleanup.
            if original.exists() and original.name != doc["code"] + "_全部历史净值.json":
                assert sha(original.read_bytes()) == digest, "Source changed since preparation"
    print(json.dumps({"verified_staged_funds": len(plan["funds"]), "all_rows_roundtrip_checked": True}))


def publish_index():
    entries = []
    for history in sorted((ROOT / "基金").glob("*/*/历史净值")):
        code = history.parent.name[:6]
        files = list(history.iterdir())
        assert all(f.is_file() for f in files), "History contains a subdirectory"
        assert len({f.suffix.lower() for f in files}) == len(files) <= 3
        assert all(f.stem == code + "_全部历史净值" and f.suffix in (".json", ".csv", ".xlsx") for f in files)
        file = history / (code + "_全部历史净值.json")
        doc = json.loads(file.read_text(encoding="utf-8-sig"))
        validate(doc)
        with file.with_suffix(".csv").open(encoding="utf-8-sig", newline="") as handle:
            saved = list(csv.DictReader(handle))
        validate_csv(doc, saved)
        entry = {"code": code, "name": doc["name"], "records": doc["count"], "first_date": doc["first_date"], "last_date": doc["last_date"],
                 "source": doc.get("source", doc.get("source_type")),
                 "json_path": file.relative_to(ROOT).as_posix(), "csv_path": file.with_suffix(".csv").relative_to(ROOT).as_posix(),
                 "json_sha256": sha(file.read_bytes()), "csv_sha256": sha(file.with_suffix(".csv").read_bytes())}
        if file.with_suffix(".xlsx").exists():
            entry["xlsx_path"] = file.with_suffix(".xlsx").relative_to(ROOT).as_posix()
            entry["xlsx_sha256"] = sha(file.with_suffix(".xlsx").read_bytes())
        entries.append(entry)
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="seconds")
    archive = ROOT / "公共资料/历史净值"
    pointer = {"schema": "all-fund-nav-current-v1", "updated_at": now,
               "storage_policy": "每只基金、每种格式只保存一份固定文件名的完整历史主档；日期见文件内容。",
               "table_columns": HEADERS, "funds": entries}
    (archive / "全基金历史净值当前入口.json").write_text(json.dumps(pointer, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    text = "# 全基金历史净值当前入口\n\n" + f"整理核验：{now}。基金目录仅保留历史净值与定期报告；数据文件按固定名称更新。以下为全部研究产品的数据目录，不代表当前账户持仓。\n\n"
    text += "CSV与Excel统一只保留三列：日期、净值、日增长率。JSON继续保留来源、累计净值及核验信息。\n\n"
    text += "| 代码 | 基金名称 | 条数 | 起始净值日 | 最新净值日 | 完整历史文件 |\n|---|---|---:|---|---|---|\n"
    for entry in entries:
        links = []
        for fmt in ("json", "csv", "xlsx"):
            if fmt + "_path" in entry:
                links.append(f"[{fmt.upper()}](../../{entry[fmt + '_path']})")
        text += f"| {entry['code']} | {entry['name']} | {entry['records']} | {entry['first_date']} | {entry['last_date']} | {' · '.join(links)} |\n"
    (archive / "全基金历史净值当前入口.md").write_text(text, encoding="utf-8")
    old_pointer = archive / "四基金历史净值当前入口.json"
    if old_pointer.exists():
        previous = json.loads(old_pointer.read_text(encoding="utf-8"))
        codes = previous.get("scope", ["270023", "005698", "016701", "006373"])
        previous["funds"] = [e for e in entries if e["code"] in codes]
        previous["updated_at"] = now
        previous["storage_policy"] = pointer["storage_policy"]
        previous["table_columns"] = HEADERS
        previous["all_funds_pointer"] = "公共资料/历史净值/全基金历史净值当前入口.json"
        old_pointer.write_text(json.dumps(previous, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (archive / "四基金历史净值当前入口.md").write_text("# 四基金历史净值当前入口\n\n当前路径、日期与哈希已同步固定文件名，详见[全基金当前入口](全基金历史净值当前入口.md)及[四基金机器入口](四基金历史净值当前入口.json)。旧核验报告保留为历史记录。\n", encoding="utf-8")
    print(json.dumps({"current_funds": len(entries), "current_files": sum(2 + ("xlsx_path" in e) for e in entries),
                      "total_public_nav_observations": sum(e["records"] for e in entries), "installed_data_verified": True}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-staged", action="store_true")
    parser.add_argument("--index", action="store_true", help="Verify installed files and refresh the public current index")
    args = parser.parse_args()
    if args.index:
        publish_index()
    elif args.check_staged:
        check_staged()
    else:
        prepare()
