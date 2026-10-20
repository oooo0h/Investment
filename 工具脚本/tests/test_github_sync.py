"""Synthetic sync control-flow tests; no live accounts, credentials or GitHub."""
import sys
sys.dont_write_bytecode = True
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('github_sync', Path(__file__).resolve().parents[1] / 'github_sync.py')
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)
MIRROR_SPEC = importlib.util.spec_from_file_location('github_mirror_recovery_test', Path(__file__).resolve().parents[1] / 'github_mirror.py')
mirror_module = importlib.util.module_from_spec(MIRROR_SPEC)
MIRROR_SPEC.loader.exec_module(mirror_module)


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

    def push_reviewed(self, plan):
        self.calls.append('transport')
        self.cloud = self.head
        self.verify(plan)

    def verify(self, plan):
        self.calls.append('verify')
        print(json.dumps({'path_sets_equal': True, 'file_hashes_equal': True}))


class SyncTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[2] / '临时文件/GitHub同步测试'
        root.mkdir(parents=True, exist_ok=True)
        self.folder = tempfile.TemporaryDirectory(dir=root)
        self.root = Path(self.folder.name)
        (self.root / '.git').mkdir()
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

    def test_new_manual_run_reviews_new_files_without_discarding_pending_commit_and_rejects_remote_changes(self):
        self.mirror.prepare()
        self.mirror.head = 'b' * 40
        self.mirror.files = {name: {**entry, 'git_blob': 'f' * 40} for name, entry in self.mirror.files.items()}
        self.run_sync()
        self.assertNotIn('transport', self.mirror.calls)
        self.assertIn('prepare', self.mirror.calls)
        self.assertIn('apply', self.mirror.calls)
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
             patch.object(sync, 'ensure_authenticated'), \
             patch.object(sync, 'load_mirror', return_value=self.mirror), redirect_stdout(output):
            code = sync.main([])
        self.assertEqual(code, 1)
        self.assertIn('未确认成功', output.getvalue())
        self.assertNotIn('同步成功', output.getvalue())
        self.assertNotIn('synthetic-private-failure', output.getvalue())

    def test_missing_login_waits_for_browser_authorization_then_continues_same_sync(self):
        with patch.object(sync, 'authentication_state', side_effect=['required', 'authenticated']), \
             patch.object(sync.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as login, \
             patch.dict(os.environ, {'GH_TOKEN': '', 'GITHUB_TOKEN': '', 'GH_PROMPT_DISABLED': '1'}), \
             redirect_stdout(self.progress):
            sync.synchronize_with_login(self.mirror, self.progress, interactive=True)
        self.assertIn('apply', self.mirror.calls)
        self.assertIn('verify', self.mirror.calls)
        self.assertEqual(login.call_count, 1)
        self.assertEqual(login.call_args.args[0][:3], ['gh', 'auth', 'login'])
        self.assertIn('--web', login.call_args.args[0])
        self.assertNotIn('GH_PROMPT_DISABLED', login.call_args.kwargs['env'])
        self.assertNotIn('stdout', login.call_args.kwargs)
        self.assertNotIn('stderr', login.call_args.kwargs)
        self.assertIn('登录已核验，继续同步', self.console.getvalue())

    def test_valid_login_does_not_launch_browser(self):
        with patch.object(sync, 'authentication_state', return_value='authenticated'), \
             patch.object(sync.subprocess, 'run') as login:
            sync.ensure_authenticated(self.progress, interactive=True)
        login.assert_not_called()

    def test_network_permissions_and_environment_tokens_never_trigger_login_loop(self):
        cases = [('network', 'github_auth_network', {}),
                 ('permissions', 'github_auth_permissions', {}),
                 ('required', 'github_auth_environment_token', {'GH_TOKEN': 'synthetic-placeholder'}),
                 ('unavailable', 'github_auth_unavailable', {})]
        for state, reason, env in cases:
            with self.subTest(state=state), patch.object(sync, 'authentication_state', return_value=state), \
                 patch.object(sync.subprocess, 'run') as login, \
                 patch.dict(os.environ, {'GH_TOKEN': '', 'GITHUB_TOKEN': '', **env}):
                with self.assertRaisesRegex(RuntimeError, reason):
                    sync.ensure_authenticated(self.progress, interactive=True)
                login.assert_not_called()

    def test_login_cancel_can_retry_in_place_or_quit_without_syncing(self):
        with patch.object(sync, 'authentication_state', side_effect=['required', 'required', 'authenticated']), \
             patch.object(sync.subprocess, 'run') as login, \
             patch.dict(os.environ, {'GH_TOKEN': '', 'GITHUB_TOKEN': ''}), \
             patch('builtins.input', return_value=''):
            sync.ensure_authenticated(self.progress, interactive=True)
        self.assertEqual(login.call_count, 2)
        with patch.object(sync, 'authentication_state', return_value='required'), \
             patch.object(sync.subprocess, 'run'), \
             patch.dict(os.environ, {'GH_TOKEN': '', 'GITHUB_TOKEN': ''}), \
             patch('builtins.input', return_value='q'):
            with self.assertRaisesRegex(RuntimeError, 'github_auth_cancelled'):
                sync.synchronize_with_login(self.mirror, self.progress, interactive=True)
        self.assertNotIn('apply', self.mirror.calls)

    def test_noninteractive_missing_login_fails_clearly_without_opening_browser(self):
        with patch.object(sync, 'authentication_state', return_value='required'), \
             patch.object(sync.subprocess, 'run') as login, \
             patch.dict(os.environ, {'GH_TOKEN': '', 'GITHUB_TOKEN': ''}):
            with self.assertRaisesRegex(RuntimeError, 'github_auth_required'):
                sync.ensure_authenticated(self.progress, interactive=False)
            login.assert_not_called()

    def test_expired_auth_rechecks_safe_sync_and_does_not_retry_conflicts(self):
        with patch.object(sync, 'ensure_authenticated') as auth, \
             patch.object(sync, 'synchronize', side_effect=[RuntimeError('gh failed: authentication'), None]) as run:
            sync.synchronize_with_login(self.mirror, self.progress, interactive=True)
            self.assertEqual(auth.call_count, 2)
            self.assertEqual(run.call_count, 2)
        with patch.object(sync, 'ensure_authenticated') as auth, \
             patch.object(sync, 'synchronize', side_effect=RuntimeError('Remote changed after review')) as run:
            with self.assertRaisesRegex(RuntimeError, 'Remote changed'):
                sync.synchronize_with_login(self.mirror, self.progress, interactive=True)
            self.assertEqual(auth.call_count, 1)
            self.assertEqual(run.call_count, 1)

    def test_auth_probe_classifies_failures_without_printing_raw_cli_data(self):
        for code, error, state in [(0, b'', 'authenticated'), (1, b'HTTP 401: Bad credentials', 'required'),
                                   (1, b'gh auth login', 'required'), (1, b'connection timeout', 'network'),
                                   (1, b'HTTP 403 forbidden', 'permissions'), (1, b'synthetic-private-body', 'unavailable')]:
            with patch.object(sync.subprocess, 'run', return_value=subprocess.CompletedProcess([], code, b'', error)):
                self.assertEqual(sync.authentication_state(), state)
        self.assertNotIn('synthetic-private-body', self.console.getvalue())
        with patch.object(sync.subprocess, 'run', side_effect=subprocess.TimeoutExpired('gh', 30)):
            self.assertEqual(sync.authentication_state(), 'network')

    def test_missing_repository_has_its_own_explanation(self):
        message = sync.error_message(RuntimeError('Local Git metadata missing; restore repository metadata before mirroring'))
        self.assertIn('.git', message)
        self.assertIn('仅重新登录不能解决', message)

    def test_system_proxy_is_inherited_without_overriding_explicit_proxy_or_logging_values(self):
        with patch.dict(os.environ, {}, clear=True), \
             patch.object(sync.urllib.request, 'getproxies', return_value={'http': 'http://synthetic-proxy:8000'}):
            sync.configure_system_proxy()
            self.assertEqual(os.environ['https_proxy'], 'http://synthetic-proxy:8000')
            self.assertEqual(os.environ['HTTP_PROXY'], 'http://synthetic-proxy:8000')
        with patch.dict(os.environ, {'HTTPS_PROXY': 'http://explicit-proxy:8001'}, clear=True), \
             patch.object(sync.urllib.request, 'getproxies', return_value={'https': 'http://system-proxy:8000'}):
            sync.configure_system_proxy()
            self.assertEqual(os.environ['HTTPS_PROXY'], 'http://explicit-proxy:8001')
        self.assertNotIn('synthetic-proxy', self.console.getvalue())


@unittest.skipUnless(shutil.which('git'), 'Git is required for synthetic metadata recovery tests')
class RecoveryTests(unittest.TestCase):
    def setUp(self):
        temp_root = Path(__file__).resolve().parents[2] / '临时文件/GitHub同步测试'
        temp_root.mkdir(parents=True, exist_ok=True)
        self.folder = tempfile.TemporaryDirectory(dir=temp_root)
        self.root = Path(self.folder.name)
        self.source = self.root / '临时文件/source'
        self.source.mkdir(parents=True)
        self.git('init', '-b', 'main', str(self.source), cwd=self.root)
        self.git('config', 'user.name', 'Synthetic Recovery', cwd=self.source)
        self.git('config', 'user.email', 'synthetic@example.test', cwd=self.source)
        (self.source / '说明.txt').write_bytes(b'remote original\n')
        (self.source / 'remote-only.txt').write_bytes(b'old remote file\n')
        self.git('add', '.', cwd=self.source)
        self.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic initial history', cwd=self.source)
        self.commit = self.git('rev-parse', 'HEAD', cwd=self.source)
        (self.root / '说明.txt').write_bytes(b'local edited bytes\r\n')
        (self.root / 'local-only.txt').write_bytes(b'local new file\n')
        self.messages = []
        self.progress = type('ProgressSink', (), {'say': lambda _, message: self.messages.append(message)})()
        owner = self

        class Mirror:
            ROOT = owner.root
            STATE = owner.root / '临时文件/GitHub完整同步'
            REPOSITORY = 'oooo0h/Investment'
            require = staticmethod(FakeMirror.require)
            api_calls = 0
            remote_changed = False
            files_changed = False

            def inventory(self, scan=True):
                return mirror_module.inventory(self.ROOT, scan=scan)

            def api(self, endpoint):
                self.api_calls += 1
                return {'object': {'sha': 'd' * 40 if self.remote_changed and self.api_calls > 1 else owner.commit}}

            def command(self, args):
                clone = 'clone' in args
                actual = list(args)
                if clone:
                    actual[-2] = str(owner.source)
                data = owner.run_git(actual[1:], cwd=self.ROOT)
                if clone:
                    owner.git('remote', 'set-url', 'origin', f'https://github.com/{self.REPOSITORY}.git', cwd=Path(actual[-1]))
                    if self.files_changed:
                        (self.ROOT / 'local-only.txt').write_bytes(b'concurrent local edit\n')
                return data

            def git(self, *args):
                return self.command(['git', *args]).decode('utf-8').strip()

            def verify_context(self):
                self.require(self.git('branch', '--show-current') == 'main', 'Unexpected local branch')
                self.require(self.git('remote', 'get-url', 'origin') == f'https://github.com/{self.REPOSITORY}.git', 'Unexpected destination')
                self.require(not self.git('diff', '--cached', '--name-only'), 'Unreviewed staged changes')

        self.mirror = Mirror()

    def run_git(self, args, cwd):
        process = subprocess.run([shutil.which('git'), *args], cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(process.returncode, 0, 'Synthetic local Git fixture command failed: ' + process.stderr.decode('utf-8', errors='replace'))
        return process.stdout

    def git(self, *args, cwd):
        return self.run_git(args, cwd).decode('utf-8').strip()

    def tearDown(self):
        # Git marks object files read-only on Windows; allow fixture cleanup.
        for parent, _, files in os.walk(self.root):
            for name in files:
                os.chmod(Path(parent) / name, 0o666)
        self.folder.cleanup()

    def test_recovery_installs_remote_metadata_and_index_without_overwriting_local_files(self):
        before = self.mirror.inventory(scan=False)
        self.assertTrue(sync.restore_repository(self.mirror, self.progress))
        self.assertEqual(self.mirror.inventory(scan=False), before)
        self.assertEqual(self.mirror.git('rev-parse', 'HEAD'), self.commit)
        self.assertEqual(self.mirror.git('diff', '--cached', '--name-only'), '')
        self.assertEqual((self.root / '说明.txt').read_bytes(), b'local edited bytes\r\n')
        self.assertTrue((self.root / 'local-only.txt').exists())
        self.assertFalse((self.root / 'remote-only.txt').exists())
        receipts = list(self.mirror.STATE.glob('repository-recovery-*/result.json'))
        self.assertEqual(len(receipts), 1)
        receipt = json.loads(receipts[0].read_text(encoding='utf-8'))
        self.assertTrue(receipt['working_files_unchanged'])
        self.assertEqual(receipt['created_commits'], 0)
        self.assertEqual(receipt['uploaded_files'], 0)

    def test_existing_metadata_is_never_replaced(self):
        (self.root / '.git').mkdir()
        (self.root / '.git/keep').write_bytes(b'existing metadata')
        self.assertFalse(sync.restore_repository(self.mirror, self.progress))
        self.assertEqual(self.mirror.api_calls, 0)
        self.assertEqual((self.root / '.git/keep').read_bytes(), b'existing metadata')

    def test_remote_move_stops_before_installing_metadata(self):
        self.mirror.remote_changed = True
        before = self.mirror.inventory(scan=False)
        with self.assertRaisesRegex(RuntimeError, 'Remote changed'):
            sync.restore_repository(self.mirror, self.progress)
        self.assertFalse((self.root / '.git').exists())
        self.assertEqual(self.mirror.inventory(scan=False), before)

    def test_concurrent_working_file_edit_stops_without_replacing_it(self):
        self.mirror.files_changed = True
        with self.assertRaisesRegex(RuntimeError, 'Files changed'):
            sync.restore_repository(self.mirror, self.progress)
        self.assertFalse((self.root / '.git').exists())
        self.assertEqual((self.root / 'local-only.txt').read_bytes(), b'concurrent local edit\n')


if __name__ == '__main__': unittest.main()
