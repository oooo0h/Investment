"""Double-click project mirror: readable progress and private local diagnostics."""
from __future__ import annotations

import argparse
from contextlib import contextmanager, redirect_stdout
from datetime import datetime, timezone, timedelta
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import threading
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / '临时文件' / 'GitHub完整同步'
BEIJING = timezone(timedelta(hours=8))


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
    mirror.require(mirror.git('show', '-s', '--format=%P', 'HEAD') == remote,
                   'Local HEAD and remote main differ; reconcile before mirroring')
    expected = {entry['path']: entry for entry in plan['files']}
    mirror.require(mirror.inventory() == expected, 'Files changed after review; prepare again')
    # NUL-delimited paths preserve Chinese names, spaces and quote characters.
    committed = {}
    for entry in mirror.command(['git', 'ls-tree', '-r', '-z', 'HEAD']).split(b'\0'):
        if entry:
            metadata, name = entry.split(b'\t', 1)
            committed[name.decode('utf-8')] = metadata.split()[2].decode('ascii')
    mirror.require(committed == {p: e['git_blob'] for p, e in expected.items()},
                   'Staged tree differs from reviewed file paths or bytes')
    return plan


def synchronize(mirror, progress, check=False):
    progress.step(2, '扫描正式文件并核对 GitHub 当前版本')
    plan = pending_plan(mirror)
    if plan:
        progress.say('发现上次已提交但尚未完成上传的版本，可以安全继续。')
    else:
        mirror.prepare()
        plan = json.loads((mirror.STATE / 'plan.json').read_text(encoding='utf-8'))
    if check:
        return
    progress.step(3, '提交并上传本地文件，请保持窗口打开')
    if plan['remote_base_commit'] != mirror.git('rev-parse', 'HEAD'):
        output = mirror.command([sys.executable, '-X', 'utf8', '-u', '-B', str(mirror.ROOT / '工具脚本/github_api_transport.py')])
        progress.write(output.decode('utf-8'))
        progress.step(4, '核验云端目录和每个文件的内容')
        mirror.verify(plan)
        mirror.git('update-ref', 'refs/remotes/origin/main', mirror.git('rev-parse', 'HEAD'))
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
    if 'staged changes' in value: return '发现已有暂存修改，请先核对暂存区，再重新同步。'
    if 'Files changed' in value or 'files changed' in value: return '文件在核验后又发生变化，已停止；请核对后重新运行。'
    if 'HEAD and remote' in value or 'Remote changed' in value or 'Remote main' in value: return '本地与云端版本有变化或分叉，已停止；请先核对两端版本。'
    if 'Credential' in value: return '检测到凭据文件或疑似密钥，已停止上传；请将凭据移到临时目录。'
    if 'network' in value or 'gh failed' in value: return '无法访问 GitHub 或登录授权不可用；请检查网络及 GitHub CLI 登录后重试。'
    if 'branch' in value or 'destination' in value: return '仓库地址或当前分支与预设不符，已停止。'
    if 'permissions' in value: return '文件或 Git 写入权限不足，已停止。'
    if 'tree' in value.lower() or 'hash' in value.lower() or 'paths' in value.lower(): return '文件目录或内容核验未通过，请先核对再重试。'
    return '本次同步未完成；请检查网络、GitHub 登录及项目状态后重试。'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Only validate and prepare; do not upload.')
    parser.add_argument('--no-pause', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    STATE.mkdir(parents=True, exist_ok=True)
    log_path = STATE / f'sync-{datetime.now(BEIJING):%Y%m%d-%H%M%S}-{os.getpid()}.log'
    progress = Progress(log_path, total=2 if args.check else 4)
    try:
        with single_run(STATE):
            progress.say('========== 本地文件 → GitHub ==========')
            progress.say('目标：oooo0h/Investment · main；排除：根目录临时文件及 Git 元数据。')
            progress.step(1, '检查运行环境与同步入口')
            dependencies()
            with redirect_stdout(progress):
                synchronize(load_mirror(), progress, check=args.check)
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
