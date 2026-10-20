import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { adaptNav, createEnvelopeEncryptor, createLiveDataStore, resolveFundPath } from '../scripts/live-data.mjs';
import { getDailyCode } from '../src/vault.js';
import { FUND_CODES } from '../src/funds.js';
import { calculateLedger } from '../src/engine.js';
import { createLiveBondDataStore } from '../scripts/live-bond-data.mjs';

const pythonPath = process.env.FUND_PREVIEW_PYTHON || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function nav(code) {
  return { code, count: 2, first_date: '2024-01-02', last_date: '2024-01-03',
    rows: [{ date: '2024-01-02', nav: '1.12345678901234' }, { date: '2024-01-03', nav: '1.2345' }],
    supplementary_rows: [{ date: '2024-01-04', nav: '9' }] };
}
function entry(code) { return { code, name: `Synthetic ${code}`, records: 2, first_date: '2024-01-02', last_date: '2024-01-03', source: 'Synthetic public source', json_path: `基金/${code}_synthetic/历史净值/${code}_全部历史净值.json` }; }
function encryptionFixture() {
  const key = randomBytes(32), salt = randomBytes(16), iv = randomBytes(12);
  const wrapping = pbkdf2Sync(getDailyCode(), salt, 600000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', wrapping, iv);
  const bytes = Buffer.concat([cipher.update(key), cipher.final(), cipher.getAuthTag()]);
  const original = { version: 2, kdf: 'PBKDF2-SHA256', iterations: 600000,
    keys: { [getDailyCode()]: { salt: salt.toString('base64'), iv: iv.toString('base64'), ciphertext: bytes.toString('base64') } } };
  const decrypt = envelope => {
    const bytes = Buffer.from(envelope.ciphertext, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    cipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(0, -16)), cipher.final()]).toString());
  };
  return { original, decrypt };
}

test('NAV adapter uses every primary date, preserves raw precision and separates supplements', () => {
  const result = adaptNav(nav('270023'), entry('270023'), '2024-01-05T00:00:00Z');
  assert.equal(result.history.length, 2);
  assert.equal(result.history[0].navRaw, '1.12345678901234');
  assert.equal(result.lastDate, '2024-01-03');
  assert.equal(result.supplementaryCount, 1);
  assert.match(result.source, /gffunds/);
  for (const change of [d => d.rows.push(d.rows[0]), d => d.code = '005698', d => d.rows[0].date = '2024-02-30', d => d.count++]) {
    const invalid = nav('270023'); change(invalid);
    assert.throws(() => adaptNav(invalid, entry('270023')), { message: 'Local source validation failed.' });
  }
});

test('import paths cannot escape the fund or switch fund codes', () => {
  const workspace = path.resolve('synthetic-workspace');
  assert.equal(resolveFundPath(workspace, entry('005698').json_path, '005698'), path.join(workspace, entry('005698').json_path));
  for (const relative of ['../private.xlsx', '公共资料/private.xlsx', '基金/270023_other/records.xlsx', '基金/005698_synthetic/../../outside.xlsx']) {
    assert.throws(() => resolveFundPath(workspace, relative, '005698'));
  }
});

test('saved formula results are read without executing formulas and missing caches remain pending', () => {
  const script = String.raw`
import io,json,sys,zipfile,importlib.util
from openpyxl import Workbook
spec=importlib.util.spec_from_file_location('reader','scripts/local-workbooks.py')
reader=importlib.util.module_from_spec(spec);spec.loader.exec_module(reader)
b=Workbook();s=b.active;s.title='交易记录';s.append(reader.HEADERS)
for i in range(3):s.append(['2024-01-02',1,'=E'+str(i+2)+'/B'+str(i+2),'买入',10,0])
raw=io.BytesIO();b.save(raw);published=io.BytesIO()
with zipfile.ZipFile(raw) as source,zipfile.ZipFile(published,'w') as target:
    for item in source.infolist():
        data=source.read(item.filename)
        if item.filename=='xl/worksheets/sheet1.xml':
            xml=data.decode();xml=xml.replace('<f>E2/B2</f><v></v>','<f>E2/B2</f><v>10</v>')
            xml=xml.replace('<c r="C4"><f>E4/B4</f><v></v></c>','<c r="C4" t="e"><f>E4/B4</f><v>#DIV/0!</v></c>')
            data=xml.encode()
        target.writestr(item,data)
rows=reader.read_book(published.getvalue(),'005698',False,[{'row':2,'status':'confirmed'}])
print(json.dumps([{'shares':r['shares'],'status':r['status'],'sourceStatus':r['sourceStatus']} for r in rows]))
`;
  const result = spawnSync(pythonPath, ['-X', 'utf8', '-c', script], { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, 'Synthetic formula workbook could not be read');
  assert.deepEqual(JSON.parse(result.stdout), [
    { shares: 10, status: 'estimated', sourceStatus: 'formula-calculated' },
    { shares: null, status: 'pending', sourceStatus: 'formula-calculated' },
    { shares: null, status: 'pending', sourceStatus: 'formula-calculated' },
  ]);
});

test('live encryption retains credentials and session key across source updates', () => {
  const fixture = encryptionFixture(), encrypt = createEnvelopeEncryptor(fixture.original);
  const first = encrypt({ funds: { synthetic: { transactions: [] } } });
  const second = encrypt({ funds: { synthetic: { transactions: [{ status: 'pending' }] } } });
  assert.deepEqual(first.keys, fixture.original.keys);
  assert.notEqual(first.iv, second.iv);
  assert.equal(fixture.decrypt(first).funds.synthetic.transactions.length, 0);
  assert.equal(fixture.decrypt(second).funds.synthetic.transactions.length, 1);
  assert.equal(Object.hasOwn(first, 'funds'), false);
});

test('bond tables alone control row counts, retain unfinished drafts and never append legacy pending orders', async t => {
  const prefix = path.join(os.tmpdir(), 'fund-bond-synthetic-'), workspace = await mkdtemp(prefix), root = path.join(workspace, 'fund-trade-web');
  t.after(async () => { assert.ok(workspace.startsWith(prefix)); await rm(workspace, { recursive: true, force: true }); });
  const fixture = encryptionFixture(), encrypt = createEnvelopeEncryptor(fixture.original);
  await mkdir(path.join(root, 'data'), { recursive: true });
  await writeFile(path.join(root, 'data/bonds.enc.json'), JSON.stringify(encrypt({ funds: {}, transactions: {
    '006485': [{ id: 'legacy-pending', sourceStatus: 'processing', status: 'pending', type: 'buy', date: '2024-01-04', amount: 3 }],
  } })));
  const entries = ['006485', '006663'].map(entry);
  const indexFile = path.join(workspace, '公共资料/历史净值/全基金历史净值当前入口.json');
  await mkdir(path.dirname(indexFile), { recursive: true });
  await writeFile(indexFile, JSON.stringify({ schema: 'all-fund-nav-current-v1', updated_at: '2024-01-05', funds: entries }));
  const checksums = [];
  for (const item of entries) {
    const target = path.join(workspace, item.json_path); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(nav(item.code)));
    const workbook = path.join(path.dirname(path.dirname(target)), `${item.code}_交易记录.xlsx`);
    const script = `import sys,openpyxl\nb=openpyxl.Workbook()\ns=b.active\ns.title='交易记录'\ns.append(['交易日期','成交净值','确认份额','交易类型','金额','手续费（元）'])\ns.append(['2024-01-02',1,10,'买入',10,0])\ns.append([None,None,2.345678,'卖出',None,None])\nb.save(sys.argv[1])`;
    assert.equal(spawnSync(pythonPath, ['-X', 'utf8', '-c', script, workbook], { windowsHide: true }).status, 0);
    checksums.push([workbook, hash(await readFile(workbook))]);
  }
  const metadataFile = path.join(workspace, 'fund-trade-web/local/bond-metadata.json');
  await mkdir(path.dirname(metadataFile), { recursive: true });
  await writeFile(metadataFile, JSON.stringify({ funds: entries.map(item => ({ code: item.code, workbook_sha256: 'prior-source' })) }));
  const snapshot = await (await createLiveBondDataStore({ workspace, root, pythonPath })).snapshot();
  const payload = fixture.decrypt(snapshot.envelope);
  assert.equal(payload.bonds.length, 2);
  for (const item of entries) {
    assert.equal(payload.transactions[item.code].length, 2);
    assert.equal(payload.transactions[item.code].some(row => row.id === 'legacy-pending'), false);
    assert.equal(payload.transactions[item.code][1].date, null);
    assert.equal(payload.transactions[item.code][1].status, 'pending');
    assert.equal(payload.transactions[item.code][1].shares, 2.345678);
  }
  for (const [file, checksum] of checksums) assert.equal(hash(await readFile(file)), checksum);
});

test('real loader reads only selected canonical files, retains nulls, refreshes safely and never rewrites originals', async t => {
  const prefix = path.join(os.tmpdir(), 'fund-local-synthetic-'), workspace = await mkdtemp(prefix), root = path.join(workspace, 'fund-trade-web');
  t.after(async () => { assert.ok(workspace.startsWith(prefix)); await rm(workspace, { recursive: true, force: true }); });
  const fixture = encryptionFixture();
  await mkdir(path.join(root, 'data'), { recursive: true });
  await writeFile(path.join(root, 'data/ledger.enc.json'), JSON.stringify(fixture.original));
  const entries = [...FUND_CODES, '009608'].map(entry);
  const indexFile = path.join(workspace, '公共资料/历史净值/全基金历史净值当前入口.json');
  await mkdir(path.dirname(indexFile), { recursive: true });
  await writeFile(indexFile, JSON.stringify({ schema: 'all-fund-nav-current-v1', updated_at: '2024-01-05', funds: entries }));
  for (const item of entries.filter(item => FUND_CODES.includes(item.code))) {
    const file = path.join(workspace, item.json_path); await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(nav(item.code)));
  }
  const metadataFile = path.join(workspace, 'fund-trade-web/local/ledger-metadata.json');
  await mkdir(path.dirname(metadataFile), { recursive: true });
  await writeFile(metadataFile, JSON.stringify({ funds: [{ code: '005698', source_estimates_retained: true }] }));
  const workbook = path.join(workspace, '基金/005698_synthetic/005698_交易记录.xlsx');
  const makeBook = (missing, title = 'Synthetic') => {
    const code = `import sys,openpyxl\nb=openpyxl.Workbook()\nb.properties.title=sys.argv[2]\ns=b.active\ns.title='交易记录'\ns.append(['交易日期','成交净值','确认份额','交易类型','金额','手续费（元）'])\ns.append(['2024-01-02',${missing ? 'None' : '1'},${missing ? 'None' : '9'},'买入',10,${missing ? 'None' : '1'}])\nb.save(sys.argv[1])`;
    const result = spawnSync(pythonPath, ['-c', code, workbook, title], { windowsHide: true, encoding: 'utf8' });
    assert.equal(result.status, 0, 'Synthetic workbook creation failed');
  };
  makeBook(false);
  const original = hash(await readFile(workbook));
  const store = await createLiveDataStore({ workspace, root, pythonPath });
  const first = await store.snapshot(), payload = fixture.decrypt(first.envelope);
  assert.deepEqual(Object.keys(payload.funds).sort(), [...FUND_CODES].sort());
  assert.equal(payload.funds['005698'].transactions[0].status, 'estimated');
  assert.equal(payload.funds['005698'].transactions[0].dateBasis, 'order');
  assert.equal(payload.funds['005698'].transactions[0].navDate, null);
  assert.equal(payload.funds['006373'].transactions.length, 0);
  assert.equal(first.nav['009608'], undefined);
  assert.equal(hash(await readFile(workbook)), original);
  assert.strictEqual(await store.snapshot(), first);
  await writeFile(metadataFile, JSON.stringify({ funds: [{ code: '005698', source_estimates_retained: false,
    workbook_sha256: original, row_provenance: [{ row: 2, status: 'confirmed', nav_date: '2024-01-03' }] }] }));
  const identified = await store.snapshot(), identifiedRow = fixture.decrypt(identified.envelope).funds['005698'].transactions[0];
  assert.notEqual(identified.revision, first.revision);
  assert.equal(identifiedRow.status, 'confirmed');
  assert.equal(identifiedRow.navDate, '2024-01-03');
  makeBook(false, 'Edited');
  const unverified = fixture.decrypt((await store.snapshot()).envelope).funds['005698'].transactions[0];
  assert.equal(unverified.status, 'estimated');
  assert.equal(unverified.navDate, null);
  makeBook(true);
  const second = await store.snapshot(), changed = fixture.decrypt(second.envelope).funds['005698'];
  assert.notEqual(second.revision, first.revision);
  assert.equal(changed.transactions[0].nav, null);
  assert.equal(changed.transactions[0].fee, null);
  assert.equal(changed.transactions[0].status, 'pending');
  assert.equal(changed.incomplete, true);
  // An appended order after the published NAV uses a General-format Excel
  // serial date and has no confirmed NAV/shares yet. History stays usable.
  makeBook(false);
  const appendProcessing = String.raw`import sys,datetime,openpyxl
from openpyxl.utils.datetime import to_excel
b=openpyxl.load_workbook(sys.argv[1]);s=b['交易记录']
s.append([to_excel(datetime.datetime(2024,1,4)),None,None,'买入',5,0])
s['A3'].number_format='General';b.save(sys.argv[1])`;
  assert.equal(spawnSync(pythonPath, ['-X', 'utf8', '-B', '-c', appendProcessing, workbook], { windowsHide: true }).status, 0);
  const withOrder = fixture.decrypt((await store.snapshot()).envelope).funds['005698'];
  assert.equal(withOrder.transactions[1].date, '2024-01-04');
  assert.equal(withOrder.transactions[1].status, 'pending');
  assert.equal(withOrder.transactions[1].sourceStatus, 'processing');
  assert.equal(withOrder.incomplete, false);
  const calculated = calculateLedger(withOrder.transactions);
  assert.equal(calculated.summary.valid, true);
  assert.equal(calculated.summary.shares, 9);
  const appendDraft = String.raw`import sys,openpyxl
b=openpyxl.load_workbook(sys.argv[1]);b['交易记录'].append([None,None,None,None,3,None]);b.save(sys.argv[1])`;
  assert.equal(spawnSync(pythonPath, ['-X', 'utf8', '-B', '-c', appendDraft, workbook], { windowsHide: true }).status, 0);
  const withDraft = fixture.decrypt((await store.snapshot()).envelope).funds['005698'];
  assert.equal(withDraft.transactions[2].sourceStatus, 'draft');
  assert.equal(withDraft.incomplete, true);
  // Bad headers are refused without exposing a bad row or using stale data as fresh.
  await writeFile(workbook, 'synthetic invalid workbook');
  await assert.rejects(store.snapshot(), { message: 'Local source validation failed.' });
});
