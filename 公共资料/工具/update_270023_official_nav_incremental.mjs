/**
 * Public NAV window updater, exclusively for 270023 人民币A.
 * node update_270023_official_nav_incremental.mjs --input=<current-official.json>
 *   [--as-of=YYYY-MM-DD] [--from-raw=<prior-run-raw.json>]
 *
 * Queries the final five existing NAV dates through the execution date, with
 * complete pagination inside that window. It never downloads full history,
 * invents calendar-day observations, overwrites archives, edits an index,
 * reads account data, or merges third-party supplemental observations.
 * Changed JSON is a candidate until the three-column CSV (日期/净值/日增长率)
 * and any existing XLSX have been exported and reread/validated by the caller.
 * Source identity and third-party separation remain in the JSON master.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const code = '270023';
const name = '广发全球精选股票（QDII）人民币A';
const shareClass = '人民币A';
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fundDir = path.join(projectDir, '基金/持仓基金/270023_广发全球精选股票_QDII_人民币A');
const navDir = path.join(fundDir, '历史净值');
const now = new Date();
const timestamp = () => new Date(Date.now() + 8 * 3600000).toISOString().replace('Z', '+08:00');
const executionDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);
const runId = timestamp().replace(/[^0-9]/g, '').slice(0, 17);
const arg = key => process.argv.find(value => value.startsWith(key + '='))?.slice(key.length + 1);
const asOf = arg('--as-of') || executionDate;
assert.match(asOf, /^\d{4}-\d{2}-\d{2}$/);
assert.ok(asOf <= executionDate, 'Future query dates are not allowed');
assert.ok(arg('--input'), 'Explicit current official master --input is required');
const inputPath = path.resolve(projectDir, arg('--input'));
assert.equal(path.dirname(inputPath), navDir, 'Current master must belong to this unique fund directory');
const fundDirs = (await fs.readdir(path.dirname(fundDir), { withFileTypes: true }))
  .filter(item => item.isDirectory() && item.name.startsWith(code + '_'));
assert.equal(fundDirs.length, 1, 'Multiple directories for 270023; no update attempted');
const inputBytes = await fs.readFile(inputPath);
const master = JSON.parse(inputBytes.toString('utf8').replace(/^\uFEFF/, ''));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const relative = file => path.relative(projectDir, file).split(path.sep).join('/');
const fields = ['nav', 'accumulated_nav', 'daily_growth_pct', 'previous_nav',
  'previous_accumulated_nav', 'previous_nav_date'];
const isMissing = value => value === null || value === undefined || value === '';
function validateRows(doc) {
  assert.equal(doc.code, code);
  assert.equal(doc.name, name);
  assert.equal(doc.share_class, shareClass);
  assert.equal(doc.source_type, 'fund_manager_official_public_API');
  assert.equal(doc.count, doc.rows.length);
  assert.equal(new Set(doc.rows.map(row => row.date)).size, doc.rows.length);
  assert.deepEqual(doc.rows.map(row => row.date), doc.rows.map(row => row.date).sort());
  assert.equal(doc.rows[0].date, doc.first_date);
  assert.equal(doc.rows.at(-1).date, doc.last_date);
  for (const row of doc.rows) {
    assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(row.date <= asOf);
    assert.ok(!isMissing(row.nav) && Number(row.nav) > 0 && Number.isFinite(Number(row.nav)));
    for (const field of fields.filter(key => key !== 'previous_nav_date')) {
      assert.ok(isMissing(row[field]) || Number.isFinite(Number(row[field])), 'Invalid field ' + field);
    }
  }
}
validateRows(master);
assert.ok(master.last_date <= asOf, 'Input master is newer than query date');
const inputCsvPath = inputPath.replace(/\.json$/, '.csv');
const expectedHeaders = ['日期', '净值', '日增长率'];
function parseCSV(text) {
  const rows = []; let row = []; let value = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && quoted && text[i + 1] === '"') { value += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { row.push(value); value = ''; }
    else if ((ch === '\r' || ch === '\n') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(value); if (row.some(cell => cell !== '')) rows.push(row);
      row = []; value = '';
    } else value += ch;
  }
  assert.ok(!quoted, 'Unclosed CSV quote');
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}
const csvBytes = await fs.readFile(inputCsvPath);
assert.ok(csvBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'Missing CSV UTF-8 BOM');
const parsedCsv = parseCSV(csvBytes.toString('utf8').replace(/^\uFEFF/, ''));
assert.deepEqual(parsedCsv[0], expectedHeaders, 'CSV layout differs from the current three-column archive');
assert.equal(parsedCsv.length - 1, master.count);
for (let i = 0; i < master.rows.length; i++) {
  const row = master.rows[i]; const csv = parsedCsv[i + 1];
  assert.equal(csv.length, 3);
  assert.equal(csv[0], row.date);
  for (const [col, field] of [[1, 'nav'], [2, 'daily_growth_pct']]) {
    if (isMissing(row[field])) assert.equal(csv[col], '');
    else { assert.notEqual(csv[col], ''); assert.equal(Number(csv[col].replace(/%$/, '')), Number(row[field])); }
  }
}

const startDate = master.rows[Math.max(0, master.count - 5)].date;
const runDir = path.join(projectDir, '公共资料/工具/tmp/净值请求', code, `日常增量核验_${executionDate}_${runId}`);
await fs.mkdir(runDir, { recursive: true });
const rawPath = path.join(runDir, `${code}_官网窗口原始响应.json`);
const resultPath = path.join(runDir, `${code}_增量核验结果.json`);
const replayPath = arg('--from-raw');
const replay = replayPath ? JSON.parse(await fs.readFile(path.resolve(projectDir, replayPath), 'utf8')) : null;
if (replay) {
  assert.equal(replay.code, code); assert.equal(replay.query_start_date, startDate);
  assert.equal(replay.query_end_date, asOf);
}
const requests = [];
const pageSize = 20;
const homepage = 'https://www.gffunds.com.cn/funds/?fundcode=270023';
function urlFor(page) {
  const url = new URL('https://www.gffunds.com.cn/apistore/JsonService');
  const parameters = { service: 'MarketPerformance', method: 'NAV', op: 'queryNAVByFundcode',
    fundcode: code, startdate: startDate.replaceAll('-', ''), enddate: asOf.replaceAll('-', ''),
    orderby: 'NAVDATE_DESC', pagelines: String(pageSize), curpage: String(page) };
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.href;
}
async function request(page, label) {
  const url = urlFor(page);
  if (replay) {
    const record = replay.requests.findLast(item => item.label === label && item.url === url && item.http_status === 200);
    assert.ok(record, 'Replay missing ' + label);
    const data = JSON.parse(record.raw_text); assert.equal(String(data.errorno), '20000');
    requests.push(record); return data;
  }
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const record = { label, url, attempt, fetched_at: timestamp() }; requests.push(record);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      record.http_status = response.status;
      record.content_type = response.headers.get('content-type');
      record.server_date = response.headers.get('date');
      record.raw_text = await response.text();
      assert.ok(response.ok, 'HTTP ' + response.status);
      const data = JSON.parse(record.raw_text);
      assert.equal(String(data.errorno), '20000', 'Official API error');
      return data;
    } catch (error) {
      record.error = error.message; lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 300 * attempt));
    }
  }
  throw new Error(`${label}: ${lastError.message}`);
}
function date(value) {
  if (isMissing(value) || value === '00000000') return null;
  assert.match(String(value), /^\d{8}$/);
  return String(value).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
}
function numeric(value) {
  if (isMissing(value)) return null;
  assert.match(String(value), /^[+-]?\d+(?:\.\d+)?$/);
  assert.ok(Number.isFinite(Number(value)));
  return Number(value);
}
let failure = null;
let rows = [];
let delta = { added: [], revisions: [] };
let summary;
let candidate = null;
try {
  const first = await request(1, 'NAV window page 1');
  const totalRows = Number(first.totalrows); const totalPages = Number(first.totalpages);
  assert.ok(Number.isInteger(totalRows) && totalRows >= 5, 'Expected at least five existing official observations');
  assert.equal(Number(first.pagelines), pageSize);
  assert.equal(totalPages, Math.ceil(totalRows / pageSize));
  const pages = [first];
  for (let i = 2; i <= totalPages; i++) pages.push(await request(i, 'NAV window page ' + i));
  for (let i = 0; i < pages.length; i++) {
    assert.equal(Number(pages[i].curpage), i + 1);
    assert.equal(Number(pages[i].totalrows), totalRows);
    assert.equal(Number(pages[i].totalpages), totalPages);
    assert.equal(pages[i].data.length, Math.min(pageSize, totalRows - i * pageSize));
  }
  const tail = await request(totalPages + 1, 'NAV window empty tail');
  assert.ok((Array.isArray(tail.data) && tail.data.length === 0) ||
    (tail.data === '' && Number(tail.totalrows) === 0 && Number(tail.totalpages) === 0), 'Nonempty window tail');
  const finalFirst = await request(1, 'NAV window first-page stability');
  assert.equal(Number(finalFirst.totalrows), totalRows);
  assert.deepEqual(finalFirst.data, first.data, 'Official window changed while fetching');
  const sourceRows = pages.flatMap(page => page.data);
  assert.equal(sourceRows.length, totalRows);
  for (const row of sourceRows) { assert.equal(row.FUNDCODE, code); assert.equal(row.FUNDNAME, name); }
  rows = sourceRows.map(row => ({ date: date(row.NAVDATE), nav: numeric(row.NAVUNIT),
    accumulated_nav: numeric(row.NAVACCUMULATED), daily_growth_pct: numeric(row.DAYINCREMENTRATE),
    previous_nav: numeric(row.PRENAVUNIT), previous_accumulated_nav: numeric(row.PRENAVACCUMULATED),
    previous_nav_date: date(row.PRENAVEDATE) })).sort((a, b) => a.date.localeCompare(b.date));
  assert.equal(new Set(rows.map(row => row.date)).size, rows.length);
  assert.ok(rows.every(row => row.date >= startDate && row.date <= asOf));
  const fresh = new Map(rows.map(row => [row.date, row]));
  const old = new Map(master.rows.map(row => [row.date, row]));
  const removedDates = master.rows.filter(row => row.date >= startDate && !fresh.has(row.date)).map(row => row.date);
  assert.deepEqual(removedDates, [], 'Previously archived official dates disappeared from source');
  delta.added = rows.filter(row => !old.has(row.date)).map(row => row.date);
  delta.revisions = rows.filter(row => old.has(row.date)).flatMap(row => {
    const changes = fields.filter(field => (row[field] ?? null) !== (old.get(row.date)[field] ?? null));
    return changes.length ? [{ date: row.date, fields: changes, before: old.get(row.date), after: row }] : [];
  });
  const merged = new Map(master.rows.map(row => [row.date, row]));
  for (const row of rows) merged.set(row.date, row);
  const mergedRows = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
  const missingPredecessors = rows.filter(row => row.previous_nav_date && row.previous_nav_date >= startDate &&
    !fresh.has(row.previous_nav_date)).map(row => ({ date: row.date, previous_nav_date: row.previous_nav_date }));
  assert.deepEqual(missingPredecessors, [], 'Official window contains an unresolved previous-date gap');
  candidate = { ...master, checked_at: timestamp(), query_end_date: asOf,
    last_date: mergedRows.at(-1).date, count: mergedRows.length, rows: mergedRows,
    raw_archive_path: rawPath,
    sources: [...new Set([...(master.sources || []), ...requests.map(item => item.url), homepage])],
    incremental_update: { previous_json_path: relative(inputPath), previous_json_sha256: hash(inputBytes),
      execution_date: executionDate, query_start_date: startDate, query_end_date: asOf,
      added_dates: delta.added, revisions: delta.revisions,
      full_history_refetched: false, third_party_supplement_merged: false,
      disclosure_time_available: false,
      prior_full_history_validation: master.incremental_update?.prior_full_history_validation ?? master.validation,
      prior_comparison_to_previous_archive_snapshot: master.incremental_update?.prior_comparison_to_previous_archive_snapshot ??
        master.comparison_to_previous_archive ?? null,
      prior_comparison_note: 'Historical comparison snapshot only; current-run additions and revisions are recorded exclusively in incremental_update.added_dates and incremental_update.revisions.',
      source_decimal_text: sourceRows.map(row => ({ date: date(row.NAVDATE),
        nav: isMissing(row.NAVUNIT) ? null : String(row.NAVUNIT),
        accumulated_nav: isMissing(row.NAVACCUMULATED) ? null : String(row.NAVACCUMULATED),
        daily_growth_pct: isMissing(row.DAYINCREMENTRATE) ? null : String(row.DAYINCREMENTRATE) })) },
    validation: { passed: true, scope: 'Existing full official archive preserved; all pages in the recent incremental window checked',
      query_window_rows: rows.length, query_window_pages: totalPages, date_unique: true, dates_ascending: true,
      first_page_stable: true, empty_tail: true, all_rows_match_code_and_share_class: true,
      unresolved_window_gaps: missingPredecessors, removed_dates: removedDates,
      historical_full_archive_rechecked: false, csv_pending_when_changed: Boolean(delta.added.length || delta.revisions.length) } };
  // The old top-level comparison describes an earlier full-history capture.
  // Keep it in an explicitly historical slot so its added_count cannot be
  // interpreted as the delta of this incremental run.
  delete candidate.comparison_to_previous_archive;
  validateRows(candidate);
  assert.equal(candidate.first_date, master.first_date);
  assert.equal(candidate.count, master.count + delta.added.length);
  summary = { schema: 'public-fund-incremental-nav-result-v1', code, name, share_class: shareClass,
    status: delta.added.length || delta.revisions.length ? 'changed_json_candidate_pending_csv' : 'no_change',
    execution_date: executionDate, checked_at: timestamp(), query_end_date: asOf,
    query_start_date: startDate, source: '广发基金管理人官网公开历史净值接口', source_type: master.source_type,
    first_date: candidate.first_date, last_date: candidate.last_date, records: candidate.count,
    added_count: delta.added.length, added_dates: delta.added, revision_count: delta.revisions.length,
    revisions: delta.revisions, recent_five_verified_dates: rows.slice(-5).map(row => row.date),
    last_five_preexisting_verified_dates: master.rows.slice(-5).map(row => row.date),
    official_window_records: rows.length, official_window_pages: totalPages,
    missing_unit_nav_count: mergedRows.filter(row => isMissing(row.nav)).length,
    missing_accumulated_nav_dates: mergedRows.filter(row => isMissing(row.accumulated_nav)).map(row => row.date),
    missing_growth_dates: mergedRows.filter(row => isMissing(row.daily_growth_pct)).map(row => row.date),
    unresolved_window_gaps: missingPredecessors, source_conflicts: [],
    third_party_supplement_note: 'Existing ten third-party-only observations remain separate, unchanged and outside the official master',
    previous_json_path: relative(inputPath), previous_json_sha256: hash(inputBytes),
    json_path: relative(inputPath), csv_path: relative(inputCsvPath),
    json_sha256: hash(inputBytes), csv_sha256: hash(csvBytes),
    previous_csv_row_validation_passed: true, csv_json_row_comparison_passed: true,
    raw_evidence_path: relative(rawPath), result_path: relative(resultPath),
    full_history_refetched: false, disclosure_time_available: false,
    failure: null };
} catch (error) {
  failure = error;
  summary = { schema: 'public-fund-incremental-nav-result-v1', code, name,
    execution_date: executionDate, checked_at: timestamp(), status: 'failed_validation_or_fetch',
    query_start_date: startDate, query_end_date: asOf,
    previous_json_path: relative(inputPath), previous_json_sha256: hash(inputBytes),
    previous_csv_sha256: hash(csvBytes), raw_evidence_path: relative(rawPath), result_path: relative(resultPath),
    failure: error.message, retryable: true, current_master_changed: false };
}
// Public source responses, including unsuccessful attempts, precede any candidate output.
const rawArchive = { code, name, share_class: shareClass, checked_at: timestamp(),
  execution_date: executionDate, query_start_date: startDate, query_end_date: asOf,
  homepage, previous_json_path: relative(inputPath), previous_json_sha256: hash(inputBytes),
  request_count: requests.length, capture_status: failure ? 'failed_validation_or_fetch' : 'complete',
  failure: failure?.message ?? null, replay_source_path: replayPath || null, requests };
await fs.writeFile(rawPath, JSON.stringify(rawArchive, null, 2) + '\n', { flag: 'wx' });
summary.raw_evidence_sha256 = hash(await fs.readFile(rawPath));
if (!failure && (delta.added.length || delta.revisions.length)) {
  // A concurrent task's successful update must never be overwritten.
  assert.equal(hash(await fs.readFile(inputPath)), hash(inputBytes), 'Input changed during fetch; retry against current entry');
  let targetPath = path.join(runDir, `${code}_全部历史净值.json`);
  if (delta.revisions.length || candidate.last_date === master.last_date) {
    targetPath = targetPath.replace(/\.json$/, `_核验${executionDate}_${runId}.json`);
  }
  let existing = null;
  try { existing = JSON.parse(await fs.readFile(targetPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    validateRows(existing);
    assert.deepEqual(existing.rows, candidate.rows, 'Existing date target differs; retain both and resolve explicitly');
    summary.status = 'concurrent_existing_candidate_requires_csv_validation';
  } else {
    await fs.writeFile(targetPath, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
    const readback = JSON.parse(await fs.readFile(targetPath, 'utf8'));
    validateRows(readback); assert.deepEqual(readback.rows, candidate.rows);
  }
  summary.json_path = relative(targetPath); summary.csv_path = relative(targetPath.replace(/\.json$/, '.csv'));
  summary.json_sha256 = hash(await fs.readFile(targetPath)); summary.csv_sha256 = null;
  summary.csv_json_row_comparison_passed = false;
  summary.candidate_json_validation_passed = true;
  summary.current_entry_may_switch = false;
}
await fs.writeFile(resultPath, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(summary));
if (failure) process.exitCode = 1;
