// Publish only the allowlisted dist directory; source workbooks never enter Git.
import { readFile, readdir, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPLOY_FILES, ACCOUNT_FILES, isPublicAsset } from './site-files.mjs';
import { classifyGithubFailure } from './publish-diagnostics.mjs';
import { siteTemporaryPath } from './project-paths.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = siteTemporaryPath(root, 'dist');
const repository = 'oooo0h/Investment';
const arguments_ = process.argv.slice(2);
if (arguments_.some(argument => argument !== '--include-account-data')) throw new Error('Unknown publish option');
// Account payloads require a separate, deliberate opt-in. A normal deployment
// updates the interface and public prices while preserving remote account data.
const includeAccountData = arguments_.includes('--include-account-data');
const accountFiles = new Set(ACCOUNT_FILES);
const trace = message => console.error(`[Publish] ${message}`);
const api = (endpoint, method = 'GET', payload = undefined, optional = false) => {
  const args = ['api', endpoint, '-X', method];
  if (payload !== undefined) args.push('--input', '-');
  const started = Date.now();
  trace(`GitHub ${method} ${endpoint}: started`);
  const result = spawnSync('gh', args, { input: payload === undefined ? undefined : JSON.stringify(payload), encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    const failure = classifyGithubFailure(result);
    trace(`GitHub ${method} ${endpoint}: exit=${result.status ?? 'unavailable'}, http=${failure.http || 'unknown'}, reason=${failure.category}, duration=${Date.now() - started}ms`);
    if (optional && failure.http === '404') return null;
    throw new Error(`GitHub ${method} ${endpoint} failed (exit=${result.status ?? 'unavailable'}, http=${failure.http || 'unknown'}, reason=${failure.category}).`);
  }
  trace(`GitHub ${method} ${endpoint}: complete, exit=0, duration=${Date.now() - started}ms`);
  try { return result.stdout.trim() ? JSON.parse(result.stdout) : null; }
  catch { throw new Error(`GitHub ${method} ${endpoint} returned an invalid JSON response.`); }
};

const allowed = new Set(DEPLOY_FILES);
const tree = [];
const collected = new Set();
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if ((await lstat(absolute)).isSymbolicLink()) throw new Error('Publish input must not contain links');
    if (entry.isDirectory()) await collect(absolute);
    else {
      const relative = path.relative(dist, absolute).replaceAll('\\', '/');
      if (!allowed.has(relative) && !isPublicAsset(relative)) throw new Error('Publish input is outside the site allowlist');
      collected.add(relative);
      if (!includeAccountData && accountFiles.has(relative)) continue;
      tree.push({ path: relative, mode: '100644', type: 'blob', content: await readFile(absolute, 'utf8') });
    }
  }
}
await collect(dist);
if (![...allowed].every(file => collected.has(file))) throw new Error('Publish input is incomplete');
trace(`Validated ${collected.size} files; upload=${tree.length}; accountData=${includeAccountData ? 'explicitly included' : 'preserved remotely'}.`);
let inlineBytes = tree.reduce((sum, item) => sum + Buffer.byteLength(item.content, 'utf8'), 0);
for (const item of [...tree].sort((left, right) => Buffer.byteLength(right.content, 'utf8') - Buffer.byteLength(left.content, 'utf8'))) {
  if (inlineBytes < 500000) break;
  const bytes = Buffer.from(item.content, 'utf8');
  const blob = api(`repos/${repository}/git/blobs`, 'POST', { encoding: 'base64', content: bytes.toString('base64') });
  item.sha = blob.sha;
  delete item.content;
  inlineBytes -= bytes.length;
}
const previous = api(`repos/${repository}/git/ref/heads/gh-pages`, 'GET', undefined, true);
if (!previous && !includeAccountData) throw new Error('An initial account deployment needs explicit authorization');
const previousCommit = previous ? api(`repos/${repository}/git/commits/${previous.object.sha}`) : null;
const remoteTree = api(`repos/${repository}/git/trees`, 'POST', { ...(previousCommit ? { base_tree: previousCommit.tree.sha } : {}), tree });
const commit = api(`repos/${repository}/git/commits`, 'POST', {
  message: 'Update spreadsheet ledgers and compact fund dashboard',
  tree: remoteTree.sha, parents: previous ? [previous.object.sha] : [],
});
if (previous) api(`repos/${repository}/git/refs/heads/gh-pages`, 'PATCH', { sha: commit.sha, force: false });
else api(`repos/${repository}/git/refs`, 'POST', { ref: 'refs/heads/gh-pages', sha: commit.sha });
const pages = api(`repos/${repository}/pages`, 'GET', undefined, true);
if (pages) {
  if (pages.source?.branch !== 'gh-pages' || pages.source?.path !== '/') {
    api(`repos/${repository}/pages`, 'PUT', { build_type: 'legacy', source: { branch: 'gh-pages', path: '/' } });
  }
} else api(`repos/${repository}/pages`, 'POST', { build_type: 'legacy', source: { branch: 'gh-pages', path: '/' } });
const final = api(`repos/${repository}/pages`);
console.log(JSON.stringify({ commit: commit.sha, url: final.html_url, branch: final.source?.branch, status: final.status, accountData: includeAccountData ? 'updated' : 'preserved' }));
