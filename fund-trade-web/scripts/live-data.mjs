// Real local sources only. Private rows live in RAM and leave through AES-GCM.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { getDailyCode } from '../src/vault.js';
import { FUND_CODES } from '../src/funds.js';
import { readLocalFile } from './local-bundle.mjs';

const INDEX = '公共资料/历史净值/全基金历史净值当前入口.json';
const METADATA = 'fund-trade-web/local/ledger-metadata.json';
const reader = fileURLToPath(new URL('./local-workbooks.py', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const safeError = () => new Error('Local source validation failed.');
const validDate = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

export function resolveFundPath(workspace, relative, code) {
  if (typeof relative !== 'string' || !/^\d{6}$/.test(code) || path.isAbsolute(relative)) throw safeError();
  const full = path.resolve(workspace, relative), within = path.relative(path.resolve(workspace, '基金'), full);
  if (within.startsWith('..') || path.isAbsolute(within)) throw safeError();
  // Funds live one level down after the 持仓基金/观察基金 split.
  const segments = within.split(path.sep);
  if (segments[0] === '持仓基金' || segments[0] === '观察基金') segments.shift();
  if (!segments[0] || !segments[0].startsWith(`${code}_`)) throw safeError();
  return full;
}

export function resolveNavPath(workspace, relative, code) {
  const central = `公共资料/历史净值/维护数据/${code}/${code}_全部历史净值.json`;
  if (/^\d{6}$/.test(code) && relative === central) return path.resolve(workspace, central);
  return resolveFundPath(workspace, relative, code);
}

export function transactionSourcePath(entry) {
  const directory = entry.xlsx_path ? path.posix.dirname(entry.xlsx_path)
    : path.posix.dirname(path.posix.dirname(entry.json_path));
  return path.posix.join(directory, `${entry.code}_交易记录.xlsx`);
}

export function adaptNav(document, entry, verifiedAt) {
  if (document.code !== entry.code || !Array.isArray(document.rows) || !document.rows.length) throw safeError();
  const seen = new Set();
  const history = document.rows.map(row => {
    if (!validDate(row.date) || seen.has(row.date) || !Number.isFinite(Number(row.nav)) || Number(row.nav) <= 0) throw safeError();
    seen.add(row.date);
    return { date: row.date, nav: Number(row.nav), navRaw: String(row.nav),
      accumulatedNavRaw: row.accumulated_nav ?? null, dailyGrowthPctRaw: row.daily_growth_pct ?? null };
  }).sort((a, b) => a.date.localeCompare(b.date));
  if (history.length !== document.count || history.length !== entry.records || history[0].date !== entry.first_date
    || history.at(-1).date !== entry.last_date || document.first_date !== entry.first_date || document.last_date !== entry.last_date) throw safeError();
  return { code: entry.code, name: entry.name, history, firstDate: history[0].date, lastDate: history.at(-1).date,
    count: history.length, verifiedAt, sourceLabel: entry.source,
    source: entry.code === '270023' ? 'https://www.gffunds.com.cn/funds/?fundcode=270023'
      : `https://fundf10.eastmoney.com/jjjz_${entry.code}.html`,
    sourcePath: entry.json_path,
    // Third-party supplements are deliberately excluded from the official curve.
    supplementaryCount: document.supplementary_rows?.length || 0,
    sourceType: document.source_type || 'third_party_public_nav' };
}

function readWorkbooks(pythonPath, workspace, sources) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, ['-X', 'utf8', reader], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', bytes = 0, settled = false;
    const fail = () => { if (!settled) { settled = true; output = ''; reject(safeError()); } };
    const timeout = setTimeout(() => { child.kill(); fail(); }, 30000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 16000000) { child.kill(); fail(); } else output += chunk; });
    // Never forward workbook contents, filenames, or exception values into logs.
    child.stderr.resume();
    child.on('error', fail);
    child.on('close', code => {
      clearTimeout(timeout);
      if (settled) return;
      if (code !== 0) return fail();
      try { const result = JSON.parse(output); output = ''; settled = true; resolve(result); } catch { fail(); }
    });
    child.stdin.on('error', fail);
    child.stdin.end(JSON.stringify({ workspace, sources }));
  });
}

export function createEnvelopeEncryptor(original) {
  if (original.version !== 2 || original.iterations !== 600000 || original.kdf !== 'PBKDF2-SHA256') throw safeError();
  // Retain existing credentials and wrapped keys, so browser sessions can refresh.
  const day = getDailyCode(), wrapped = original.keys?.[day];
  if (!wrapped) throw safeError();
  const wrappingKey = pbkdf2Sync(day, Buffer.from(wrapped.salt, 'base64'), 600000, 32, 'sha256');
  const encrypted = Buffer.from(wrapped.ciphertext, 'base64');
  const decryptor = createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(wrapped.iv, 'base64'));
  decryptor.setAuthTag(encrypted.subarray(-16));
  const key = Buffer.concat([decryptor.update(encrypted.subarray(0, -16)), decryptor.final()]);
  wrappingKey.fill(0);
  if (key.length !== 32) throw safeError();
  return payload => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.from(JSON.stringify(payload));
    try {
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
      return { version: 2, kdf: original.kdf, iterations: original.iterations,
        keys: original.keys, iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64') };
    } finally { bytes.fill(0); }
  };
}

export async function createLiveDataStore({ workspace, root, pythonPath }) {
  const encrypt = createEnvelopeEncryptor(JSON.parse(await readFile(path.join(root, 'data/ledger.enc.json'), 'utf8')));
  let cached = null, signature = null, pending = null;
  async function fingerprint(files) {
    return (await Promise.all(files.map(async file => {
      try { const info = await stat(file, { bigint: true }); return `${file}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`; }
      catch (error) { if (error.code === 'ENOENT') return `${file}:absent`; throw safeError(); }
    }))).join('|');
  }
  async function load() {
    try {
      const indexHit = await readLocalFile({ root, workspace, name: 'navIndex', legacy: INDEX });
      if (!indexHit) throw safeError();
      const indexBytes = indexHit.bytes;
      const index = JSON.parse(indexBytes);
      if (index.schema !== 'all-fund-nav-current-v1' || !Array.isArray(index.funds) || !index.funds.length
        || new Set(index.funds.map(entry => entry.code)).size !== index.funds.length) throw safeError();
      index.funds = index.funds.filter(entry => FUND_CODES.includes(entry.code));
      if (index.funds.length !== FUND_CODES.length) throw safeError();
      let provenance = {};
      const metadataHit = await readLocalFile({ root, workspace, name: 'ledgerMetadata', legacy: METADATA });
      try { if (metadataHit) provenance = JSON.parse(metadataHit.bytes); } catch { /* Unknown provenance stays unverified. */ }
      const sources = index.funds.map(entry => ({ code: entry.code,
        path: transactionSourcePath(entry),
        estimated: provenance.funds?.find(fund => fund.code === entry.code)?.source_estimates_retained !== false,
        workbook_sha256: provenance.funds?.find(fund => fund.code === entry.code)?.workbook_sha256,
        row_provenance: provenance.funds?.find(fund => fund.code === entry.code)?.row_provenance,
        allow_drafts: true }));
      const navFiles = index.funds.map(entry => resolveNavPath(workspace, entry.json_path, entry.code));
      const workbookFiles = sources.map(source => resolveFundPath(workspace, source.path, source.code));
      const files = [indexHit.file, ...(metadataHit ? [metadataHit.file] : []), ...navFiles, ...workbookFiles, reader];
      const before = await fingerprint(files);
      if (cached && before === signature) return cached;
      const present = (await Promise.all(sources.map(async (source, index) => {
        try { await stat(workbookFiles[index]); return source; } catch (error) { if (error.code === 'ENOENT') return null; throw safeError(); }
      }))).filter(Boolean);
      const [navBytes, books] = await Promise.all([Promise.all(navFiles.map(file => readFile(file))), readWorkbooks(pythonPath, workspace, present)]);
      const nav = Object.fromEntries(index.funds.map((entry, i) => [entry.code, adaptNav(JSON.parse(navBytes[i]), entry, index.updated_at)]));
      const funds = {}, sourceSummary = [];
      for (const entry of index.funds) {
        const imported = books[entry.code];
        const transactions = (imported?.transactions || []).map(tx => {
          // A dated cash order beyond the last published NAV is still processing.
          // It must not become a guessed fill or erase the confirmed history.
          if (tx.status === 'pending' && tx.sourceStatus === 'incomplete'
            && validDate(tx.date) && tx.date > nav[entry.code].lastDate
            && ['buy', 'sell'].includes(tx.type) && Number.isFinite(tx.amount) && tx.amount > 0
            && (tx.nav === null || tx.shares === null)) return { ...tx, sourceStatus: 'processing' };
          return tx;
        });
        const pendingBackupCount = provenance.funds?.find(fund => fund.code === entry.code)?.legacy_pending_records || 0;
        const incomplete = transactions.some(tx => tx.status === 'pending' && tx.sourceStatus !== 'processing');
        const processing = transactions.filter(tx => tx.status === 'pending' && tx.sourceStatus === 'processing').length;
        const estimated = transactions.some(tx => tx.status === 'estimated');
        const formulaAdjusted = transactions.filter(tx => tx.formulaAdjustment).length;
        funds[entry.code] = { transactions, mode: 'profit-first', incomplete,
          sourceNote: imported
            ? `来源：${entry.code}_交易记录.xlsx（六列）。交易日期为原始下单日期，不当作净值日期。${estimated ? '含估算记录，未重新核实成交。' : '确认状态沿用来源记录，未重新核实成交。'}${formulaAdjusted ? `有 ${formulaAdjusted} 笔份额公式已按手续费口径重新估算，原表未改写，请核对实际确认份额。` : ''}${processing ? `有 ${processing} 笔进行中订单未计入持仓和收益。` : ''}${incomplete ? '成交资料待补全或存在来源差异，暂停账户汇总。' : ''}${pendingBackupCount ? `旧网站另有 ${pendingBackupCount} 笔待确认订单保留在加密备份中，未列为已成交。` : ''}`
            : '尚未提供六列交易记录表；不推断持仓。' };
        sourceSummary.push({ code: entry.code, nav: { kind: 'full-history', records: nav[entry.code].count },
          transactions: { kind: imported ? 'workbook' : 'absent', records: transactions.length, incomplete, estimated } });
      }
      if (before !== await fingerprint(files)) throw safeError();
      const revision = digest(Buffer.concat([indexBytes, ...navBytes, await readFile(reader),
        Buffer.from(JSON.stringify(provenance.funds?.filter(fund => FUND_CODES.includes(fund.code)) || [])),
        Buffer.from(JSON.stringify(present.map(source => [source.code, source.estimated, books[source.code].sha256])))]));
      const envelope = encrypt({ createdAt: new Date().toISOString(), funds });
      cached = { revision, status: 'valid', nav, envelope, sourceSummary };
      signature = before;
      return cached;
    } catch { throw safeError(); }
  }
  return { snapshot() { if (!pending) pending = load().finally(() => { pending = null; }); return pending; } };
}
