"""Read original workbooks in memory and publish only an encrypted ledger.

The password is read from standard input. No plaintext ledger, account values,
password, or encryption key is written to disk or emitted to stdout.
"""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone, timedelta
import hashlib
import getpass
import json
import math
from pathlib import Path
import re
import secrets
import sys

import openpyxl
from openpyxl.utils.datetime import from_excel
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


ITERATIONS = 600_000
TYPE_MAP = {
    "买入": "buy", "定投": "sip", "卖出": "sell", "红利再投": "reinvest",
    "现金分红": "dividend", "转换转入": "transfer-in",
}
STATUS_MAP = {
    "已确认": "confirmed", "历史估算": "estimated", "已录入": "confirmed",
    "待确认": "pending", "待修正": "pending", "撤单": "cancelled",
    "交易失败": "failed", "交易关闭": "closed",
}
FUND_CODES = {
    "005698", "270023", "006373", "016701", "000216",
    "009608", "018124", "015789", "019454", "022459",
}
TX_KEYS = {"id", "date", "type", "nav", "shares", "fee", "amount", "cost", "status", "note", "submittedAt", "sourceStatus"}
TEMPLATE_SUFFIX = "单笔交易自动计算_双模式_模板2026-09-28.xlsx"
UNCONFIRMED_STATUSES = {"pending", "cancelled", "failed", "closed"}


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) else None


def iso_date(value, epoch):
    if isinstance(value, (datetime, date)):
        return value.strftime("%Y-%m-%d")
    if number(value) is not None:
        result = from_excel(value, epoch)
        if isinstance(result, (datetime, date)):
            return result.strftime("%Y-%m-%d")
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.strip()).strftime("%Y-%m-%d")
        except ValueError:
            return None
    return None


def application_timestamp(value):
    if not isinstance(value, str) or len(value) != 19:
        raise ValueError("Invalid application timestamp")
    try:
        if datetime.strptime(value, "%Y-%m-%d %H:%M:%S").strftime("%Y-%m-%d %H:%M:%S") != value:
            raise ValueError("Invalid application timestamp")
    except (TypeError, ValueError):
        raise ValueError("Invalid application timestamp") from None
    return value


def source_metadata(note, status):
    """Read machine labels from the existing note column without inferring a fill."""
    metadata = {}
    if isinstance(note, str):
        stamp = re.search(r"(?:^|[；;\n])\s*申请时间\s*[：:]\s*([^；;\n]+)", note)
        if stamp:
            metadata["submittedAt"] = application_timestamp(stamp[1].strip())
        source_status = re.search(r"(?:^|[；;\n])\s*来源状态\s*[：:]\s*([a-z-]+)\s*(?=[；;\n]|$)", note)
        if source_status:
            metadata["sourceStatus"] = source_status[1]
    if status == "pending":
        metadata.setdefault("sourceStatus", "processing")
    elif status == "cancelled":
        metadata.setdefault("sourceStatus", "cancelled")
    return metadata


def read_fund(workspace: Path, code: str):
    matches = [item for item in (workspace / "基金").glob(f"*/{code}*/*{TEMPLATE_SUFFIX}")
               if item.is_file() and not item.name.startswith("~$")]
    if len(matches) != 1:
        raise ValueError(f"{code}: original template is missing or ambiguous")
    raw = openpyxl.load_workbook(matches[0], read_only=True, data_only=False)
    cached = openpyxl.load_workbook(matches[0], read_only=True, data_only=True)
    try:
        sheet = raw["逐笔交易"]
        cached_sheet = cached["逐笔交易"]
        mode = "principal-first" if raw["持仓总览"]["C7"].value == "本金优先" else "profit-first"
        transactions = []
        cached_rows = cached_sheet.iter_rows(min_row=7, max_col=8, values_only=True)
        raw_rows = sheet.iter_rows(min_row=7, max_col=8, values_only=True)
        for sheet_row, (values, cached_values) in enumerate(zip(raw_rows, cached_rows), start=7):
            nav_date, kind, nav, shares, amount, fee, status, _note = values
            if all(value is None or value == "" for value in (nav_date, kind, nav, shares, fee)):
                continue
            if kind not in TYPE_MAP:
                raise ValueError(f"{code}: unrecognized transaction type")
            if isinstance(status, str) and status.startswith("="):
                status = cached_values[6] or "已确认"
            if status not in STATUS_MAP:
                raise ValueError(f"{code}: unrecognized confirmation status")
            normalized_date = iso_date(nav_date, raw.epoch)
            normalized_fields = []
            for value, cached_value in zip((nav, shares, fee), (cached_values[2], cached_values[3], cached_values[5])):
                resolved = cached_value if isinstance(value, str) and value.startswith("=") else value
                if resolved not in (None, "") and number(resolved) is None:
                    raise ValueError(f"{code}: a source confirmation field is invalid")
                normalized_fields.append(number(resolved))
            normalized_nav, normalized_shares, normalized_fee = normalized_fields
            normalized_status = STATUS_MAP[status]
            if normalized_date is None or (normalized_status not in UNCONFIRMED_STATUSES
                                           and any(value is None for value in normalized_fields)):
                raise ValueError(f"{code}: a source confirmation field is invalid")
            tx = {
                "id": f"{code}-row-{sheet_row}", "date": normalized_date,
                "type": TYPE_MAP[kind], "nav": normalized_nav,
                "shares": normalized_shares, "fee": normalized_fee,
                "status": normalized_status,
            }
            note = cached_values[7] if isinstance(_note, str) and _note.startswith("=") else _note
            if isinstance(note, str) and note.strip():
                tx["note"] = note.strip()
            tx.update(source_metadata(note, normalized_status))
            recorded_amount = number(amount)
            if recorded_amount is None and isinstance(amount, str) and amount.startswith("="):
                recorded_amount = number(cached_values[4])
            if recorded_amount is not None:
                tx["amount"] = recorded_amount
            if kind == "转换转入":
                if recorded_amount is None and normalized_status not in UNCONFIRMED_STATUSES:
                    raise ValueError(f"{code}: transfer-in requires recorded cost")
                if recorded_amount is not None:
                    tx["cost"] = recorded_amount
            if kind == "现金分红" and recorded_amount is None and normalized_status not in UNCONFIRMED_STATUSES:
                raise ValueError(f"{code}: dividend requires recorded amount")
            transactions.append(tx)
        fund = {"transactions": transactions, "mode": mode}
        validate_funds({code: fund}, allow_missing=True)
        return fund
    finally:
        raw.close()
        cached.close()


def read_source(source: Path):
    """Validate an explicitly selected local source; do not log its contents."""
    payload = json.loads(source.read_text(encoding="utf-8-sig"))
    if not isinstance(payload, dict) or not set(payload).issubset({"funds", "createdAt"}):
        raise ValueError("Invalid source root structure")
    if "createdAt" in payload and not isinstance(payload["createdAt"], str):
        raise ValueError("Invalid source timestamp")
    funds = payload.get("funds")
    validate_funds(funds)
    return funds


def read_workspace_funds(workspace: Path, existing_funds):
    """Replace only funds with an explicit local workbook; preserve the rest."""
    funds = dict(existing_funds)
    for code in sorted(FUND_CODES):
        candidates = [item for item in (workspace / "基金").glob(f"*/{code}*/*{TEMPLATE_SUFFIX}")
                      if item.is_file() and not item.name.startswith("~$")]
        if candidates:
            funds[code] = read_fund(workspace, code)
    return funds


def validate_funds(funds, allow_missing=False):
    if not isinstance(funds, dict) or (not set(funds).issubset(FUND_CODES) if allow_missing else set(funds) != FUND_CODES):
        raise ValueError("Source must contain the supported fund set")
    statuses = set(STATUS_MAP) | set(STATUS_MAP.values())
    for fund in funds.values():
        if not isinstance(fund, dict) or not {"transactions", "mode"}.issubset(fund) or not set(fund).issubset({"transactions", "mode", "incomplete", "sourceNote"}):
            raise ValueError("Invalid fund structure")
        if fund["mode"] not in ("profit-first", "principal-first") or not isinstance(fund["transactions"], list):
            raise ValueError("Invalid ledger settings")
        if "incomplete" in fund and not isinstance(fund["incomplete"], bool):
            raise ValueError("Invalid incomplete ledger flag")
        if "sourceNote" in fund and not isinstance(fund["sourceNote"], str):
            raise ValueError("Invalid source note")
        for tx in fund["transactions"]:
            if not isinstance(tx, dict) or not set(tx).issubset(TX_KEYS):
                raise ValueError("Invalid transaction structure")
            if not {"date", "type", "nav", "shares", "fee"}.issubset(tx):
                raise ValueError("A required confirmation field is missing")
            if tx["type"] not in TYPE_MAP.values():
                raise ValueError("Invalid transaction type")
            if "id" in tx and not isinstance(tx["id"], str):
                raise ValueError("Invalid transaction identifier")
            if "note" in tx and not isinstance(tx["note"], str):
                raise ValueError("Invalid transaction note")
            if "submittedAt" in tx:
                application_timestamp(tx["submittedAt"])
            if "sourceStatus" in tx and not isinstance(tx["sourceStatus"], str):
                raise ValueError("Invalid transaction source status")
            if fund.get("incomplete"):
                if tx["date"] != "" or any(tx[key] is not None for key in ("nav", "shares", "fee")):
                    raise ValueError("Incomplete applications must not imply confirmed NAV, shares, fees or date")
                if tx.get("status") not in ("pending", "cancelled") or tx.get("sourceStatus") not in ("processing", "unverified", "cancelled"):
                    raise ValueError("Invalid incomplete application status")
                if (tx["status"] == "cancelled") != (tx["sourceStatus"] == "cancelled"):
                    raise ValueError("Inconsistent cancelled application status")
                if number(tx.get("amount")) is None or tx["amount"] <= 0 or "cost" in tx:
                    raise ValueError("Invalid incomplete application amount")
                application_timestamp(tx.get("submittedAt"))
                continue
            if not isinstance(tx["date"], str) or len(tx["date"]) != 10:
                raise ValueError("Invalid confirmation date")
            try:
                if date.fromisoformat(tx["date"]).isoformat() != tx["date"]:
                    raise ValueError("Invalid confirmation date")
            except (TypeError, ValueError):
                raise ValueError("Invalid confirmation date") from None
            if "status" in tx and tx["status"] not in statuses:
                raise ValueError("Invalid confirmation status")
            normalized_status = STATUS_MAP.get(tx.get("status", "confirmed"), tx.get("status", "confirmed"))
            unconfirmed = normalized_status in UNCONFIRMED_STATUSES
            if not (unconfirmed and tx["nav"] is None) and (number(tx["nav"]) is None or tx["nav"] <= 0):
                raise ValueError("Invalid confirmation NAV")
            for key in ("shares", "fee", "amount", "cost"):
                if unconfirmed and key in ("shares", "fee") and tx[key] is None:
                    continue
                if key in tx and (number(tx[key]) is None or tx[key] < 0):
                    raise ValueError("Invalid numeric confirmation field")
            if unconfirmed:
                if normalized_status == "pending" and not any(number(tx.get(key)) is not None and tx[key] > 0
                                                             for key in ("amount", "shares")):
                    raise ValueError("Pending application requires an amount or shares")
                continue
            if tx["type"] == "dividend":
                if tx["shares"] != 0 or tx["fee"] != 0 or number(tx.get("amount")) is None or tx["amount"] <= 0:
                    raise ValueError("Invalid cash dividend confirmation")
            elif tx["shares"] <= 0:
                raise ValueError("Confirmed shares must be positive")
            if tx["type"] == "reinvest" and (tx["fee"] != 0 or tx.get("amount", 0) != 0):
                raise ValueError("Invalid reinvestment confirmation")
            if tx["type"] == "transfer-in" and number(tx.get("cost", tx.get("amount"))) is None:
                raise ValueError("Transfer-in requires actual cost")


def beijing_today_code():
    return datetime.now(timezone(timedelta(hours=8))).strftime("%m%d")


def daily_codes():
    start = date(2024, 1, 1)
    return [(start + timedelta(days=index)).strftime("%m%d") for index in range(366)]


def decode_b64(value):
    if not isinstance(value, str):
        raise ValueError("Invalid encoded encryption field")
    return base64.b64decode(value, validate=True)


def encode_b64(value):
    return base64.b64encode(value).decode("ascii")


def read_envelope(path: Path):
    envelope = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(envelope, dict) or envelope.get("kdf") != "PBKDF2-SHA256" or envelope.get("iterations") != ITERATIONS:
        raise ValueError("Unsupported encryption parameters")
    version = envelope.get("version")
    expected = {"version", "kdf", "iterations", "iv", "ciphertext"}
    if version == 1:
        expected.add("salt")
    elif version == 2:
        expected.add("keys")
    else:
        raise ValueError("Unsupported encrypted envelope version")
    if set(envelope) != expected:
        raise ValueError("Invalid encrypted envelope")
    if len(decode_b64(envelope["iv"])) != 12 or len(decode_b64(envelope["ciphertext"])) < 16:
        raise ValueError("Invalid encryption field lengths")
    if version == 1:
        if len(decode_b64(envelope["salt"])) != 16:
            raise ValueError("Invalid encryption salt")
    else:
        keys = envelope["keys"]
        if not isinstance(keys, dict) or set(keys) != set(daily_codes()):
            raise ValueError("The daily envelope must cover every calendar day")
        for wrapped in keys.values():
            if not isinstance(wrapped, dict) or set(wrapped) != {"salt", "iv", "ciphertext"}:
                raise ValueError("Invalid daily key wrapper")
            if len(decode_b64(wrapped["salt"])) != 16 or len(decode_b64(wrapped["iv"])) != 12 or len(decode_b64(wrapped["ciphertext"])) != 48:
                raise ValueError("Invalid daily key wrapper field lengths")
    return envelope


def wrap_daily_key(data_key, code):
    salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    kek = hashlib.pbkdf2_hmac("sha256", code.encode("utf-8"), salt, ITERATIONS, dklen=32)
    ciphertext = AESGCM(kek).encrypt(iv, data_key, None)
    return {"salt": encode_b64(salt), "iv": encode_b64(iv), "ciphertext": encode_b64(ciphertext)}


def create_daily_keys(data_key):
    codes = daily_codes()
    wrapped = {}
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {executor.submit(wrap_daily_key, data_key, code): code for code in codes}
        for completed, future in enumerate(as_completed(futures), start=1):
            wrapped[futures[future]] = future.result()
            if completed % 25 == 0 or completed == len(codes):
                print(f"Encryption preparation: {completed}/{len(codes)}", flush=True)
    return {code: wrapped[code] for code in codes}


def unwrap_daily_key(envelope, password):
    today = beijing_today_code()
    if password != today:
        raise ValueError("Only the current Beijing calendar day code can unlock this envelope")
    wrapped = envelope["keys"][today]
    salt, iv, ciphertext = (decode_b64(wrapped[key]) for key in ("salt", "iv", "ciphertext"))
    kek = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS, dklen=32)
    data_key = AESGCM(kek).decrypt(iv, ciphertext, None)
    if len(data_key) != 32:
        raise ValueError("Invalid unwrapped data key")
    return data_key


def decrypt_payload(path: Path, password: str):
    envelope = read_envelope(path)
    iv, ciphertext = (decode_b64(envelope[key]) for key in ("iv", "ciphertext"))
    if envelope["version"] == 1:
        salt = decode_b64(envelope["salt"])
        data_key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS, dklen=32)
    else:
        data_key = unwrap_daily_key(envelope, password)
    plaintext = AESGCM(data_key).decrypt(iv, ciphertext, None)
    payload = json.loads(plaintext.decode("utf-8"))
    if not isinstance(payload, dict) or not set(payload).issubset({"funds", "createdAt"}):
        raise ValueError("Invalid decrypted payload")
    validate_funds(payload.get("funds"), allow_missing=True)
    for code in FUND_CODES:
        payload["funds"].setdefault(code, {"transactions": [], "mode": "profit-first"})
    return payload


def encrypt_funds(funds, password: str, output: Path, *, created_at=None):
    validate_funds(funds)
    output = output.resolve()
    if output.is_file():
        existing = read_envelope(output)
        if existing["version"] == 2:
            data_key = unwrap_daily_key(existing, password)
            wrapped_keys = existing["keys"]
        else:
            # Authenticate the previous envelope before replacing it during migration.
            decrypt_payload(output, password)
            data_key = secrets.token_bytes(32)
            wrapped_keys = create_daily_keys(data_key)
    else:
        if not password:
            raise ValueError("A nonempty password input is required")
        data_key = secrets.token_bytes(32)
        wrapped_keys = create_daily_keys(data_key)
    plaintext = json.dumps({
        "createdAt": created_at if created_at is not None else datetime.now(timezone.utc).isoformat(), "funds": funds,
    }, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    iv = secrets.token_bytes(12)
    ciphertext = AESGCM(data_key).encrypt(iv, plaintext, None)
    envelope = {"version": 2, "kdf": "PBKDF2-SHA256", "iterations": ITERATIONS,
                "iv": encode_b64(iv), "ciphertext": encode_b64(ciphertext), "keys": wrapped_keys}
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(__file__).resolve().parents[2] / "临时文件" / "fund-trade-web" / "account-staging"
    staging.mkdir(parents=True, exist_ok=True)
    temporary = staging / (output.name + "." + secrets.token_hex(8) + ".tmp")
    temporary.write_text(json.dumps(envelope, separators=(",", ":")), encoding="utf-8")
    temporary.replace(output)


def main():
    parser = argparse.ArgumentParser(description="Encrypt workbook transactions without producing plaintext files.")
    source_group = parser.add_mutually_exclusive_group(required=True)
    source_group.add_argument("--workspace", type=Path)
    source_group.add_argument("--source", type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "ledger.enc.json")
    args = parser.parse_args()
    password = getpass.getpass("Ledger password: ") if sys.stdin.isatty() else sys.stdin.readline().rstrip("\r\n")
    if not password:
        raise ValueError("A nonempty password must be provided on standard input")
    if args.source is not None:
        funds = read_source(args.source.resolve())
    else:
        # Existing non-workbook funds survive subsequent workspace refreshes.
        funds = decrypt_payload(args.output.resolve(), password)["funds"] if args.output.is_file() else {
            code: {"transactions": [], "mode": "profit-first"} for code in FUND_CODES
        }
        funds = read_workspace_funds(args.workspace.resolve(), funds)
    encrypt_funds(funds, password, args.output)
    for code, fund in funds.items():
        print(f"{code}: {len(fund['transactions'])} rows encrypted")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Encryption failed. Check the source workbook fields and runtime dependencies.", file=sys.stderr)
        sys.exit(1)
