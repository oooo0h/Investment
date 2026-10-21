"""Run with bundled Python -B -m unittest discover -s 工具脚本/tests -p test_nav_update.py."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('nav_update', Path(__file__).resolve().parents[1] / 'nav_update.py')
nav = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(nav)


def history(code='005698'):
    rows = [dict(date=f'2026-10-{i:02}', nav='1.0000', accumulated_nav='1.0000', daily_growth_pct='0.00', event='') for i in range(1, 8)]
    return dict(code=code, count=7, first_date=rows[0]['date'], last_date=rows[-1]['date'], rows=rows)


class NavTests(unittest.TestCase):
    def test_explicit_node_path_survives_a_moved_project(self):
        with tempfile.TemporaryDirectory(dir=nav.TEMP) as directory:
            node = Path(directory) / 'Other Device Tools' / 'node.exe'
            node.parent.mkdir()
            node.write_bytes(b'synthetic runtime')
            with patch.dict(nav.os.environ, {'FUND_NAV_NODE': str(node)}):
                self.assertEqual(nav.runtime_node(), str(node))
            with patch.dict(nav.os.environ, {'FUND_NAV_NODE': str(node) + '.missing'}):
                with self.assertRaisesRegex(RuntimeError, 'FUND_NAV_NODE'):
                    nav.runtime_node()

    def test_gap_is_filled_without_losing_old_rows(self):
        old = history()
        fresh = copy.deepcopy(old['rows'][-5:]) + [dict(old['rows'][-1], date='2026-10-08'), dict(old['rows'][-1], date='2026-10-09')]
        doc, added, revisions = nav.merge(old, fresh, '2026-10-10', 9)
        self.assertEqual(doc['rows'][:7], old['rows'])
        self.assertEqual(added, ['2026-10-08', '2026-10-09'])
        self.assertEqual(revisions, [])

    def test_equal_decimal_precision_is_idempotent(self):
        old = history()
        fresh = [dict(r, nav='1.0', accumulated_nav='1', daily_growth_pct='0') for r in old['rows'][-5:]]
        doc, added, revisions = nav.merge(old, fresh, '2026-10-10', 7)
        self.assertEqual(doc, old)
        self.assertEqual((added, revisions), ([], []))

    def test_revision_retains_evidence(self):
        old = history()
        fresh = copy.deepcopy(old['rows'][-5:])
        fresh[-1]['nav'] = '1.0123'
        doc, added, revisions = nav.merge(old, fresh, '2026-10-10', 7)
        self.assertEqual(doc['rows'][-1]['nav'], '1.0123')
        self.assertEqual(revisions[0]['before']['nav'], '1.0000')
        self.assertEqual(old['rows'][-1]['nav'], '1.0000')

    def test_missing_old_date_is_rejected(self):
        old = history()
        with self.assertRaisesRegex(RuntimeError, '缺失已有历史日期'):
            nav.merge(old, [r for r in old['rows'] if r['date'] != '2026-10-06'], '2026-10-10')

    def test_future_duplicate_and_total_mismatch(self):
        old = history()
        for fresh, asof, total in [(old['rows'] * 2, '2026-10-10', 7),
                                    (old['rows'], '2026-10-06', 7),
                                    (old['rows'], '2026-10-10', 8)]:
            with self.subTest(asof=asof, total=total):
                with self.assertRaises(RuntimeError):
                    nav.merge(old, fresh, asof, total)

    def test_existing_number_cannot_disappear(self):
        old = history()
        fresh = copy.deepcopy(old['rows'])
        fresh[-1]['daily_growth_pct'] = None
        with self.assertRaisesRegex(RuntimeError, '缺失已归档数值'):
            nav.merge(old, fresh, '2026-10-10')

    def test_official_supplement_remains_separate(self):
        old = history('270023')
        old['supplementary_rows'] = [dict(old['rows'][0], date='2026-09-30')]
        doc, _, _ = nav.merge(old, old['rows'], '2026-10-10')
        self.assertEqual(doc['supplementary_rows'], old['supplementary_rows'])
        self.assertNotIn('2026-09-30', [r['date'] for r in doc['rows']])

    def test_failed_transaction_restores_every_file(self):
        nav.TEMP.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=nav.TEMP) as directory:
            folder = Path(directory)
            pairs = []
            for i in range(3):
                target, stage = folder / f'target{i}', folder / f'stage{i}'
                target.write_bytes(b'old')
                stage.write_bytes(b'new')
                pairs.append((target, stage))
            def fail():
                raise OSError('simulated Excel/index failure')
            with self.assertRaises(OSError):
                nav.replace_transaction(pairs, folder, fail)
            self.assertEqual([target.read_bytes() for target, _ in pairs], [b'old'] * 3)
            self.assertFalse((nav.TEMP / '待恢复事务.json').exists())

    def test_windows_lock_blocks_duplicate_and_releases(self):
        with nav.locked('测试.lock'):
            with self.assertRaisesRegex(RuntimeError, '已有净值更新'):
                with nav.locked('测试.lock'):
                    self.fail('duplicate lock accepted')
        with nav.locked('测试.lock'):
            pass

    def test_launchers_match_current_funds_and_keep_crlf(self):
        folders = nav.discover()
        self.assertGreater(len(folders), 0)
        for folder in folders:
            raw = (folder / nav.CHILD).read_bytes()
            self.assertIn(b'--fund-dir', raw)
            self.assertNotIn(b'\n', raw.replace(b'\r\n', b''))
            self.assertFalse(raw.startswith(b'\xef\xbb\xbf'))

    def test_parent_continues_after_failure(self):
        folders = nav.discover()[:2]
        class Args:
            check_only = True
        with tempfile.TemporaryDirectory(dir=nav.TEMP) as directory:
            run = Path(directory)
            nav.save(run / folders[1].name[:6] / '结果.json', dict(status='unchanged'))
            with patch.object(nav, 'stream', side_effect=[1, 0]) as execute:
                self.assertEqual(nav.batch(folders, run, Args(), lambda message: None), 1)
                self.assertEqual(execute.call_count, 2)
            self.assertEqual(nav.load(run / '汇总.json')['failed'], 1)


if __name__ == '__main__':
    unittest.main()
