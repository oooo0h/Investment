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

if __name__=='__main__':unittest.main()
