// Publish only the allowlisted dist directory; source workbooks never enter Git.
import { readFile, readdir, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FUND_CODES } from '../funds.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const repository = 'oooo0h/Investment';
const arguments_ = process.argv.slice(2);
if (arguments_.some(argument => argument !== '--include-account-data')) throw new Error('Unknown publish option');
// Account payloads require a separate, deliberate opt-in. A normal deployment
// updates the interface and public prices while preserving remote account data.
const includeAccountData = arguments_.includes('--include-account-data');
const accountFiles = new Set(['data/ledger.enc.json', 'data/bonds.enc.json']);
const api = (endpoint, method = 'GET', payload = undefined, optional = false) => {
  const args = ['api', endpoint, '-X', method];
  if (payload !== undefined) args.push('--input', '-');
  const result = spawnSync('gh', args, { input: payload === undefined ? undefined : JSON.stringify(payload), encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    if (optional && /404/.test(result.stderr + result.stdout)) return null;
    throw new Error(`GitHub operation failed: ${method} ${endpoint}. Check authentication and repository access.`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
};

const allowed = new Set(['index.html', 'redesign.css', 'visual-runtime.js', 'ambient-scene.js', 'interface-motion.js', 'vendor/three/three.module.js', 'vendor/three/three.core.js', 'vendor/three/LICENSE.txt', 'vendor/gsap/gsap.min.js', 'vendor/gsap/README.md', 'styles.css', 'app.js', 'funds.js', 'discipline.js', 'discipline-actions.js', 'discipline-sync.js', 'nav-annualized.js', 'region-data.js', 'us-exposure.js', 'holding-duration.js', 'bond-reserve.js', 'bond-model.js', 'bond-store.js', 'bonds-view.js', 'engine.js', 'application-estimates.js', 'vault.js', 'refresh-controller.js', 'transaction-performance.js', 'nav-range.js', 'nav-chart.js', 'nav-display.js', 'nav-estimates.js', 'nav-estimate-store.js', 'estimate-panel.js', 'nav-interaction.js', 'nav-slider.js', 'manifest.webmanifest', '.nojekyll', 'data/discipline.json', 'data/ledger.enc.json', 'data/bonds.enc.json', ...FUND_CODES.map(code => `data/nav/${code}.json`)]);
const tree = [];
const collected = new Set();
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if ((await lstat(absolute)).isSymbolicLink()) throw new Error('Publish input must not contain links');
    if (entry.isDirectory()) await collect(absolute);
    else {
      const relative = path.relative(dist, absolute).replaceAll('\\', '/');
      if (!allowed.has(relative) && !/^assets\/[a-z0-9-]+\.svg$/.test(relative)) throw new Error('Publish input is outside the site allowlist');
      collected.add(relative);
      if (!includeAccountData && accountFiles.has(relative)) continue;
      tree.push({ path: relative, mode: '100644', type: 'blob', content: await readFile(absolute, 'utf8') });
    }
  }
}
await collect(dist);
if (![...allowed].every(file => collected.has(file))) throw new Error('Publish input is incomplete');
const previous = api(`repos/${repository}/git/ref/heads/gh-pages`, 'GET', undefined, true);
if (!previous && !includeAccountData) throw new Error('An initial account deployment needs explicit authorization');
const previousCommit = previous ? api(`repos/${repository}/git/commits/${previous.object.sha}`) : null;
const remoteTree = api(`repos/${repository}/git/trees`, 'POST', { ...(previousCommit ? { base_tree: previousCommit.tree.sha } : {}), tree });
const commit = api(`repos/${repository}/git/commits`, 'POST', {
  message: 'Publish collapsible fund information and NAV panels',
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
