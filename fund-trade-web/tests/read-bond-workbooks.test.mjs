// All payloads are synthetic. Source workbook and account files are never read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.PYTHON_PATH || String.raw`C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`;
const preamble = String.raw`
import base64,importlib.util,json,sys,tempfile
from datetime import date,datetime,time
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('reader',Path('scripts/read-bond-workbooks.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Cell:
 def __init__(self,value):self.value=value
class Sheet:
 def __init__(self,rows=None,cells=None,lots=None):self.rows=rows or [];self.cells=cells or {};self.lots=lots or []
 def __getitem__(self,key):return [Cell(h) for h in m.HEADERS] if key==5 else Cell(self.cells.get(key))
 def iter_rows(self,**kwargs):return iter(self.lots if kwargs['min_row']==17 else self.rows)
def row(**changes):
 x={'application_date':date(2026,10,16),'application_time':time(12,0),'raw_type':'转换转出','amount':None,'requested_shares':3,'shares':None,'nav_date':None,'nav':None,'fee':None,'confirmed_amount':None,'confirmed_date':None,'raw_status':'进行中','source_status':'processing','note':'Synthetic source','identifier':'synthetic-unique','_source_filename':'synthetic.png','completion_deadline':None}
 x.update(changes)
 return tuple(x.values())
`;

function check(script) {
  const result = spawnSync(python, ['-c', preamble + '\n' + script], { cwd: root, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' } });
  assert.equal(result.status, 0, 'Synthetic bond-source validation failed.');
  assert.deepEqual(JSON.parse(result.stdout), { passed: true });
}

test('bond reader preserves application shares while pending confirmation fields stay empty and cancelled rows are excluded', () => {
  check(String.raw`
rows=m.read_transactions(Sheet([row(),row(raw_status='已撤销',source_status='cancelled',identifier='cancelled')] ),'006663')
assert len(rows)==1
r=rows[0]
assert r['requestedShares']==3 and r['shares'] is None and r['amount'] is None
assert r['status']=='pending' and r['sourceStatus']=='processing'
assert r['nav'] is None and r['navDate'] is None and r['fee'] is None and r['confirmedDate'] is None
assert r['submittedAt']=='2026-10-16 12:00:00'
print(json.dumps({'passed':True}))
`);
});

test('conversion NAV date and completion deadline never become the missing share confirmation date', () => {
  check(String.raw`
r=m.read_transactions(Sheet([row(application_date=date(2026,10,2),shares=3,nav_date=date(2026,10,8),nav=1.1,fee=0,confirmed_amount=3.3,raw_status='已确认',source_status='confirmed',completion_deadline=date(2026,10,9))]),'006663')[0]
assert r['date']=='2026-10-02' and r['navDate']=='2026-10-08'
assert r['confirmedDate'] is None and r['status']=='confirmed' and r['fee']==0
assert '2026-10-09' in r['note'] and '并非份额确认日期' in r['note']
assert r['confirmedAmount']==3.3 and r['amount'] is None
print(json.dumps({'passed':True}))
`);
});

test('Excel floating date precision cannot silently subtract a second from the source application time', () => {
  check(String.raw`
assert m.iso_time(datetime(2026,10,2,17,33,17,999000),'2026-10-02')=='17:33:18'
assert m.iso_time(time(17,33,17,999000),'2026-10-02')=='17:33:18'
assert m.iso_time(datetime(2026,10,1,23,59,59,999000),'2026-10-02')=='00:00:00'
assert m.iso_time('17:33:18','2026-10-02')=='17:33:18'
print(json.dumps({'passed':True}))
`);
});

test('confirmed trades require real shares, NAV, fee and explicit NAV date without inferred values', () => {
  check(String.raw`
for changes in ({'shares':None},{'nav':None},{'fee':None},{'nav_date':None},{'shares':0},{'nav':0}):
 values={'shares':3,'nav':1.1,'fee':0,'nav_date':date(2026,10,8),'raw_status':'已确认','source_status':'confirmed'}
 values.update(changes)
 try:m.read_transactions(Sheet([row(**values)]),'006663')
 except ValueError as error:assert str(error)=='Bond workbook source unavailable.'
 else:raise AssertionError('Missing evidence accepted')
assert m.numeric(0,optional=True)==0 and m.numeric(None,optional=True) is None
for invalid in (True,'1',float('nan'),float('inf')):
 try:m.numeric(invalid)
 except ValueError:pass
 else:raise AssertionError('Invalid numeric accepted')
print(json.dumps({'passed':True}))
`);
});

test('snapshot reader retains source amounts and original timestamp while the missing lot evidence stays explicitly false', () => {
  check(String.raw`
overview=Sheet(cells={'C4':'006485','C6':'2026-01-01T00:00:00.000Z','C7':100,'C8':5,'C13':False})
class Book:
 sheetnames=['持仓总览','逐笔交易']
 def __getitem__(self,key):return overview if key=='持仓总览' else Sheet([row()])
 def close(self):pass
original=m.openpyxl.load_workbook;m.openpyxl.load_workbook=lambda *args,**kwargs:Book()
try:r=m.read_book(Path('synthetic.xlsx'),'006485')
finally:m.openpyxl.load_workbook=original
assert r['bond']=={'code':'006485','marketValue':100,'holdingProfit':5}
assert r['updatedAt']=='2026-01-01T00:00:00.000Z' and r['holdingLots']=={'complete':False,'lots':[]}
print(json.dumps({'passed':True}))
`);
});

test('refresh keeps the authenticated data key and wrapping fields, writes ciphertext only and preserves optional cash flow', () => {
  check(String.raw`
with tempfile.TemporaryDirectory(prefix='bond-reader-synthetic-') as directory:
 root=Path(directory);(root/'data').mkdir()
 key=b'\x01'*32
 envelope={'version':2,'kdf':'PBKDF2-SHA256','iterations':600000,'keys':{'synthetic':{'salt':'unchanged','iv':'unchanged','ciphertext':'unchanged'}},'iv':'old','ciphertext':'old'}
 payload={'funds':{},'bonds':[],'freeCashFlow':-5,'updatedAt':'2026-01-01T00:00:00.000Z','holdingLots':{},'transactions':{}}
 m.refresh(root,payload,envelope,key)
 saved=json.loads((root/'data/bonds.enc.json').read_text())
 assert saved['keys']==envelope['keys'] and saved['iv']!=envelope['iv']
 decoded=json.loads(AESGCM(key).decrypt(base64.b64decode(saved['iv']),base64.b64decode(saved['ciphertext']),None))
 assert decoded==payload and decoded['funds']=={} and decoded['freeCashFlow']==-5
 assert set(saved)==set(envelope) and 'freeCashFlow' not in (root/'data/bonds.enc.json').read_text()
print(json.dumps({'passed':True}))
`);
});
