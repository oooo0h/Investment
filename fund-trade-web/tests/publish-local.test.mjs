import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPublishWorkflow } from '../scripts/publish-local.mjs';
import { createPublishLogger, publishLogName, safeChildDiagnostics, sanitizePublishText } from '../scripts/publish-log.mjs';

const success = extra => ({ status: 0, stdout: '', stderr: '', ...extra });
const publication = JSON.stringify({ commit: 'a'.repeat(40), url: 'https://oooo0h.github.io/Investment/', accountData: 'preserved' });
function harness({ response, args = [], env = { PATH: 'test-path' }, exists = () => false, logger } = {}) {
  const calls = [], records = [], output = [];
  let ticks = Date.parse('2026-10-19T00:00:00Z');
  const runner = (command, commandArgs, options) => {
    const call = { command, args: [...commandArgs], options: { ...options, env: { ...options.env } } };
    calls.push(call);
    const custom = response?.(call, calls);
    if (custom !== undefined) return custom;
    if (commandArgs[0] === '--version') return success({ stdout: 'gh version 2.81.0 (2025-09-29)\nhttps://github.com/cli/cli/releases' });
    if (commandArgs[0].endsWith('prepare-account-data.mjs')) return success({ stdout: `[Prepare] Validated 6 workbook sources; encryptedFiles=2; mode=${commandArgs.includes('--check') ? 'check' : 'refresh'}.` });
    if (commandArgs[0].endsWith('package-site.mjs')) return success({ stdout: 'Packaged 45 static files. Account data is encrypted.' });
    if (commandArgs[0].endsWith('publish-pages.mjs')) return success({ stdout: publication, stderr: '[Publish] Validated 45 files; upload=43; accountData=preserved remotely.\n[Publish] GitHub GET repos/oooo0h/Investment/pages: complete, exit=0, duration=12ms' });
    return success();
  };
  const result = runPublishWorkflow({ args, root: path.resolve('synthetic-publish-root'), runner, env, exists,
    now: () => new Date(ticks += 7), nodeExecutable: 'synthetic-node', nodeVersion: 'v24.16.0',
    logger: logger || { file: path.resolve('synthetic-publish.log'), write: message => records.push(sanitizePublishText(message)) },
    output: message => output.push(message),
  });
  return { result, calls, records, output, text: [...records, ...output].join('\n') };
}
const isAuth = call => call.args[0] === 'auth' && call.args[1] === 'status';
const isLogin = call => call.args[0] === 'auth' && call.args[1] === 'login';
const isBuild = call => call.args[0].endsWith('package-site.mjs');
const isPublish = call => call.args[0].endsWith('publish-pages.mjs');
const isPrepare = call => call.args[0].endsWith('prepare-account-data.mjs');

test('valid authentication builds and publishes without opening web login', () => {
  const run = harness();
  assert.equal(run.result.exitCode, 0);
  assert.equal(run.calls.filter(isAuth).length, 1);
  assert.equal(run.calls.filter(isLogin).length, 0);
  assert.equal(run.calls.filter(isBuild).length, 1);
  assert.equal(run.calls.filter(isPublish).length, 1);
  assert.equal(run.calls.filter(isPrepare).length, 1);
  assert.deepEqual(run.calls.find(isPublish).args.slice(1), ['--include-account-data']);
  assert.ok(run.calls.findIndex(isPrepare) < run.calls.findIndex(isBuild));
  assert.match(run.text, /账户密文：已从六份表格刷新并上传/);
  assert.match(run.text, /Node.js：v24.16.0/);
  assert.match(run.text, /GitHub CLI：2.81.0/);
  assert.match(run.text, /阶段完成：发布到 GitHub Pages；exit=0；duration=\d+ms/);
  assert.match(run.text, /本次上传提交：a{40}/);
  assert.match(run.output[0], /基金账本.*发布网站/);
});

test('failed auth opens inherited web login, rechecks status, then continues', () => {
  let statusCalls = 0;
  const run = harness({ response(call) {
    if (isAuth(call) && ++statusCalls === 1) return { status: 1, stderr: 'PRIVATE_AUTH_OUTPUT' };
    if (isLogin(call)) return success({ stdout: 'DEVICE_LOGIN_PRIVATE_OUTPUT', stderr: 'ABCD-EFGH' });
  } });
  assert.equal(run.result.exitCode, 0);
  assert.equal(run.calls.filter(isAuth).length, 2);
  const login = run.calls.find(isLogin);
  assert.deepEqual(login.args, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web']);
  assert.equal(login.options.stdio, 'inherit');
  assert.equal(login.options.windowsHide, false);
  assert.equal(login.options.encoding, undefined);
  assert.equal(run.calls.filter(isAuth).every(call => call.options.stdio === 'ignore'), true);
  assert.ok(run.calls.findIndex(isLogin) < run.calls.findIndex(isBuild));
  assert.doesNotMatch(run.text, /PRIVATE|ABCD-EFGH/);
});

test('invalid environment tokens are removed only from the recovery process environment', () => {
  const env = { PATH: 'initial', GH_TOKEN: 'ghp_SYNTHETIC_ENV_TOKEN', GITHUB_TOKEN: 'github_pat_SYNTHETIC_ENV_TOKEN' };
  let statusCalls = 0;
  const run = harness({ env, response(call) { if (isAuth(call) && ++statusCalls === 1) return { status: 1 }; } });
  assert.equal(run.result.exitCode, 0);
  assert.equal(run.calls.find(isAuth).options.env.GH_TOKEN, env.GH_TOKEN);
  for (const call of run.calls.slice(run.calls.findIndex(isLogin))) {
    assert.equal(Object.hasOwn(call.options.env, 'GH_TOKEN'), false);
    assert.equal(Object.hasOwn(call.options.env, 'GITHUB_TOKEN'), false);
  }
  assert.equal(env.GH_TOKEN, 'ghp_SYNTHETIC_ENV_TOKEN');
  assert.equal(env.GITHUB_TOKEN, 'github_pat_SYNTHETIC_ENV_TOKEN');
  assert.match(run.text, /全局环境未修改/);
  assert.doesNotMatch(run.text, /SYNTHETIC_ENV_TOKEN/);
});

test('valid environment authentication is retained and never logged', () => {
  const env = { PATH: 'test', GH_TOKEN: 'ghp_SYNTHETIC_ENV_TOKEN' };
  const run = harness({ env });
  assert.equal(run.result.exitCode, 0);
  assert.equal(run.calls.find(isPublish).options.env.GH_TOKEN, env.GH_TOKEN);
  assert.doesNotMatch(run.text, /SYNTHETIC_ENV_TOKEN/);
});

test('cancelled browser login preserves its exit status and stops before building', () => {
  const run = harness({ response(call) {
    if (isAuth(call)) return { status: 1 };
    if (isLogin(call)) return { status: 4 };
  } });
  assert.equal(run.result.exitCode, 4);
  assert.equal(run.calls.some(isBuild), false);
  assert.equal(run.calls.some(isPublish), false);
  assert.match(run.text, /网页登录未完成/);
  assert.match(run.text, /阶段失败：验证 GitHub 登录；exit=4/);
});

test('status must pass again after browser login or workflow fails', () => {
  const run = harness({ response(call) { if (isAuth(call)) return { status: 9 }; } });
  assert.equal(run.result.exitCode, 9);
  assert.equal(run.calls.filter(isLogin).length, 1);
  assert.equal(run.calls.filter(isAuth).length, 2);
  assert.equal(run.calls.some(isBuild), false);
  assert.match(run.text, /认证检查仍未通过/);
});

test('--check recovers authentication and privately validates without changing snapshots, dist or publishing', () => {
  let statuses = 0;
  const run = harness({ args: ['--check'], response(call) { if (isAuth(call) && ++statuses === 1) return { status: 1 }; } });
  assert.equal(run.result.exitCode, 0);
  assert.equal(run.result.checkOnly, true);
  assert.equal(run.calls.filter(isLogin).length, 1);
  assert.equal(run.calls.filter(isPrepare).length, 1);
  assert.deepEqual(run.calls.find(isPrepare).args.slice(1), ['--check']);
  assert.equal(run.calls.filter(isBuild).length, 0);
  assert.equal(run.calls.some(isPublish), false);
  assert.match(run.text, /--check 未修改密文或打包目录，未发布任何内容/);
});

test('--public-only skips workbook preparation and keeps the lower-level public-only publication default', () => {
  const run = harness({ args: ['--public-only'] });
  assert.equal(run.result.exitCode, 0);
  assert.equal(run.calls.some(isPrepare), false);
  assert.equal(run.calls.filter(isBuild).length, 1);
  assert.deepEqual(run.calls.find(isPublish).args.slice(1), []);
  assert.match(run.text, /账户密文：未上传，线上已有文件保持原样/);
});

test('--check --public-only checks access without reading accounts, packaging or publishing', () => {
  const run = harness({ args: ['--check', '--public-only'] });
  assert.equal(run.result.exitCode, 0);
  assert.equal(run.calls.some(isPrepare), false);
  assert.equal(run.calls.some(isBuild), false);
  assert.equal(run.calls.some(isPublish), false);
});

test('workbook preparation failure logs only fixed diagnostics and stops before packaging or publishing', () => {
  const run = harness({ response(call) {
    if (isPrepare(call)) return { status: 6, stdout: '{"funds":"PRIVATE_ACCOUNT_DATA"}', stderr: '[Prepare] Stage source-read: failed.\nError: Account data preparation failed.\nError: PRIVATE_SOURCE_ERROR' };
  } });
  assert.equal(run.result.exitCode, 6);
  assert.equal(run.calls.some(isBuild), false);
  assert.equal(run.calls.some(isPublish), false);
  assert.match(run.text, /Stage source-read: failed/);
  assert.match(run.text, /Account data preparation failed/);
  assert.doesNotMatch(run.text, /PRIVATE_ACCOUNT_DATA|PRIVATE_SOURCE_ERROR/);
});

test('unknown arguments fail with usage exit 2 before any external command', () => {
  const run = harness({ args: ['--include-account-data', 'token=DO_NOT_LOG_ARGUMENT'] });
  assert.equal(run.result.exitCode, 2);
  assert.equal(run.calls.length, 0);
  assert.doesNotMatch(run.text, /DO_NOT_LOG_ARGUMENT/);
});

test('missing GitHub CLI stops and does not misreport expired authentication', () => {
  const run = harness({ response(call) { if (call.args[0] === '--version') return { status: null, error: { code: 'ENOENT', message: 'PRIVATE_ERROR' } }; } });
  assert.equal(run.result.exitCode, 1);
  assert.equal(run.calls.some(isAuth), false);
  assert.equal(run.calls.some(isLogin), false);
  assert.match(run.text, /未找到 GitHub CLI/);
  assert.doesNotMatch(run.text, /PRIVATE_ERROR|登录已失效/);
});

test('auth process spawn errors stop instead of starting browser authentication', () => {
  const run = harness({ response(call) { if (isAuth(call)) return { status: null, error: { code: 'EACCES', message: 'PRIVATE_ERROR' } }; } });
  assert.equal(run.result.exitCode, 1);
  assert.equal(run.calls.some(isLogin), false);
  assert.match(run.text, /error=EACCES/);
  assert.doesNotMatch(run.text, /PRIVATE_ERROR|登录已失效/);
});

test('repository access failure retains its exit code and never packages', () => {
  const run = harness({ response(call) { if (call.args[0] === 'api') return { status: 5, stdout: 'PRIVATE_REPO_RESPONSE', stderr: 'PRIVATE_REPO_ERROR (HTTP 403)' }; } });
  assert.equal(run.result.exitCode, 5);
  assert.equal(run.calls.some(isBuild), false);
  assert.doesNotMatch(run.text, /PRIVATE_REPO/);
  assert.match(run.text, /http=403；reason=permission/);
});

test('build failure retains code, safe stack position, and prevents publishing', () => {
  const run = harness({ response(call) {
    if (isBuild(call)) return { status: 7, stderr: 'file:///synthetic/scripts/package-site.mjs:45\nJSON.parse(PRIVATE_ACCOUNT_PAYLOAD)\nSyntaxError: Unexpected token at PRIVATE_ACCOUNT_PAYLOAD\n    at file:///synthetic/scripts/package-site.mjs:45:12\n' };
  } });
  assert.equal(run.result.exitCode, 7);
  assert.equal(run.calls.some(isPublish), false);
  assert.match(run.text, /SyntaxError: 子进程错误/);
  assert.match(run.text, /位置：package-site.mjs:45:12/);
  assert.doesNotMatch(run.text, /PRIVATE_ACCOUNT_PAYLOAD|JSON.parse/);
});

test('publish failure keeps safe GitHub diagnostics and original exit status', () => {
  const run = harness({ response(call) {
    if (isPublish(call)) return { status: 8, stdout: '{"accountPayload":"PRIVATE_BODY"}', stderr: '[Publish] GitHub POST repos/oooo0h/Investment/git/trees: exit=8, http=403, reason=permission, duration=42ms\nError: PRIVATE_ERROR' };
  } });
  assert.equal(run.result.exitCode, 8);
  assert.match(run.text, /http=403, reason=permission, duration=42ms/);
  assert.match(run.text, /阶段失败：发布到 GitHub Pages；exit=8/);
  assert.doesNotMatch(run.text, /PRIVATE_BODY|PRIVATE_ERROR/);
});

test('interrupted process uses a meaningful signal exit code', () => {
  const run = harness({ response(call) { if (isBuild(call)) return { status: null, signal: 'SIGINT' }; } });
  assert.equal(run.result.exitCode, 130);
  assert.match(run.text, /signal=SIGINT/);
  assert.equal(run.calls.some(isPublish), false);
});

test('runner exceptions are visible as safe failures without raw exception text', () => {
  const run = harness({ response(call) { if (isBuild(call)) throw Object.assign(new Error('password=SYNTHETIC_SECRET'), { code: 'ENOENT' }); } });
  assert.equal(run.result.exitCode, 1);
  assert.match(run.text, /error=ENOENT/);
  assert.doesNotMatch(run.text, /SYNTHETIC_SECRET/);
});

test('an unwritable log stops before running external commands', () => {
  const run = harness({ logger: { file: '/synthetic/blocked.log', write() { throw new Error('ENOSPC PRIVATE'); } } });
  assert.equal(run.result.exitCode, 1);
  assert.equal(run.calls.length, 0);
  assert.match(run.output.join('\n'), /日志无法写入/);
  assert.doesNotMatch(run.output.join('\n'), /PRIVATE/);
});

test('fallback gh directory is added only to the child environment', () => {
  const env = { PATH: 'initial', ProgramFiles: path.resolve('synthetic-programs') };
  const run = harness({ env, exists: () => true, response(call) {
    if (call.command === 'gh' && call.args[0] === '--version') return { status: null, error: { code: 'ENOENT' } };
  } });
  assert.equal(run.result.exitCode, 0);
  const auth = run.calls.find(isAuth);
  assert.equal(auth.options.env.PATH, `${path.dirname(auth.command)}${path.delimiter}initial`);
  assert.equal(env.PATH, 'initial');
  assert.equal(run.calls.find(isPublish).options.env.PATH, auth.options.env.PATH);
});

test('publish metadata never forwards unknown JSON fields or untrusted URLs', () => {
  const run = harness({ response(call) { if (isPublish(call)) return success({ stdout: JSON.stringify({ commit: 'a'.repeat(40), url: 'https://example.com/PRIVATE_URL', token: 'ghp_SYNTHETIC_SECRET', accountPayload: { amount: 'PRIVATE_AMOUNT' } }) }); } });
  assert.equal(run.result.exitCode, 0);
  assert.match(run.text, /https:\/\/oooo0h.github.io\/Investment\//);
  assert.doesNotMatch(run.text, /PRIVATE_|SYNTHETIC_SECRET|example.com/);
});

test('child diagnostics allow only fixed public diagnostics and safe locations', () => {
  const diagnostics = safeChildDiagnostics('Packaged 45 static files. Account data is encrypted.\n{"ciphertext":"PRIVATE_CIPHERTEXT"}', [
    '[Publish] Validated 45 files; upload=43; accountData=preserved remotely.',
    '[Publish] GitHub GET repos/oooo0h/Investment/git/ref/heads/gh-pages: started',
    '[Publish] GitHub GET repos/oooo0h/Investment/pages: complete, exit=0, duration=10ms',
    '[Publish] GitHub GET repos/oooo0h/Investment/pages: exit=unavailable, http=unknown, reason=network-timeout, duration=10ms',
    'Error: Invalid publish data.',
    'Error: ENOENT PRIVATE_FILESYSTEM_PATH',
    'password=SYNTHETIC_SECRET',
    'deviceCode=ABCD-EFGH',
    'Unexpected token PRIVATE_PARSE_EXCERPT',
  ].join('\n')).join('\n');
  assert.match(diagnostics, /Packaged 45/);
  assert.match(diagnostics, /Validated 45/);
  assert.match(diagnostics, /http=unknown, reason=network-timeout/);
  assert.match(diagnostics, /Invalid publish data\./);
  assert.match(diagnostics, /系统错误 ENOENT/);
  assert.doesNotMatch(diagnostics, /PRIVATE_|SYNTHETIC_SECRET|ABCD-EFGH/);
});

test('preparation diagnostics expose only workbook counts and fixed stages', () => {
  const diagnostics = safeChildDiagnostics([
    '[Prepare] Stage source-validation: complete.',
    '[Prepare] Validated 6 workbook sources; encryptedFiles=2; mode=refresh.',
    '[Prepare] Encrypted snapshots refreshed: files=2.',
    '[Prepare] PRIVATE_ACCOUNT_DETAILS',
    '{"funds":"PRIVATE_ACCOUNT_PAYLOAD"}',
  ].join('\n')).join('\n');
  assert.match(diagnostics, /Validated 6 workbook sources/);
  assert.match(diagnostics, /Stage source-validation: complete/);
  assert.match(diagnostics, /snapshots refreshed/);
  assert.doesNotMatch(diagnostics, /PRIVATE_ACCOUNT/);
});

test('publish logs use Beijing date even when the UTC calendar date differs', () => {
  assert.equal(publishLogName(new Date('2026-10-18T16:02:03.004Z')), 'publish-20261019-000203-004.log');
});

test('logger creates the centralized file and strips credentials before writing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fund-publish-log-test-'));
  try {
    const logger = createPublishLogger({ root, now: () => new Date('2026-10-18T16:02:03.004Z') });
    assert.equal(logger.file, path.join(path.dirname(root), '临时文件', path.basename(root), 'logs', 'publish-20261019-000203-004.log'));
    logger.write('阶段开始：验证 GitHub 登录');
    logger.write('password=SYNTHETIC_PASSWORD accountPayload={"amount":"PRIVATE_AMOUNT","cash":"PRIVATE_CASH"}');
    logger.write('ghp_SYNTHETIC_ACCESS_TOKEN github_pat_SYNTHETIC_TOKEN Bearer SYNTHETIC_BEARER ABCD-EFGH');
    const text = readFileSync(logger.file, 'utf8');
    assert.match(text, /2026-10-19 00:02:03.004 \+08:00/);
    assert.match(text, /阶段开始：验证 GitHub 登录/);
    assert.doesNotMatch(text, /SYNTHETIC_|PRIVATE_|ABCD-EFGH/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows launcher keeps pause and the Node process exit status', () => {
  const script = readFileSync(new URL('../一键发布到GitHub Pages.cmd', import.meta.url), 'utf8');
  assert.match(script, /publish-local\.mjs" %\*/);
  assert.match(script, /set "RESULT=%ERRORLEVEL%"/);
  assert.match(script, /pause >nul/);
  assert.match(script, /exit \/b %RESULT%/);
  assert.match(script, /本次操作已结束/);
  assert.match(script, /按任意键关闭/);
  assert.doesNotMatch(script, /publish-local\.mjs[^\r\n]*[12]?>/);
});

test('console shows numbered stages and final success while technical diagnostics stay in the log', () => {
  const run = harness();
  const consoleText = run.output.join('\n');
  for (let step = 1; step <= 7; step++) assert.match(consoleText, new RegExp(`\\[${step}/7\\]`));
  assert.match(consoleText, /发布成功/);
  assert.match(consoleText, /本次版本已上线/);
  assert.doesNotMatch(consoleText, /\[Prepare\]|\[Publish\]|GitHub GET|duration=|已省略|Node\.js/);
  assert.match(run.records.join('\n'), /\[Publish\] GitHub GET/);
  const verification = run.calls.find(call => call.args[0].endsWith('verify-pages.mjs'));
  assert.ok(verification);
  assert.equal(verification.options.stdio[1], 'inherit');
});

test('check-only completion cannot be mistaken for publication success', () => {
  const run = harness({ args: ['--check'] });
  assert.match(run.output.join('\n'), /\[4\/4\]/);
  assert.match(run.output.join('\n'), /检查完成/);
  assert.doesNotMatch(run.output.join('\n'), /发布成功/);
});

test('deployment verification timeout reports uploaded but unconfirmed instead of success', () => {
  const run = harness({ response(call) {
    if (call.args[0].endsWith('verify-pages.mjs')) return { status: 3 };
  } });
  assert.equal(run.result.exitCode, 3);
  assert.match(run.output.join('\n'), /尚未确认上线/);
  assert.match(run.output.join('\n'), /\[7\/7\]/);
  assert.doesNotMatch(run.output.join('\n'), /发布成功/);
});

test('missing upload version never reports a successful live deployment', () => {
  const run = harness({ response(call) {
    if (isPublish(call)) return success({ stdout: '{}' });
  } });
  assert.equal(run.result.exitCode, 1);
  assert.match(run.output.join('\n'), /无法识别本次版本/);
  assert.doesNotMatch(run.output.join('\n'), /发布成功/);
});
