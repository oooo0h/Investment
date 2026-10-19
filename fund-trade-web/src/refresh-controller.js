export function createRefreshController({
  readVersion,
  onChange,
  isActive = () => true,
  intervalMs = 10000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let session = null;

  function canRun(candidate) {
    try {
      return session === candidate && candidate !== null && Boolean(isActive());
    } catch {
      return false;
    }
  }

  function check() {
    const current = session;
    if (!canRun(current)) return Promise.resolve();
    if (current.pending) return current.pending;

    const pending = Promise.resolve().then(async () => {
      try {
        if (!canRun(current)) return;
        const version = await readVersion();
        if (!canRun(current) || typeof version?.revision !== 'string' || !version.revision.trim()) return;

        const revision = version.revision;
        if (current.revision === null) {
          current.revision = revision;
          return;
        }
        if (revision === current.revision) return;

        await onChange(version);
        if (canRun(current)) current.revision = revision;
      } catch {
        // Keep the previous revision so a later check can retry safely.
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
    current.timer = setIntervalFn(() => {
      if (session === current) void check();
    }, intervalMs);
    return check();
  }

  function stop() {
    const current = session;
    session = null;
    if (current) clearIntervalFn(current.timer);
  }

  return { start, stop, check };
}
