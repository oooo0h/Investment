// Synthetic revisions only: this suite never opens ledger or workbook files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshController } from '../src/refresh-controller.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeTimers() {
  let nextId = 0;
  const timers = new Map();
  const callbacks = [];
  return {
    timers,
    callbacks,
    setInterval(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, delay });
      callbacks.push(callback);
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    tick() { for (const { callback } of [...timers.values()]) callback(); },
  };
}

function harness(options = {}) {
  const timers = fakeTimers();
  const changes = [];
  let revision = 'synthetic-a';
  let active = true;
  let reads = 0;
  const controller = createRefreshController({
    readVersion: async () => { reads += 1; return { revision }; },
    onChange: async version => { changes.push(version); },
    isActive: () => active,
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
    ...options,
  });
  return { controller, timers, changes,
    setRevision(value) { revision = value; },
    setActive(value) { active = value; },
    get reads() { return reads; },
  };
}

test('checks require a started active controller and the first revision establishes the baseline', async () => {
  const h = harness();
  await h.controller.check();
  assert.equal(h.reads, 0);
  h.setActive(false);
  await h.controller.start();
  assert.equal(h.reads, 0);
  assert.equal(h.timers.timers.size, 1);
  assert.equal([...h.timers.timers.values()][0].delay, 10000);
  h.setActive(true);
  await h.controller.check();
  assert.equal(h.reads, 1);
  assert.deepEqual(h.changes, []);
  await h.controller.check();
  assert.deepEqual(h.changes, []);
  h.setRevision('synthetic-b');
  await h.controller.check();
  assert.deepEqual(h.changes, [{ revision: 'synthetic-b' }]);
  await h.controller.check();
  assert.equal(h.changes.length, 1);
});

test('interval checks refresh changed revisions and repeated start does not add timers', async () => {
  const h = harness({ intervalMs: 250 });
  await h.controller.start();
  await h.controller.start();
  assert.equal(h.timers.timers.size, 1);
  assert.equal([...h.timers.timers.values()][0].delay, 250);
  assert.equal(h.reads, 1);
  h.setRevision('synthetic-b');
  h.timers.tick();
  await h.controller.check();
  assert.deepEqual(h.changes, [{ revision: 'synthetic-b' }]);
  h.controller.stop();
  h.controller.stop();
  assert.equal(h.timers.timers.size, 0);
  h.timers.tick();
  await h.controller.check();
  assert.equal(h.reads, 2);
});

test('missing and invalid revisions are ignored until the first valid revision', async () => {
  const values = [null, {}, { revision: '' }, { revision: '  ' }, { revision: 2 }, { revision: 'synthetic-a' }, { revision: 'synthetic-b', tag: 'synthetic' }];
  const h = harness({ readVersion: async () => values.shift() });
  await h.controller.start();
  for (let index = 0; index < 5; index += 1) await h.controller.check();
  assert.deepEqual(h.changes, []);
  await h.controller.check();
  assert.deepEqual(h.changes, [{ revision: 'synthetic-b', tag: 'synthetic' }]);
});

test('read failures are swallowed without losing the previous baseline', async () => {
  let value = { revision: 'synthetic-a' };
  const h = harness({ readVersion: () => {
    if (value instanceof Error) throw value;
    return Promise.resolve(value);
  } });
  await h.controller.start();
  value = new Error('synthetic read failure');
  await assert.doesNotReject(h.controller.check());
  value = { revision: 'synthetic-b' };
  await h.controller.check();
  assert.deepEqual(h.changes, [{ revision: 'synthetic-b' }]);
});

test('failed onChange is retried and acknowledges its revision only after success', async () => {
  const attempts = [];
  let fail = true;
  const h = harness({ onChange: async version => {
    attempts.push(version.revision);
    if (fail) throw new Error('synthetic refresh failure');
  } });
  await h.controller.start();
  h.setRevision('synthetic-b');
  await assert.doesNotReject(h.controller.check());
  fail = false;
  await h.controller.check();
  await h.controller.check();
  assert.deepEqual(attempts, ['synthetic-b', 'synthetic-b']);
});

test('overlapping timer and manual checks share one pending read and one pending refresh', async () => {
  const reading = deferred();
  const refreshing = deferred();
  let reads = 0;
  let changes = 0;
  const h = harness({
    readVersion: () => ++reads === 1 ? { revision: 'synthetic-a' } : reading.promise,
    onChange: () => { changes += 1; return refreshing.promise; },
  });
  await h.controller.start();
  const checking = h.controller.check();
  h.timers.tick();
  assert.equal(h.controller.check(), checking);
  await Promise.resolve();
  assert.equal(reads, 2);
  reading.resolve({ revision: 'synthetic-b' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(changes, 1);
  h.timers.tick();
  assert.equal(h.controller.check(), checking);
  assert.equal(reads, 2);
  refreshing.resolve();
  await checking;
});

test('becoming inactive before a read completes prevents a refresh until an active check', async () => {
  const reading = deferred();
  let reads = 0;
  const h = harness({ readVersion: () => ++reads === 2 ? reading.promise : { revision: reads === 1 ? 'synthetic-a' : 'synthetic-b' } });
  await h.controller.start();
  const checking = h.controller.check();
  await Promise.resolve();
  h.setActive(false);
  reading.resolve({ revision: 'synthetic-b' });
  await checking;
  assert.deepEqual(h.changes, []);
  h.setActive(true);
  await h.controller.check();
  assert.deepEqual(h.changes, [{ revision: 'synthetic-b' }]);
});

test('stop invalidates a pending read and restart establishes a new independent baseline', async () => {
  const oldRead = deferred();
  let reads = 0;
  const h = harness({ readVersion: () => ++reads === 1 ? oldRead.promise : { revision: reads === 2 ? 'synthetic-new-a' : 'synthetic-new-b' } });
  const oldStart = h.controller.start();
  await Promise.resolve();
  h.controller.stop();
  await h.controller.start();
  assert.equal(reads, 2);
  oldRead.resolve({ revision: 'synthetic-old' });
  await oldStart;
  assert.deepEqual(h.changes, []);
  await h.controller.check();
  assert.deepEqual(h.changes, [{ revision: 'synthetic-new-b' }]);
  assert.equal(h.timers.timers.size, 1);
});

test('old reads and queued timer callbacks cannot affect a newer pending check', async () => {
  const oldRead = deferred();
  const newRead = deferred();
  let reads = 0;
  const h = harness({ readVersion: () => ++reads === 1 ? oldRead.promise : newRead.promise });
  const oldStart = h.controller.start();
  await Promise.resolve();
  const oldTimer = h.timers.callbacks[0];
  h.controller.stop();
  const newStart = h.controller.start();
  await Promise.resolve();
  oldRead.reject(new Error('synthetic obsolete read'));
  await oldStart;
  oldTimer();
  assert.equal(h.controller.check(), newStart);
  assert.equal(reads, 2);
  newRead.resolve({ revision: 'synthetic-new' });
  await newStart;
  assert.deepEqual(h.changes, []);
});

test('an old onChange completion cannot acknowledge or clear a newer generation', async () => {
  const oldChange = deferred();
  const newRead = deferred();
  let reads = 0;
  const changes = [];
  const h = harness({
    readVersion: () => {
      reads += 1;
      if (reads === 3) return newRead.promise;
      return { revision: reads === 1 ? 'synthetic-old-a' : reads === 2 ? 'synthetic-old-b' : 'synthetic-new-b' };
    },
    onChange: version => {
      changes.push(version.revision);
      return changes.length === 1 ? oldChange.promise : Promise.resolve();
    },
  });
  await h.controller.start();
  const oldCheck = h.controller.check();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(changes, ['synthetic-old-b']);
  h.controller.stop();
  const newStart = h.controller.start();
  await Promise.resolve();
  oldChange.resolve();
  await oldCheck;
  assert.equal(h.controller.check(), newStart);
  newRead.resolve({ revision: 'synthetic-new-a' });
  await newStart;
  await h.controller.check();
  assert.deepEqual(changes, ['synthetic-old-b', 'synthetic-new-b']);
});

test('stopping before the initial microtask prevents even the initial version read', async () => {
  const h = harness();
  const starting = h.controller.start();
  h.controller.stop();
  await starting;
  assert.equal(h.reads, 0);
  await h.controller.start();
  assert.equal(h.reads, 1);
  assert.deepEqual(h.changes, []);
});
