import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalTransactionStore } from '../scripts/local-transactions.mjs';
import { readRegistrationRecords } from '../scripts/registration-records.mjs';
import { readTransferRecords } from '../scripts/transfer-records.mjs';

const pythonPath = process.env.FUND_PREVIEW_PYTHON || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const writer = fileURLToPath(new URL('../scripts/write-workbook.py', import.meta.url));
const HEADER = "['成交日期','成交净值','确认份额','交易类型','金额','手续费（元）']";

function makeBook(file, includeBuy) {
  const rows = includeBuy
    ? "s.append(['2026-09-01',1.5,100,'买入',150,0])\n[s.append([None,f'=IF(A{r}=\"\",\"\",1)',f'=IF(A{r}=\"\",\"\",1)',None,None,f'=IF(E{r}=\"\",\"\",0)']) for r in range(3,14)]"
    : "[s.append([None,f'=IF(A{r}=\"\",\"\",1)',f'=IF(A{r}=\"\",\"\",1)',None,None,f'=IF(E{r}=\"\",\"\",0)']) for r in range(2,14)]";
  const script = `import sys,openpyxl\nb=openpyxl.Workbook();s=b.active;s.title='交易记录'\ns.append(${HEADER})\n${rows}\nb.save(sys.argv[1])`;
  const result = spawnSync(pythonPath, ['-B', '-X', 'utf8', '-c', script, file], { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, 'Synthetic workbook creation failed');
}

function readWritten(workspace, code, relative, row, kind, date) {
  const payload = { workspace, code, path: relative, action: 'read', row, expect: { date, kind } };
  const result = spawnSync(pythonPath, ['-B', '-X', 'utf8', writer], { windowsHide: true, encoding: 'utf8', input: JSON.stringify(payload) });
  assert.equal(result.status, 0, 'Synthetic workbook read failed');
  return JSON.parse(result.stdout).values;
}

test('local buy, sell, transfer and review write the expected fee amounts', async t => {
  const prefix = path.join(os.tmpdir(), 'local-transactions-'), workspace = await mkdtemp(prefix), root = path.join(workspace, 'fund-trade-web');
  t.after(async () => { assert.ok(workspace.startsWith(prefix)); await rm(workspace, { recursive: true, force: true }); });
  await mkdir(path.join(root, 'local'), { recursive: true });
  await mkdir(path.join(workspace, '公共资料/历史净值'), { recursive: true });
  const sources = {};
  for (const [code, nav, includeBuy] of [['005698', '1.5', true], ['016701', '2', false]]) {
    const dir = path.join(workspace, '基金', '持仓基金', `${code}_测试`);
    await mkdir(dir, { recursive: true });
    makeBook(path.join(dir, `${code}_交易记录.xlsx`), includeBuy);
    await writeFile(path.join(dir, 'nav.json'), JSON.stringify({ code, rows: [{ date: '2026-10-21', nav }] }));
    sources[code] = { code, name: code, json_path: `基金/持仓基金/${code}_测试/nav.json`, xlsx_path: `基金/持仓基金/${code}_测试/${code}_交易记录.xlsx`, records: 1 };
  }
  await writeFile(path.join(workspace, '公共资料/历史净值/全基金历史净值当前入口.json'), JSON.stringify({ schema: 'all-fund-nav-current-v1', funds: [sources['005698'], sources['016701']] }));
  const store = createLocalTransactionStore({ workspace, root, pythonPath });

  const buy = await store.create({ mode: 'buy', code: '005698', date: '2026-10-21', cutoff: 'before', amount: '1000' });
  assert.equal(buy.row, 3);
  const buyRow = readWritten(workspace, '005698', sources['005698'].xlsx_path, buy.row, '买入', '2026-10-21');
  assert.equal(buyRow.E, 1000);
  assert.equal(buyRow.F, 1.5);

  const sell = await store.create({ mode: 'sell', code: '005698', date: '2026-10-21', cutoff: 'before', outShares: '50' });
  assert.equal(sell.row, 4);
  const sellRow = readWritten(workspace, '005698', sources['005698'].xlsx_path, sell.row, '卖出', '2026-10-21');
  assert.equal(sellRow.B, 1.5);
  assert.equal(sellRow.C, 50);
  assert.equal(sellRow.E, 74.62);
  assert.equal(sellRow.F, 0.38);

  const transfer = await store.create({ mode: 'transfer', code: '005698', targetCode: '016701', date: '2026-10-21', cutoff: 'before', outShares: '30' });
  const filled = await store.reconcile();
  assert.equal(filled.updated, 1);
  const outRow = readWritten(workspace, '005698', sources['005698'].xlsx_path, transfer.row, '卖出', '2026-10-21');
  const inRow = readWritten(workspace, '016701', sources['016701'].xlsx_path, transfer.inRow, '转入', '2026-10-21');
  assert.equal(outRow.E, 44.77);
  assert.equal(outRow.F, 0.23);
  assert.equal(inRow.E, 44.77);
  assert.equal(inRow.F, 0);
  assert.equal(inRow.C, 22.385);

  const reviewed = await store.review({ id: transfer.transferId, outAmount: '44.77', inAmount: '44.75', outFee: '0', inFee: '0' });
  assert.deepEqual(reviewed, { ok: true, difference: 0.02 });
  const reviewedIn = readWritten(workspace, '016701', sources['016701'].xlsx_path, transfer.inRow, '转入', '2026-10-21');
  assert.equal(reviewedIn.E, 44.75);
  assert.equal(reviewedIn.C, 22.375);
  const transfers = await readTransferRecords({ root });
  assert.equal(transfers[0].status, 'reviewed');
  const registrations = await readRegistrationRecords({ root });
  assert.deepEqual(registrations.map(record => record.status), ['filled', 'filled']);
});
