import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLiveDataStore } from './live-data.mjs';
import { createLiveBondDataStore } from './live-bond-data.mjs';
import { createDisciplineSource } from './discipline-source.mjs';
import { WORKSPACE_ROOT, staticSourcePath, isPublicAsset } from './site-files.mjs';
import { syncLocalSources } from './local-bundle.mjs';
import { siteTemporaryPath } from './project-paths.mjs';
import { createLocalNavPolling } from './local-nav-polling.mjs';
import { createLocalTransactionStore, RegistrationError } from './local-transactions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { await syncLocalSources({ workspace: WORKSPACE_ROOT, root }); }
catch { console.warn('Local bundle refresh failed; using existing copies.'); }
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
const demoNotice = `<style>.gate .brand::after,.brand-copy>span:first-child::after{font:500 10px/1.5 "Microsoft YaHei",sans-serif;padding:2px 6px;border:1px solid var(--line);border-radius:4px;color:var(--muted);background:var(--paper-2)}.gate .brand::after{content:"测试数据"}.brand-copy>span:first-child::after{content:"测试";margin-left:7px}</style>`;
const port = Number(process.env.PORT || 4186);
const demo = process.argv.includes('--demo');
const pythonPath = process.env.FUND_PREVIEW_PYTHON || path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
const navPolling = demo ? null : createLocalNavPolling({ workspace: WORKSPACE_ROOT, pythonPath });
const disciplines = await createDisciplineSource({ workspace: WORKSPACE_ROOT, root });
const tables = demo
  ? await (await import('./demo-tables.mjs')).createDemoTableStore({ directory: siteTemporaryPath(root, 'demo-tables') })
  : await createLiveDataStore({ workspace: WORKSPACE_ROOT, root, pythonPath });
const bondTables = demo ? null : await createLiveBondDataStore({ workspace: WORKSPACE_ROOT, root, pythonPath });
const transactionWriter = demo ? null : createLocalTransactionStore({ workspace: WORKSPACE_ROOT, root, pythonPath });
// Verify real sources before listening; failure must never fall back to test data.
try { await tables.snapshot(); if (bondTables) await bondTables.snapshot(); }
catch { console.error('Local data unavailable.'); process.exit(1); }

function readJson(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('too-large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid')); }
    });
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const origin = req.headers.origin;
  if (origin && !allowed.has(origin)) return false;
  const site = req.headers['sec-fetch-site'];
  if (!origin && site && site !== 'same-origin') return false;
  return true;
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(payload));
}

async function handleLocalApi(req, res, relative) {
  if (!transactionWriter) return json(res, 404, { error: 'Not found' });
  if (!sameOrigin(req)) return json(res, 403, { error: '请求来源无效。' });
  if (relative === '__local/transfers' && req.method === 'GET') {
    try { return json(res, 200, await transactionWriter.list()); }
    catch { return json(res, 503, { error: '转换记录暂不可用。' }); }
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return json(res, 415, { error: 'Unsupported media type' });
  let body;
  try { body = await readJson(req); }
  catch { return json(res, 400, { error: '请求内容无效。' }); }
  try {
    let result;
    if (relative === '__local/transactions') result = await transactionWriter.create(body);
    else if (relative === '__local/transfers/reconcile') result = await transactionWriter.reconcile();
    else if (relative === '__local/transfers/review') result = await transactionWriter.review(body);
    else return json(res, 404, { error: 'Not found' });
    // A historical conversion whose NAVs are already published can be filled
    // immediately; pending ones stay in the awaiting state for later review.
    if (result?.mode === 'transfer') { try { await transactionWriter.reconcile(); } catch { /* Awaiting state remains. */ } }
    return json(res, 200, result);
  } catch (error) {
    if (error instanceof RegistrationError) return json(res, 400, { error: error.message, code: error.code });
    return json(res, 500, { error: '登记未完成，请稍后重试。' });
  }
}

http.createServer(async (req, res) => {
  res.setHeader('X-Fund-Trade-Web', demo ? 'demo' : 'live');
  let dataRequest = false;
  try {
    const url = new URL(req.url, 'http://localhost');
    const relative = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
    if (relative.startsWith('__local/') && relative !== '__local/health') {
      return await handleLocalApi(req, res, relative);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Method not allowed');
      return;
    }
    dataRequest = ['__local/health', 'data/discipline.json', 'data/version.json', 'data/ledger.enc.json', 'data/bonds.enc.json'].includes(relative)
      || /^data\/nav\/\d{6}\.json$/.test(relative);
    let bytes;
    let contentType;
    if (relative === '__local/health') {
      await tables.snapshot();
      if (bondTables) await bondTables.snapshot();
      bytes = JSON.stringify({ application: 'fund-trade-web', mode: demo ? 'demo' : 'live', status: 'ready' });
      contentType = 'application/json';
    } else if (relative === 'data/discipline.json') {
      bytes = JSON.stringify(await disciplines.snapshot());
      contentType = 'application/json';
    } else if (relative === 'data/version.json') {
      const snapshot = await tables.snapshot();
      const bonds = bondTables ? await bondTables.snapshot() : null;
      const revision = createHash('sha256').update(`${snapshot.revision}:${bonds?.revision || 'unavailable'}`).digest('hex');
      bytes = JSON.stringify({ revision, status: snapshot.status });
      contentType = 'application/json';
    } else if (relative === 'data/ledger.enc.json') {
      bytes = JSON.stringify((await tables.snapshot()).envelope);
      contentType = 'application/json';
    } else if (relative === 'data/bonds.enc.json') {
      if (demo) {
        const { demoEnvelope } = await import('./demo-data.mjs');
        bytes = JSON.stringify(await demoEnvelope({ funds: {}, bonds: [], holdingLots: {}, transactions: {}, freeCashFlow: null, updatedAt: new Date().toISOString() }));
      } else {
        const snapshot = await bondTables.snapshot();
        if (!snapshot) throw new Error();
        bytes = JSON.stringify(snapshot.envelope);
      }
      contentType = 'application/json';
    } else if (/^data\/nav\/\d{6}\.json$/.test(relative)) {
      const nav = (await tables.snapshot()).nav[relative.slice(9, 15)];
      if (!nav) throw new Error();
      bytes = JSON.stringify(nav);
      contentType = 'application/json';
    } else {
      const target = staticSourcePath(relative) || (isPublicAsset(relative) ? path.resolve(root, relative) : null);
      if (!target) throw new Error();
      bytes = await readFile(target);
      if (relative === 'index.html' && demo) bytes = bytes.toString('utf8').replace('</head>', `${demoNotice}</head>`);
      contentType = types[path.extname(target)] || 'application/manifest+json';
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(bytes);
  } catch {
    res.writeHead(dataRequest ? 503 : 404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end(dataRequest ? 'Local data unavailable' : 'Not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Local ${demo ? 'demo' : 'live'}: http://127.0.0.1:${port}/`);
  void navPolling?.start();
});
process.once('exit', () => navPolling?.stop());
