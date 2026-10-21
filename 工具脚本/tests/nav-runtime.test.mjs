import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveArtifactTool } from '../nav_runtime.mjs';

const missing = () => { throw Object.assign(new Error(), { code: 'MODULE_NOT_FOUND' }); };
test('explicit dependencies on another drive take precedence and preserve spaces', () => {
  const modules = path.resolve('D:/Shared Tools/node_modules'), calls = [];
  const result = resolveArtifactTool({ root: path.resolve('E:/Moved Project'), home: path.resolve('D:/Another User'), env: { FUND_NAV_NODE_MODULES: modules },
    resolve(base) { calls.push(base); return path.join(base, 'node_modules/@oai/artifact-tool/index.mjs'); } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0], path.dirname(modules));
  assert.ok(result.includes('Shared Tools'));
});
test('cleared temporary links do not prevent automatic bundled discovery', () => {
  const home = path.resolve('D:/Another User'), calls = [];
  const expected = path.join(home, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node');
  assert.equal(resolveArtifactTool({ root: path.resolve('E:/Moved Project'), home, env: {}, resolve(base) { calls.push(base); if (base === expected) return 'bundled-tool'; return missing(); } }), 'bundled-tool');
  assert.deepEqual(calls, [expected]);
});
test('non-Codex device uses standard resolution or gives an actionable missing dependency error', () => {
  const root = path.resolve('E:/Moved Project'), calls = [];
  assert.equal(resolveArtifactTool({ root, home: path.resolve('D:/Another User'), env: {}, resolve(base) { calls.push(base); return base === root ? 'system-tool' : missing(); } }), 'system-tool');
  assert.equal(calls.at(-1), root);
  assert.throws(() => resolveArtifactTool({ root, home: path.resolve('D:/Another User'), env: {}, resolve: missing }), /FUND_NAV_NODE_MODULES/);
});
