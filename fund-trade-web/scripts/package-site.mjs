// Explicit allowlist: no spreadsheets, private source files, or account logs.
import { cp, mkdir, readdir, readFile, writeFile, lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { FUND_CODES } from '../src/funds.js';
import { createDisciplineSource } from './discipline-source.mjs';
import { createLiveDataStore } from './live-data.mjs';
import { validateEncryptedEnvelope, validatePublicNav } from './publish-data.mjs';
import { STATIC_FILE_SOURCES, DEPLOY_FILES, WORKSPACE_ROOT, staticSourcePath, isPublicAsset } from './site-files.mjs';
import { syncLocalSources } from './local-bundle.mjs';
import { siteTemporaryPath } from './project-paths.mjs';
const root = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
await syncLocalSources({ workspace: WORKSPACE_ROOT, root });
const dist = siteTemporaryPath(root, 'dist');
if (path.resolve(dist) !== path.resolve(WORKSPACE_ROOT, '临时文件', path.basename(root), 'dist')) throw new Error('Unsafe build target');
try {
  if ((await lstat(dist)).isSymbolicLink()) throw new Error('Build target must not be a link');
  // This exact generated output directory has been resolved and checked above.
  await rm(dist, { recursive: true, force: true });
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const files = Object.keys(STATIC_FILE_SOURCES);
const expected = new Set(DEPLOY_FILES);
const current = await (await createLiveDataStore({ workspace: WORKSPACE_ROOT, root,
  pythonPath: process.env.FUND_PREVIEW_PYTHON || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe') })).snapshot();
await mkdir(dist, { recursive: true });
for (const file of files) {
  await mkdir(path.dirname(path.join(dist, file)), { recursive: true });
  await cp(staticSourcePath(file), path.join(dist, file));
}
for (const directory of ['assets']) {
  await mkdir(path.join(dist, directory), { recursive: true });
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (!entry.isFile() || !isPublicAsset(`${directory}/${entry.name}`)) throw new Error('Unexpected asset');
    const relative = `${directory}/${entry.name}`;
    expected.add(relative);
    await cp(path.join(root, relative), path.join(dist, relative));
  }
}
await mkdir(path.join(dist, 'data', 'nav'), { recursive: true });
const disciplines = await (await createDisciplineSource({ workspace: WORKSPACE_ROOT, root })).snapshot();
if (!disciplines.revision || disciplines.status !== 'valid') throw new Error('Discipline source unavailable');
await writeFile(path.join(dist, 'data', 'discipline.json'), JSON.stringify(disciplines));
for (const name of ['ledger', 'bonds']) {
  const envelope = validateEncryptedEnvelope(JSON.parse(await readFile(path.join(root, 'data', `${name}.enc.json`), 'utf8')));
  await writeFile(path.join(dist, 'data', `${name}.enc.json`), JSON.stringify(envelope));
}
for (const code of FUND_CODES) {
  const data = validatePublicNav(current.nav[code], code);
  await writeFile(path.join(dist, 'data', 'nav', `${code}.json`), JSON.stringify(data));
}
await writeFile(path.join(dist, '.nojekyll'), '');
const paths = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else paths.push(path.relative(dist, target).replaceAll('\\', '/'));
  }
}
await walk(dist);
if (paths.length !== expected.size || paths.some(file => !expected.has(file))) throw new Error('Unexpected deploy artifact');
console.log(`Packaged ${paths.length} static files. Account data is encrypted.`);
