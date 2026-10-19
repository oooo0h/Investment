import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** Defense in depth for our own messages. Child output also requires an allowlist below. */
export function sanitizePublishText(value) {
  return String(value ?? '')
    .split(/\r?\n/).map(line => /\b(?:token|password|passwd|secret|authorization|device[_ -]?code|user[_ -]?code|account[_ -]?payload|ciphertext|access[_ -]?token|refresh[_ -]?token)\b\s*["']?\s*[:=]/i.test(line) ? '[REDACTED sensitive content]' : line).join('\n')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '[REDACTED]')
    .replace(/\b(?:token|password|passwd|secret|authorization|device[_ -]?code|user[_ -]?code|account[_ -]?payload|ciphertext|access[_ -]?token|refresh[_ -]?token)\b\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[REDACTED]')
    .replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, '[REDACTED]')
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi, 'https://[REDACTED]@')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function bjtParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}
export function publishLogName(date) {
  const value = bjtParts(date);
  return `publish-${value.year}${value.month}${value.day}-${value.hour}${value.minute}${value.second}-${String(date.getUTCMilliseconds()).padStart(3, '0')}.log`;
}
export function createPublishLogger({ root, now = () => new Date() }) {
  const directory = path.join(root, 'tmp', 'logs');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, publishLogName(now()));
  appendFileSync(file, '', 'utf8');
  return {
    file,
    write(message) {
      const date = now();
      const value = bjtParts(date);
      const timestamp = `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}.${String(date.getUTCMilliseconds()).padStart(3, '0')} +08:00`;
      appendFileSync(file, `[${timestamp}] ${sanitizePublishText(message)}\n`, 'utf8');
    },
  };
}

const knownErrors = new Set([
  'Unsafe build target', 'Build target must not be a link', 'Unexpected asset',
  'Discipline source unavailable', 'Unexpected deploy artifact', 'Invalid publish data.',
  'Publish input must not contain links', 'Publish input is outside the site allowlist',
  'Publish input is incomplete', 'An initial account deployment needs explicit authorization',
  'Unknown publish option',
  'Account data preparation failed.', 'Account data rollback failed.',
]);
/** Never persist arbitrary child output: JSON parse excerpts can contain account ciphertext. */
export function safeChildDiagnostics(stdout = '', stderr = '') {
  const result = [];
  let omitted = 0;
  for (const raw of `${stdout || ''}\n${stderr || ''}`.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^Packaged \d+ static files\. Account data is encrypted\.$/.test(line)
      || /^\[Prepare\] (?:Stage (?:source-read|source-validation|stage-envelopes|replace-envelopes|rollback-envelopes|temporary-cleanup): (?:started|complete|failed)\.|Validated 6 workbook sources; encryptedFiles=2; mode=(?:check|refresh)\.|Encrypted snapshots refreshed: files=2\.)$/.test(line)
      || /^\[Publish\] Validated \d+ files; upload=\d+; accountData=(?:preserved remotely|explicitly included)\.$/.test(line)
      || /^\[Publish\] GitHub (?:GET|POST|PATCH|PUT|DELETE) repos\/oooo0h\/Investment\/(?:git\/(?:ref\/heads\/gh-pages|commits(?:\/[a-f0-9]{7,64})?|trees|refs(?:\/heads\/gh-pages)?)|pages): (?:started|complete|exit=(?:\d+|unavailable)|http=(?:\d{3}|unknown)|reason=(?:cli-not-found|authentication|rate-limit|permission|network-timeout|network|not-found|request-failed)|duration=\d+ms)(?:[,; ]+(?:exit=(?:\d+|unavailable)|http=(?:\d{3}|unknown)|reason=(?:cli-not-found|authentication|rate-limit|permission|network-timeout|network|not-found|request-failed)|duration=\d+ms))*$/.test(line)) {
      result.push(sanitizePublishText(line));
      continue;
    }
    // The final publish JSON is read in memory by the caller, never copied to logs.
    if (line.startsWith('{')) { omitted++; continue; }
    const error = /^(\w*Error):\s*(.*)$/.exec(line);
    if (error) {
      const name = ['Error', 'SyntaxError', 'TypeError', 'RangeError', 'ReferenceError'].includes(error[1]) ? error[1] : 'Error';
      const code = /\b(ENOENT|EACCES|EPERM|ENOSPC|ETIMEDOUT|ENOBUFS)\b/.exec(error[2])?.[1];
      result.push(`${name}: ${knownErrors.has(error[2]) ? error[2] : code ? `系统错误 ${code}` : '子进程错误（具体内容因隐私保护省略）'}`);
      continue;
    }
    const frame = /^(?:at .*|file:\/\/\/.*)[/\\]([a-zA-Z0-9_.-]+\.(?:mjs|cjs|js)):(\d+)(?::(\d+))?\)?$/.exec(line);
    if (frame) { result.push(`位置：${frame[1]}:${frame[2]}${frame[3] ? `:${frame[3]}` : ''}`); continue; }
    omitted++;
  }
  if (omitted) result.push(`已省略 ${omitted} 行未列入安全格式的子进程输出。`);
  return result;
}
