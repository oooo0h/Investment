import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createDemoTableStore } from './demo-tables.mjs';
import { createLiveDataStore } from './live-data.mjs';
import { createDisciplineSource } from './discipline-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
const staticFiles = new Set(['index.html', 'redesign.css', 'visual-runtime.js', 'ambient-scene.js', 'interface-motion.js', 'vendor/three/three.module.js', 'vendor/three/three.core.js', 'vendor/three/LICENSE.txt', 'vendor/gsap/gsap.min.js', 'vendor/gsap/README.md', 'styles.css', 'app.js', 'funds.js', 'discipline.js', 'discipline-actions.js', 'discipline-sync.js', 'nav-annualized.js', 'region-data.js', 'us-exposure.js', 'holding-duration.js', 'bond-reserve.js', 'bond-model.js', 'bond-store.js', 'bonds-view.js', 'data/bonds.enc.json', 'engine.js', 'application-estimates.js', 'vault.js', 'refresh-controller.js', 'transaction-performance.js', 'nav-range.js', 'nav-chart.js', 'nav-display.js', 'nav-estimates.js', 'nav-estimate-store.js', 'estimate-panel.js', 'nav-interaction.js', 'nav-slider.js', 'manifest.webmanifest']);
const demoNotice = `<style>.gate .brand::after,.brand-copy>span:first-child::after{font:500 10px/1.5 "Microsoft YaHei",sans-serif;padding:2px 6px;border:1px solid var(--line);border-radius:4px;color:var(--muted);background:var(--paper-2)}.gate .brand::after{content:"测试数据"}.brand-copy>span:first-child::after{content:"测试";margin-left:7px}</style>`;
const port = Number(process.env.PORT || 4186);
const demo = process.argv.includes('--demo');
const disciplines = await createDisciplineSource({ workspace: path.resolve(root, '../../..') });
const tables = demo
  ? await createDemoTableStore({ directory: path.join(root, 'tmp', 'demo-tables') })
  : await createLiveDataStore({
    workspace: path.resolve(root, '../../..'), root,
    pythonPath: process.env.FUND_PREVIEW_PYTHON || path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe'),
  });
// Verify real sources before listening; failure must never fall back to test data.
try { await tables.snapshot(); }
catch { console.error('Local data unavailable.'); process.exit(1); }
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const relative = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
    let bytes;
    let contentType;
    if (relative === 'data/discipline.json') {
      bytes = JSON.stringify(await disciplines.snapshot());
      contentType = 'application/json';
    } else if (relative === 'data/version.json') {
      const snapshot = await tables.snapshot();
      bytes = JSON.stringify({ revision: snapshot.revision, status: snapshot.status });
      contentType = 'application/json';
    } else if (relative === 'data/ledger.enc.json') {
      bytes = JSON.stringify((await tables.snapshot()).envelope);
      contentType = 'application/json';
    } else if (/^data\/nav\/\d{6}\.json$/.test(relative)) {
      const nav = (await tables.snapshot()).nav[relative.slice(9, 15)];
      if (!nav) throw new Error();
      bytes = JSON.stringify(nav);
      contentType = 'application/json';
    } else {
      if (!staticFiles.has(relative) && !/^assets\/[a-z0-9-]+\.svg$/.test(relative)) throw new Error();
      const target = path.resolve(root, relative);
      bytes = await readFile(target);
      if (relative === 'index.html' && demo) bytes = bytes.toString('utf8').replace('</head>', `${demoNotice}</head>`);
      contentType = types[path.extname(target)] || 'application/manifest+json';
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(bytes);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Local ${demo ? 'demo' : 'live'}: http://127.0.0.1:${port}/`));
