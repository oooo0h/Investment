// Portable test entry, including local application and publication suites.
import { readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { siteTemporaryPath } from './project-paths.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const files = (await readdir(new URL('../tests/', import.meta.url)))
  .filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`);
console.log('Application and publication regression tests.');
const temporary = siteTemporaryPath(root, 'test-runtime');
await mkdir(temporary, { recursive: true });
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary, PYTHONDONTWRITEBYTECODE: '1' } });
child.on('error', () => { process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
