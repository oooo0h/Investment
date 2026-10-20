import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedNavDate, createEveningNavPoller, NAV_POLL_INTERVAL } from '../scripts/local-nav-polling.mjs';
import { staticSourcePath } from '../scripts/site-files.mjs';
import { readLocalFile } from '../scripts/local-bundle.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

function fixture(time = '2026-10-20T11:00:00Z', update) {
  let instant = Date.parse(time), serial = 0;
  const timers = new Map(), calls = [], statuses = [];
  const funds = [{ code: '005698', qdii: true, latestDate: '2026-10-16' }, { code: '006663', qdii: false, latestDate: '2026-10-19' }];
  const poller = createEveningNavPoller({ readFunds: async () => structuredClone(funds),
    updateFund: async fund => { calls.push(fund.code); if (update) return update(fund, funds); funds.find(item => item.code === fund.code).latestDate = expectedNavDate('2026-10-20', fund.qdii); },
    now: () => instant, setTimeoutFn: (callback, delay) => { const id = ++serial; timers.set(id, { callback, delay }); return id; },
    clearTimeoutFn: id => timers.delete(id), onStatus: status => statuses.push(status) });
  return { poller, funds, calls, statuses, timers, setTime: value => { instant = Date.parse(value); } };
}

test('latest NAV dates use same trading day for domestic funds and prior trading day for QDII, skipping closures', () => {
  assert.equal(expectedNavDate('2026-10-20', false), '2026-10-20');
  assert.equal(expectedNavDate('2026-10-20', true), '2026-10-19');
  assert.equal(expectedNavDate('2026-10-19', true), '2026-10-16');
  assert.equal(expectedNavDate('2026-10-08', true), '2026-09-30');
  assert.equal(expectedNavDate('2026-10-04', false), '2026-09-30');
  assert.equal(expectedNavDate('2026-10-10', false), '2026-10-09');
  assert.equal(expectedNavDate('2026-01-01', true), '2025-12-31');
  assert.throws(() => expectedNavDate('2027-01-05', true), /calendar unavailable/);
});

test('startup before Beijing 19:00 waits for the evening rather than querying early', async () => {
  const h = fixture('2026-10-20T10:59:00Z');
  await h.poller.start(); assert.deepEqual(h.calls, []);
  assert.equal([...h.timers.values()][0].delay, 60000);
  h.setTime('2026-10-20T11:00:00Z'); await h.poller.check();
  assert.deepEqual(h.calls, ['005698', '006663']);
  assert.equal(h.poller.status().completedDay, '2026-10-20');
  assert.equal([...h.timers.values()][0].delay, 86400000);
  h.poller.stop(); assert.equal(h.timers.size, 0);
});

test('only stale funds are retried every three minutes and an unpublished date never counts as current', async () => {
  const h = fixture(undefined, async () => {});
  h.funds[0].latestDate = '2026-10-19';
  await h.poller.start(); assert.deepEqual(h.calls, ['006663']);
  assert.equal(h.poller.status().completedDay, null);
  assert.equal([...h.timers.values()][0].delay, NAV_POLL_INTERVAL);
  await h.poller.check(); assert.deepEqual(h.calls, ['006663', '006663']);
  h.funds[1].latestDate = '2026-10-20'; await h.poller.check();
  assert.equal(h.poller.status().completedDay, '2026-10-20');
  h.poller.stop();
});

test('polling has no overlapping updater and an unfinished evening retains its target across midnight', async () => {
  let release;
  const h = fixture('2026-10-20T15:59:00Z', () => new Promise(resolve => { release = resolve; }));
  h.funds[1].latestDate = '2026-10-20';
  const pending = h.poller.start();
  await Promise.resolve(); await Promise.resolve();
  await h.poller.check(); assert.equal(h.calls.length, 1);
  release(); await pending;
  h.setTime('2026-10-20T16:01:00Z');
  h.funds[0].latestDate = '2026-10-19'; await h.poller.check();
  assert.equal(h.poller.status().completedDay, '2026-10-20');
  assert.equal(h.calls.length, 1); h.poller.stop();
});

test('failed updates retry safely, unknown calendars cannot report completion, and cloud sources exclude the runner', async () => {
  const h = fixture(undefined, async () => { throw new Error('synthetic network failure'); });
  await h.poller.start(); assert.ok(h.statuses.includes('retry'));
  assert.equal(h.poller.status().completedDay, null); h.poller.stop();
  const future = fixture('2027-01-05T11:00:00Z');
  await future.poller.start(); assert.deepEqual(future.calls, []);
  assert.deepEqual(future.statuses, ['retry']); future.poller.stop();
  assert.equal(staticSourcePath('local-nav-polling.mjs'), null);
  assert.equal(staticSourcePath('scripts/local-nav-polling.mjs'), null);
});

test('a running local server reads the new canonical NAV index instead of its stale startup copy', async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'nav-index-synthetic-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const root = path.join(workspace, 'fund-trade-web'), legacy = '公共资料/历史净值/全基金历史净值当前入口.json';
  await mkdir(path.join(root, 'local'), { recursive: true });
  await mkdir(path.dirname(path.join(workspace, legacy)), { recursive: true });
  await writeFile(path.join(root, 'local/nav-index.json'), 'old synthetic index');
  await writeFile(path.join(workspace, legacy), 'current synthetic index');
  assert.equal((await readLocalFile({ root, workspace, name: 'navIndex', legacy })).bytes.toString(), 'current synthetic index');
  await writeFile(path.join(workspace, legacy), 'new synthetic index');
  assert.equal((await readLocalFile({ root, workspace, name: 'navIndex', legacy })).bytes.toString(), 'new synthetic index');
});
