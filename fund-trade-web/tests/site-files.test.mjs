import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECT_ROOT, WORKSPACE_ROOT, STATIC_FILE_SOURCES, ACCOUNT_FILES,
  DEPLOY_FILES, staticSourcePath, isPublicAsset,
} from '../scripts/site-files.mjs';

test('the relocated project resolves its workspace and all src modules through stable public URLs', async () => {
  const expectedProject = fileURLToPath(new URL('..', import.meta.url));
  assert.equal(PROJECT_ROOT, path.resolve(expectedProject));
  assert.equal(WORKSPACE_ROOT, path.dirname(PROJECT_ROOT));
  const sourceFiles = (await readdir(path.join(PROJECT_ROOT, 'src'))).filter(file => /\.(?:js|css)$/.test(file));
  assert.deepEqual(Object.values(STATIC_FILE_SOURCES).filter(file => file.startsWith('src/')).sort(), sourceFiles.map(file => `src/${file}`).sort());
  for (const file of sourceFiles) {
    assert.equal(STATIC_FILE_SOURCES[file], `src/${file}`);
    assert.equal(staticSourcePath(file), path.join(PROJECT_ROOT, 'src', file));
    await access(staticSourcePath(file));
  }
  for (const file of ['index.html', 'manifest.webmanifest', 'vendor/three/three.module.js', 'vendor/three/three.core.js', 'vendor/gsap/gsap.min.js']) {
    assert.equal(STATIC_FILE_SOURCES[file], file);
    await access(staticSourcePath(file));
  }
});

test('the static allowlist rejects source, project, private, and traversal URLs', () => {
  for (const file of [
    'src/app.js', 'src/engine.js', 'src/', '../src/app.js', '../交易纪律.md',
    'README.md', 'package.json', '.git/config', 'portfolio-state.json',
    'scripts/serve.mjs', 'tests/site-files.test.mjs', 'tmp/report.json',
    'data/ledger.enc.json', 'data/bonds.enc.json', 'data/unknown.enc.json',
    'constructor', '__proto__',
  ]) assert.equal(staticSourcePath(file), null, file);
  assert.equal(isPublicAsset('assets/fund-symbol.svg'), true);
  for (const file of ['assets/../app.js', 'assets/raw.json', 'assets/sub/icon.svg', '../assets/icon.svg', 'src/icon.svg']) {
    assert.equal(isPublicAsset(file), false, file);
  }
});

test('deployment uses public URLs and only the two explicit encrypted account paths', () => {
  for (const file of Object.keys(STATIC_FILE_SOURCES)) assert.ok(DEPLOY_FILES.includes(file), file);
  for (const file of ['index.html', 'app.js', 'styles.css', 'redesign.css', 'manifest.webmanifest', '.nojekyll', 'data/discipline.json']) {
    assert.ok(DEPLOY_FILES.includes(file), file);
  }
  assert.deepEqual(ACCOUNT_FILES, ['data/ledger.enc.json', 'data/bonds.enc.json']);
  assert.deepEqual(DEPLOY_FILES.filter(file => /\.enc(?:\.json)?$/.test(file)).sort(), [...ACCOUNT_FILES].sort());
  assert.equal(new Set(DEPLOY_FILES).size, DEPLOY_FILES.length);
  assert.ok(DEPLOY_FILES.every(file => !/^(?:src|scripts|tests|tmp)\//.test(file) && !file.startsWith('../')));
});
