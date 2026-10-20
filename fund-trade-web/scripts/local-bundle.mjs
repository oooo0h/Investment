// Keep every website-only input in one folder: fund-trade-web/local/.
// Fund data (NAV archives and workbooks) stays in the fund directories; this
// bundle only mirrors the documents the site itself owns.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL_DIR = path.join(PROJECT_ROOT, 'local');

const SOURCES = Object.freeze([
  ['discipline.md', '交易纪律.md'],
  ['nav-index.json', '公共资料/历史净值/全基金历史净值当前入口.json'],
  ['ledger-metadata.json', 'fund-trade-web/local/ledger-metadata.json'],
  ['bond-metadata.json', 'fund-trade-web/local/bond-metadata.json'],
]);

async function readIfPresent(file) {
  try { return await readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeIfChanged(file, bytes) {
  const existing = await readIfPresent(file);
  if (existing && existing.equals(bytes)) return false;
  await writeFile(file, bytes);
  return true;
}

/** Mirror the workspace copies into local/. Missing sources leave existing copies untouched. */
export async function syncLocalSources({ workspace, root = PROJECT_ROOT } = {}) {
  if (!workspace) throw new Error('Workspace is required.');
  const target = path.join(root, 'local');
  await mkdir(target, { recursive: true });
  const updated = [], kept = [];
  for (const [name, relative] of SOURCES) {
    const bytes = await readIfPresent(path.join(workspace, ...relative.split('/')));
    if (!bytes) { kept.push(name); continue; }
    if (await writeIfChanged(path.join(target, name), bytes)) updated.push(name);
  }
  return { directory: target, updated, kept };
}

export const LOCAL_FILES = Object.freeze({
  discipline: 'local/discipline.md',
  navIndex: 'local/nav-index.json',
  ledgerMetadata: 'local/ledger-metadata.json',
  bondMetadata: 'local/bond-metadata.json',
});

/** Resolve a local file under root, falling back to the legacy workspace copy. */
export async function readLocalFile({ root, workspace, name, legacy }) {
  const candidates = [];
  if (root) candidates.push(path.join(root, ...LOCAL_FILES[name].split('/')));
  if (workspace && legacy) candidates.push(path.join(workspace, ...legacy.split('/')));
  for (const file of candidates) {
    const bytes = await readIfPresent(file);
    if (bytes) return { file, bytes };
  }
  return null;
}
