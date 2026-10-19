import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// Use the loader-provided runtime and its node_modules junction only.
// Run mark_artifact_operation_started.mjs once for the whole export operation
// before invoking this builder. Dated legacy archives remain immutable;
// validated fixed-name current CSV files can be replaced atomically.
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(toolDir, '../..');
const tempDir = path.join(toolDir, 'tmp', 'nav_csv_2026-10-18');
const bundledRequire = createRequire(path.join(tempDir, 'entry.mjs'));
const { Workbook } = await import(pathToFileURL(bundledRequire.resolve('@oai/artifact-tool')).href);
const verifyExisting = process.argv.includes('--verify-existing');
const inputPaths = process.argv.slice(2).filter(argument => argument !== '--verify-existing');
assert.ok(inputPaths.length, 'Usage: node export_public_nav_csv.mjs <public-nav.json> [...]');
const headers = ['基金代码', '基金名称', '净值日期', '单位净值', '累计净值', '日增长率(%)', '分红事件', '数据来源'];

function isMissing(value) {
  return value === null || value === undefined || value === '';
}

function number(value) {
  if (isMissing(value)) return null;
  assert.match(String(value), /^[+-]?\d+(?:\.\d+)?$/, 'Expected an unrounded source decimal');
  const converted = Number(value);
  assert.ok(Number.isFinite(converted), 'Non-finite public source value');
  return converted;
}

function sourceDecimal(readback, source) {
  if (isMissing(source)) {
    assert.ok(isMissing(readback), 'Missing public source value changed');
    return '';
  }
  assert.equal(readback, Number(source), 'Workbook numeric value differs from public JSON');
  // CSV is an archival interchange format. Restore the original decimal text
  // after validating the typed workbook value, including source trailing zeros.
  return String(source);
}

function csvCell(value) {
  const text = isMissing(value) ? '' : String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function relative(file) {
  return path.relative(rootDir, file).split(path.sep).join('/');
}

async function ensureAbsent(file) {
  try {
    await fs.access(file);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Refusing to overwrite existing public CSV: ' + relative(file));
}

await fs.mkdir(tempDir, { recursive: true });
const results = [];
for (const input of inputPaths) {
  const inputPath = path.resolve(rootDir, input);
  assert.ok(inputPath.startsWith(rootDir + path.sep), 'Input is outside the project');
  assert.match(inputPath, /_全部历史净值(?:_截至\d{4}-\d{2}-\d{2}(?:_修订_核验\d{4}-\d{2}-\d{2}_[A-Za-z0-9]+)?)?\.json$/);
  const fixedName = /^\d{6}_全部历史净值\.json$/.test(path.basename(inputPath));
  const outputPath = inputPath.replace(/\.json$/, '.csv');
  if (!verifyExisting && !fixedName) await ensureAbsent(outputPath);
  const inputBytes = await fs.readFile(inputPath);
  const doc = JSON.parse(inputBytes.toString('utf8').replace(/^\uFEFF/, ''));
  assert.match(doc.code, /^\d{6}$/);
  const rows = doc.rows;
  assert.equal(rows.length, doc.count);
  assert.ok(rows.length);
  assert.equal(new Set(rows.map(row => row.date)).size, rows.length);
  assert.deepEqual(rows.map(row => row.date), rows.map(row => row.date).sort());
  assert.equal(rows[0].date, doc.first_date);
  assert.equal(rows.at(-1).date, doc.last_date);
  const last = rows.length + 1;
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add(doc.code);
  sheet.showGridLines = false;
  const data = rows.map(row => {
    assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(number(row.nav) > 0, 'Missing or non-positive public unit NAV');
    return [doc.code, doc.name, row.date, number(row.nav), number(row.accumulated_nav), number(row.daily_growth_pct), row.event ?? '', row.source ?? doc.source ?? ''];
  });
  sheet.getRange(`A1:H${last}`).values = [headers, ...data];
  sheet.getRange(`A1:H${last}`).format.font = { name: 'Arial', size: 10 };
  sheet.getRange(`A1:H${last}`).format.verticalAlignment = 'center';
  // Preserve the established CSV representation of six-digit IDs and ISO dates.
  sheet.getRange(`A2:C${last}`).setNumberFormat('@');
  // The renderer numerically formats digit-only strings. The display mask
  // keeps six-digit public identifiers visible while stored values stay text.
  sheet.getRange(`A2:A${last}`).setNumberFormat('000000');
  sheet.getRange(`D2:E${last}`).setNumberFormat('0.0000');
  sheet.getRange(`F2:F${last}`).setNumberFormat('0.00');
  sheet.getRange('A1:H1').format = { fill: '#1F4E78', font: { name: 'Arial', size: 10, bold: true, color: '#FFFFFF' }, horizontalAlignment: 'center', verticalAlignment: 'center' };
  sheet.getRange(`A1:A${last}`).format.columnWidth = 12;
  sheet.getRange(`B1:B${last}`).format.columnWidth = 65;
  sheet.getRange(`C1:C${last}`).format.columnWidth = 15;
  sheet.getRange(`D1:F${last}`).format.columnWidth = 17;
  sheet.getRange(`G1:G${last}`).format.columnWidth = 25;
  sheet.getRange(`H1:H${last}`).format.columnWidth = 80;
  sheet.freezePanes.freezeRows(1);
  workbook.recalculate();
  await workbook.inspect({ kind: 'table', range: `${doc.code}!A1:H3`, include: 'values', maxChars: 700, tableMaxRows: 3, tableMaxCols: 8 });
  const formulaErrors = await workbook.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!', options: { useRegex: true, maxResults: 20 }, maxChars: 1200 });
  const readback = sheet.getRange(`A2:H${last}`).values;
  assert.equal(readback.length, rows.length);
  let serialized = readback.map((row, index) => {
    const source = rows[index];
    assert.equal(row[0], doc.code);
    assert.equal(row[1], doc.name);
    assert.equal(row[2], source.date);
    assert.equal(row[6] ?? '', source.event ?? '');
    assert.equal(row[7] ?? '', source.source ?? doc.source ?? '');
    return [row[0], row[1], row[2], sourceDecimal(row[3], source.nav), sourceDecimal(row[4], source.accumulated_nav), sourceDecimal(row[5], source.daily_growth_pct), row[6] ?? '', row[7] ?? ''];
  });
  const preview = await workbook.render({ sheetName: doc.code, range: 'A1:H4', scale: 1, format: 'png' });
  const previewPath = path.join(tempDir, `public_nav_csv_preview_${doc.code}_${doc.last_date}.png`);
  await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
  const official = doc.code === '270023' && doc.source_type === 'fund_manager_official_public_API';
  const outputHeaders = ['日期', '净值', '日增长率'];
  serialized = serialized.map(row => [row[2], row[3], isMissing(row[5]) ? '' : row[5] + '%']);
  const csvText = '\uFEFF' + [outputHeaders, ...serialized].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  if (verifyExisting) {
    assert.equal(await fs.readFile(outputPath, 'utf8'), csvText, 'Existing CSV differs; it was not overwritten');
  } else {
    if (fixedName) {
      const temporary = outputPath + '.tmp';
      await fs.writeFile(temporary, csvText, 'utf8');
      await fs.rename(temporary, outputPath);
    } else await fs.writeFile(outputPath, csvText, { encoding: 'utf8', flag: 'wx' });
  }
  const saved = await fs.readFile(outputPath);
  assert.ok(saved.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])));
  const imported = await Workbook.fromCSV(saved.toString('utf8').replace(/^\uFEFF/, ''), { sheetName: 'CSVCheck' });
  const verified = imported.worksheets.getItemAt(0).getRange(`A1:C${last}`).values;
  assert.deepEqual(verified[0], outputHeaders);
  for (let index = 0; index < serialized.length; index++) {
    assert.deepEqual(verified[index + 1].map(value => isMissing(value) ? '' : String(value)), serialized[index].map(String), `Saved CSV differs from public JSON at ${doc.code} row ${index + 2}`);
  }
  results.push({ code: doc.code, count: rows.length, first_date: doc.first_date, last_date: doc.last_date, csv_file: relative(outputPath), json_sha256: crypto.createHash('sha256').update(inputBytes).digest('hex'), csv_sha256: crypto.createHash('sha256').update(saved).digest('hex'), missing_accumulated_nav_count: rows.filter(row => isMissing(row.accumulated_nav)).length, all_fields_roundtrip_verified: true, preview_file: relative(previewPath), formula_error_scan: formulaErrors.ndjson });
  console.log(JSON.stringify(results.at(-1)));
}
const validationPath = path.join(tempDir, `public_nav_csv_validation_${Date.now()}.json`);
await fs.writeFile(validationPath, JSON.stringify({ outputs: results.length, rows: results.reduce((sum, item) => sum + item.count, 0), results }, null, 2) + '\n');
console.log(JSON.stringify({ outputs: results.length, all_fields_roundtrip_verified: true, validation_file: relative(validationPath) }));
