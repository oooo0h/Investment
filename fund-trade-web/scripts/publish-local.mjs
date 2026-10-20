// One-click publish: workbook snapshots, packaging and authentication recovery.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublishLogger, safeChildDiagnostics, sanitizePublishText } from './publish-log.mjs';
import { classifyGithubFailure } from './publish-diagnostics.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = 'oooo0h/Investment';
const siteUrl = 'https://oooo0h.github.io/Investment/';

class WorkflowError extends Error {
  constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}
function resultCode(result = {}) {
  if (Number.isInteger(result.status) && result.status !== 0) return result.status;
  if (result.signal === 'SIGINT') return 130;
  if (result.signal === 'SIGTERM') return 143;
  return result.error || result.signal || result.status !== 0 ? 1 : 0;
}
function safeErrorCode(error) {
  return /^[A-Z][A-Z0-9_]{0,39}$/.test(error?.code || '') ? error.code : 'RUNNER_ERROR';
}

/** All external commands are injected in tests; importing this module does no work. */
export function runPublishWorkflow({
  args = [], runner = spawnSync, root = defaultRoot, env = process.env,
  nodeExecutable = process.execPath, nodeVersion = process.version,
  exists = existsSync, now = () => new Date(), logger: suppliedLogger,
  output = message => console.log(message),
} = {}) {
  let logger;
  let logWritable = true;
  let stageName = '初始化';
  let step = 0;
  let uploaded = false;
  const checkOnly = args.includes('--check');
  const publicOnly = args.includes('--public-only');
  const totalSteps = checkOnly ? (publicOnly ? 3 : 4) : (publicOnly ? 6 : 7);
  const labels = { '检测 GitHub CLI': '检查运行环境', '验证 GitHub 登录': '确认 GitHub 登录',
    '验证仓库访问': '确认仓库访问权限', '读取并校验六份表格': checkOnly ? '校验 6 只基金交易记录' : '校验交易记录并更新加密数据',
    '生成本地最新版': '生成网站文件', '发布到 GitHub Pages': '上传网站文件', '确认网站上线': '确认网站已更新' };
  const started = now().getTime();
  const environment = { ...env };
  const emit = message => output(sanitizePublishText(message));
  const record = message => {
    try { logger.write(message); }
    catch { logWritable = false; throw new WorkflowError('无法写入发布日志，请检查 ../临时文件/fund-trade-web/logs 的写入权限。'); }
  };
  const line = (message = '') => { record(message); emit(message); };
  const stage = (name, action) => {
    stageName = name;
    step += 1;
    const start = now().getTime();
    line(`[${step}/${totalSteps}] ${labels[name] || name}……`);
    record(`阶段开始：${name}`);
    try {
      const result = action();
      record(`阶段完成：${name}；exit=0；duration=${Math.max(0, now().getTime() - start)}ms`);
      line(`      已完成（${(Math.max(0, now().getTime() - start) / 1000).toFixed(1)} 秒）`);
      return result;
    } catch (error) {
      record(`阶段失败：${name}；exit=${error.exitCode || 1}；duration=${Math.max(0, now().getTime() - start)}ms`);
      throw error;
    }
  };
  const command = (label, executable, commandArgs, { capture = false, interactive = false, live = false } = {}) => {
    const start = now().getTime();
    record(`命令开始：${label}${interactive ? '；交互输出不记录' : ''}`);
    let result;
    try {
      result = runner(executable, commandArgs, {
        cwd: root, env: environment, windowsHide: !interactive,
        stdio: interactive ? 'inherit' : live ? ['ignore', 'inherit', 'pipe'] : capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
        ...(capture ? { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 } : {}),
      }) || { status: 1 };
    } catch (error) { result = { status: null, error: { code: safeErrorCode(error) } }; }
    const exitCode = resultCode(result);
    record(`命令结束：${label}；exit=${exitCode}；duration=${Math.max(0, now().getTime() - start)}ms${result.error ? `；error=${safeErrorCode(result.error)}` : ''}${result.signal ? `；signal=${['SIGINT', 'SIGTERM'].includes(result.signal) ? result.signal : 'terminated'}` : ''}`);
    return { ...result, exitCode };
  };
  const requireSuccess = (result, message) => {
    if (result.exitCode !== 0) throw new WorkflowError(message, result.exitCode);
    return result;
  };
  const child = (file, childArgs = []) => {
    const result = command(file, nodeExecutable, [path.join(root, 'scripts', file), ...childArgs], { capture: true });
    for (const message of safeChildDiagnostics(result.stdout, result.stderr)) record(message);
    return requireSuccess(result, `${file} 执行失败（退出码 ${result.exitCode}），请查看日志中的阶段和安全诊断。`);
  };

  try {
    logger = suppliedLogger || createPublishLogger({ root, now });
    line(`========== 基金账本 · ${checkOnly ? '发布检查' : '发布网站'} ==========`);
    line('请等待下方显示最终结果，再关闭窗口。');
    line('');
    record(publicOnly ? '基金账本发布流程开始；仅更新公开网站文件，保留线上账户文件。' : '基金账本发布流程开始；从六份表格刷新账户密文后发布。');
    record(`模式：${args.includes('--check') ? 'check' : 'publish'}`);
    record(`Node.js：${/^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(nodeVersion) ? nodeVersion : '版本无法识别'}`);
    if (args.some(argument => !['--check', '--public-only'].includes(argument))) throw new WorkflowError('用法：一键发布到GitHub Pages.cmd [--check] [--public-only]', 2);

    const gh = stage('检测 GitHub CLI', () => {
      const candidates = ['gh'];
      for (const base of [environment.ProgramFiles, environment['ProgramFiles(x86)'], environment.LOCALAPPDATA]) {
        if (base) candidates.push(path.join(base, 'GitHub CLI', 'gh.exe'), path.join(base, 'GitHubCLI', 'bin', 'gh.exe'));
      }
      candidates.push('F:\\Tools\\GitHubCLI\\bin\\gh.exe');
      for (const candidate of [...new Set(candidates)]) {
        if (candidate !== 'gh' && !exists(candidate)) continue;
        const found = command(`检测 gh：${candidate}`, candidate, ['--version'], { capture: true });
        if (found.exitCode !== 0) continue;
        const version = /^gh version (\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/m.exec(String(found.stdout || ''))?.[1];
        record(`GitHub CLI：${version || '已找到（版本格式未识别）'}`);
        return candidate;
      }
      throw new WorkflowError('未找到 GitHub CLI（gh）。请安装 GitHub CLI 后重试。');
    });
    if (gh !== 'gh') environment.PATH = `${path.dirname(gh)}${path.delimiter}${environment.PATH || ''}`;

    stage('验证 GitHub 登录', () => {
      const status = command('gh auth status', gh, ['auth', 'status', '--hostname', 'github.com']);
      if (status.exitCode === 0) return;
      if (status.error || status.signal) requireSuccess(status, '无法运行 GitHub 认证检查，请检查 GitHub CLI。');
      line('GitHub 登录检查未通过，接下来将打开网页登录。请按终端提示完成授权，成功后会自动继续。');
      // Invalid environment tokens override the desktop keyring and prevent gh's web login.
      if (Object.hasOwn(environment, 'GH_TOKEN') || Object.hasOwn(environment, 'GITHUB_TOKEN')) {
        delete environment.GH_TOKEN;
        delete environment.GITHUB_TOKEN;
        record('本次流程改用系统凭据；已忽略环境认证变量（全局环境未修改）。');
      }
      const login = command('gh auth login --web', gh, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], { interactive: true });
      requireSuccess(login, 'GitHub 网页登录未完成，发布已停止。');
      requireSuccess(command('重新验证 gh auth status', gh, ['auth', 'status', '--hostname', 'github.com']), '网页登录后认证检查仍未通过，发布已停止。');
    });
    record('GitHub CLI：认证检查通过');
    stage('验证仓库访问', () => {
      const access = command('验证仓库访问', gh, ['api', `repos/${repository}`, '--jq', '.full_name'], { capture: true });
      if (access.exitCode !== 0) {
        const failure = classifyGithubFailure(access);
        record(`仓库检查失败；http=${failure.http || 'unknown'}；reason=${failure.category}`);
      }
      requireSuccess(access, `无法访问 GitHub 仓库 ${repository}，请检查网络与仓库权限。`);
    });
    record(`仓库：${repository} 可访问`);
    if (!publicOnly) stage('读取并校验六份表格', () => child('prepare-account-data.mjs', args.includes('--check') ? ['--check'] : []));
    if (args.includes('--check')) {
      record(`检查完成：登录、仓库访问${publicOnly ? '' : '与六份表格校验'}通过；--check 未修改密文或打包目录，未发布任何内容。`);
      line('\n========== 检查完成 ==========');
      line('发布环境检查通过。本次仅检查，没有上传文件。');
    } else {
      stage('生成本地最新版', () => child('package-site.mjs'));
      const published = stage('发布到 GitHub Pages', () => child('publish-pages.mjs', publicOnly ? [] : ['--include-account-data']));
      uploaded = true;
      let info;
      try { info = JSON.parse(String(published.stdout || '').trim().split(/\r?\n/).at(-1)); } catch { /* Stop without pretending an unknown version is live. */ }
      if (!/^[0-9a-f]{40}$/i.test(info?.commit || '')) throw new WorkflowError('文件已上传，但无法识别本次版本，尚未确认网站上线。');
      record(`本次上传提交：${info.commit}`);
      stage('确认网站上线', () => {
        const verified = command('确认网站上线', nodeExecutable, [path.join(root, 'scripts/verify-pages.mjs'), `--commit=${info.commit}`, `--log-file=${logger.file}`], { capture: true, live: true });
        for (const message of safeChildDiagnostics(verified.stdout, verified.stderr)) record(message);
        requireSuccess(verified, verified.exitCode === 3
          ? '文件已上传，但等待上线确认已超时；网站可能仍在更新，请稍后刷新，暂勿重复发布。'
          : '文件已上传，但网站上线确认未通过，请查看详细日志。');
      });
      line('\n========== 发布成功 ==========');
      line('本次版本已上线，可以打开网站查看。');
      line(`网站：${siteUrl}`);
      record(publicOnly ? '账户密文：未上传，线上已有文件保持原样。' : '账户密文：已从六份表格刷新并上传。');
    }
    line(`详细日志：${logger.file}`);
    record(`流程完成；exit=0；duration=${Math.max(0, now().getTime() - started)}ms`);
    return { exitCode: 0, checkOnly: args.includes('--check'), logFile: logger.file };
  } catch (error) {
    const exitCode = error instanceof WorkflowError ? error.exitCode : 1;
    const message = error instanceof WorkflowError ? error.message : '发布流程发生未预期错误，敏感错误内容已省略。';
    if (logger && logWritable) {
      try { record(`流程失败：${stageName}；exit=${exitCode}；duration=${Math.max(0, now().getTime() - started)}ms；${message}`); } catch { /* Report log failures through the terminal below. */ }
    }
    emit(`\n========== ${uploaded ? '尚未确认上线' : checkOnly ? '检查失败' : '发布失败'} ==========`);
    emit(`停止位置：[${step}/${totalSteps}] ${labels[stageName] || stageName}`);
    emit(`原因：${message}`);
    if (uploaded) emit('文件已上传；本次确认已结束，暂勿重复点击发布。');
    if (!logWritable || !logger) emit('日志无法写入，请检查 ../临时文件/fund-trade-web/logs 的写入权限。');
    if (logger?.file) emit(`日志：${logger.file}`);
    return { exitCode, checkOnly: args.includes('--check'), logFile: logger?.file };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runPublishWorkflow({ args: process.argv.slice(2) }).exitCode;
}
