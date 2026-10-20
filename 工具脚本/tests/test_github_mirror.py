"""Synthetic file-tree checks; never reads project account files or GitHub."""
import sys
sys.dont_write_bytecode=True
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess
import zipfile

SPEC=importlib.util.spec_from_file_location('github_mirror',Path(__file__).resolve().parents[1]/'github_mirror.py')
mirror=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mirror)

class MirrorTests(unittest.TestCase):
    def setUp(self):
        temporary=Path(__file__).resolve().parents[2]/'临时文件/GitHub同步测试'
        temporary.mkdir(parents=True,exist_ok=True)
        self.folder=tempfile.TemporaryDirectory(dir=temporary)
        self.root=Path(self.folder.name)
    def tearDown(self): self.folder.cleanup()
    def put(self,name,data):
        p=self.root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
    def test_only_root_temporary_and_git_are_excluded(self):
        self.put('.git/config',b'local-metadata')
        self.put('临时文件/cache.txt',b'generated')
        self.put('fund-trade-web/local/source.json',b'{"source":"synthetic"}\r\n')
        self.put('工具脚本/app.py',b'print("synthetic")\n')
        self.put('基金/观察基金/123456_test/123456_全部历史净值.csv',b'date,nav\n2026-01-01,1\n')
        actual=mirror.inventory(self.root)
        self.assertEqual(set(actual),{'fund-trade-web/local/source.json','工具脚本/app.py','基金/观察基金/123456_test/123456_全部历史净值.csv'})
    def test_git_blob_preserves_exact_line_endings(self):
        content=b'alpha\r\nbeta\r\n'
        self.put('document.md',content)
        entry=mirror.inventory(self.root)['document.md']
        self.assertEqual(entry['git_blob'],hashlib.sha1(b'blob '+str(len(content)).encode()+b'\0'+content).hexdigest())
        self.put('document.md',content.replace(b'\r\n',b'\n'))
        self.assertNotEqual(entry,mirror.inventory(self.root)['document.md'])
    def test_credentials_fail_before_staging_in_plain_files_or_archives(self):
        self.put('.env',b'synthetic-only')
        with self.assertRaisesRegex(RuntimeError,'Credential file'):mirror.inventory(self.root)
        (self.root/'.env').unlink()
        raw=io.BytesIO()
        with zipfile.ZipFile(raw,'w') as z:z.writestr('settings.json',json.dumps({'value':'ghp_'+'A'*40}))
        self.put('source.zip',raw.getvalue())
        with self.assertRaisesRegex(RuntimeError,'Credential pattern'):mirror.inventory(self.root)

    def test_missing_git_metadata_is_detected_before_running_git_or_network_commands(self):
        with patch.object(mirror,'ROOT',self.root), patch.object(mirror,'command') as command:
            with self.assertRaisesRegex(RuntimeError,'Local Git metadata missing'):
                mirror.verify_context()
            command.assert_not_called()

    def test_auth_expiration_is_distinct_from_permissions_and_network_failures(self):
        for raw,category in [(b'HTTP 401: Bad credentials','authentication'),
                             (b'RuntimeError: GitHub API failed: 401','authentication'),
                             (b'gh auth login','authentication'),
                             (b'HTTP 403 forbidden','permissions'),
                             (b'connection timeout','network')]:
            with patch.object(mirror.subprocess,'run',return_value=subprocess.CompletedProcess([],1,b'',raw)):
                with self.assertRaisesRegex(RuntimeError,f'failed: {category}'):
                    mirror.command(['gh','api','synthetic'])

    def test_native_push_uses_existing_gh_login_without_force_and_verifies_afterward(self):
        entry={'path':'synthetic.txt','git_blob':'c'*40}
        plan={'files':[entry],'remote_base_commit':'a'*40,'reviewed_local_head':'a'*40}
        calls=[]
        def git(*args):
            if args==('rev-parse','HEAD'):return 'b'*40
            if args[:1]==('show',):return 'a'*40
            calls.append(args)
            return ''
        with patch.object(mirror,'verify_context'), patch.object(mirror,'inventory',return_value={'synthetic.txt':entry}), \
             patch.object(mirror,'committed_files',return_value={'synthetic.txt':'c'*40}), \
             patch.object(mirror,'remote',return_value=('a'*40,{})), patch.object(mirror,'git',side_effect=git), \
             patch.object(mirror,'command',return_value=b'') as command, patch.object(mirror,'verify') as verify:
            mirror.push_reviewed(plan)
        push=[call.args[0] for call in command.call_args_list if 'push' in call.args[0]]
        self.assertEqual(len(push),1)
        self.assertIn('credential.helper=!gh auth git-credential',push[0])
        self.assertEqual(push[0][-2:],['origin','HEAD:refs/heads/main'])
        self.assertNotIn('--force',push[0])
        self.assertNotIn('--force-with-lease',push[0])
        verify.assert_called_once_with(plan)
        self.assertIn(('update-ref','refs/remotes/origin/main','b'*40),calls)

    def test_native_push_stops_on_remote_changes_and_dry_run_never_updates_refs(self):
        entry={'path':'synthetic.txt','git_blob':'c'*40}
        plan={'files':[entry],'remote_base_commit':'a'*40}
        def git(*args):return 'b'*40 if args==('rev-parse','HEAD') else 'a'*40
        with patch.object(mirror,'verify_context'), patch.object(mirror,'inventory',return_value={'synthetic.txt':entry}), \
             patch.object(mirror,'committed_files',return_value={'synthetic.txt':'c'*40}), \
             patch.object(mirror,'remote',return_value=('d'*40,{})), patch.object(mirror,'git',side_effect=git), \
             patch.object(mirror,'command') as command:
            with self.assertRaisesRegex(RuntimeError,'Remote changed'):
                mirror.push_reviewed(plan)
            command.assert_not_called()
        with patch.object(mirror,'verify_context'), patch.object(mirror,'inventory',return_value={'synthetic.txt':entry}), \
             patch.object(mirror,'committed_files',return_value={'synthetic.txt':'c'*40}), \
             patch.object(mirror,'remote',return_value=('a'*40,{})), patch.object(mirror,'git',side_effect=git), \
             patch.object(mirror,'command',return_value=b'') as command, patch.object(mirror,'verify') as verify:
            mirror.push_reviewed(plan,dry_run=True)
            push=[call.args[0] for call in command.call_args_list if 'push' in call.args[0]]
            self.assertIn('--dry-run',push[0])
            verify.assert_not_called()

    def test_re_review_accepts_only_the_exact_prior_reviewed_commit_chain(self):
        plan={'schema':'project-full-mirror-v1','repository':mirror.REPOSITORY,'branch':'main',
              'remote_base_commit':'a'*40,'files':[{'path':'synthetic.txt','git_blob':'c'*40}]}
        (self.root/'plan.json').write_text(json.dumps(plan),encoding='utf-8')
        def git(*args):
            if args==('rev-parse','HEAD'):return 'b'*40
            if args[:1]==('show',):return 'a'*40
            return 'e'*40
        with patch.object(mirror,'STATE',self.root), patch.object(mirror,'git',side_effect=git), \
             patch.object(mirror,'committed_files',return_value={'synthetic.txt':'c'*40}), patch.object(mirror,'command'):
            self.assertEqual(mirror.reviewed_base('a'*40),'b'*40)
        with patch.object(mirror,'STATE',self.root), patch.object(mirror,'git',side_effect=git), \
             patch.object(mirror,'committed_files',return_value={'unreviewed.txt':'f'*40}):
            with self.assertRaisesRegex(RuntimeError,'HEAD and remote'):
                mirror.reviewed_base('a'*40)

if __name__=='__main__':unittest.main()
