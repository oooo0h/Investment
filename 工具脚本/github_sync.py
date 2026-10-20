"""Double-click project mirror: readable progress and private local diagnostics."""
from __future__ import annotations

import argparse
from contextlib import contextmanager, redirect_stdout
from datetime import datetime, timezone, timedelta
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / '临时文件' / 'GitHub完整同步'
BEIJING = timezone(timedelta(hours=8))


def configure_system_proxy():
    """Use Windows' system proxy when CLI-specific proxy settings are absent.

    Keep explicit environment overrides; never persist or print proxy values.
    """
    if os.environ.get('ALL_PROXY') or os.environ.get('all_proxy'):
        return
    proxies = urllib.request.getproxies()
    for scheme in ('http', 'https'):
        if os.environ.get(f'{scheme}_proxy') or os.environ.get(f'{scheme.upper()}_PROXY'):
            continue
        value = proxies.get(scheme) or proxies.get('http')
        if value:
            os.environ[f'{scheme}_proxy'] = value
            os.environ[f'{scheme.upper()}_PROXY'] = value


def dependencies():
    candidates = [Path('F:/Tools/Git/cmd'), Path('F:/Tools/GitHubCLI/bin')]
    for base in (os.environ.get('ProgramFiles'), os.environ.get('LOCALAPPDATA')):
        if base:
            candidates.extend(Path(base) / suffix for suffix in ('Git/cmd', 'GitHub CLI'))
    os.environ['PATH'] = os.pathsep.join([os.environ.get('PATH', ''), *(str(p) for p in candidates if p.is_dir())])
    if not shutil.which('git') or not shutil.which('gh'):
        raise RuntimeError('missing_dependencies')
    os.environ['GIT_TERMINAL_PROMPT'] = '0'
    os.environ['GH_PROMPT_DISABLED'] = '1'
    os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
    configure_system_proxy()


def authentication_state():
    """Probe the active credential without printing user data or tokens.

    Unlike `gh auth status --json`, the API probe fails on an invalid token.
    A network failure must never be mistaken for a request to sign in again.
    """
    try:
        result = subprocess.run(
            ['gh', 'api', '--hostname', 'github.com', 'user', '--silent'],
            cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=30)
    except subprocess.TimeoutExpired:
        return 'network'
    if result.returncode == 0:
        return 'authenticated'
    error = result.stderr.decode('utf-8', errors='replace')
    if re.search(r'HTTP\s+401|bad credentials|gh auth login|not logged|requires authentication', error, re.I):
        return 'required'
    if re.search(r'connect|timeout|timed out|network|TLS|resolve|no such host|EOF|HTTP\s+50[234]', error, re.I):
        return 'network'
    if re.search(r'HTTP\s+403|forbidden|permission', error, re.I):
        return 'permissions'
    return 'unavailable'


def ensure_authenticated(progress, interactive=None):
    """Let a manually launched console wait for browser login, then continue.

    gh owns the device-code prompt; it inherits the console directly so the
    one-time code, token and raw CLI output never enter Progress or its log.
    """
    if interactive is None:
        interactive = sys.stdin.isatty()
    state = authentication_state()
    while state != 'authenticated':
        if state != 'required':
            raise RuntimeError(f'github_auth_{state}')
        if any(os.environ.get(name) for name in ('GH_TOKEN', 'GITHUB_TOKEN')):
            raise RuntimeError('github_auth_environment_token')
        if not interactive:
            raise RuntimeError('github_auth_required')
        progress.say('GitHub 尚未登录或授权已失效。现在打开浏览器登录，请按窗口中的提示完成授权。')
        progress.say('此窗口会等待；登录成功后自动继续本次同步，无需重新双击。')
        login_environment = dict(os.environ)
        login_environment.pop('GH_PROMPT_DISABLED', None)
        subprocess.run(
            ['gh', 'auth', 'login', '--hostname', 'github.com', '--web',
             '--git-protocol', 'https', '--skip-ssh-key'],
            cwd=ROOT, env=login_environment, check=False)
        state = authentication_state()
        if state == 'required':
            progress.say('登录尚未完成。按回车重新登录，或输入 Q 结束本次同步。')
            try:
                choice = input().strip().lower()
            except EOFError:
                choice = 'q'
            if choice in ('q', 'quit', 'exit'):
                raise RuntimeError('github_auth_cancelled')
        elif state == 'authenticated':
            progress.say('GitHub 登录已核验，继续同步。')


def synchronize_with_login(mirror, progress, check=False, interactive=None):
    ensure_authenticated(progress, interactive)
    for attempt in range(2):
        try:
            if not check:
                restore_repository(mirror, progress)
            return synchronize(mirror, progress, check)
        except RuntimeError as error:
            if attempt or 'failed: authentication' not in str(error):
                raise
            progress.say('同步时 GitHub 授权已失效，完成登录后将重新核验并继续。')
            ensure_authenticated(progress, interactive)


def restore_repository(mirror, progress):
    """Restore missing metadata only, preserving every formal working file.

    Clone into the excluded temporary folder without checkout, retain the
    existing remote history, prepare its unchanged HEAD index, then install
    only .git after checking file hashes and the remote head again. Never
    reset, checkout, stage, commit or push the user's working files.
    """
    root = Path(mirror.ROOT).resolve()
    target = root / '.git'
    if os.path.lexists(target):
        return False
    progress.say('本地版本库元数据缺失，正在从 GitHub 恢复；现有项目文件保持原样。')
    before = mirror.inventory(scan=False)
    remote = mirror.api('git/ref/heads/main')['object']['sha']
    mirror.require(bool(re.fullmatch(r'[0-9a-f]{40}', remote)), 'Unexpected remote branch')
    state = Path(mirror.STATE).resolve()
    mirror.require(state.is_relative_to(root / '临时文件'), 'Unexpected recovery destination')
    state.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='repository-recovery-', dir=state)).resolve()
    checkout = stage / 'checkout'
    repository = f'https://github.com/{mirror.REPOSITORY}.git'
    mirror.command(['git', '-c', 'http.version=HTTP/1.1', 'clone', '--no-checkout',
                    '--filter=blob:none', '--single-branch', '--branch', 'main',
                    repository, str(checkout)])
    metadata = checkout / '.git'
    mirror.require(metadata.is_dir() and not metadata.is_symlink()
                   and metadata.resolve().is_relative_to(state), 'Unexpected recovery destination')
    prefix = ['git', f'--git-dir={metadata}', f'--work-tree={root}']

    def git(*args):
        return mirror.command(prefix + list(args)).decode('utf-8').strip()

    mirror.require(git('rev-parse', 'HEAD') == remote, 'Remote changed during repository recovery')
    mirror.require(git('symbolic-ref', '--short', 'HEAD') == 'main'
                   and git('remote', 'get-url', 'origin') == repository, 'Unexpected recovery branch or destination')
    git('config', 'core.autocrlf', 'false')
    git('config', 'http.version', 'HTTP/1.1')
    git('read-tree', 'HEAD')
    mirror.require(not git('diff', '--cached', '--name-only'), 'Recovered index differs from remote HEAD')
    git('fsck', '--connectivity-only')
    mirror.require(mirror.inventory(scan=False) == before, 'Files changed during repository recovery')
    mirror.require(mirror.api('git/ref/heads/main')['object']['sha'] == remote,
                   'Remote changed during repository recovery')
    mirror.require(not os.path.lexists(target), 'Local repository appeared during recovery; stop')
    # Only metadata moves. Both absolute paths have been checked within the
    # workspace; a concurrent repository creation must never be overwritten.
    metadata.rename(target)
    mirror.require(mirror.git('rev-parse', 'HEAD') == remote, 'Recovered repository HEAD differs')
    mirror.verify_context()
    mirror.require(mirror.inventory(scan=False) == before, 'Files changed during repository recovery')
    receipt = {'schema': 'project-git-recovery-v1', 'repository': mirror.REPOSITORY,
               'branch': 'main', 'remote_base_commit': remote,
               'formal_files_verified': len(before), 'working_files_unchanged': True,
               'created_commits': 0, 'uploaded_files': 0}
    (stage / 'result.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    progress.say('本地版本库已恢复，正式文件哈希核验一致；继续核对同步清单。')
    return True


@contextmanager
def single_run(folder):
    """OS-owned lock releases on exit, including a closed CMD window."""
    folder.mkdir(parents=True, exist_ok=True)
    handle = (folder / 'sync.lock').open('a+b')
    try:
        handle.seek(0, 2)
        if handle.tell() == 0:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise RuntimeError('already_running') from None
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


class Progress:
    def __init__(self, path, console=None, heartbeat=10, total=4):
        self.console = console if console is not None else sys.stdout
        self.log = path.open('a', encoding='utf-8')
        self.guard = threading.Lock()
        self.stop = threading.Event()
        self.started = time.monotonic()
        self.stage = 0
        self.total = total
        self.buffer = ''
        self.thread = threading.Thread(target=self._heartbeat, args=(heartbeat,), daemon=True)
        self.thread.start()

    def say(self, text):
        with self.guard:
            print(text, file=self.console, flush=True)
            self.log.write(f'{datetime.now(BEIJING):%H:%M:%S} {text}\n')
            self.log.flush()

    def step(self, number, text):
        self.stage = number
        self.say(f'[{number}/{self.total}] {text}')

    def _heartbeat(self, seconds):
        while not self.stop.wait(seconds):
            if self.stage:
                self.say(f'[{self.stage}/{self.total}] 仍在执行，请保持窗口打开…… 已用时 {int(time.monotonic() - self.started)} 秒')

    def write(self, text):
        self.buffer += text
        while '\n' in self.buffer:
            line, self.buffer = self.buffer.split('\n', 1)
            try:
                self.event(json.loads(line))
            except (ValueError, TypeError):
                # Never echo raw child output, file contents, or exception traces.
                pass
        return len(text)

    def flush(self):
        pass

    def event(self, event):
        if not isinstance(event, dict):
            return
        stage = event.get('sync_stage')
        if stage in ('stage', 'commit', 'push', 'push-dry-run', 'verify'):
            if stage == 'verify':
                self.step(4, '核验云端目录和每个文件的内容')
            else:
                self.say({'stage': '正在暂存本次已核验的正式文件。', 'commit': '正在生成本地提交。',
                          'push': '正在通过标准 Git 推送上传，复用当前 GitHub 登录。',
                          'push-dry-run': '正在检查标准 Git 推送连接，不上传。'}[stage])
            return
        if all(type(event.get(key)) is int for key in ('reviewed_files', 'changed_or_added', 'old_remote_paths_to_remove')):
            self.say(f"已检查 {event['reviewed_files']} 个文件；新增或修改 {event['changed_or_added']} 个，云端旧路径删除 {event['old_remote_paths_to_remove']} 个。")
        elif all(type(event.get(key)) is int for key in ('tree_batch_verified', 'total_batches')):
            self.say(f"[3/4] 上传目录已核对 {event['tree_batch_verified']}/{event['total_batches']} 批。")
        elif event.get('path_sets_equal') is True and event.get('file_hashes_equal') is True:
            if self.stage != 4:
                self.step(4, '核验云端目录和每个文件的内容')
            self.say('文件路径、内容及提交一致；临时文件上传数为 0。')

    def close(self):
        self.stop.set()
        self.thread.join()
        self.log.close()


def load_mirror():
    spec = importlib.util.spec_from_file_location('project_github_mirror', ROOT / '工具脚本/github_mirror.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def pending_plan(mirror):
    """Resume only the exact reviewed single commit left by a failed upload."""
    mirror.verify_context()
    head = mirror.git('rev-parse', 'HEAD')
    remote, _ = mirror.remote()
    if head == remote:
        return None
    plan_path = mirror.STATE / 'plan.json'
    if not plan_path.is_file():
        raise RuntimeError('Local HEAD and remote main differ; reconcile before mirroring')
    plan = json.loads(plan_path.read_text(encoding='utf-8'))
    mirror.require(plan.get('schema') == 'project-full-mirror-v1'
                   and plan.get('repository') == mirror.REPOSITORY
                   and plan.get('branch') == 'main'
                   and plan.get('remote_base_commit') == remote,
                   'Local HEAD and remote main differ; reconcile before mirroring')
    reviewed = plan.get('reviewed_local_head', remote)
    if head == reviewed:
        mirror.require(plan.get('reviewed_head_tree') == mirror.git('rev-parse', 'HEAD^{tree}'),
                       'Local HEAD and remote main differ; reconcile before mirroring')
        return None
    mirror.require(mirror.git('show', '-s', '--format=%P', 'HEAD') == reviewed,
                   'Local HEAD and remote main differ; reconcile before mirroring')
    expected = {entry['path']: entry for entry in plan['files']}
    # NUL-delimited paths preserve Chinese names, spaces and quote characters.
    committed = {}
    for entry in mirror.command(['git', 'ls-tree', '-r', '-z', 'HEAD']).split(b'\0'):
        if entry:
            metadata, name = entry.split(b'\t', 1)
            committed[name.decode('utf-8')] = metadata.split()[2].decode('ascii')
    mirror.require(committed == {p: e['git_blob'] for p, e in expected.items()},
                   'Staged tree differs from reviewed file paths or bytes')
    if mirror.inventory() != expected:
        # This is a new manual run: preserve the reviewed commit and scan the
        # changed working files into a fresh plan. apply() still rejects any
        # further change after this new review.
        return None
    return plan


def synchronize(mirror, progress, check=False):
    progress.step(2, '扫描正式文件并核对 GitHub 当前版本')
    plan = pending_plan(mirror)
    resume = plan is not None
    if plan:
        progress.say('发现上次已提交但尚未完成上传的版本，可以安全继续。')
    else:
        if mirror.git('rev-parse', 'HEAD') != mirror.remote()[0]:
            progress.say('发现未上传提交及新的本地修改，保留已有提交并重新核验当前文件。')
        mirror.prepare()
        plan = json.loads((mirror.STATE / 'plan.json').read_text(encoding='utf-8'))
    if check:
        return
    progress.step(3, '提交并上传本地文件，请保持窗口打开')
    if resume:
        mirror.push_reviewed(plan)
    elif plan['changed_paths'] or plan['delete_remote_paths']:
        mirror.apply()
    else:
        progress.say('没有需要上传的变化，直接核验现有版本。')
        progress.step(4, '核验云端目录和每个文件的内容')
        mirror.verify(plan)
        mirror.git('update-ref', 'refs/remotes/origin/main', mirror.git('rev-parse', 'HEAD'))


def error_message(error):
    value = str(error) if isinstance(error, RuntimeError) else ''
    if value == 'already_running': return '另一个同步窗口正在运行，请等待它结束。'
    if value == 'missing_dependencies': return '未找到 Git 或 GitHub CLI，请安装后重试。'
    if 'Local Git metadata missing' in value: return '本地项目缺少 .git 版本库目录，需要先恢复本地版本库；仅重新登录不能解决。正式文件已保留。'
    if value == 'github_auth_cancelled': return '登录已取消，未继续同步；重新双击可以再次登录。'
    if value == 'github_auth_required': return 'GitHub 尚未登录或授权已失效；请在可交互窗口双击入口完成登录后继续。'
    if value == 'github_auth_environment_token': return '环境变量 GH_TOKEN 或 GITHUB_TOKEN 中的授权已失效，请先清除或更新；它会覆盖浏览器登录状态。'
    if value == 'github_auth_network': return 'GitHub 登录检查遇到网络故障；请恢复连接后重试，无需因此重复登录。'
    if value == 'github_auth_permissions': return 'GitHub 拒绝当前授权访问，请核对账户授权或组织访问限制。'
    if value == 'github_auth_unavailable': return '无法核验 GitHub 登录状态，已保留本地资料；请检查 GitHub CLI 后重试。'
    if 'failed: authentication' in value: return 'GitHub 授权仍不可用，未确认同步成功；请核对登录状态后重新双击。'
    if 'staged changes' in value: return '发现已有暂存修改，请先核对暂存区，再重新同步。'
    if 'Files changed' in value or 'files changed' in value: return '文件在核验后又发生变化，已停止；请核对后重新运行。'
    if 'HEAD and remote' in value or 'Remote changed' in value or 'Remote main' in value or 'remote_changed' in value: return '本地与云端版本有变化或分叉，已停止；请先核对两端版本。'
    if 'Credential' in value: return '检测到凭据文件或疑似密钥，已停止上传；请将凭据移到临时目录。'
    if 'permissions' in value: return '文件、Git 或 GitHub 仓库的写入权限不足，已停止；请核对对应权限。'
    if 'network' in value: return '无法连接 GitHub，请检查网络后重试；不会将网络故障当成未登录。'
    if 'gh failed' in value: return 'GitHub CLI 请求未完成，请核对仓库访问与服务状态后重试。'
    if 'branch' in value or 'destination' in value: return '仓库地址或当前分支与预设不符，已停止。'
    if 'tree' in value.lower() or 'hash' in value.lower() or 'paths' in value.lower(): return '文件目录或内容核验未通过，请先核对再重试。'
    return '本次同步未完成；请检查网络、GitHub 登录及项目状态后重试。'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Only validate and prepare; do not upload.')
    parser.add_argument('--no-pause', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--non-interactive', action='store_true', help='Do not open browser login or wait for input.')
    args = parser.parse_args(argv)
    STATE.mkdir(parents=True, exist_ok=True)
    log_path = STATE / f'sync-{datetime.now(BEIJING):%Y%m%d-%H%M%S}-{os.getpid()}.log'
    progress = Progress(log_path, total=2 if args.check else 4)
    try:
        with single_run(STATE):
            progress.say('========== 本地文件 → GitHub ==========')
            progress.say('目标：oooo0h/Investment · main；排除：根目录临时文件及 Git 元数据。')
            progress.step(1, '检查运行环境与 GitHub 登录')
            dependencies()
            with redirect_stdout(progress):
                synchronize_with_login(load_mirror(), progress, check=args.check,
                                       interactive=False if args.non_interactive else None)
            progress.say('========== 检查完成，未上传 ==========' if args.check else '========== 同步成功 ==========')
            progress.say(f'本次任务已结束，用时 {int(time.monotonic() - progress.started)} 秒。')
            progress.say(f'日志：{log_path}')
            return 0
    except (Exception, KeyboardInterrupt) as error:
        progress.say('========== 同步已停止，未确认成功 ==========')
        progress.say(f'停止位置：第 {progress.stage} 步。{error_message(error)}')
        progress.say('已完成的本地提交会保留，上传中断后可重新双击继续；不会强推或丢弃修改。')
        progress.say(f'日志：{log_path}')
        return 1
    finally:
        progress.close()


if __name__ == '__main__':
    raise SystemExit(main())
