// Public URLs stay stable when physical source files are organized under src/.
// Only this explicit list can be served or packaged; src/ is never a web root.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FUND_CODES } from '../src/funds.js';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKSPACE_ROOT = path.dirname(PROJECT_ROOT);

const sourceFiles = [
  'ambient-scene.js', 'app.js', 'application-estimates.js',
  'bond-holding-duration.js', 'bond-model.js', 'bond-reserve.js', 'bond-store.js', 'bond-transactions.js', 'bonds-view.js',
  'discipline-actions.js', 'discipline-sync.js', 'discipline.js', 'engine.js',
  'edge-navigation.js', 'estimate-panel.js', 'funds.js', 'holding-duration.js', 'interface-motion.js',
  'nav-annualized.js', 'nav-chart.js', 'nav-display.js', 'nav-estimate-store.js',
  'nav-estimates.js', 'nav-interaction.js', 'nav-range.js', 'nav-slider.js',
  'redesign.css', 'refresh-controller.js', 'region-data.js', 'styles.css',
  'transaction-date.js', 'transaction-model.js', 'transaction-performance.js', 'transaction-store.js', 'transaction-view.js',
  'unlock-errors.js', 'us-exposure.js', 'portfolio-allocation.js', 'vault.js', 'viewport-anchor.js', 'visual-runtime.js',
];
const vendorFiles = [
  'vendor/three/three.module.js', 'vendor/three/three.core.js', 'vendor/three/LICENSE.txt',
  'vendor/gsap/gsap.min.js', 'vendor/gsap/README.md',
];

export const STATIC_FILE_SOURCES = Object.freeze(Object.fromEntries([
  ['index.html', 'index.html'], ['manifest.webmanifest', 'manifest.webmanifest'],
  ...sourceFiles.map(file => [file, `src/${file}`]),
  ...vendorFiles.map(file => [file, file]),
]));
export const ACCOUNT_FILES = Object.freeze(['data/ledger.enc.json', 'data/bonds.enc.json']);
export const DATA_FILES = Object.freeze(['data/discipline.json', ...ACCOUNT_FILES, ...FUND_CODES.map(code => `data/nav/${code}.json`)]);
export const DEPLOY_FILES = Object.freeze([...Object.keys(STATIC_FILE_SOURCES), '.nojekyll', ...DATA_FILES]);
export const isPublicAsset = relative => /^assets\/[a-z0-9-]+\.svg$/.test(relative);

export function staticSourcePath(relative) {
  const source = STATIC_FILE_SOURCES[relative];
  if (typeof source !== 'string') return null;
  return path.resolve(PROJECT_ROOT, source);
}
