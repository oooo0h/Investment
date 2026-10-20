const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = __dirname;
const port = Number(process.env.PORT || 5173);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
let refreshing = false;
function json(res, status, data) { res.writeHead(status, { 'Content-Type': mime['.json'], 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
http.createServer((req, res) => {
  const origin = `http://127.0.0.1:${port}`;
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return json(res, 403, { error: '无效的本地主机。' });
  const url = new URL(req.url, origin);
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    if (req.headers.origin && ![origin, `http://localhost:${port}`].includes(req.headers.origin)) return json(res, 403, { error: '仅允许本地页面发起更新。' });
    if (refreshing) return json(res, 409, { error: '正在更新，请稍后重试。' });
    refreshing = true;
    const child = spawn(process.env.PWSH_PATH || 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/refresh-data.ps1')], { cwd: root, windowsHide: true });
    let log = ''; let finished = false;
    const timeout = setTimeout(() => { child.kill(); finish(504, { error: '数据源响应超时，请稍后重试。' }); }, 280000);
    function finish(code, data) { if (finished) return; finished = true; clearTimeout(timeout); refreshing = false; if (!res.destroyed) json(res, code, data); }
    child.stdout.on('data', chunk => { log = (log + chunk).slice(-16000); });
    child.stderr.on('data', chunk => { log = (log + chunk).slice(-16000); });
    child.on('error', error => { console.error(error.message); finish(500, { error: '未能启动更新程序，请检查 Node.js 与 PowerShell。' }); });
    child.on('close', code => {
      if (code === 0) { try { finish(200, JSON.parse(fs.readFileSync(path.join(root, 'data/market-data.json'), 'utf8'))); } catch { finish(500, { error: '更新结果无法读取，已保留页面数据。' }); } }
      else { console.error(log); finish(502, { error: '公开数据源访问失败，或新数据未通过完整性校验。请稍后重试。' }); }
    });
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '不支持的请求方式。' });
  let relative;
  try { relative = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: '无效路径。' }); }
  // Only serve the chart's static entry points and data snapshot, never workspace files or scripts.
  if (relative === '/') relative = '/index.html';
  if (!['/index.html', '/styles.css', '/chart-core.js', '/app.js', '/vendor/echarts.min.js', '/data/market-data.js', '/data/market-data.json'].includes(relative)) { res.writeHead(404); res.end(); return; }
  const file = path.join(root, relative);
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}).listen(port, '127.0.0.1', () => console.log(`Market chart: http://127.0.0.1:${port}`));
