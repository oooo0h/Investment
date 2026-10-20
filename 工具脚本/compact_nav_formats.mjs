// Fixed three-column public NAV exports. Never reads transaction workbooks.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(toolDir, '..');
const bundle = createRequire(path.join(workspace, '临时文件/工具脚本/净值目录整理/entry.mjs'));
const { Workbook, SpreadsheetFile } = await import(pathToFileURL(bundle.resolve('@oai/artifact-tool')).href);
const state = path.join(workspace, '临时文件/工具脚本/净值三列整理_20261019');
const manifestFile = path.join(state, 'manifest.json');
const headers = ['日期', '净值', '日增长率'];
const selected = process.argv.find(arg => arg.startsWith('--codes='))?.slice(8).split(',');
const csvOnly = process.argv.includes('--csv-only');
const exists = file => fs.stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const missing = value => value === null || value === undefined || value === '';
const numeric = value => missing(value) ? null : Number(value);
const csvCell = value => /[",\r\n]/.test(String(value)) ? '"' + String(value).replaceAll('"','""') + '"' : String(value);
function resolve(relative, code) {
  const file = path.resolve(workspace, relative), inside = path.relative(path.join(workspace, '公共资料/历史净值/维护数据', code), file);
  assert.ok(!inside.startsWith('..') && !path.isAbsolute(inside) && !inside.includes(path.sep));
  return file;
}
async function publish() {
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  for (const source of manifest.sources) assert.equal(hash(await fs.readFile(source.file)), source.sha256, 'NAV source changed');
  for (const output of manifest.outputs) {
    assert.equal(hash(await fs.readFile(output.target)), output.previousSha256, 'Existing table changed');
    assert.equal(hash(await fs.readFile(output.staged)), output.sha256, 'Prepared table changed');
  }
  for (const output of manifest.outputs) {
    const temporary = output.target + '.replace-tmp';
    await fs.copyFile(output.staged, temporary);
    await fs.rename(temporary, output.target);
  }
  console.log(JSON.stringify({ published: manifest.outputs.length, csv: manifest.outputs.filter(f => f.target.endsWith('.csv')).length, xlsx: manifest.outputs.filter(f => f.target.endsWith('.xlsx')).length }));
}
if (process.argv.includes('--publish')) { await publish(); process.exit(0); }
await fs.mkdir(state, { recursive: true });
const index = JSON.parse(await fs.readFile(path.join(workspace, '公共资料/历史净值/全基金历史净值当前入口.json'), 'utf8'));
const manifest = { columns: headers, sources: [], outputs: [], funds: [] };
for (const fund of index.funds) {
  if (selected && !selected.includes(fund.code)) continue;
  const file = resolve(fund.json_path, fund.code), source = await fs.readFile(file), doc = JSON.parse(source);
  assert.equal(doc.code, fund.code); assert.equal(doc.rows.length, fund.records);
  assert.equal(doc.rows[0].date, fund.first_date); assert.equal(doc.rows.at(-1).date, fund.last_date);
  manifest.sources.push({ file, sha256: hash(source) });
  const csvRows = doc.rows.map(row => [row.date, String(row.nav), missing(row.daily_growth_pct) ? '' : row.daily_growth_pct + '%']);
  const csv = '\uFEFF' + [headers, ...csvRows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const csvTarget = file.replace(/\.json$/, '.csv'), csvStaged = path.join(state, fund.code + '_全部历史净值.csv');
  const roundtrip = await Workbook.fromCSV(csv.slice(1), { sheetName: '核对' });
  const readback = roundtrip.worksheets.getItemAt(0).getRange('A1:C' + (csvRows.length + 1)).values;
  assert.deepEqual(readback[0], headers);
  for (let row = 0; row < csvRows.length; row++) assert.deepEqual(readback[row + 1].map(value => missing(value) ? '' : String(value)), csvRows[row]);
  await fs.writeFile(csvStaged, csv, 'utf8');
  manifest.outputs.push({ target: csvTarget, staged: csvStaged, previousSha256: hash(await fs.readFile(csvTarget)), sha256: hash(Buffer.from(csv)) });
  const xlsxTarget = path.resolve(workspace, fund.xlsx_path);
  assert.equal(path.basename(xlsxTarget), fund.code + '_全部历史净值.xlsx');
  assert.ok(xlsxTarget.startsWith(path.join(workspace, '基金') + path.sep));
  const hasXlsx = !csvOnly && await exists(xlsxTarget);
  if (hasXlsx) {
    const book = Workbook.create();
    for (const [name, rows] of [['全部历史净值', doc.rows], ...(doc.supplementary_rows?.length ? [['待官网复核', doc.supplementary_rows]] : [])]) {
      const sheet = book.worksheets.add(name), last = rows.length + 1;
      sheet.showGridLines = false;
      const values = rows.map(row => [new Date(row.date + 'T00:00:00Z'), numeric(row.nav), missing(row.daily_growth_pct) ? null : Number(row.daily_growth_pct) / 100]);
      sheet.getRange('A1:C' + last).values = [headers, ...values];
      sheet.getRange('A1:C' + last).format.font = { name: 'Arial', size: 11 };
      sheet.getRange('A1:C' + last).format.verticalAlignment = 'center';
      sheet.getRange('A1:C1').format = { fill: '#243F5B', font: { name: 'Arial', size: 11, bold: true, color: '#FFFFFF' }, horizontalAlignment: 'center' };
      sheet.getRange('A2:A' + last).setNumberFormat('yyyy-mm-dd');
      sheet.getRange('B2:B' + last).setNumberFormat('0.0000########');
      sheet.getRange('C2:C' + last).setNumberFormat('0.00########%');
      for (const [column, width] of [['A', 18], ['B', 22], ['C', 22]]) sheet.getRange(column + '1:' + column + last).format.columnWidth = width;
      sheet.freezePanes.freezeRows(1);
      sheet.tables.add('A1:C' + last, true, 'FundNav_' + fund.code + (name === '全部历史净值' ? '' : '_Supplement'));
      const actual = sheet.getRange('B2:C' + last).values;
      for (let row = 0; row < values.length; row++) assert.deepEqual(actual[row], values[row].slice(1));
    }
    book.recalculate();
    await book.inspect({ kind: 'table', range: '全部历史净值!A1:C5', include: 'values', tableMaxRows: 5, tableMaxCols: 3, maxChars: 600 });
    const scan = await book.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!', options: { useRegex: true, maxResults: 20 }, maxChars: 600 });
    assert.ok(!/"cell"/.test(scan.ndjson));
    for (const name of ['全部历史净值', ...(doc.supplementary_rows?.length ? ['待官网复核'] : [])]) {
      const preview = await book.render({ sheetName: name, range: 'A1:C6', scale: 1.5, format: 'png' });
      await fs.writeFile(path.join(state, fund.code + '_' + name + '.png'), new Uint8Array(await preview.arrayBuffer()));
    }
    const xlsxStaged = path.join(state, fund.code + '_全部历史净值.xlsx');
    await (await SpreadsheetFile.exportXlsx(book)).save(xlsxStaged);
    manifest.outputs.push({ target: xlsxTarget, staged: xlsxStaged, previousSha256: hash(await fs.readFile(xlsxTarget)), sha256: hash(await fs.readFile(xlsxStaged)) });
  }
  manifest.funds.push({ code: fund.code, records: doc.rows.length, first_date: fund.first_date, last_date: fund.last_date, xlsx: hasXlsx });
  console.log(JSON.stringify(manifest.funds.at(-1)));
}
await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
if (!process.argv.includes('--stage')) await publish();
