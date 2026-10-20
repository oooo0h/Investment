// Read local six-column bond workbooks; never infer missing economics or lots.
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { adaptNav, createEnvelopeEncryptor, resolveFundPath, resolveNavPath, transactionSourcePath } from './live-data.mjs';
import { calculateBondWorkbook } from './bond-ledger.mjs';
import { normalizeBondTransactions } from '../src/bond-transactions.js';
import { readLocalFile } from './local-bundle.mjs';
const CODES = ['006485', '006663'];
const META = 'fund-trade-web/local/bond-metadata.json';
const reader = fileURLToPath(new URL('./local-workbooks.py', import.meta.url));
const safeError = () => new Error('Bond source validation failed.');
function readBooks(pythonPath, workspace, sources) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, ['-X', 'utf8', reader], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', done = false;
    const fail = () => { if (!done) { done = true; output = ''; reject(safeError()); } };
    const timer = setTimeout(() => { child.kill(); fail(); }, 30000);
    child.stdout.setEncoding('utf8'); child.stderr.resume();
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 16000000) { child.kill(); fail(); } });
    child.on('error', fail); child.stdin.on('error', fail);
    child.on('close', code => { clearTimeout(timer); if (done) return; if (code !== 0) return fail();
      try { const books = JSON.parse(output); output = ''; done = true; resolve(books); } catch { fail(); } });
    child.stdin.end(JSON.stringify({ workspace, sources }));
  });
}
export async function createLiveBondDataStore({ workspace, root, pythonPath }) {
  let original;
  try { original = JSON.parse(await readFile(path.join(root, 'data/bonds.enc.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { snapshot: async () => null }; throw safeError(); }
  const encrypt = createEnvelopeEncryptor(original);
  let cached = null, signature = null, pending = null;
  async function snapshot() {
    try {
      const metadataHit = await readLocalFile({ root, workspace, name: 'bondMetadata', legacy: META });
      const indexHit = await readLocalFile({ root, workspace, name: 'navIndex', legacy: '公共资料/历史净值/全基金历史净值当前入口.json' });
      if (!metadataHit || !indexHit) throw safeError();
      const metadataBytes = metadataHit.bytes, metadata = JSON.parse(metadataBytes);
      const index = JSON.parse(indexHit.bytes);
      const sources = CODES.map(code => {
        const entry = index.funds.find(fund => fund.code === code), details = metadata.funds.find(fund => fund.code === code);
        if (!entry || !details) throw safeError();
        const relative = transactionSourcePath(entry);
        return { code, path: relative, estimated: false, allow_drafts: true, workbook_sha256: details.workbook_sha256, row_provenance: details.row_provenance };
      });
      const navFiles = CODES.map(code => resolveNavPath(workspace, index.funds.find(fund => fund.code === code).json_path, code));
      const files = [...sources.map(source => resolveFundPath(workspace, source.path, source.code)), ...navFiles,
        indexHit.file];
      const fingerprint = async () => (await Promise.all([...files, metadataHit.file].map(async file => {
        const info = await stat(file, { bigint: true }); return `${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      }))).join('|');
      const before = await fingerprint();
      if (cached && before === signature) return cached;
      const [books, navBytes] = await Promise.all([readBooks(pythonPath, workspace, sources), Promise.all(navFiles.map(file => readFile(file)))]);
      const transactions = {}, calculated = [];
      for (let indexOfCode = 0; indexOfCode < CODES.length; indexOfCode++) {
        const code = CODES[indexOfCode], entry = index.funds.find(fund => fund.code === code);
        const nav = adaptNav(JSON.parse(navBytes[indexOfCode]), entry, index.updated_at);
        calculated.push(calculateBondWorkbook(code, books[code].transactions, nav.history.at(-1)));
      }
      for (const source of sources) {
        const book = books[source.code], matched = book.sha256 === source.workbook_sha256;
        const details = new Map((matched ? source.row_provenance : []).map(detail => [detail.row, detail]));
        const rows = book.transactions.map(row => {
          const line = Number(row.id.split('-').at(-1)), detail = details.get(line);
          const confirmed = Boolean(detail?.status === 'confirmed' && row.status === 'confirmed');
          const computed = !confirmed && row.status === 'estimated';
          return { id: detail?.source_id || row.id, submittedAt: detail?.submitted_at || row.submittedAt, date: row.date,
            type: detail?.original_type || row.type, amount: detail?.amount_kind === 'confirmed' ? null : row.amount,
            confirmedAmount: detail?.amount_kind === 'confirmed' ? row.amount : null,
            nav: row.nav, shares: row.shares, navDate: matched ? row.navDate : null, fee: row.fee, confirmedDate: null,
            status: confirmed || computed ? 'confirmed' : 'pending', sourceStatus: confirmed ? 'confirmed' : computed ? 'calculated' : 'unverified',
            sharesBasis: row.sourceStatus === 'formula-calculated' ? 'calculated' : 'reported',
            note: confirmed ? '按截图确认字段登记；未用完成时限推断确认日。' : computed ? '沿用已保存表格及其公式结果计算，未重新核验成交；确认日期未补造。' : '截图或表格未提供完整成交字段，未推算份额、净值或费用。' };
        });
        // The workbook is the sole record source. Legacy encrypted backups are
        // retained on disk but must never append an order to the current table.
        transactions[source.code] = rows.sort((a, b) => (a.submittedAt || a.date || '9999-12-31').localeCompare(b.submittedAt || b.date || '9999-12-31'));
      }
      const normalized = normalizeBondTransactions(transactions);
      if (before !== await fingerprint()) throw safeError();
      const hash = createHash('sha256').update(metadataBytes).update(JSON.stringify(CODES.map(code => books[code].sha256)));
      for (const bytes of navBytes) hash.update(bytes);
      const revision = hash.digest('hex');
      const updatedAt = new Date().toISOString();
      const usable = calculated.every(Boolean);
      const bonds = usable ? calculated.map(item => item.entry) : [];
      const holdingLots = usable ? Object.fromEntries(calculated.map(item => [item.entry.code, item.holdingLots])) : {};
      const valuationDate = usable ? calculated.map(item => item.valuationDate).sort()[0] : null;
      const envelope = encrypt({ funds: {}, bonds, freeCashFlow: null, holdingLots, valuationDate, transactions: normalized, updatedAt });
      cached = { status: 'live', revision, envelope, sourceSummary: CODES.map(code => ({ code, records: normalized[code].length, kind: 'workbook' })) };
      signature = before;
      return cached;
    } catch { throw safeError(); }
  }
  return { snapshot() { if (!pending) pending = snapshot().finally(() => { pending = null; }); return pending; } };
}
