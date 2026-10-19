"""Migrate an encrypted ledger to a static calendar-day key envelope.

The previous password is read from stdin; it is never stored or printed.
The source and all decrypted account data remain in memory. Only the encrypted
envelope is replaced, after successful authentication and complete preparation.
"""
import argparse
import getpass
import importlib.util
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description="Migrate an encrypted ledger to daily calendar-day keys.")
    parser.add_argument("--ledger", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "ledger.enc.json")
    args = parser.parse_args()
    password = getpass.getpass("Previous ledger password: ") if sys.stdin.isatty() else sys.stdin.readline().rstrip("\r\n")
    if not password:
        raise ValueError("A nonempty previous password is required")
    spec = importlib.util.spec_from_file_location("ledger_encoder", Path(__file__).with_name("encrypt-workbooks.py"))
    encoder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(encoder)
    ledger = args.ledger.resolve()
    payload = encoder.decrypt_payload(ledger, password)
    encoder.encrypt_funds(payload["funds"], password, ledger, created_at=payload.get("createdAt"))
    for code, fund in payload["funds"].items():
        print(f"{code}: {len(fund['transactions'])} rows retained")
    print("Daily key envelope ready: 366 calendar-day wrappers")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Daily password migration failed. The original encrypted ledger was not replaced.", file=sys.stderr)
        sys.exit(1)
