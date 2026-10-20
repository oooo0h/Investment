import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mergeRecentWindow, validateHistory } from './nav_incremental_core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asOf = process.argv.find(value => value.startsWith('--as-of='))?.slice(8);
assert.match(asOf ?? '', /^\d{4}-\d{2}-\d{2}$/);
const allowed = ['005698', '006373', '016701'];
const codes = (process.argv.find(value => value.startsWith('--codes='))?.slice(8) ?? allowed.join(',')).split(',');
assert.ok(codes.length && new Set(codes).size === codes.length && codes.every(code => allowed.includes(code)));
const runId = new Date().toISOString().replace(/[-:.]/g, '');
const rel = file => path.relative(root, file).split(path.sep).join('/');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const archive = path.join(root, '公共资料/历史净值');
const manifestPath = path.join(archive, '全基金历史净值当前入口.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const headers = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://fundf10.eastmoney.com/', 'Cache-Control': 'no-cache' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(code, page, endDate, evidence) {
  const url = new URL('https://api.fund.eastmoney.com/f10/lsjz');
  for (const [key, value] of Object.entries({ fundCode: code, pageIndex: page, pageSize: 20, startDate: '', endDate, _: Date.now() })) url.searchParams.set(key, String(value));
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      assert.ok(response.ok, 'Public source HTTP ' + response.status);
      const text = await response.text();
      const body = JSON.parse(text);
      assert.equal(body.ErrCode, 0);
      assert.ok(Array.isArray(body.Data?.LSJZList));
      const record = { url: url.href, captured_at: new Date().toISOString(), response: body };
      const rawPath = path.join(evidence, `${code}_${endDate || 'latest'}_page${page}_${Date.now()}.json`);
      await fs.writeFile(rawPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
      return { body, evidence: { path: rel(rawPath), sha256: hash(await fs.readFile(rawPath)), url: url.href } };
    } catch (error) {
      if (attempt === 3) throw error;
      await wait(attempt * 700);
    }
  }
}

async function update(code) {
  const entry = manifest.funds.find(item => item.code === code);
  assert.ok(entry, 'Code absent from current manifest');
  const dirs = [];
  for (const group of ['持仓基金', '观察基金']) {
    let items = [];
    try { items = await fs.readdir(path.join(root, '基金', group), { withFileTypes: true }); } catch { continue; }
    dirs.push(...items.filter(item => item.isDirectory() && item.name.startsWith(code + '_')).map(item => ({ group, name: item.name })));
  }
  assert.equal(dirs.length, 1, 'Fund directory must be unique');
  const jsonPath = path.resolve(root, entry.json_path);
  const csvPath = path.resolve(root, entry.csv_path);
  const history = path.dirname(jsonPath);
  assert.equal(history, path.join(archive, '维护数据', code));
  const previousBytes = await fs.readFile(jsonPath);
  const previousCsv = await fs.readFile(csvPath);
  assert.equal(hash(previousBytes), entry.json_sha256, 'Current JSON does not match manifest hash');
  assert.equal(hash(previousCsv), entry.csv_sha256, 'Current CSV does not match manifest hash');
  const old = JSON.parse(previousBytes.toString('utf8'));
  assert.equal(old.code, code);
  validateHistory(old);
  const evidence = path.join(history, '原始数据', '四基金增量核验_' + asOf, runId);
  await fs.mkdir(evidence, { recursive: true });
  const head = await request(code, 1, '', evidence);
  const latest = head.body.Data.LSJZList[0]?.FSRQ;
  assert.match(latest ?? '', /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(latest <= asOf && latest >= old.last_date, 'Unexpected latest source date');
  const first = await request(code, 1, latest, evidence);
  const total = Number(first.body.TotalCount);
  assert.ok(Number.isInteger(total) && Number(first.body.PageSize) === 20);
  const records = [...first.body.Data.LSJZList];
  const sources = [head.evidence, first.evidence];
  const boundary = old.rows.at(-5).date;
  let page = 1;
  while (records.at(-1)?.FSRQ > boundary) {
    assert.ok(page < Math.ceil(total / 20), 'Could not reach archive overlap');
    const next = await request(code, ++page, latest, evidence);
    assert.equal(Number(next.body.TotalCount), total, 'Pinned pagination changed');
    assert.equal(Number(next.body.PageIndex), page);
    assert.ok(next.body.Data.LSJZList.length, 'Gap contains an empty page');
    records.push(...next.body.Data.LSJZList);
    sources.push(next.evidence);
  }
  const repeat = await request(code, 1, latest, evidence);
  sources.push(repeat.evidence);
  assert.equal(Number(repeat.body.TotalCount), total);
  assert.deepEqual(repeat.body.Data.LSJZList, first.body.Data.LSJZList, 'Source changed during capture');
  const merged = mergeRecentWindow(old, records, { asOf, sourceTotal: total });
  const result = { code, name: old.name, status: merged.conflicts.length ? 'conflict' : merged.changed ? 'pending_csv_validation' : 'unchanged', checked_at: new Date().toISOString(), execution_date: asOf, source: '东方财富/天天基金 f10/lsjz，沿用第三方主档；非管理人官网独立核验', source_total_count: total, source_pages_fetched: sources.length, previous_last_date: old.last_date, latest_source_date: merged.latest_date, checked_dates: merged.checked_dates, window_first_date: merged.window_first_date, window_records: merged.window_count, added_dates: merged.added_dates, revisions: merged.revisions, conflicts: merged.conflicts, records: merged.rows.length, first_date: old.first_date, last_date: merged.latest_date, json_path: entry.json_path, csv_path: entry.csv_path, json_sha256: hash(previousBytes), csv_sha256: hash(previousCsv), old_json_path: entry.json_path, old_csv_path: entry.csv_path, old_json_sha256: hash(previousBytes), old_csv_sha256: hash(previousCsv), missing_accumulated_nav_dates: merged.rows.filter(row => row.accumulated_nav === null).map(row => row.date), raw_evidence: sources, previous_full_archive_evidence: entry.raw_evidence_path, frozen_originals_unchanged: true };
  if (merged.changed && !merged.conflicts.length) {
    const suffix = merged.revisions.length ? '_修订_核验' + asOf + '_' + runId : '';
    const output = path.join(evidence, `${code}_全部历史净值_截至${merged.latest_date}${suffix}.json`);
    const payload = { ...old, downloaded_at: result.checked_at, last_date: merged.latest_date, count: merged.rows.length, reuse: { files: [entry.json_path], previous_unique_dates: old.rows.length, added_unique_dates: merged.added_dates.length, revised_unique_dates: merged.revisions.length, action: '最近窗口增量补齐；保留历史冻结主档' }, prior_validation: { dataset_path: entry.json_path, validation: old.validation }, validation: { mode: 'incremental_recent_window', unique_date_count: merged.rows.length, duplicate_dates: 0, api_total_count: total, latest_pinned_date: merged.latest_date, checked_dates: merged.checked_dates, window_first_date: merged.window_first_date, window_records: merged.window_count, source_page_requests: sources.length, source_first_page_stable: true, full_history_refetched_this_run: false, official_independent_full_validation: false, missing_accumulated_nav_count: result.missing_accumulated_nav_dates.length }, incremental_verification: { execution_date: asOf, checked_at: result.checked_at, checked_dates: merged.checked_dates, window_first_date: merged.window_first_date, added_dates: merged.added_dates, revisions: merged.revisions, source_scope: result.source, previous_full_archive_evidence: entry.raw_evidence_path, raw_evidence: sources }, rows: merged.rows };
    const existing = await fs.readFile(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing) assert.deepEqual(JSON.parse(existing.toString('utf8')).rows, merged.rows, 'Existing candidate differs; frozen file retained');
    else await fs.writeFile(output, JSON.stringify(payload, null, 2) + '\n', { flag: 'wx' });
    result.json_path = rel(output);
    result.csv_path = rel(output.replace(/\.json$/, '.csv'));
    result.json_sha256 = hash(await fs.readFile(output));
    result.csv_sha256 = null;
  }
  assert.equal(hash(await fs.readFile(jsonPath)), hash(previousBytes));
  assert.equal(hash(await fs.readFile(csvPath)), hash(previousCsv));
  const verificationPath = path.join(evidence, code + '_增量复核结果.json');
  await fs.writeFile(verificationPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  result.verification_path = rel(verificationPath);
  result.verification_sha256 = hash(await fs.readFile(verificationPath));
  return result;
}

const results = [], failures = [];
for (const code of codes) {
  try {
    const result = await update(code);
    results.push(result);
    console.log(JSON.stringify({ code, status: result.status, latest_date: result.last_date, added_records: result.added_dates.length, revisions: result.revisions.length, conflicts: result.conflicts.length }));
  } catch (error) {
    failures.push({ code, status: 'failed', error: error.message });
    console.log(JSON.stringify({ code, status: 'failed', error: error.message }));
  }
}
const summary = path.join(archive, `三基金增量核验_${asOf}_${runId}.json`);
await fs.writeFile(summary, JSON.stringify({ schema: 'three-fund-incremental-nav-v1', execution_date: asOf, run_id: runId, manifest_path: rel(manifestPath), results, failures }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ summary: rel(summary), funds: results.length, failures: failures.length }));
if (failures.length || results.some(result => result.conflicts.length)) process.exitCode = 1;
