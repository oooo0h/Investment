// Compatibility entry for the reviewed complete-tree mirror.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const operation = process.argv[2]?.replace(/^--/, '');
if (process.argv.length !== 3 || !['prepare', 'apply', 'verify'].includes(operation)) {
  throw new Error('Legacy additive manifests are disabled. Use --prepare, --apply or --verify.');
}
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.env.FUND_PREVIEW_PYTHON || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const result = spawnSync(python, ['-X', 'utf8', '-B', path.join(workspace, '工具脚本/github_mirror.py'), operation],
  { cwd: workspace, stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
