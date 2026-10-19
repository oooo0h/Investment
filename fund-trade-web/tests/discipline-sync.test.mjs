import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisciplineSync } from '../src/discipline-sync.js';

const entries = title => [{ id: 'us-exposure', title, detail: '' }];
const response = payload => ({ ok: true, json: async () => payload });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function harness(options = {}) {
  const timers = new Map(), calls = [], changes = [];
  let nextId = 0, active = true, payload = { revision: 'first', entries: entries('初始原文') };
  const controller = createDisciplineSync({
    isActive: () => active,
    onChange: value => { changes.push(value); },
    fetchFn: async (...args) => { calls.push(args); return response(payload); },
    setIntervalFn: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearIntervalFn: id => timers.delete(id),
    ...options,
  });
  return { controller, timers, calls, changes, setActive: value => { active = value; }, setPayload: value => { payload = value; } };
}

test('only an active started session reads, and first valid data replaces fallback immediately', async () => {
  const h = harness();
  await h.controller.check();
  h.setActive(false);
  await h.controller.start();
  assert.equal(h.calls.length, 0);
  assert.equal([...h.timers.values()][0].delay, 5000);
  h.setActive(true);
  await h.controller.check();
  assert.deepEqual(h.calls[0], ['./data/discipline.json', { cache: 'no-store' }]);
  assert.deepEqual(h.changes, [entries('初始原文')]);
  await h.controller.start();
  await h.controller.check();
  assert.equal(h.timers.size, 1);
  assert.equal(h.changes.length, 1);
  h.setPayload({ revision: 'second', entries: entries('新保存原文') });
  [...h.timers.values()][0].callback();
  await h.controller.check();
  assert.deepEqual(h.changes.at(-1), entries('新保存原文'));
});

test('missing static endpoints and invalid payloads leave all prior entries intact', async () => {
  let result = { ok: false };
  const h = harness({ fetchFn: async () => result });
  await assert.doesNotReject(h.controller.start());
  assert.deepEqual(h.changes, []);
  result = response({ revision: 'valid', entries: entries('完整规则') });
  await h.controller.check();
  for (const bad of [
    { revision: 'bad', entries: [] },
    { revision: null, entries: entries('不可接受') },
    { revision: 'bad', entries: [...entries('不能部分保留'), { id: 'second', title: '', detail: '' }] },
    { revision: 'bad', entries: [...entries('重复'), ...entries('重复')] },
    { revision: 'bad', entries: [{ id: 'first', title: '不接受额外字段', detail: '', amount: 1 }] },
  ]) {
    result = response(bad);
    await assert.doesNotReject(h.controller.check());
  }
  assert.deepEqual(h.changes, [entries('完整规则')]);
});

test('stopping or relocking suppresses stale fetch and stale JSON completions', async () => {
  const reading = deferred();
  const h = harness({ fetchFn: () => reading.promise });
  const pending = h.controller.start();
  await Promise.resolve();
  h.controller.stop();
  reading.resolve(response({ revision: 'old', entries: entries('旧会话') }));
  await pending;
  assert.deepEqual(h.changes, []);
  assert.equal(h.timers.size, 0);

  const parsing = deferred();
  const next = harness({ fetchFn: async () => ({ ok: true, json: () => parsing.promise }) });
  const second = next.controller.start();
  await Promise.resolve();
  await Promise.resolve();
  next.setActive(false);
  parsing.resolve({ revision: 'stale', entries: entries('锁后响应') });
  await second;
  assert.deepEqual(next.changes, []);
  next.controller.close();
});

test('old generations cannot acknowledge or overwrite a newly started session', async () => {
  const oldRead = deferred();
  let reads = 0;
  const h = harness({ fetchFn: () => ++reads === 1 ? oldRead.promise : Promise.resolve(response({ revision: 'new', entries: entries('新会话') })) });
  const old = h.controller.start();
  await Promise.resolve();
  h.controller.stop();
  await h.controller.start();
  oldRead.resolve(response({ revision: 'old', entries: entries('旧会话') }));
  await old;
  await h.controller.check();
  assert.deepEqual(h.changes, [entries('新会话')]);
});

test('failed callbacks retry and concurrent checks share a single fetch', async () => {
  let fail = true, attempts = 0;
  const waiting = deferred();
  let reads = 0;
  const h = harness({
    fetchFn: () => { reads += 1; return waiting.promise; },
    onChange: () => { attempts += 1; if (fail) throw new Error('synthetic rendering failure'); },
  });
  const first = h.controller.start();
  assert.equal(h.controller.check(), first);
  waiting.resolve(response({ revision: 'same', entries: entries('可重试原文') }));
  await first;
  fail = false;
  await h.controller.check();
  await h.controller.check();
  assert.equal(attempts, 2);
  assert.equal(reads, 3);
});

test('nested annual conditions arrive separately and a partial invalid update cannot merge or remove them', async () => {
  const nested = [
    { id: 'annual-profit', title: '止盈纪律', detail: '' },
    { id: 'annual-profit-100', title: '达到100%【一定】大幅止盈', detail: '' },
    { id: 'annual-profit-multiple', title: '超过3倍【一定】适当止盈', detail: '' },
  ];
  const h = harness();
  h.setPayload({ revision: 'nested', entries: nested });
  await h.controller.start();
  assert.deepEqual(h.changes, [nested]);
  const updated = nested.map(entry => entry.id === 'annual-profit-multiple' ? { ...entry, title: '超过3倍【一定】适当止盈，用户原文更新' } : entry);
  h.setPayload({ revision: 'changed-child', entries: updated });
  await h.controller.check();
  assert.deepEqual(h.changes.at(-1), updated);
  h.setPayload({ revision: 'incomplete-child', entries: updated.map(entry => entry.id === 'annual-profit-100' ? { ...entry, title: '' } : entry) });
  await h.controller.check();
  assert.equal(h.changes.length, 2);
  assert.deepEqual(h.changes.at(-1), updated);
});
