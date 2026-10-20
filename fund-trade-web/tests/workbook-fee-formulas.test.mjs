// Synthetic workbooks stay in memory. Never reads live account workbooks.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { calculateLedger } from '../src/engine.js';

const python = process.env.FUND_PREVIEW_PYTHON || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const script = String.raw`
import io,json,zipfile,importlib.util,hashlib,datetime
from openpyxl import Workbook
from openpyxl.utils.datetime import to_excel, WINDOWS_EPOCH, MAC_EPOCH
spec=importlib.util.spec_from_file_location('reader','scripts/local-workbooks.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def fixture(formula='=E2/B2',fee=1,cache=50,kind='买入',code='016701'):
 b=Workbook();s=b.active;s.title='交易记录';s.append(m.HEADERS)
 s.append(['2024-01-02',2,formula,kind,100,fee]);raw=io.BytesIO();b.save(raw);out=io.BytesIO()
 with zipfile.ZipFile(raw) as source,zipfile.ZipFile(out,'w') as target:
  for item in source.infolist():
   data=source.read(item.filename)
   if item.filename=='xl/worksheets/sheet1.xml' and cache is not None:
    data=data.replace(b'</f><v></v>',('</f><v>'+str(cache)+'</v>').encode())
   target.writestr(item,data)
 data=out.getvalue();before=hashlib.sha256(data).hexdigest()
 result=m.read_book(data,code,False)
 assert hashlib.sha256(data).hexdigest()==before
 return result[0]
def serial_date(epoch):
 b=Workbook();b.epoch=epoch;s=b.active;s.title='交易记录';s.append(m.HEADERS)
 s.append([to_excel(datetime.datetime(2024,1,2),epoch),2,5,'买入',10,0]);s['A2'].number_format='General'
 data=io.BytesIO();b.save(data);return m.read_book(data.getvalue(),'016701')[0]['date']
print(json.dumps({
 'buy':fixture(), 'sell':fixture(kind='卖出'),
 'absolute':fixture('= $E$2 / $B$2'), 'literal':fixture(50),
 'correct':fixture('=(E2-F2)/B2',cache=49.5),
 'other_row':fixture('=E3/B3'), 'unknown':fixture('=SUM(E2)/B2'),
 'missing':fixture(cache=None), 'zero_fee':fixture(fee=0),
 'invalid_cash':fixture(fee=101),
 'round_boundary':m.fee_adjusted_formula_shares('=E2/B2',2,'买入',2,3,5.000001,1),
 'all_codes':{code:fixture(code=code) for code in ['005698','006373','016701','270023','006485','006663']},
 'serial_dates':[serial_date(WINDOWS_EPOCH),serial_date(MAC_EPOCH)]
}))
`;
const child = spawnSync(python, ['-X', 'utf8', '-B', '-c', script], { windowsHide: true, encoding: 'utf8' });
assert.equal(child.status, 0, 'Synthetic formula reader failed');
const rows = JSON.parse(child.stdout);

test('known purchase formula subtracts the supplied fee, labels the estimate and preserves cash inputs', () => {
  assert.equal(rows.buy.shares, 49.5);
  assert.equal(rows.buy.amount, 100);
  assert.equal(rows.buy.fee, 1);
  assert.equal(rows.buy.status, 'estimated');
  assert.equal(rows.buy.formulaAdjustment, 'purchase-net-shares');
  assert.match(rows.buy.calculationNote, /扣除手续费/);
  for (const mode of ['principal-first', 'profit-first']) assert.equal(calculateLedger([rows.buy], { mode }).summary.valid, true);
});

test('sale formula adds the supplied redemption fee when amount means net proceeds', () => {
  assert.equal(rows.sell.shares, 50.5);
  assert.equal(rows.sell.formulaAdjustment, 'sale-gross-shares');
  const opening = { date: '2024-01-01', type: 'buy', status: 'confirmed', nav: 2, shares: 100, amount: 200, fee: 0 };
  assert.equal(calculateLedger([opening, rows.sell]).summary.valid, true);
});

test('absolute references and six-place decimal half rounding follow the documented formula contract', () => {
  assert.equal(rows.absolute.shares, 49.5);
  assert.equal(rows.round_boundary, 2.000001);
});

test('hand-entered confirmed shares are never replaced and real discrepancies still fail the ledger', () => {
  assert.equal(rows.literal.shares, 50);
  assert.equal(rows.literal.status, 'confirmed');
  assert.equal(rows.literal.formulaAdjustment, undefined);
  assert.equal(calculateLedger([rows.literal]).summary.valid, false);
});

test('already correct formulas, other-row references and arbitrary formulas retain saved results', () => {
  for (const key of ['correct', 'other_row', 'unknown']) assert.equal(rows[key].formulaAdjustment, undefined);
  assert.equal(rows.correct.shares, 49.5);
  assert.equal(rows.other_row.shares, 50);
  assert.equal(rows.unknown.shares, 50);
});

test('missing caches, zero fees and invalid cash never fabricate a correction', () => {
  assert.equal(rows.missing.shares, null);
  assert.equal(rows.missing.status, 'pending');
  for (const key of ['missing', 'zero_fee', 'invalid_cash']) assert.equal(rows[key].formulaAdjustment, undefined);
});

test('all six held fund identities share the same fee-aware import behavior', () => {
  for (const [code, row] of Object.entries(rows.all_codes)) {
    assert.equal(row.id, `${code}-workbook-2`);
    assert.equal(row.shares, 49.5);
    assert.equal(calculateLedger([row]).summary.valid, true);
  }
});

test('General-format Excel date serials honor both Windows and Mac workbook epochs', () => {
  assert.deepEqual(rows.serial_dates, ['2024-01-02', '2024-01-02']);
});
