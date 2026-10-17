import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

// Uses only the bundled runtime through 工具/tmp/node_modules junction.
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(toolDir, '../..');
const tmpDir = path.join(toolDir, 'tmp');
const bundledRequire = createRequire(path.join(tmpDir, 'entry.mjs'));
const { Workbook } = await import(pathToFileURL(bundledRequire.resolve('@oai/artifact-tool')).href);
const manifestPath = path.join(rootDir, '公共资料/历史净值/持仓基金全历史净值归档清单_2026-10-16.json');
const manifest = JSON.parse((await fs.readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
const excludedCodes = new Set(['270023', '019736', '019547']);
const entries = manifest.results.filter((item) => !excludedCodes.has(item.code));
assert.equal(entries.length, 14, 'Expected 14 CSV outputs after the requested exclusions');
const headers = ['基金代码', '基金名称', '净值日期', '单位净值', '累计净值', '日增长率(%)', '分红事件', '数据来源'];
const results = [];

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const output = Number(value);
  assert.ok(Number.isFinite(output), 'Non-finite source numeric value');
  return output;
}

function preserveDecimal(value, original) {
  if (original === null || original === undefined || original === '') {
    assert.ok(value === null || value === undefined || value === '', 'A missing source value changed');
    return '';
  }
  assert.equal(value, Number(original), 'Workbook numeric value differs from JSON');
  const sourceText = String(original);
  const precision = sourceText.includes('.') ? sourceText.split('.')[1].length : 0;
  const text = Number(value).toFixed(precision);
  assert.equal(Number(text), Number(original), 'Decimal serialization changed the numeric value');
  return text;
}

function escapeCsv(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

for (const entry of entries) {
  assert.match(entry.code, /^\d{6}$/);
  const inputPath = path.resolve(rootDir, entry.json_file);
  assert.ok(inputPath.startsWith(rootDir + path.sep), 'JSON path is outside the project');
  const document = JSON.parse((await fs.readFile(inputPath, 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(document.code, entry.code);
  const rows = document.rows.slice().sort((a, b) => a.date.localeCompare(b.date));
  assert.equal(rows.length, entry.count);
  assert.equal(new Set(rows.map((row) => row.date)).size, rows.length);
  assert.equal(rows[0].date, entry.first_date);
  assert.equal(rows.at(-1).date, entry.last_date);
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add(entry.code);
  sheet.showGridLines = false;
  const data = rows.map((row) => {
    assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/);
    return [entry.code, document.name, row.date, numeric(row.nav), numeric(row.accumulated_nav), numeric(row.daily_growth_pct), row.event ?? '', row.source ?? document.source ?? ''];
  });
  const lastRow = rows.length + 1;
  sheet.getRange(`A1:H${lastRow}`).values = [headers, ...data];
  sheet.getRange(`A1:H${lastRow}`).format.font = { name: 'Arial', size: 10 };
  sheet.getRange(`A1:H${lastRow}`).format.verticalAlignment = 'center';
  sheet.getRange(`A2:C${lastRow}`).setNumberFormat('@');
  sheet.getRange(`D2:E${lastRow}`).setNumberFormat('0.0000');
  sheet.getRange(`F2:F${lastRow}`).setNumberFormat('0.00');
  sheet.getRange('A1:H1').format = { fill: '#1F4E78', font: { name: 'Arial', size: 10, bold: true, color: '#FFFFFF' }, horizontalAlignment: 'center' };
  sheet.getRange(`A1:A${lastRow}`).format.columnWidth = 12;
  sheet.getRange(`B1:B${lastRow}`).format.columnWidth = 65;
  sheet.getRange(`C1:C${lastRow}`).format.columnWidth = 15;
  sheet.getRange(`D1:F${lastRow}`).format.columnWidth = 17;
  sheet.getRange(`G1:G${lastRow}`).format.columnWidth = 38;
  sheet.getRange(`H1:H${lastRow}`).format.columnWidth = 30;
  sheet.freezePanes.freezeRows(1);
  workbook.recalculate();
  await workbook.inspect({ kind: 'table', range: `${entry.code}!A1:H3`, include: 'values', maxChars: 1000, tableMaxRows: 3, tableMaxCols: 8 });
  const readback = sheet.getRange(`A2:H${lastRow}`).values;
  assert.equal(readback.length, rows.length);
  const exportedRows = readback.map((row, index) => {
    const source = rows[index];
    assert.equal(row[0], entry.code, 'Six-digit fund code changed');
    assert.equal(row[1], document.name);
    assert.equal(row[2], source.date, 'ISO date changed');
    assert.equal(row[6] ?? '', source.event ?? '');
    assert.equal(row[7] ?? '', source.source ?? document.source ?? '');
    return [row[0], row[1], row[2], preserveDecimal(row[3], source.nav), preserveDecimal(row[4], source.accumulated_nav), preserveDecimal(row[5], source.daily_growth_pct), row[6] ?? '', row[7] ?? ''];
  });
  const preview = await workbook.render({ sheetName: entry.code, range: 'A1:H4', scale: 1, format: 'png' });
  await fs.writeFile(path.join(tmpDir, `nav_csv_preview_${entry.code}.png`), new Uint8Array(await preview.arrayBuffer()));
  const csvText = '\uFEFF' + [headers, ...exportedRows].map((row) => row.map(escapeCsv).join(',')).join('\r\n') + '\r\n';
  const csvPath = inputPath.replace(/\.json$/i, '.csv');
  assert.notEqual(csvPath, inputPath);
  await fs.writeFile(csvPath, csvText, 'utf8');
  const saved = await fs.readFile(csvPath);
  assert.ok(saved.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])), 'CSV BOM missing');
  const imported = await Workbook.fromCSV(saved.toString('utf8').replace(/^\uFEFF/, ''), { sheetName: 'CSVCheck' });
  const importedRows = imported.worksheets.getItemAt(0).getRange(`A1:H${lastRow}`).values;
  assert.equal(importedRows.length, lastRow);
  assert.deepEqual(importedRows[0], headers);
  for (let index = 0; index < exportedRows.length; index += 1) {
    assert.deepEqual(importedRows[index + 1].map((cell) => cell === null || cell === undefined ? '' : String(cell)), exportedRows[index].map(String), `Saved CSV differs from JSON at code ${entry.code}, row ${index + 2}`);
  }
  results.push({ code: entry.code, count: rows.length, first_date: rows[0].date, last_date: rows.at(-1).date, csv_file: path.relative(rootDir, csvPath).split(path.sep).join('/'), missing_accumulated_nav_count: rows.filter((row) => row.accumulated_nav === null || row.accumulated_nav === undefined || row.accumulated_nav === '').length, validated_against_json: true });
}

const validationPath = path.join(tmpDir, 'holding_nav_csv_validation_2026-10-16.json');
await fs.writeFile(validationPath, JSON.stringify({ outputs: results.length, rows: results.reduce((sum, item) => sum + item.count, 0), excluded_codes: [...excludedCodes], results }, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ outputs: results.length, rows: results.reduce((sum, item) => sum + item.count, 0), validated_all_rows: true, validation_file: path.relative(rootDir, validationPath) }));
