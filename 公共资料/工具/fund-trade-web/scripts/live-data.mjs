// Read-only real-source adapter. Plaintext crosses only a captured local pipe.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateLedger } from '../engine.js';
import { FUND_CODES as CODES } from '../funds.js';
import { getDailyCode } from '../vault.js';
import { demoEnvelope } from './demo-data.mjs';

const READER = fileURLToPath(new URL('./read-local-data.py', import.meta.url));
const SUFFIX = '单笔交易自动计算_双模式_模板2026-09-28.xlsx';
const TX_KEYS = ['id', 'date', 'type', 'nav', 'shares', 'fee', 'amount', 'cost', 'status', 'note', 'submittedAt', 'sourceStatus'];
const failure = () => new Error('Local data unavailable.');
const validDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
};
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

async function fingerprint(workspace, root) {
  const base = path.join(workspace, '基金');
  const directories = await readdir(base, { withFileTypes: true });
  const files = [READER, path.join(root, 'scripts', 'encrypt-workbooks.py'), path.join(root, 'data', 'ledger.enc.json')];
  for (const code of CODES) {
    const matches = directories.filter(item => item.isDirectory() && item.name.startsWith(code));
    if (matches.length !== 1) throw failure();
    const directory = path.join(base, matches[0].name);
    const entries = await readdir(directory, { withFileTypes: true });
    const workbooks = entries.filter(item => item.isFile() && !item.name.startsWith('~$') && item.name.endsWith(SUFFIX));
    if (workbooks.length > 1) throw failure();
    files.push(...workbooks.map(item => path.join(directory, item.name)));
    const archive = path.join(directory, '历史净值');
    const candidates = (await readdir(archive, { withFileTypes: true })).flatMap(item => {
      const match = new RegExp(`^${code}_全部历史净值_截至(\\d{4}-\\d{2}-\\d{2})\\.(csv|json|xlsx)$`).exec(item.name);
      return item.isFile() && match && validDate(match[1]) ? [{ path: path.join(archive, item.name), cutoff: match[1], priority: { csv: 2, json: 1, xlsx: 0 }[match[2]] }] : [];
    }).sort((left, right) => right.cutoff.localeCompare(left.cutoff) || right.priority - left.priority);
    if (!candidates.length) throw failure();
    files.push(candidates[0].path);
  }
  const metadata = await Promise.all(files.sort().map(async file => {
    const info = await stat(file, { bigint: true });
    if (!info.isFile()) throw failure();
    return [file, String(info.size), String(info.mtimeNs), String(info.ctimeNs), String(info.ino)];
  }));
  return createHash('sha256').update(JSON.stringify([getDailyCode(), metadata])).digest('hex');
}

function readPipe(pythonPath, workspace, root) {
  return new Promise((resolve, reject) => {
    let chunks = [], length = 0, finished = false;
    const child = spawn(pythonPath, [READER, '--workspace', workspace, '--root', root, '--codes', CODES.join(',')], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
    });
    const end = (error, payload) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      for (const chunk of chunks) chunk.fill(0);
      chunks = [];
      if (error) reject(failure()); else resolve(payload);
    };
    const timeout = setTimeout(() => { child.kill(); end(true); }, 30000);
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > 32 * 1024 * 1024) { child.kill(); end(true); }
      else if (!finished) chunks.push(chunk);
    });
    // Consume warnings without propagating dependency output or source values.
    child.stderr.resume();
    child.on('error', () => end(true));
    child.on('close', code => {
      if (finished) return;
      if (code !== 0) { end(true); return; }
      const bytes = Buffer.concat(chunks);
      try { end(false, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
      catch { end(true); }
      finally { bytes.fill(0); }
    });
  });
}

function normalize(payload) {
  if (!payload || typeof payload !== 'object' || payload.vault?.demo !== false || !payload.vault.funds || !payload.nav) throw failure();
  if (Object.keys(payload.vault.funds).sort().join() !== [...CODES].sort().join() || Object.keys(payload.nav).sort().join() !== [...CODES].sort().join()) throw failure();
  const funds = {}, nav = {};
  for (const code of CODES) {
    const book = payload.vault.funds[code], quote = payload.nav[code];
    if (!book || !['profit-first', 'principal-first'].includes(book.mode) || !Array.isArray(book.transactions)
      || ('incomplete' in book && typeof book.incomplete !== 'boolean') || ('sourceNote' in book && typeof book.sourceNote !== 'string')) throw failure();
    const ids = new Set();
    const transactions = book.transactions.map((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw failure();
      const tx = Object.fromEntries(TX_KEYS.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
      tx.id ??= `${code}-local-${index + 1}`;
      if (typeof tx.id !== 'string' || !tx.id || ids.has(tx.id)) throw failure();
      ids.add(tx.id);
      for (const key of ['nav', 'shares', 'fee', 'amount', 'cost']) if (key in tx && tx[key] !== null && (typeof tx[key] !== 'number' || !Number.isFinite(tx[key]) || tx[key] < 0)) throw failure();
      for (const key of ['note', 'submittedAt', 'sourceStatus']) if (key in tx && typeof tx[key] !== 'string') throw failure();
      return tx;
    });
    for (const mode of ['profit-first', 'principal-first']) if (calculateLedger(transactions, { mode }).errors.length) throw failure();
    funds[code] = { transactions, mode: book.mode };
    for (const key of ['incomplete', 'sourceNote', 'rate']) if (Object.hasOwn(book, key)) funds[code][key] = book[key];
    if (!quote || quote.code !== code || typeof quote.source !== 'string' || !Array.isArray(quote.history) || !quote.history.length) throw failure();
    const history = quote.history.map(row => {
      if (!row || !validDate(row.date) || typeof row.nav !== 'number' || !Number.isFinite(row.nav) || row.nav <= 0) throw failure();
      return { date: row.date, nav: row.nav };
    });
    if (history.some((row, index) => index > 0 && row.date <= history[index - 1].date) || quote.asOf !== history.at(-1).date) throw failure();
    nav[code] = { code, source: quote.source, asOf: history.at(-1).date, history };
  }
  const vault = { demo: false, createdAt: typeof payload.vault.createdAt === 'string' ? payload.vault.createdAt : null, funds };
  const revision = createHash('sha256').update(JSON.stringify(canonical({ vault, nav }))).digest('hex');
  // Only known metadata is exposed; source notes and numeric cells stay in vault.
  const sourceSummary = Array.isArray(payload.sourceSummary) ? payload.sourceSummary.flatMap(item => {
    if (!CODES.includes(item?.code)) return [];
    const entry = { code: item.code };
    if (typeof item.nav?.path === 'string' && validDate(item.nav.asOf) && Number.isSafeInteger(item.nav.recordCount) && item.nav.recordCount >= 0) entry.nav = { path: item.nav.path, asOf: item.nav.asOf, recordCount: item.nav.recordCount };
    const transactionSource = item.transactions;
    if (Number.isSafeInteger(transactionSource?.recordCount) && transactionSource.recordCount >= 0
      && (transactionSource.kind === 'empty' ? transactionSource.path === null && transactionSource.recordCount === 0
        : ['workbook', 'encrypted'].includes(transactionSource.kind) && typeof transactionSource.path === 'string')) {
      entry.transactions = { path: transactionSource.path, kind: transactionSource.kind, recordCount: transactionSource.recordCount };
    }
    return [entry];
  }) : [];
  return { revision, vault, nav, sourceSummary };
}

export async function createLiveDataStore({ workspace, root, pythonPath }) {
  const sourceWorkspace = path.resolve(workspace), sourceRoot = path.resolve(root);
  if (typeof pythonPath !== 'string' || !pythonPath) throw failure();
  let lastGood = null, goodFingerprint = null, failedFingerprint = null;
  let queue = Promise.resolve();
  const invalidSnapshot = async () => {
    if (!lastGood) throw failure();
    lastGood = { ...lastGood, envelope: await demoEnvelope(lastGood.vault) };
    return { ...lastGood, status: 'invalid' };
  };
  const snapshot = async () => {
    let before;
    try {
      before = await fingerprint(sourceWorkspace, sourceRoot);
      if (before === goodFingerprint) {
        lastGood = { ...lastGood, envelope: await demoEnvelope(lastGood.vault) };
        return { ...lastGood, status: 'valid' };
      }
      if (before === failedFingerprint) return invalidSnapshot();
      const next = normalize(await readPipe(pythonPath, sourceWorkspace, sourceRoot));
      if (before !== await fingerprint(sourceWorkspace, sourceRoot)) throw failure();
      const envelope = await demoEnvelope(next.vault);
      lastGood = { ...next, envelope };
      goodFingerprint = before;
      failedFingerprint = null;
      return { ...lastGood, status: 'valid' };
    } catch {
      if (before) failedFingerprint = before;
      return invalidSnapshot();
    }
  };
  return {
    snapshot() {
      const pending = queue.then(snapshot);
      queue = pending.catch(() => {});
      return pending;
    },
  };
}
