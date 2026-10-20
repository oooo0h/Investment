// Synthetic quantities only. No workbook or encrypted account file is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.PYTHON_PATH || String.raw`C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`;
const preamble = String.raw`
import importlib.util,json,sys
from pathlib import Path
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('bond_math',Path('scripts/bond-workbook-math.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def row(identifier='a',day='2026-06-01',clock='10:00:00',kind='buy',**changes):
 r={'id':identifier,'date':day,'submittedAt':day+' '+clock,'type':kind,'amount':22,'shares':None,'requestedShares':None,'confirmedAmount':None,'confirmedDate':None,'nav':None,'navDate':None,'fee':None,'status':'pending','sourceStatus':'unverified','note':None}
 r.update(changes);return r
navs={'2026-06-01':1.1,'2026-06-02':1.1,'2026-06-03':1.2,'2026-06-04':1.2,'2026-06-08':1.2,'2026-06-09':1.2,'2026-06-10':1.2,'2026-06-11':1.2,'2026-07-02':1.2,'2026-07-03':1.2}
def run(rows,code='006485',values=None):return m.reconstruct(code,rows,values or navs,as_of='2026-10-19')
`;
function check(body) {
  const result = spawnSync(python, ['-c', preamble + '\n' + body + '\nprint(json.dumps({"passed":True}))'], {
    cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, 'Synthetic bond reconstruction failed.');
  assert.deepEqual(JSON.parse(result.stdout), { passed: true });
}

test('missing completed purchase shares use amount divided by NAV and remain explicitly provisional', () => check(String.raw`
source=row();r=run([source]);t=r['transactions'][0]
assert t['shares']==20 and t['nav']==1.1 and t['fee']==0
assert t['navDate']=='2026-06-01' and t['confirmedDate']=='2026-06-02'
assert t['sharesBasis']=='calculated' and t['sourceStatus']=='calculated'
assert source['shares'] is None and source['status']=='pending'
assert r['holdingLots']['complete'] is False and r['holdingLots']['basis']=='calculated'
assert '未证明不存在更早期初持仓' in t['note']
`));

test('15:00 cutoff and non-open application days advance to the next actual NAV date', () => check(String.raw`
t=run([row(day='2026-06-02',clock='15:00:00',amount=24)])['transactions'][0]
assert t['navDate']=='2026-06-03' and t['confirmedDate']=='2026-06-04' and t['shares']==20
calendar={'2026-10-01':1,'2026-10-08':1.25,'2026-10-09':1.25,'2026-10-16':1.25}
t=run([row(day='2026-10-02',clock='17:33:18',amount=25)],values=calendar)['transactions'][0]
assert t['navDate']=='2026-10-08' and t['confirmedDate']=='2026-10-09' and t['shares']==20
`));

test('reported confirmed shares, NAV and actual conversion charge retain priority over derived fields', () => check(String.raw`
buy=row(amount=44)
out=row('b','2026-06-08',kind='transfer-out',amount=None,requestedShares=3,shares=3,nav=1.23,navDate='2026-06-08',fee=0.13,status='confirmed',sourceStatus='confirmed',confirmedAmount=3.69)
r=run([buy,out]);t=r['transactions'][1]
for field in ('shares','nav','navDate','fee','confirmedAmount','confirmedDate'):assert t[field]==out[field]
assert t['sharesBasis']=='reported' and t['sourceStatus']=='confirmed'
assert r['holdingLots']['lots'][0]['remainingShares']==37
`));

test('redemptions consume oldest shares first and preserve the later acquisition date', () => check(String.raw`
rows=[row(amount=22),row('b','2026-06-03',amount=24),row('c','2026-06-08',kind='transfer-out',amount=None,requestedShares=25)]
r=run(rows);lots=r['holdingLots']['lots']
assert len(lots)==1 and lots[0]['remainingShares']==15 and lots[0]['confirmedDate']=='2026-06-04'
`));

test('net redemption cash is inverted per lot using the specified ordinary redemption fee tiers', () => check(String.raw`
r=run([row(amount=110),row('b','2026-06-10',kind='sell',amount=11.988)])
assert r['transactions'][1]['shares']==10 and r['transactions'][1]['fee']==0.01
assert r['holdingLots']['lots'][0]['remainingShares']==90
assert m.redemption_rate('006485',6)==m.dec('.015')
assert m.redemption_rate('006485',7)==m.dec('.001')
assert m.redemption_rate('006485',29)==m.dec('.001')
assert m.redemption_rate('006485',30)==0
assert m.redemption_rate('006663',7)==0
`));

test('ongoing requests are retained without confirmed economics or any lot change', () => check(String.raw`
pending=row('b','2026-10-19',kind='buy',sourceStatus='processing')
r=run([row(),pending]);assert r['transactions'][1]==pending
assert len(r['holdingLots']['lots'])==1 and r['holdingLots']['lots'][0]['remainingShares']==20
`));

test('purchase actual fee wins while incoming converted cash is not charged twice', () => check(String.raw`
a=run([row(amount=22.11,fee=.11)])['transactions'][0]
b=run([row(kind='transfer-in',amount=22,fee=.11)])['transactions'][0]
assert a['shares']==20 and b['shares']==20 and a['fee']==b['fee']==.11
`));

test('a missing opening balance cannot silently become a fabricated acquisition', () => check(String.raw`
for rows in ([row('a',kind='transfer-out',amount=None,requestedShares=1)], [row(),row('b','2026-06-08',kind='sell',amount=50)]):
 try:run(rows)
 except m.ReconstructionError as e:assert e.reason=='history-shortfall' and str(e)=='Bond reconstruction unavailable.'
 else:raise AssertionError('Short history accepted')
`));

test('unknown timing, NAV coverage and a missing next open day never become guessed confirmations', () => check(String.raw`
cases=[(row(submittedAt=None),'missing-application-time'),(row(day='2026-10-19'),'missing-nav'),(row(day='2026-07-03'),'missing-confirmation-calendar'),(row(day='2026-05-01'),'nav-window-incomplete')]
for source,reason in cases:
 try:run([source])
 except m.ReconstructionError as e:assert e.reason==reason
 else:raise AssertionError('Unknown execution accepted')
`));

test('a purchase not yet confirmed cannot be consumed by an earlier redemption', () => check(String.raw`
try:run([row(),row('b',kind='transfer-out',amount=None,requestedShares=2)])
except m.ReconstructionError as e:assert e.reason=='history-shortfall'
else:raise AssertionError('Future lot consumed')
`));

test('a partially reported NAV or NAV date is preserved while only its missing counterpart is derived', () => check(String.raw`
a=run([row(day='2026-06-02',navDate='2026-06-03',amount=24)])['transactions'][0]
b=run([row(nav=1.3,amount=26)])['transactions'][0]
assert a['navDate']=='2026-06-03' and a['nav']==1.2 and a['shares']==20
assert b['nav']==1.3 and b['navDate']=='2026-06-01' and b['shares']==20
`));

test('actual redemption fees take priority when reversing net received cash into shares', () => check(String.raw`
t=run([row(amount=110),row('b','2026-06-10',kind='sell',amount=11.5,fee=.5)])['transactions'][1]
assert t['shares']==10 and t['fee']==.5
`));

test('fee boundary uses redemption confirmation day excluding that day, including elapsed non-open days', () => check(String.raw`
t=run([row(day='2026-06-03',amount=120),row('b','2026-06-10',kind='sell',amount=11.988)])['transactions'][1]
assert t['shares']==10 and t['fee']==.01
extended={**navs,'2026-07-01':1.2}
t=run([row(amount=110),row('b','2026-07-01',kind='sell',amount=12)],values=extended)['transactions'][1]
assert t['shares']==10 and t['fee']==0
`));

test('an actual purchase with an unknown confirmation date retains its reported date field', () => check(String.raw`
t=run([row(shares=20,nav=1.1,navDate='2026-06-01',fee=0,status='confirmed',sourceStatus='confirmed')])
assert t['transactions'][0]['confirmedDate'] is None
assert t['transactions'][0]['sourceStatus']=='confirmed' and t['transactions'][0]['sharesBasis']=='reported'
assert t['holdingLots']['lots'][0]['confirmedDate']=='2026-06-02' and t['holdingLots']['complete'] is False
`));

test('a known redemption share count never turns an unknown actual fee into zero', () => check(String.raw`
t=run([row(amount=110),row('b','2026-06-03',kind='sell',amount=None,shares=3,nav=1.2,navDate='2026-06-03')])['transactions'][1]
assert t['shares']==3 and t['fee'] is None
`));

test('FIFO follows reported confirmation order even when an earlier application was confirmed later', () => check(String.raw`
a=row(shares=20,nav=1.1,navDate='2026-06-01',fee=0,confirmedDate='2026-06-09',status='confirmed',sourceStatus='confirmed')
b=row('b','2026-06-03',shares=20,nav=1.2,navDate='2026-06-03',fee=0,confirmedDate='2026-06-04',status='confirmed',sourceStatus='confirmed')
out=row('c','2026-06-10',kind='transfer-out',amount=None,requestedShares=25)
lots=run([a,b,out])['holdingLots']['lots']
assert len(lots)==1 and lots[0]['confirmedDate']=='2026-06-09' and lots[0]['remainingShares']==15
`));
