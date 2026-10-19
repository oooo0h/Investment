// Upload an explicitly reviewed manifest. File bytes travel through stdin only;
// output contains commit IDs, counts and fixed diagnostics, never workbook cells.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { WORKSPACE_ROOT } from './site-files.mjs';
const manifestFile = process.argv[2];
if (!manifestFile || process.argv.length !== 3) throw new Error('Provide the reviewed source manifest.');
const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
if (manifest.schema !== 'github-sync-manifest-v1' || manifest.repository !== 'oooo0h/Investment' || manifest.branch !== 'main'
  || manifest.publicRawWorkbookConsent !== '2026-10-20 explicit second confirmation' || !Array.isArray(manifest.entries)) throw new Error('Unapproved source manifest.');
const repo = manifest.repository;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const gitBlob = bytes => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
const api = (endpoint, method = 'GET', body) => {
  const result = spawnSync(process.env.GH_EXECUTABLE || 'gh', ['api', endpoint, '-X', method, ...(body === undefined ? [] : ['--input', '-'])],
    { input: body === undefined ? undefined : JSON.stringify(body), encoding: 'utf8', maxBuffer: 64000000, windowsHide: true });
  if (result.status !== 0) throw new Error(`GitHub source request failed (HTTP ${/HTTP\s+(\d{3})/.exec(result.stderr || '')?.[1] || 'unavailable'}).`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
};
const files = new Map();
for (const entry of manifest.entries) {
  const relative = entry.path;
  if (typeof relative !== 'string' || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some(part => ['..', '.', '.git', 'node_modules', '.venv', '__pycache__'].includes(part))
    || relative.startsWith('fund-trade-web/tmp/') || relative.startsWith('fund-trade-web/dist/') || files.has(relative)) throw new Error('Unsafe source path.');
  const target = path.resolve(WORKSPACE_ROOT, relative), within = path.relative(WORKSPACE_ROOT, target);
  if (within.startsWith('..') || path.isAbsolute(within) || !(await fs.lstat(target)).isFile()) throw new Error('Unsafe source file.');
  const bytes = await fs.readFile(target);
  if (sha256(bytes) !== entry.sha256 || gitBlob(bytes) !== entry.git_blob) throw new Error('A reviewed source changed; prepare a new manifest.');
  files.set(relative, bytes);
}
if (api('user').login !== repo.split('/')[0]) throw new Error('GitHub account does not match the approved destination.');
const ref = api(`repos/${repo}/git/ref/heads/main`), previous = api(`repos/${repo}/git/commits/${ref.object.sha}`);
const inventory = api(`repos/${repo}/git/trees/${previous.tree.sha}?recursive=1`);
if (inventory.truncated) throw new Error('Remote source inventory is incomplete.');
const remote = new Map(inventory.tree.filter(item => item.type === 'blob').map(item => [item.path, item.sha]));
const changed = manifest.entries.filter(entry => remote.get(entry.path) !== entry.git_blob), tree = [];
let binary = 0;
for (const entry of changed) {
  const bytes = files.get(entry.path);
  if (/\.(?:xlsx|xls|xlsm|pdf)$/i.test(entry.path)) {
    const blob = api(`repos/${repo}/git/blobs`, 'POST', { encoding: 'base64', content: bytes.toString('base64') });
    if (blob.sha !== entry.git_blob) throw new Error('Binary upload checksum mismatch.');
    tree.push({ path: entry.path, mode: '100644', type: 'blob', sha: blob.sha });
    console.log(`Source sync: verified binary ${++binary}.`);
  } else tree.push({ path: entry.path, mode: '100644', type: 'blob', content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
}
let commit = ref.object.sha;
if (tree.length) {
  const nextTree = api(`repos/${repo}/git/trees`, 'POST', { base_tree: previous.tree.sha, tree });
  commit = api(`repos/${repo}/git/commits`, 'POST', { message: 'Refine fund dashboard and sync canonical NAV, documentation and authorized workbooks', tree: nextTree.sha, parents: [ref.object.sha] }).sha;
  api(`repos/${repo}/git/refs/heads/main`, 'PATCH', { sha: commit, force: false });
}
const installed = api(`repos/${repo}/git/trees/${commit}?recursive=1`);
if (installed.truncated) throw new Error('Published source inventory is incomplete.');
const published = new Map(installed.tree.filter(item => item.type === 'blob').map(item => [item.path, item.sha]));
if (manifest.entries.some(entry => published.get(entry.path) !== entry.git_blob)) throw new Error('Published source checksum mismatch.');
const workbooks = manifest.entries.filter(entry => /^基金\/[^/]+\/[^/]+\.(?:xlsx|xls|xlsm)$/i.test(entry.path));
for (const entry of workbooks) {
  const blob = api(`repos/${repo}/git/blobs/${entry.git_blob}`);
  if (sha256(Buffer.from(blob.content.replace(/\s/g, ''), 'base64')) !== entry.sha256) throw new Error('Published workbook SHA-256 mismatch.');
}
const result = { repository: repo, branch: 'main', commit, url: `https://github.com/${repo}/commit/${commit}`, verifiedFiles: manifest.entries.length,
  changedFiles: changed.length, verifiedOriginalWorkbooks: workbooks.length, completedAt: new Date().toISOString() };
await fs.writeFile(path.join(path.dirname(path.resolve(manifestFile)), 'source-sync-result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
