// An independent, read-only document refresh; no vault, account or storage access.
function validate(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.revision !== 'string'
    || !payload.revision.trim() || payload.revision.length > 256
    || !Array.isArray(payload.entries) || !payload.entries.length || payload.entries.length > 100) return null;
  const ids = new Set(), entries = [];
  for (const item of payload.entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['id', 'title', 'detail'].includes(key))
      || typeof item.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(item.id) || ids.has(item.id)
      || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 10000
      || typeof item.detail !== 'string' || item.detail.length > 10000
      || /\u0000/.test(item.title + item.detail)) return null;
    ids.add(item.id);
    entries.push(Object.freeze({ id: item.id, title: item.title, detail: item.detail }));
  }
  return { revision: payload.revision, entries: Object.freeze(entries) };
}

export function createDisciplineSync({
  isActive = () => false,
  onChange = () => {},
  fetchFn = (...args) => globalThis.fetch(...args),
  intervalMs = 5000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let session = null;
  const canRun = candidate => {
    try { return candidate !== null && session === candidate && Boolean(isActive()); }
    catch { return false; }
  };
  function check() {
    const current = session;
    if (!canRun(current)) return Promise.resolve();
    if (current.pending) return current.pending;
    const pending = Promise.resolve().then(async () => {
      try {
        if (!canRun(current)) return;
        const response = await fetchFn('./data/discipline.json', { cache: 'no-store' });
        if (!canRun(current) || !response?.ok) return;
        const payload = await response.json();
        if (!canRun(current)) return;
        const next = validate(payload);
        if (!next || next.revision === current.revision) return;
        await onChange(next.entries);
        if (canRun(current)) current.revision = next.revision;
      } catch {
        // Missing static endpoints, network failures and invalid saves stay quiet.
        // Do not acknowledge failed changes, so a subsequent check can retry.
      } finally {
        if (session === current && current.pending === pending) current.pending = null;
      }
    });
    current.pending = pending;
    return pending;
  }
  function start() {
    if (session) return session.pending || Promise.resolve();
    const current = { revision: null, pending: null, timer: null };
    session = current;
    current.timer = setIntervalFn(() => { if (session === current) void check(); }, intervalMs);
    return check();
  }
  function stop() {
    const current = session;
    session = null;
    if (current) clearIntervalFn(current.timer);
  }
  return { start, check, stop, close: stop };
}
