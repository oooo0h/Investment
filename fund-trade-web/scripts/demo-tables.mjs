// Editable fixtures for the local preview only. No account or published NAV files.
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { calculateLedger } from '../src/engine.js';
import { FUND_CODES } from '../src/funds.js';
import { demoEnvelope, demoNav, demoVault } from './demo-data.mjs';

const NAV_COLUMNS = [['净值日期', 'date'], ['单位净值', 'nav']];
const TX_COLUMNS = [
  ['交易编号', 'id'], ['净值日期', 'date'], ['交易类型', 'type'], ['成交净值', 'nav'],
  ['确认份额', 'shares'], ['手续费', 'fee'], ['确认金额', 'amount'], ['确认状态', 'status'],
  ['申请时间', 'submittedAt'], ['备注', 'note'],
];
const TYPE_NAMES = { buy: '买入', sip: '定投', sell: '卖出', reinvest: '红利再投', dividend: '现金分红', 'transfer-in': '转换转入' };
const STATUS_NAMES = { confirmed: '已确认', estimated: '历史估算', pending: '待确认', cancelled: '撤单', failed: '交易失败', closed: '交易关闭' };
const TYPE_KEYS = new Map(Object.entries(TYPE_NAMES).flatMap(([key, label]) => [[key, key], [label, key]]));
const STATUS_KEYS = new Map(Object.entries(STATUS_NAMES).flatMap(([key, label]) => [[key, key], [label, key]]));
STATUS_KEYS.set('已录入', 'confirmed');
STATUS_KEYS.set('估算成交', 'estimated');
const SKIPPED = new Set(['pending', 'cancelled', 'failed', 'closed']);
const invalid = () => { throw new Error('Invalid local test table.'); };
const csvCell = value => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const csv = rows => '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';

function parseCsv(text) {
  const input = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', quoted = false, closed = false;
  const finishCell = () => { row.push(cell); cell = ''; closed = false; };
  const finishRow = () => { finishCell(); if (row.some(value => value.trim() !== '')) rows.push(row); row = []; };
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') { quoted = false; closed = true; }
      else if (char === '\r') { cell += '\n'; if (input[i + 1] === '\n') i += 1; }
      else cell += char;
    } else if (char === ',') finishCell();
    else if (char === '\r' || char === '\n') { finishRow(); if (char === '\r' && input[i + 1] === '\n') i += 1; }
    else if (closed) { if (!/[ \t]/.test(char)) invalid(); }
    else if (char === '"') { if (cell !== '') invalid(); quoted = true; }
    else cell += char;
  }
  if (quoted) invalid();
  if (cell !== '' || row.length || closed) finishRow();
  if (!rows.length) invalid();
  return rows;
}

function records(text, columns) {
  const [header, ...rows] = parseCsv(text);
  const aliases = new Map(columns.flatMap(([label, key]) => [[label, key], [key, key]]));
  const keys = header.map(value => aliases.get(value.trim()));
  if (keys.length !== columns.length || keys.some(key => !key) || new Set(keys).size !== columns.length) invalid();
  return rows.map(row => {
    if (row.length !== keys.length) invalid();
    return Object.fromEntries(keys.map((key, index) => [key, row[index].trim()]));
  });
}

function number(value) {
  if (value === '') return null;
  let text = value;
  if (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text)) text = text.replaceAll(',', '');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) invalid();
  const converted = Number(text);
  if (!Number.isFinite(converted)) invalid();
  return converted;
}

function date(value, { optional = false } = {}) {
  if (optional && value === '') return '';
  let normalized;
  const parts = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value);
  if (parts) normalized = `${parts[1]}-${parts[2].padStart(2, '0')}-${parts[3].padStart(2, '0')}`;
  else if (/^\d+(?:\.0+)?$/.test(value)) {
    const serial = Number(value);
    if (!Number.isInteger(serial) || serial < 1 || serial > 2958465 || serial === 60) invalid();
    normalized = new Date(Date.UTC(1899, 11, 30) + serial * 86400000 + (serial < 60 ? 86400000 : 0)).toISOString().slice(0, 10);
  } else invalid();
  const stamp = Date.parse(`${normalized}T00:00:00Z`);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== normalized) invalid();
  return normalized;
}

function timestamp(value) {
  if (value === '') return '';
  const parts = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!parts || Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4] || '0') > 59) invalid();
  return `${date(parts[1])} ${parts[2].padStart(2, '0')}:${parts[3]}:${parts[4] || '00'}`;
}

function normalize(files) {
  const nav = {}, funds = {};
  for (const code of FUND_CODES) {
    const history = records(files.get(`${code}_净值.csv`), NAV_COLUMNS).map(row => ({ date: date(row.date), nav: number(row.nav) }));
    if (history.some((row, index) => row.nav === null || row.nav <= 0 || (index > 0 && row.date <= history[index - 1].date))) invalid();
    nav[code] = { code, demo: true, asOf: history.at(-1)?.date ?? null, source: '本地虚构数据', history };
    const seenIds = new Set();
    const transactions = records(files.get(`${code}_交易.csv`), TX_COLUMNS).map((row, index) => {
      const type = TYPE_KEYS.get(row.type), status = STATUS_KEYS.get(row.status || 'confirmed');
      if (!type || !status) invalid();
      const id = row.id || `demo-${code}-csv-${index + 1}`;
      if (seenIds.has(id)) invalid();
      seenIds.add(id);
      const txDate = date(row.date, { optional: SKIPPED.has(status) });
      const tx = {
        id, date: txDate, ...(txDate ? { recordedAt: txDate } : {}),
        ...(row.submittedAt ? { submittedAt: timestamp(row.submittedAt) } : {}),
        type, status, sourceStatus: status === 'pending' ? 'processing' : status === 'estimated' ? 'confirmed' : status,
        nav: number(row.nav), shares: number(row.shares), fee: number(row.fee),
      };
      if (Object.values(tx).some(value => typeof value === 'number' && value < 0)) invalid();
      if (tx.nav !== null && tx.nav <= 0) invalid();
      const amount = number(row.amount);
      if (amount !== null) { if (amount < 0) invalid(); tx.amount = amount; }
      if (row.note) tx.note = row.note;
      return tx;
    });
    for (const mode of ['profit-first', 'principal-first']) {
      if (calculateLedger(transactions, { mode }).errors.length) invalid();
    }
    funds[code] = { ...demoVault.funds[code], transactions };
  }
  const vault = { demo: true, createdAt: '本地演示', funds };
  const revision = createHash('sha256').update(JSON.stringify({ nav, vault })).digest('hex');
  return { revision, nav, vault };
}

function seeds() {
  return new Map(FUND_CODES.flatMap(code => [
    [`${code}_净值.csv`, csv([NAV_COLUMNS.map(([label]) => label), ...demoNav[code].history.map(row => [row.date, row.nav])])],
    [`${code}_交易.csv`, csv([TX_COLUMNS.map(([label]) => label), ...demoVault.funds[code].transactions.map(tx => TX_COLUMNS.map(([, key]) => key === 'type' ? TYPE_NAMES[tx.type] : key === 'status' ? STATUS_NAMES[tx.status] : tx[key]))])],
  ]));
}

async function readStable(directory, names) {
  const read = () => Promise.all(names.map(async name => {
    const target = path.join(directory, name);
    const before = await stat(target);
    if (!before.isFile() || before.size > 4 * 1024 * 1024) invalid();
    const bytes = await readFile(target);
    const after = await stat(target);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) invalid();
    return [name, bytes];
  }));
  const first = await read();
  // Excel may truncate or replace a file while saving. Accept one stable bundle.
  await new Promise(resolve => setTimeout(resolve, 25));
  const second = await read();
  if (first.some(([name, bytes], index) => name !== second[index][0] || !bytes.equals(second[index][1]))) invalid();
  return new Map(second.map(([name, bytes]) => [name, new TextDecoder('utf-8', { fatal: true }).decode(bytes)]));
}

export async function createDemoTableStore({ directory }) {
  const resolved = path.resolve(directory);
  await mkdir(resolved, { recursive: true });
  const initial = seeds();
  await Promise.all([...initial].map(async ([name, contents]) => {
    try { await writeFile(path.join(resolved, name), contents, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw new Error('Unable to create local test tables.'); }
  }));
  const baseline = normalize(initial);
  let lastGood = { ...baseline, envelope: await demoEnvelope(baseline.vault) };
  let queue = Promise.resolve();
  const snapshot = async () => {
    try {
      const next = normalize(await readStable(resolved, [...initial.keys()]));
      if (next.revision !== lastGood.revision) lastGood = { ...next, envelope: await demoEnvelope(next.vault) };
      else lastGood = { ...lastGood, envelope: await demoEnvelope(lastGood.vault) };
      return { ...lastGood, status: 'valid' };
    } catch {
      // Keep all prior valid data together; never echo a malformed input cell.
      return { ...lastGood, status: 'invalid' };
    }
  };
  return {
    directory: resolved,
    snapshot() {
      const pending = queue.then(snapshot);
      queue = pending.catch(() => {});
      return pending;
    },
  };
}
