import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForPagesDeployment, gitBlobHash, DeploymentError } from '../scripts/verify-pages.mjs';

const commit = 'a'.repeat(40), other = 'b'.repeat(40);
const paths = ['index.html', 'app.js'];
const bytes = Buffer.from('synthetic public resource');
function fixture(overrides = {}) {
  let clock = 0, polls = 0;
  const seen = [];
  const settings = {
    commit, paths, now: () => clock, timeoutMs: 30, intervalMs: 10,
    wait: async ms => { clock += ms; },
    fetchResource: async () => bytes,
    api: async endpoint => {
      seen.push(endpoint);
      if (endpoint === 'git/ref/heads/gh-pages') return { object: { sha: commit } };
      if (endpoint === 'pages/builds/latest') { polls++; return { commit, status: 'built' }; }
      if (endpoint.startsWith('git/trees/')) return { tree: paths.map(path => ({ path, type: 'blob', sha: gitBlobHash(bytes) })) };
      throw new Error('Unexpected synthetic endpoint');
    }, ...overrides,
  };
  return { run: () => waitForPagesDeployment(settings), settings, seen, polls: () => polls };
}

test('success requires the exact commit, completed build, and matching public bytes', async () => {
  const f = fixture();
  assert.equal((await f.run()).status, 'verified');
  assert.equal(f.seen.filter(value => value === 'git/ref/heads/gh-pages').length, 2);
});
test('an old successful build cannot certify a newly uploaded version', async () => {
  const f = fixture();
  const original = f.settings.api;
  f.settings.api = async endpoint => endpoint === 'pages/builds/latest' ? { commit: other, status: 'built' } : original(endpoint);
  await assert.rejects(f.run, error => error instanceof DeploymentError && error.exitCode === 3);
});
test('queued and building states wait until the matching build completes', async () => {
  const f = fixture(); let round = 0;
  const original = f.settings.api;
  f.settings.api = async endpoint => endpoint === 'pages/builds/latest' ? { commit, status: ['queued', 'building', 'built'][round++] } : original(endpoint);
  assert.equal((await f.run()).status, 'verified');
  assert.equal(round, 3);
});
test('a stale CDN response must match before success', async () => {
  let attempt = 0;
  const f = fixture({ fetchResource: async () => ++attempt <= paths.length ? Buffer.from('older public resource') : bytes });
  assert.equal((await f.run()).status, 'verified');
  assert.equal(attempt, 4);
});
test('wrong public bytes time out without claiming publication success', async () => {
  const f = fixture({ fetchResource: async () => Buffer.from('old') });
  await assert.rejects(f.run, error => error.exitCode === 3);
});
test('a failed matching build stops immediately', async () => {
  const f = fixture(); const original = f.settings.api;
  f.settings.api = async endpoint => endpoint === 'pages/builds/latest' ? { commit, status: 'errored' } : original(endpoint);
  await assert.rejects(f.run, /构建失败/);
});
test('a concurrent deployment cannot be mistaken for this deployment', async () => {
  const f = fixture(); const original = f.settings.api; let calls = 0;
  f.settings.api = async endpoint => endpoint === 'git/ref/heads/gh-pages' && ++calls === 2 ? { object: { sha: other } } : original(endpoint);
  await assert.rejects(f.run, /其他新版本/);
});
test('a missing required resource fails even when the build is successful', async () => {
  const f = fixture(); const original = f.settings.api;
  f.settings.api = async endpoint => endpoint.startsWith('git/trees/') ? { tree: [] } : original(endpoint);
  await assert.rejects(f.run, /缺少必要网站文件/);
});
