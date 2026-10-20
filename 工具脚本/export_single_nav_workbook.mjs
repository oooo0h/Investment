// Public NAV only. One user-facing workbook per fund; machine sources stay central.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = createRequire(path.join(root, '临时文件/entry.mjs'));
const { Workbook, SpreadsheetFile, FileBlob } = await import(pathToFileURL(runtime.resolve('@oai/artifact-tool')).href);
const indexPath = path.join(root, '公共资料/历史净值/全基金历史净值当前入口.json');
const stage = path.join(root, '临时文件/工具脚本/单份净值整理_20261020');
const selected = process.argv.find(a => a.startsWith('--codes='))?.slice(8).split(',');
const staging = process.argv.includes('--stage');
const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
await fs.mkdir(stage, { recursive: true });
const outputs = [];
for (const entry of index.funds) {
  if (selected && !selected.includes(entry.code)) continue;
  const doc = JSON.parse(await fs.readFile(path.join(root, entry.json_path), 'utf8'));
  assert.equal(doc.code, entry.code);
  assert.equal(doc.count, doc.rows.length);
  assert.equal(new Set(doc.rows.map(r => r.date)).size, doc.count);
  const book = Workbook.create();
  const sources = [['全部历史净值', doc.rows], ...(doc.supplementary_rows?.length ? [['待官网复核', doc.supplementary_rows]] : [])];
  for (const [name, rows] of sources) {
    const sheet = book.worksheets.add(name);
    const last = rows.length + 1;
    sheet.showGridLines = false;
    sheet.getRange(`A1:C${last}`).values = [['日期', '净值', '日增长率'], ...rows.map(r => [new Date(r.date + 'T00:00:00Z'), Number(r.nav), r.daily_growth_pct == null || r.daily_growth_pct === '' ? null : Number(r.daily_growth_pct) / 100])];
    sheet.getRange(`A1:C${last}`).format.font = { name: 'Arial', size: 11 };
    sheet.getRange(`A1:C${last}`).format.rowHeight = 20;
    sheet.getRange('A1:C1').format = { fill: '#243F5B', font: { name: 'Arial', size: 11, bold: true, color: '#FFFFFF' }, horizontalAlignment: 'center', rowHeight: 26 };
    sheet.getRange(`A2:A${last}`).setNumberFormat('yyyy-mm-dd');
    sheet.getRange(`B2:B${last}`).setNumberFormat('0.0000########');
    sheet.getRange(`C2:C${last}`).setNumberFormat('0.00########%');
    for (const col of ['A', 'B', 'C']) sheet.getRange(`${col}1:${col}${last}`).format.columnWidth = col === 'A' ? 18 : 22;
    sheet.freezePanes.freezeRows(1);
    sheet.tables.add(`A1:C${last}`, true, `Nav_${entry.code}${name === '全部历史净值' ? '' : '_Supplement'}`);
  }
  book.recalculate();
  await book.inspect({ kind: 'table', range: '全部历史净值!A1:C4', tableMaxRows: 4, tableMaxCols: 3, maxChars: 400 });
  const errors = await book.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#NUM!', options: { useRegex: true, maxResults: 10 }, maxChars: 500 });
  assert.ok(!/"cell"/.test(errors.ndjson));
  for (const [name] of sources) {
    const blob = await book.render({ sheetName: name, range: 'A1:C6', scale: 1.5, format: 'png' });
    await fs.writeFile(path.join(stage, `${entry.code}_${name}.png`), new Uint8Array(await blob.arrayBuffer()));
  }
  const output = path.join(stage, `${entry.code}_全部历史净值.xlsx`);
  await (await SpreadsheetFile.exportXlsx(book)).save(output);
  // Reimport the actual exported bytes, including the Excel date serialization.
  const saved = await SpreadsheetFile.importXlsx(await FileBlob.load(output));
  for (const [name, rows] of sources) {
    const actual = saved.worksheets.getItem(name).getRange(`A2:C${rows.length + 1}`).values;
    assert.equal(actual.length, rows.length);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], excelDay = Math.round((Date.parse(r.date + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000);
      assert.equal(actual[i][0] instanceof Date ? actual[i][0].toISOString().slice(0, 10) : actual[i][0], actual[i][0] instanceof Date ? r.date : excelDay);
      assert.equal(actual[i][1], Number(r.nav));
      const growth = r.daily_growth_pct == null || r.daily_growth_pct === '' ? null : Number(r.daily_growth_pct) / 100;
      assert.ok(growth === null ? actual[i][2] == null || actual[i][2] === '' : Math.abs(actual[i][2] - growth) < 1e-14);
    }
  }
  if (!staging) {
    assert.ok(entry.xlsx_path, 'Current index must specify the sole workbook');
    const target = path.join(root, entry.xlsx_path);
    await fs.copyFile(output, target + '.replace-tmp');
    await fs.rename(target + '.replace-tmp', target);
  }
  outputs.push({ code: entry.code, staged: path.relative(root, output).split(path.sep).join('/'), rows: doc.rows.length, sheets: sources.length });
  console.log(JSON.stringify(outputs.at(-1)));
}
await fs.writeFile(path.join(stage, 'workbooks.json'), JSON.stringify(outputs, null, 2));
