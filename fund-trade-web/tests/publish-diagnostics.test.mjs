import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGithubFailure } from '../scripts/publish-diagnostics.mjs';

test('GitHub diagnostics identify authentication, permission and missing resources', () => {
  for (const [status, category] of [['401', 'authentication'], ['403', 'permission'], ['404', 'not-found'], ['429', 'rate-limit']]) {
    assert.deepEqual(classifyGithubFailure({ stderr: `gh: request failed (HTTP ${status})` }), { http: status, category });
  }
});

test('GitHub diagnostics distinguish executable and connection failures', () => {
  assert.deepEqual(classifyGithubFailure({ error: { code: 'ENOENT' } }), { http: null, category: 'cli-not-found' });
  assert.equal(classifyGithubFailure({ stderr: 'TLS handshake timeout' }).category, 'network-timeout');
  assert.equal(classifyGithubFailure({ stderr: 'failed to connect to host' }).category, 'network');
});

test('GitHub diagnostics expose only fixed categories and HTTP codes', () => {
  const result = classifyGithubFailure({ stdout: 'SYNTHETIC_PRIVATE_PAYLOAD_404', stderr: 'token=ghp_SYNTHETIC_SECRET password=EXAMPLE' });
  assert.deepEqual(result, { http: null, category: 'request-failed' });
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC|ghp_|password|token|PAYLOAD/);
});
