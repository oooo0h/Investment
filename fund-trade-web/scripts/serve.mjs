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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { await syncLocalSources({ workspace: WORKSPACE_ROOT, root }); }
catch { console.warn('Local bundle refresh failed; using existing copies.'); }
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
const demoNotice = `<style>.gate .brand::after,.brand-copy>span:first-child::after{font:500 10px/1.5 "Microsoft YaHei",sans-serif;padding:2px 6px;border:1px solid var(--line);border-radius:4px;color:var(--muted);background:var(--paper-2)}.gate .brand::after{content:"测试数据"}.brand-copy>span:first-child::after{content:"测试";margin-left:7px}</style>`;
const port = Number(process.env.PORT || 4186);
const demo = process.argv.includes('--demo');
const disciplines = await createDisciplineSource({ workspace: WORKSPACE_ROOT, root });
const tables = demo
  ? await (await import('./demo-tables.mjs')).createDemoTableStore({ directory: path.join(root, 'tmp', 'demo-tables') })
  : await createLiveDataStore({
    workspace: WORKSPACE_ROOT, root,
    pythonPath: process.env.FUND_PREVIEW_PYTHON || path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe'),
  });
const bondTables = demo ? null : await createLiveBondDataStore({ workspace: WORKSPACE_ROOT, root,
  pythonPath: process.env.FUND_PREVIEW_PYTHON || path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe') });
// Verify real sources before listening; failure must never fall back to test data.
try { await tables.snapshot(); if (bondTables) await bondTables.snapshot(); }
catch { console.error('Local data unavailable.'); process.exit(1); }
http.createServer(async (req, res) => {
  let dataRequest = false;
  try {
    const url = new URL(req.url, 'http://localhost');
    const relative = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
    dataRequest = ['data/discipline.json', 'data/version.json', 'data/ledger.enc.json', 'data/bonds.enc.json'].includes(relative)
      || /^data\/nav\/\d{6}\.json$/.test(relative);
    let bytes;
    let contentType;
    if (relative === 'data/discipline.json') {
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
}).listen(port, '127.0.0.1', () => console.log(`Local ${demo ? 'demo' : 'live'}: http://127.0.0.1:${port}/`));
