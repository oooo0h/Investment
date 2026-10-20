"""Synthetic-only checks. No source workbook or actual encrypted ledger is read."""
import copy
from datetime import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import secrets
import tempfile
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("test_encoder", ROOT / "scripts" / "encrypt-workbooks.py")
encoder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(encoder)


class DailyEncryptionTests(unittest.TestCase):
    def setUp(self):
        temporary = ROOT.parent / "临时文件" / ROOT.name / "encryption-tests"
        temporary.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=temporary)
        self.path = Path(self.temp.name) / "synthetic.enc.json"
        self.funds = {code: {"transactions": [], "mode": "profit-first"} for code in encoder.FUND_CODES}
        self.funds["006373"] = {
            "incomplete": True, "sourceNote": "Synthetic source metadata", "mode": "profit-first",
            "transactions": [{"date": "", "submittedAt": "2026-01-01 12:00:00", "type": "sip",
                              "nav": None, "shares": None, "fee": None, "amount": 1,
                              "status": "pending", "sourceStatus": "unverified", "note": "Synthetic note"}],
        }

    def tearDown(self):
        self.temp.cleanup()

    def write_legacy(self, funds=None):
        salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
        key = hashlib.pbkdf2_hmac("sha256", b"synthetic-legacy-password", salt, encoder.ITERATIONS, dklen=32)
        plain = json.dumps({"createdAt": "2026-01-01T00:00:00Z", "funds": self.funds if funds is None else funds}).encode()
        envelope = {"version": 1, "kdf": "PBKDF2-SHA256", "iterations": encoder.ITERATIONS,
                    "salt": encoder.encode_b64(salt), "iv": encoder.encode_b64(iv),
                    "ciphertext": encoder.encode_b64(AESGCM(key).encrypt(iv, plain, None))}
        self.path.write_text(json.dumps(envelope), encoding="utf-8")

    @staticmethod
    def single_day_test_wrappers(data_key):
        # Avoid the intentionally expensive full calendar preparation in tests.
        # Only today's wrapper is used here; all other entries are shape fixtures.
        wrapper = encoder.wrap_daily_key(data_key, encoder.beijing_today_code())
        return {code: copy.deepcopy(wrapper) for code in encoder.daily_codes()}

    def write_daily(self, funds):
        data_key, iv = secrets.token_bytes(32), secrets.token_bytes(12)
        plain = json.dumps({"createdAt": "2026-01-01T00:00:00Z", "funds": funds}).encode()
        envelope = {
            "version": 2, "kdf": "PBKDF2-SHA256", "iterations": encoder.ITERATIONS,
            "iv": encoder.encode_b64(iv),
            "ciphertext": encoder.encode_b64(AESGCM(data_key).encrypt(iv, plain, None)),
            "keys": self.single_day_test_wrappers(data_key),
        }
        self.path.write_text(json.dumps(envelope), encoding="utf-8")

    def test_calendar_covers_leap_day_without_duplicates(self):
        codes = encoder.daily_codes()
        self.assertTrue(len(codes) == len(set(codes)) == 366, "calendar coverage")
        self.assertTrue("0229" in codes and codes[0] == "0101" and codes[-1] == "1231", "leap calendar boundaries")

    def test_a_calendar_wrapper_uses_the_documented_kdf_and_aes_format(self):
        data_key = secrets.token_bytes(32)
        wrapped = encoder.wrap_daily_key(data_key, "0229")
        kek = hashlib.pbkdf2_hmac("sha256", b"0229", encoder.decode_b64(wrapped["salt"]), encoder.ITERATIONS, dklen=32)
        decoded = AESGCM(kek).decrypt(encoder.decode_b64(wrapped["iv"]), encoder.decode_b64(wrapped["ciphertext"]), None)
        self.assertTrue(decoded == data_key, "documented wrapper format")

    def test_migration_preserves_metadata_and_reuses_existing_calendar_keys(self):
        self.write_legacy()
        payload = encoder.decrypt_payload(self.path, "synthetic-legacy-password")
        with patch.object(encoder, "create_daily_keys", self.single_day_test_wrappers):
            encoder.encrypt_funds(payload["funds"], "synthetic-legacy-password", self.path, created_at=payload["createdAt"])
        original = encoder.read_envelope(self.path)
        decoded = encoder.decrypt_payload(self.path, encoder.beijing_today_code())
        self.assertTrue(decoded == payload, "migration retains all plaintext fields")
        with patch.object(encoder, "create_daily_keys", side_effect=AssertionError("calendar regenerated")):
            encoder.encrypt_funds(decoded["funds"], encoder.beijing_today_code(), self.path, created_at=decoded["createdAt"])
        refreshed = encoder.read_envelope(self.path)
        self.assertTrue(refreshed["keys"] == original["keys"], "calendar wrappers retained")
        self.assertTrue(refreshed["iv"] != original["iv"], "payload IV refreshed")
        self.assertTrue(encoder.decrypt_payload(self.path, encoder.beijing_today_code()) == payload, "refresh retains all plaintext fields")

    def test_invalid_or_old_password_cannot_replace_an_existing_daily_envelope(self):
        with patch.object(encoder, "create_daily_keys", self.single_day_test_wrappers):
            encoder.encrypt_funds(self.funds, "synthetic-initial-input", self.path)
        before = self.path.read_bytes()
        with self.assertRaises(ValueError):
            encoder.encrypt_funds(self.funds, "synthetic-old-password", self.path)
        self.assertTrue(self.path.read_bytes() == before, "incorrect password retains original ciphertext")
        with self.assertRaises(ValueError):
            encoder.decrypt_payload(self.path, "synthetic-old-password")

    def test_missing_daily_wrapper_is_rejected(self):
        with patch.object(encoder, "create_daily_keys", self.single_day_test_wrappers):
            encoder.encrypt_funds(self.funds, "synthetic-initial-input", self.path)
        envelope = encoder.read_envelope(self.path)
        envelope["keys"].pop("0229")
        self.path.write_text(json.dumps(envelope), encoding="utf-8")
        with self.assertRaises(ValueError):
            encoder.decrypt_payload(self.path, encoder.beijing_today_code())

    def test_older_four_fund_envelopes_preserve_original_ledgers_and_add_only_empty_supported_funds(self):
        original_codes = {"005698", "270023", "006373", "016701"}
        added_codes = {"000216", "009608", "018124", "015789", "019454", "022459"}
        self.assertTrue(encoder.FUND_CODES == original_codes | added_codes, "supported catalog")
        original = {code: copy.deepcopy(self.funds[code]) for code in original_codes}
        original["270023"]["mode"] = "principal-first"
        original["005698"]["transactions"] = [{
            "id": "synthetic-original-confirmation", "date": "2026-01-01", "type": "buy",
            "nav": 1, "shares": 1, "fee": 0, "status": "confirmed", "note": "Synthetic legacy note",
        }]
        for version in (1, 2):
            with self.subTest(envelope_version=version):
                if version == 1:
                    self.write_legacy(original)
                    password = "synthetic-legacy-password"
                else:
                    self.write_daily(original)
                    password = encoder.beijing_today_code()
                before = self.path.read_bytes()
                decoded = encoder.decrypt_payload(self.path, password)
                self.assertTrue(set(decoded["funds"]) == encoder.FUND_CODES, "all supported funds are available")
                self.assertTrue(all(decoded["funds"][code] == original[code] for code in original_codes), "original ledgers and metadata are unchanged")
                self.assertTrue(all(decoded["funds"][code] == {"transactions": [], "mode": "profit-first"} for code in added_codes), "new catalog entries start as empty ledgers")
                self.assertTrue(decoded["createdAt"] == "2026-01-01T00:00:00Z", "original timestamp retained")
                self.assertTrue(self.path.read_bytes() == before, "read-only expansion retains original ciphertext")

    def test_complete_source_import_requires_all_supported_funds_while_partial_validation_remains_available(self):
        source = self.path.with_name("synthetic-source.json")
        source.write_text(json.dumps({"funds": self.funds}), encoding="utf-8")
        self.assertTrue(encoder.read_source(source) == self.funds, "complete supported source accepted")
        old_codes = {"005698", "270023", "006373", "016701"}
        original = {code: self.funds[code] for code in old_codes}
        encoder.validate_funds(original, allow_missing=True)
        source.write_text(json.dumps({"funds": original}), encoding="utf-8")
        with self.assertRaises(ValueError):
            encoder.read_source(source)

    def test_mixed_workbook_confirmations_and_pending_applications_are_accepted(self):
        transactions = [
            {"date": "2026-01-01", "type": "sip", "nav": 2, "shares": 5, "fee": 0,
             "status": "confirmed", "submittedAt": "2026-01-01 10:00:00"},
            {"date": "2026-01-02", "type": "sip", "nav": None, "shares": None, "fee": None,
             "amount": 10, "status": "pending", "sourceStatus": "processing", "submittedAt": "2026-01-02 10:00:00"},
            {"date": "2026-01-03", "type": "buy", "nav": None, "shares": None, "fee": None,
             "amount": 10, "status": "cancelled", "sourceStatus": "cancelled"},
        ]
        fund = {"transactions": transactions, "mode": "profit-first", "incomplete": False}
        before = copy.deepcopy(fund)
        encoder.validate_funds({"006373": fund}, allow_missing=True)
        self.assertTrue(fund == before, "validation preserves pending blanks and actual confirmation fields")
        transactions[1]["status"] = "confirmed"
        with self.assertRaises(ValueError):
            encoder.validate_funds({"006373": fund}, allow_missing=True)

    def test_pending_rows_reject_invalid_dates_numeric_values_and_missing_application_basis(self):
        original = {"date": "2026-01-02", "type": "sip", "nav": None, "shares": None, "fee": None,
                    "amount": 10, "status": "pending", "sourceStatus": "processing"}
        for extra in ({"date": "2026-02-30"}, {"nav": -1}, {"shares": "5"}, {"fee": float("nan")},
                      {"amount": 0}, {"submittedAt": "2026-01-02 25:00:00"}):
            with self.subTest(fields=list(extra)):
                fund = {"mode": "profit-first", "transactions": [{**original, **extra}]}
                with self.assertRaises(ValueError):
                    encoder.validate_funds({"006373": fund}, allow_missing=True)

    def test_failed_and_closed_rows_preserve_unknown_confirmation_fields(self):
        for status in ("failed", "closed", "交易失败", "交易关闭", "撤单"):
            with self.subTest(status=status):
                fund = {"mode": "profit-first", "transactions": [{
                    "date": "2026-01-02", "type": "buy", "nav": None, "shares": None,
                    "fee": None, "status": status,
                }]}
                encoder.validate_funds({"006373": fund}, allow_missing=True)

    def test_note_metadata_preserves_daily_sip_timestamp_and_processing_state(self):
        metadata = encoder.source_metadata("日定投；申请时间：2026-01-02 10:00:00；来源状态：processing；尚无成交确认", "pending")
        self.assertTrue(metadata == {"submittedAt": "2026-01-02 10:00:00", "sourceStatus": "processing"}, "explicit source labels")
        self.assertTrue(encoder.source_metadata("历史备注", "pending") == {"sourceStatus": "processing"}, "unknown pending rows remain processing")
        with self.assertRaises(ValueError):
            encoder.source_metadata("申请时间：2026-02-30 10:00:00；日定投", "pending")

    def test_workbook_reader_keeps_mixed_pending_rows_instead_of_marking_whole_fund_incomplete(self):
        class Sheet:
            def __init__(self, rows):
                self.rows = rows

            def iter_rows(self, **_options):
                return iter(self.rows)

            def __getitem__(self, _address):
                return type("Cell", (), {"value": "本金优先"})()

        class Book:
            epoch = datetime(1899, 12, 30)

            def __init__(self, rows):
                self.rows = rows

            def __getitem__(self, name):
                return Sheet(self.rows if name == "逐笔交易" else [])

            def close(self):
                pass

        rows = [
            ("2026-01-01", "定投", 2, 5, 10, 0, "已确认", "申请时间：2026-01-01 10:00:00；日定投"),
            ("2026-01-02", "定投", None, None, 10, None, "待确认", "日定投；申请时间：2026-01-02 10:00:00；来源状态：processing"),
            ("2026-01-03", "买入", None, None, 10, None, "撤单", "历史撤单"),
        ]
        workspace = Path(self.temp.name)
        directory = workspace / "基金" / "持仓基金" / "006373_虚构测试基金"
        directory.mkdir(parents=True)
        (directory / ("006373_" + encoder.TEMPLATE_SUFFIX)).touch()
        (directory / ("~$006373_" + encoder.TEMPLATE_SUFFIX)).touch()
        with patch.object(encoder.openpyxl, "load_workbook", side_effect=lambda *_a, **_kw: Book(rows)):
            result = encoder.read_fund(workspace, "006373")
        self.assertTrue(result["mode"] == "principal-first", "workbook mode retained")
        self.assertTrue("incomplete" not in result, "pending is a per-row state")
        self.assertTrue([tx["status"] for tx in result["transactions"]] == ["confirmed", "pending", "cancelled"], "all source statuses retained")
        self.assertTrue(result["transactions"][1]["nav"] is None and result["transactions"][1]["shares"] is None, "no fabricated confirmation")
        self.assertTrue(result["transactions"][1]["submittedAt"] == "2026-01-02 10:00:00", "application time retained")

    def test_workspace_refresh_discovers_new_workbooks_and_preserves_unrepresented_funds(self):
        workspace = Path(self.temp.name)
        for code in ("006373", "016701"):
            directory = workspace / "基金" / "持仓基金" / (code + "_虚构测试基金")
            directory.mkdir(parents=True)
            (directory / (code + "_" + encoder.TEMPLATE_SUFFIX)).touch()
        directory = workspace / "基金" / "持仓基金" / "005698_虚构测试基金"
        directory.mkdir(parents=True)
        (directory / ("~$005698_" + encoder.TEMPLATE_SUFFIX)).touch()
        before = copy.deepcopy(self.funds)
        replacement = {"mode": "principal-first", "transactions": []}
        with patch.object(encoder, "read_fund", return_value=replacement) as reader:
            refreshed = encoder.read_workspace_funds(workspace, self.funds)
        self.assertTrue([call.args[1] for call in reader.call_args_list] == ["006373", "016701"], "all real supported templates are discovered")
        self.assertTrue(all(refreshed[code] == before[code] for code in encoder.FUND_CODES - {"006373", "016701"}), "unrepresented ledgers retained")
        self.assertTrue(self.funds == before, "original fund map unchanged")


if __name__ == "__main__":
    unittest.main()
