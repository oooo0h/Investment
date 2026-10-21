// Runtime discovery for a moved checkout or another Windows device.
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

export function resolveArtifactTool({ root, env = process.env, home = os.homedir(), resolve } = {}) {
  const bases = [
    ...(env.FUND_NAV_NODE_MODULES ? [path.dirname(path.resolve(env.FUND_NAV_NODE_MODULES))] : []),
    path.join(home, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node'),
    path.join(root, '临时文件'),
    root,
  ];
  for (const base of bases) {
    try { return resolve ? resolve(base) : createRequire(path.join(base, 'nav-runtime-entry.mjs')).resolve('@oai/artifact-tool'); }
    catch (error) { if (!['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(error.code)) throw error; }
  }
  throw new Error('未找到表格运行依赖。请设置 FUND_NAV_NODE_MODULES 为包含 @oai/artifact-tool 的 node_modules 目录，或使用已配置依赖的 Codex 设备。');
}
