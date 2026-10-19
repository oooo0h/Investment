/** Summarize CLI failures without returning provider bodies or credentials. */
export function classifyGithubFailure(result = {}) {
  const diagnostic = String(result.stderr || '') + String(result.stdout || '');
  const http = /\bHTTP\s+(\d{3})\b/i.exec(diagnostic)?.[1] || null;
  const category = result.error?.code === 'ENOENT' ? 'cli-not-found'
    : /bad credentials|authentication|not logged/i.test(diagnostic) || http === '401' ? 'authentication'
      : /rate limit/i.test(diagnostic) || http === '429' ? 'rate-limit'
        : /forbidden|resource not accessible/i.test(diagnostic) || http === '403' ? 'permission'
          : /timeout|timed out|TLS handshake|ETIMEDOUT/i.test(diagnostic) ? 'network-timeout'
            : /connect|ENOTFOUND|resolve host|network/i.test(diagnostic) ? 'network'
              : http === '404' ? 'not-found' : 'request-failed';
  return { http, category };
}
