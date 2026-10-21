// Local server only. This file is absent from the browser/deployment allowlist.
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

import { isLocalTradingDay } from '../src/trading-calendar.js';
const DAY = 86400000;
export const NAV_POLL_INTERVAL = 3 * 60 * 1000;
// SSE's published 2026 market closures, including weekends (not makeup workdays).
// https://www.sse.com.cn/disclosure/dealinstruc/closed/c/c_20251222_10802510.shtml
export { isLocalTradingDay };
export function expectedNavDate(day, qdii, tradingDay = isLocalTradingDay) {
  let stamp = Date.parse(`${day}T00:00:00Z`) - (qdii ? DAY : 0);
  for (let attempt = 0; attempt < 370; attempt++, stamp -= DAY) {
    const date = new Date(stamp).toISOString().slice(0, 10);
    if (tradingDay(date)) return date;
  }
  throw new Error('Trading calendar unavailable.');
}
const beijing = milliseconds => new Date(milliseconds + 8 * 3600000).toISOString();
const nextEvening = milliseconds => {
  const today = beijing(milliseconds).slice(0, 10);
  const evening = Date.parse(`${today}T11:00:00Z`);
  return (milliseconds < evening ? evening : evening + DAY) - milliseconds;
};

export function createEveningNavPoller({ readFunds, updateFund, now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
  tradingDay = isLocalTradingDay, onStatus = () => {} } = {}) {
  let timer = null, stopped = true, running = false, activeDay = null, completedDay = null;
  const clear = () => { if (timer !== null) clearTimeoutFn(timer); timer = null; };
  async function check() {
    if (stopped || running) return;
    clear(); running = true;
    let wait = NAV_POLL_INTERVAL;
    try {
      const local = beijing(now()), today = local.slice(0, 10), hour = Number(local.slice(11, 13));
      if (hour >= 19 && completedDay !== today && (!activeDay || activeDay < today)) activeDay = today;
      if (!activeDay) { wait = nextEvening(now()); return; }
      const funds = await readFunds();
      if (!Array.isArray(funds) || !funds.length || new Set(funds.map(fund => fund.code)).size !== funds.length) throw new Error();
      const targets = new Map(funds.map(fund => [fund.code, expectedNavDate(activeDay, fund.qdii, tradingDay)]));
      const fresh = fund => typeof fund.latestDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fund.latestDate)
        && fund.latestDate >= targets.get(fund.code) && fund.latestDate <= beijing(now()).slice(0, 10);
      for (const fund of funds) {
        if (stopped) break;
        if (!fresh(fund)) {
          try { await updateFund(fund); } catch { onStatus('retry'); }
        }
      }
      const updated = await readFunds();
      if (updated.length === funds.length && new Set(updated.map(fund => fund.code)).size === funds.length
        && updated.every(fund => targets.has(fund.code) && fresh(fund))) {
        completedDay = activeDay; activeDay = null; onStatus('complete');
        wait = nextEvening(now());
      }
    } catch { onStatus('retry'); }
    finally {
      running = false;
      if (!stopped) { timer = setTimeoutFn(check, wait); timer?.unref?.(); }
    }
  }
  return { start() { if (!stopped) return; stopped = false; return check(); }, check,
    stop() { stopped = true; clear(); }, status() { return { running, activeDay, completedDay, stopped }; } };
}

export function createLocalNavPolling({ workspace, pythonPath = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'), output = console.log } = {}) {
  const held = path.resolve(workspace, '基金', '持仓基金');
  const readFunds = async () => {
    const index = JSON.parse(await readFile(path.join(workspace, '公共资料/历史净值/全基金历史净值当前入口.json'), 'utf8'));
    return index.funds.filter(fund => typeof fund.xlsx_path === 'string' && fund.xlsx_path.replaceAll('\\', '/').startsWith('基金/持仓基金/')).map(fund => {
      const directory = path.dirname(path.resolve(workspace, fund.xlsx_path));
      if (!/^\d{6}$/.test(fund.code) || path.dirname(directory) !== held || !path.basename(directory).startsWith(fund.code + '_')) throw new Error();
      return { code: fund.code, directory, qdii: /QDII/i.test(fund.name), latestDate: fund.last_date };
    });
  };
  const updateFund = fund => new Promise((resolve, reject) => {
    const child = spawn(pythonPath, ['-X', 'utf8', '-B', path.join(workspace, '工具脚本/nav_update.py'), '--fund-dir', fund.directory, '--no-pause'],
      { cwd: workspace, windowsHide: true, stdio: 'ignore', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' } });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('NAV update failed.')));
  });
  return createEveningNavPoller({ readFunds, updateFund, onStatus: status => output(status === 'complete'
    ? '[NAV] All held funds reached the expected NAV dates; polling paused until the next evening.'
    : '[NAV] Some public NAVs are pending or unavailable; retrying in 3 minutes.') });
}
