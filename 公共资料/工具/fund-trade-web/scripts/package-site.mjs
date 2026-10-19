// Explicit allowlist: no spreadsheets, private source files, or account logs.
import { cp, mkdir, readdir, readFile, writeFile, lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FUND_CODES } from '../funds.js';
import { createDisciplineSource } from './discipline-source.mjs';
import { validateEncryptedEnvelope, validatePublicNav } from './publish-data.mjs';
const root = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const dist = path.join(root, 'dist');
if (path.dirname(path.resolve(dist)) !== root || path.basename(dist) !== 'dist') throw new Error('Unsafe build target');
try {
  if ((await lstat(dist)).isSymbolicLink()) throw new Error('Build target must not be a link');
  // This exact generated output directory has been resolved and checked above.
  await rm(dist, { recursive: true, force: true });
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const files = ['index.html', 'redesign.css', 'visual-runtime.js', 'ambient-scene.js', 'interface-motion.js', 'vendor/three/three.module.js', 'vendor/three/three.core.js', 'vendor/three/LICENSE.txt', 'vendor/gsap/gsap.min.js', 'vendor/gsap/README.md', 'styles.css', 'app.js', 'funds.js', 'discipline.js', 'discipline-actions.js', 'discipline-sync.js', 'nav-annualized.js', 'region-data.js', 'us-exposure.js', 'holding-duration.js', 'bond-reserve.js', 'bond-model.js', 'bond-store.js', 'bonds-view.js', 'engine.js', 'application-estimates.js', 'vault.js', 'refresh-controller.js', 'transaction-performance.js', 'nav-range.js', 'nav-chart.js', 'nav-display.js', 'nav-estimates.js', 'nav-estimate-store.js', 'estimate-panel.js', 'nav-interaction.js', 'nav-slider.js', 'manifest.webmanifest'];
const expected = new Set(files.concat(['.nojekyll', 'data/discipline.json', 'data/ledger.enc.json', 'data/bonds.enc.json', ...FUND_CODES.map(code => `data/nav/${code}.json`)]));
await mkdir(dist, { recursive: true });
for (const file of files) {
  await mkdir(path.dirname(path.join(dist, file)), { recursive: true });
  await cp(path.join(root, file), path.join(dist, file));
}
for (const directory of ['assets']) {
  await mkdir(path.join(dist, directory), { recursive: true });
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-z0-9-]+\.svg$/.test(entry.name)) throw new Error('Unexpected asset');
    const relative = `${directory}/${entry.name}`;
    expected.add(relative);
    await cp(path.join(root, relative), path.join(dist, relative));
  }
}
await mkdir(path.join(dist, 'data', 'nav'), { recursive: true });
const disciplines = await (await createDisciplineSource({ workspace: path.resolve(root, '../../..') })).snapshot();
if (!disciplines.revision || disciplines.status !== 'valid') throw new Error('Discipline source unavailable');
await writeFile(path.join(dist, 'data', 'discipline.json'), JSON.stringify(disciplines));
for (const name of ['ledger', 'bonds']) {
  const envelope = validateEncryptedEnvelope(JSON.parse(await readFile(path.join(root, 'data', `${name}.enc.json`), 'utf8')));
  await writeFile(path.join(dist, 'data', `${name}.enc.json`), JSON.stringify(envelope));
}
for (const code of FUND_CODES) {
  const data = validatePublicNav(JSON.parse(await readFile(path.join(root, 'data', 'nav', `${code}.json`), 'utf8')), code);
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
