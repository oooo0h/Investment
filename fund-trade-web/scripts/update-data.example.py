"""Copy to update-data.local.py and edit update() to change data in memory.

The source template has no account values. Never commit a local edited copy.
"""
from pathlib import Path
import getpass
import importlib.util
import sys


def update(funds):
    # Edit the existing funds dictionary here. Other records remain intact.
    # Each entry has transactions and mode; application-only entries also have
    # incomplete=True and sourceNote. See docs/workbook-spec.md for fields.
    # Do not switch incomplete to False before the complete confirmed history
    # includes date, nav, shares, and fee for every active transaction.
    pass


def main():
    folder = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location("ledger_encoder", folder / "encrypt-workbooks.py")
    encoder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(encoder)
    ledger = folder.parent / "data" / "ledger.enc.json"
    password = getpass.getpass("Ledger password: ")
    payload = encoder.decrypt_payload(ledger, password)
    update(payload["funds"])
    encoder.encrypt_funds(payload["funds"], password, ledger)
    print("Encrypted ledger updated. No plaintext account data was saved.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Update failed. Check the password and source field definitions.", file=sys.stderr)
        sys.exit(1)
