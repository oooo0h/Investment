// Read-only confirmation of the exact uploaded commit and its public resources.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FUND_CODES } from '../src/funds.js';
import { createPublishLogger, sanitizePublishText } from './publish-log.mjs';
import { classifyGithubFailure } from './publish-diagnostics.mjs';
import { siteTemporaryPath } from './project-paths.mjs';

const repository = 'oooo0h/Investment';
const siteUrl = 'https://oooo0h.github.io/Investment/';
export const VERIFIED_PATHS = Object.freeze(['index.html', 'app.js', 'engine.js', 'styles.css', 'redesign.css',
  'ambient-scene.js', 'visual-runtime.js', 'data/ledger.enc.json', 'data/bonds.enc.json',
  ...FUND_CODES.map(code => `data/nav/${code}.json`)]);
export const gitBlobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

export class DeploymentError extends Error {
  constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}

export async function waitForPagesDeployment({ commit, api, fetchResource,
  now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 300000, intervalMs = 10000, progress = () => {}, record = () => {},
  paths = VERIFIED_PATHS,
} = {}) {
  if (!/^[0-9a-f]{40}$/i.test(commit || '')) throw new DeploymentError('无法识别本次上传版本，尚未确认网站上线。');
  const started = now();
  let expected;
  let lastState = 'queued';
  while (now() - started < timeoutMs) {
    progress(Math.max(0, now() - started));
    try {
      const ref = await api('git/ref/heads/gh-pages');
      if (ref?.object?.sha !== commit) throw new DeploymentError('发布期间出现其他新版本，本次版本的上线确认已停止。');
      const build = await api('pages/builds/latest');
      lastState = build?.commit === commit ? build.status : 'queued';
      record(`上线核验：state=${['queued', 'building', 'built', 'errored'].includes(lastState) ? lastState : 'unknown'}；elapsed=${Math.max(0, now() - started)}ms`);
      if (build?.commit === commit && ['errored', 'error', 'failed'].includes(build.status)) {
        throw new DeploymentError('GitHub 网站构建失败，本次内容尚未确认上线。');
      }
      if (build?.commit === commit && build.status === 'built') {
        if (!expected) {
          const tree = await api(`git/trees/${commit}?recursive=1`);
          if (!Array.isArray(tree?.tree) || tree.truncated) throw new DeploymentError('无法读取完整发布清单，尚未确认网站上线。');
          expected = new Map(tree.tree.filter(item => item.type === 'blob').map(item => [item.path, item.sha]));
          if (!paths.every(file => /^[0-9a-f]{40}$/i.test(expected.get(file) || ''))) {
            throw new DeploymentError('发布版本缺少必要网站文件，本次上线确认失败。');
          }
        }
        const matches = await Promise.all(paths.map(async file => {
          try {
            const bytes = await fetchResource(file, commit);
            return gitBlobHash(bytes) === expected.get(file);
          } catch { return false; }
        }));
        record(`线上文件核验：matched=${matches.filter(Boolean).length}；expected=${paths.length}`);
        if (matches.every(Boolean)) {
          const finalRef = await api('git/ref/heads/gh-pages');
          if (finalRef?.object?.sha !== commit) throw new DeploymentError('核验期间出现其他新版本，本次上线确认已停止。');
          return { commit, status: 'verified', files: paths.length };
        }
        lastState = 'cdn-updating';
      }
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      record('上线核验：暂时无法读取构建状态，将在等待期限内重试。');
    }
    const remaining = timeoutMs - (now() - started);
    if (remaining > 0) await wait(Math.min(intervalMs, remaining));
  }
  record(`上线确认结束：未在等待期限内完成；state=${['queued', 'building', 'built', 'cdn-updating'].includes(lastState) ? lastState : 'unknown'}`);
  throw new DeploymentError('文件已上传，但等待上线确认已超时；网站可能仍在更新，请稍后刷新，暂勿重复发布。', 3);
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const arg = key => process.argv.find(value => value.startsWith(key + '='))?.slice(key.length + 1);
  let logger;
  let progressOpen = false;
  try {
    if (process.argv.slice(2).some(value => !value.startsWith('--commit=') && !value.startsWith('--log-file='))) {
      throw new DeploymentError('上线确认参数无效。');
    }
    const existingLog = arg('--log-file');
    if (existingLog) {
      const log = path.resolve(existingLog);
      if (path.dirname(log) !== siteTemporaryPath(root, 'logs') || !/^publish-\d{8}-\d{6}-\d{3}\.log$/.test(path.basename(log))) {
        throw new DeploymentError('上线确认日志路径无效。');
      }
      logger = { write: message => appendFileSync(log, `[${new Date().toISOString()}] ${sanitizePublishText(message)}\n`, 'utf8') };
    } else logger = createPublishLogger({ root });
    const api = endpoint => {
      const result = spawnSync('gh', ['api', `repos/${repository}/${endpoint}`], {
        encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024,
      });
      if (result.status !== 0) {
        const failure = classifyGithubFailure(result);
        logger.write(`上线状态请求失败：http=${failure.http || 'unknown'}；reason=${failure.category}`);
        if (endpoint === 'pages/builds/latest' && failure.http === '404') return null;
        if (['authentication', 'permission', 'cli-not-found'].includes(failure.category)) {
          throw new DeploymentError('文件已上传，但无法读取上线状态，请检查 GitHub 登录和仓库权限。');
        }
        throw new Error('State request unavailable');
      }
      return JSON.parse(result.stdout);
    };
    const fetchResource = async (file, commit) => {
      const url = new URL(file, siteUrl);
      url.searchParams.set('verify', `${commit}-${Date.now()}`);
      const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'Cache-Control': 'no-cache' } });
      if (!response.ok) throw new Error('Resource not ready');
      return Buffer.from(await response.arrayBuffer());
    };
    let lastPrinted = -10000;
    const progress = elapsed => {
      const seconds = Math.floor(elapsed / 1000);
      const clock = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      const message = `      等待网站更新 ${clock} / 最长 05:00，请勿关闭窗口。`;
      if (process.stdout.isTTY) { process.stdout.write('\r' + message); progressOpen = true; }
      else if (elapsed - lastPrinted >= 10000) { console.log(message); lastPrinted = elapsed; }
    };
    await waitForPagesDeployment({ commit: arg('--commit'), api, fetchResource, progress, record: message => logger.write(message) });
    if (progressOpen) { process.stdout.write('\n'); progressOpen = false; }
    logger.write('上线确认通过：本次提交已构建，必要线上文件内容一致。');
    console.log('      本次版本已上线，页面和数据文件均已核对。');
    return 0;
  } catch (error) {
    if (progressOpen) process.stdout.write('\n');
    const message = error instanceof DeploymentError ? error.message : '上线确认暂不可用，请查看详细日志。';
    try { logger?.write(message); } catch { /* Never disclose raw errors or response content. */ }
    console.log(`      ${message}`);
    return error instanceof DeploymentError ? error.exitCode : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
