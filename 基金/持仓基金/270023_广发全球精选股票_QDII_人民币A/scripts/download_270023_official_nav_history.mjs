/**
 * Download public NAV history for 广发全球精选股票（QDII）人民币A (270023).
 * No account, position, or transaction files are read.
 * Run: node download_270023_official_nav_history.mjs [--as-of=YYYY-MM-DD]
 * Reuse immutable raw responses: add --from-raw=ABSOLUTE_ARCHIVE_PATH
 * Uses the public endpoint called by the fund manager's fund-details page.
 * Existing output files are never replaced. Raw responses are archived before
 * a normalized data file is written. A repeated run needs a new capture date
 * or explicit manual handling of an existing archive.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const code = '270023';
const name = '广发全球精选股票（QDII）人民币A';
const shareClass = '人民币A';
const inception = '2010-08-18';
const fundDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const navDirectory = path.join(fundDirectory, '历史净值');
const rawDirectory = path.join(navDirectory, '原始数据');
const pageSize = 20;
const concurrency = 4;
const base = 'https://www.gffunds.com.cn/apistore/JsonService';
const homepage = `https://www.gffunds.com.cn/funds/?fundcode=${code}`;
const shanghaiDate = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const shanghaiTimestamp = () => new Date(Date.now() + 8 * 3600000)
  .toISOString().replace('Z', '+08:00');
const dateArgument = process.argv.find(arg => arg.startsWith('--as-of='));
const asOf = dateArgument ? dateArgument.slice('--as-of='.length) : shanghaiDate();
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('Use --as-of=YYYY-MM-DD');
const captureDate = shanghaiDate();
const rawPath = path.join(rawDirectory,
  `${code}_官网历史净值原始分页_抓取${captureDate}.json`);
const replayArgument = process.argv.find(arg => arg.startsWith('--from-raw='));
const replayPath = replayArgument ? replayArgument.slice('--from-raw='.length) : null;
const replayArchive = replayPath ? JSON.parse(await fs.readFile(replayPath, 'utf8')) : null;
if (replayArchive && (replayArchive.code !== code || replayArchive.query_end_date !== asOf)) {
  throw new Error('Raw replay archive has a different fund code or query end date');
}
await fs.mkdir(rawDirectory, { recursive: true });
if (!replayArchive) {
  try {
    await fs.access(rawPath);
    throw new Error(`Existing raw archive will not be replaced: ${rawPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const attempts = [];
const requests = [];
const compactDate = value => value.replaceAll('-', '');
const navURL = page => {
  const url = new URL(base);
  const parameters = {
    service: 'MarketPerformance', method: 'NAV', op: 'queryNAVByFundcode',
    fundcode: code, startdate: compactDate(inception), enddate: compactDate(asOf),
    orderby: 'NAVDATE_DESC', pagelines: String(pageSize), curpage: String(page),
  };
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.href;
};
const dividendURL = `${base}?service=Equity&method=Dividend&op=queryDividendByFundcode&fundcode=${code}`;

async function requestJSON(url, label) {
  if (replayArchive) {
    const record = replayArchive.requests.findLast(item => item.label === label &&
      item.url === url && item.http_status === 200);
    if (!record) throw new Error(`Raw replay archive does not contain ${label}`);
    const parsed = JSON.parse(record.raw_text);
    if (String(parsed.errorno) !== '20000') throw new Error(`Raw API error for ${label}`);
    attempts.push(record);
    requests.push(record);
    return parsed;
  }
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const fetchedAt = shanghaiTimestamp();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const rawText = await response.text();
      const record = {
        label, url, attempt, fetched_at: fetchedAt,
        http_status: response.status,
        content_type: response.headers.get('content-type'),
        server_date: response.headers.get('date'), raw_text: rawText,
      };
      attempts.push(record);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = JSON.parse(rawText);
      if (String(parsed.errorno) !== '20000') {
        throw new Error(`Official API error ${parsed.errorno}: ${parsed.errormsg}`);
      }
      requests.push(record);
      return parsed;
    } catch (error) {
      lastError = error;
      if (!attempts.some(record => record.label === label && record.attempt === attempt)) {
        attempts.push({ label, url, attempt, fetched_at: fetchedAt, error: error.message });
      }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    }
  }
  throw new Error(`${label} failed after retries: ${lastError?.message}`);
}

let normalized;
let failure;
let summary;
try {
  const firstPage = await requestJSON(navURL(1), 'NAV page 1');
  const totalRows = Number(firstPage.totalrows);
  const totalPages = Number(firstPage.totalpages);
  const reportedPageSize = Number(firstPage.pagelines);
  if (!Number.isInteger(totalRows) || !Number.isInteger(totalPages) || totalPages < 1) {
    throw new Error('Invalid page metadata');
  }
  if (reportedPageSize !== pageSize || totalPages !== Math.ceil(totalRows / pageSize)) {
    throw new Error('Unexpected page size or total-page count');
  }
  const pages = new Array(totalPages);
  pages[0] = firstPage;
  let nextPage = 2;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextPage <= totalPages) {
      const page = nextPage++;
      pages[page - 1] = await requestJSON(navURL(page), `NAV page ${page}`);
    }
  }));
  const emptyTail = await requestJSON(navURL(totalPages + 1), 'NAV empty tail');
  const finalFirstPage = await requestJSON(navURL(1), 'NAV page 1 final consistency check');
  const dividend = await requestJSON(dividendURL, 'Public dividend records');
  const issues = [];
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    if (Number(page.curpage) !== index + 1) issues.push(`Unexpected page index ${index + 1}`);
    if (Number(page.totalrows) !== totalRows || Number(page.totalpages) !== totalPages) {
      issues.push(`Total count changed on page ${index + 1}`);
    }
    const expectedLength = Math.min(pageSize, totalRows - index * pageSize);
    if (!Array.isArray(page.data) || page.data.length !== expectedLength) {
      issues.push(`Unexpected row count on page ${index + 1}`);
    }
  }
  const tailIsEmpty = (Array.isArray(emptyTail.data) && emptyTail.data.length === 0) ||
    (emptyTail.data === '' && Number(emptyTail.totalrows) === 0 && Number(emptyTail.totalpages) === 0);
  if (!tailIsEmpty) issues.push('Tail page is not empty');
  if (Number(finalFirstPage.totalrows) !== totalRows ||
      JSON.stringify(finalFirstPage.data) !== JSON.stringify(firstPage.data)) {
    issues.push('First page changed during capture');
  }
  const sourceRows = pages.flatMap(page => page.data || []);
  const normalizedDate = value => {
    if (value === null || value === undefined || value === '' || value === '00000000') return null;
    const str = String(value);
    if (!/^\d{8}$/.test(str)) throw new Error(`Unexpected public date format: ${str}`);
    return str.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  };
  const numeric = value => value === '' || value === null || value === undefined ? null : Number(value);
  const rows = sourceRows.map(row => ({
    date: normalizedDate(row.NAVDATE),
    nav: numeric(row.NAVUNIT),
    accumulated_nav: numeric(row.NAVACCUMULATED),
    daily_growth_pct: numeric(row.DAYINCREMENTRATE),
    previous_nav: numeric(row.PRENAVUNIT),
    previous_accumulated_nav: numeric(row.PRENAVACCUMULATED),
    previous_nav_date: normalizedDate(row.PRENAVEDATE),
  })).sort((a, b) => a.date.localeCompare(b.date));
  if (sourceRows.some(row => row.FUNDCODE !== code)) issues.push('Mixed fund code');
  if (sourceRows.some(row => row.FUNDNAME !== name)) issues.push('Unexpected fund share class/name');
  if (rows.length !== totalRows) issues.push('Merged count differs from official total');
  if (new Set(rows.map(row => row.date)).size !== rows.length) issues.push('Duplicate NAV dates');
  if (rows.some(row => row.date < inception || row.date > asOf)) issues.push('Date outside query range');
  if (rows.some(row => !Number.isFinite(row.nav) || row.nav <= 0 ||
      !Number.isFinite(row.accumulated_nav) || row.accumulated_nav <= 0 ||
      (row.daily_growth_pct !== null && !Number.isFinite(row.daily_growth_pct)))) {
    issues.push('Invalid NAV or daily growth value');
  }
  const validation = {
    passed: issues.length === 0, issues,
    official_total_rows: totalRows, official_total_pages: totalPages,
    reported_page_size: reportedPageSize, merged_row_count: rows.length,
    unique_date_count: new Set(rows.map(row => row.date)).size,
    all_page_row_counts_match: !issues.some(issue => issue.includes('row count')),
    tail_page: totalPages + 1, tail_row_count: tailIsEmpty ? 0 : emptyTail.data?.length ?? null,
    tail_source_data_type: Array.isArray(emptyTail.data) ? 'array' : typeof emptyTail.data,
    first_page_stable_during_capture: !issues.includes('First page changed during capture'),
    all_rows_match_code_and_share_class: !issues.includes('Mixed fund code') &&
      !issues.includes('Unexpected fund share class/name'),
    daily_growth_pct_is_official_field: true,
    daily_growth_pct_note: 'Copied from DAYINCREMENTRATE without recomputation; null only if source field is absent.',
    historical_release_timestamps_available: false,
    official_history_count_minus_preexisting_3884_record_archive: totalRows - 3884,
    count_comparison_note: '3884 is the prior archive count supplied for comparison. A count difference alone does not establish the date-level causes.',
  };
  normalized = {
    code, name, share_class: shareClass, checked_at: shanghaiTimestamp(),
    sources: [...Array.from({ length: totalPages }, (_, index) => navURL(index + 1)),
      navURL(totalPages + 1), dividendURL, homepage],
    source_type: 'fund_manager_official_public_API',
    query_start_date: inception, query_end_date: asOf,
    first_date: rows[0]?.date, last_date: rows.at(-1)?.date,
    count: rows.length, validation,
    raw_archive_path: replayPath || rawPath,
    raw_archive_initial_diagnostic: replayArchive?.failure ?? null,
    raw_archive_initial_diagnostic_resolution: replayArchive?.failure ?
      'Immutable raw responses revalidated with official empty-string tail representation accepted and all-zero previous-date sentinel normalized to null.' : null,
    public_dividend_records: dividend.data,
    rows,
  };
  summary = { count: rows.length, first_date: normalized.first_date,
    last_date: normalized.last_date, validation };
  if (issues.length) failure = new Error(issues.join('; '));
} catch (error) {
  failure = error;
}

// Raw API responses are always written first, including failed retry responses.
const rawArchive = {
  code, name, share_class: shareClass, checked_at: shanghaiTimestamp(),
  query_start_date: inception, query_end_date: asOf,
  homepage, successful_request_count: requests.length,
  attempt_count: attempts.length, capture_status: failure ? 'failed_validation_or_fetch' : 'complete',
  failure: failure?.message ?? null,
  requests: attempts,
};
if (!replayArchive) await fs.writeFile(rawPath, JSON.stringify(rawArchive, null, 2) + '\n', { flag: 'wx' });
if (failure) {
  console.error(JSON.stringify({ raw_path: replayPath || rawPath, failure: failure.message }));
  process.exitCode = 1;
} else {
  const normalizedPath = path.join(navDirectory,
    `${code}_全部历史净值_截至${normalized.last_date}.json`);
  await fs.writeFile(normalizedPath, JSON.stringify(normalized, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ raw_path: replayPath || rawPath, normalized_path: normalizedPath,
    successful_request_count: requests.length, attempt_count: attempts.length, ...summary }));
}
