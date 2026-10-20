"""Synthetic sync control-flow tests; no live accounts, credentials or GitHub."""
import sys
sys.dont_write_bytecode = True
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('github_sync', Path(__file__).resolve().parents[1] / 'github_sync.py')
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)


class FakeMirror:
    REPOSITORY = 'oooo0h/Investment'

    def __init__(self, root, changed=True):
        self.ROOT = root
        self.STATE = root
        self.head = 'a' * 40
        self.cloud = self.head
        self.parent = self.cloud
        self.changed = changed
        self.files = {'说明 "示例".md': {'path': '说明 "示例".md', 'bytes': 4, 'sha256': 'invented', 'git_blob': 'c' * 40}}
        self.calls = []

    @staticmethod
    def require(condition, message):
        if not condition: raise RuntimeError(message)

    def verify_context(self): self.calls.append('context')
    def remote(self): return self.cloud, {}
    def inventory(self): return self.files

    def git(self, *args):
        if args == ('rev-parse', 'HEAD'): return self.head
        if args[0] == 'show': return self.parent
        self.calls.append(args[0])
        return ''

    def command(self, args):
        if args[:2] == ['git', 'ls-tree']:
            return b'100644 blob ' + b'c' * 40 + '\t说明 "示例".md\0'.encode('utf-8')
        self.calls.append('transport')
        self.cloud = self.head
        return b'{"tree_batch_verified":1,"total_batches":1}\n'

    def prepare(self):
        self.calls.append('prepare')
        plan = {'schema': 'project-full-mirror-v1', 'repository': self.REPOSITORY, 'branch': 'main',
                'remote_base_commit': self.cloud, 'files': list(self.files.values()),
                'changed_paths': list(self.files) if self.changed else [], 'delete_remote_paths': []}
        (self.STATE / 'plan.json').write_text(json.dumps(plan), encoding='utf-8')
        print(json.dumps({'reviewed_files': 1, 'changed_or_added': int(self.changed), 'old_remote_paths_to_remove': 0}))

    def apply(self):
        self.calls.append('apply')
        self.verify({})

    def verify(self, plan):
        self.calls.append('verify')
        print(json.dumps({'path_sets_equal': True, 'file_hashes_equal': True}))


class SyncTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[2] / '临时文件/GitHub同步测试'
        root.mkdir(parents=True, exist_ok=True)
        self.folder = tempfile.TemporaryDirectory(dir=root)
        self.root = Path(self.folder.name)
        self.console = io.StringIO()
        self.progress = sync.Progress(self.root / 'output.log', console=self.console, heartbeat=180)
        self.mirror = FakeMirror(self.root)

    def tearDown(self):
        self.progress.close()
        self.folder.cleanup()

    def run_sync(self, check=False):
        with redirect_stdout(self.progress):
            sync.synchronize(self.mirror, self.progress, check)

    def test_check_prepares_without_commit_transport_or_verification_claim(self):
        self.run_sync(check=True)
        self.assertIn('prepare', self.mirror.calls)
        self.assertNotIn('apply', self.mirror.calls)
        self.assertNotIn('transport', self.mirror.calls)
        self.assertNotIn('verify', self.mirror.calls)
        self.assertNotIn('同步成功', self.console.getvalue())

    def test_normal_sync_applies_reviewed_changes_and_reports_verification(self):
        self.run_sync()
        self.assertIn('apply', self.mirror.calls)
        self.assertIn('verify', self.mirror.calls)
        self.assertEqual(self.progress.stage, 4)

    def test_unchanged_files_verify_without_creating_an_empty_commit(self):
        self.mirror.changed = False
        self.run_sync()
        self.assertIn('verify', self.mirror.calls)
        self.assertNotIn('apply', self.mirror.calls)
        self.assertIn('没有需要上传的变化', self.console.getvalue())

    def test_interrupted_single_commit_resumes_exact_reviewed_tree(self):
        self.mirror.prepare()
        self.mirror.head = 'b' * 40
        self.run_sync()
        self.assertIn('transport', self.mirror.calls)
        self.assertIn('verify', self.mirror.calls)
        self.assertNotIn('apply', self.mirror.calls)
        self.assertEqual(self.mirror.cloud, self.mirror.head)

    def test_resume_rejects_changed_files_or_a_changed_remote_parent(self):
        self.mirror.prepare()
        self.mirror.head = 'b' * 40
        self.mirror.files = {}
        with self.assertRaisesRegex(RuntimeError, 'Files changed'):
            self.run_sync()
        self.assertNotIn('transport', self.mirror.calls)
        self.mirror.files = {'说明 "示例".md': {'path': '说明 "示例".md', 'bytes': 4, 'sha256': 'invented', 'git_blob': 'c' * 40}}
        self.mirror.cloud = 'd' * 40
        with self.assertRaisesRegex(RuntimeError, 'HEAD and remote'):
            self.run_sync()
        self.assertNotIn('transport', self.mirror.calls)

    def test_resume_check_does_not_upload_the_pending_commit(self):
        self.mirror.prepare()
        self.mirror.head = 'b' * 40
        self.run_sync(check=True)
        self.assertNotIn('transport', self.mirror.calls)

    def test_unknown_output_is_never_echoed_to_console_or_log(self):
        forbidden = 'synthetic-private-body'
        self.progress.write(forbidden + '\n' + json.dumps({'untrusted': forbidden}) + '\n')
        self.assertNotIn(forbidden, self.console.getvalue())
        self.assertNotIn(forbidden, (self.root / 'output.log').read_text(encoding='utf-8'))
        self.assertNotIn(forbidden, sync.error_message(RuntimeError(forbidden)))

    def test_lock_blocks_duplicate_run_and_releases_after_exit(self):
        with sync.single_run(self.root):
            with self.assertRaisesRegex(RuntimeError, 'already_running'):
                with sync.single_run(self.root): pass
        with sync.single_run(self.root): pass

    def test_main_never_claims_success_after_upload_failure(self):
        def fail(): raise RuntimeError('synthetic-private-failure')
        self.mirror.apply = fail
        output = io.StringIO()
        with patch.object(sync, 'STATE', self.root), patch.object(sync, 'dependencies'), \
             patch.object(sync, 'load_mirror', return_value=self.mirror), redirect_stdout(output):
            code = sync.main([])
        self.assertEqual(code, 1)
        self.assertIn('未确认成功', output.getvalue())
        self.assertNotIn('同步成功', output.getvalue())
        self.assertNotIn('synthetic-private-failure', output.getvalue())


if __name__ == '__main__': unittest.main()
