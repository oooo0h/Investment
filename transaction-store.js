export const TRANSACTION_STORAGE_KEY = 'fund-ledger:transactions:local:v1';
const RECORD_KIND = 'fund-ledger:transactions:overlay';
const CODE = /^\d{6}$/;
const MAX_RECORD = 1048576;
const ID = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const failure = (code, message) => Object.assign(new Error(message), { code });
const invalid = () => failure('transaction-invalid', '交易记录格式无效，请检查后重试。');

function copyJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw invalid(); return value; }
  if (!value || typeof value !== 'object' || seen.has(value)) throw invalid();
  seen.add(value);
  let result;
  if (Array.isArray(value)) result = value.map(item => copyJson(item, seen));
  else {
    if (!plain(value)) throw invalid();
    result = {};
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw invalid();
      if (item !== undefined) result[key] = copyJson(item, seen);
    }
  }
  seen.delete(value);
  return result;
}

function transaction(value, fallbackId) {
  if (!plain(value)) throw invalid();
  const item = copyJson(value);
  if (!item.id && fallbackId) item.id = fallbackId;
  if (!ID(item.id) || JSON.stringify(item).length > 65536) throw invalid();
  return item;
}

function baseSnapshot(value) {
  if (!plain(value)) throw invalid();
  const funds = {};
  for (const [code, source] of Object.entries(value)) {
    if (!CODE.test(code) || !plain(source) || (source.transactions !== undefined && !Array.isArray(source.transactions))) throw invalid();
    const book = copyJson(source), ids = new Set();
    book.transactions = (source.transactions || []).map((item, index) => {
      const next = transaction(item, `${code}-${index}`);
      if (ids.has(next.id)) throw invalid();
      ids.add(next.id);
      return next;
    });
    funds[code] = book;
  }
  return funds;
}

function encryptedRecord(value) {
  if (!plain(value) || Object.keys(value).sort().join(',') !== 'ciphertext,iv,version' || value.version !== 1 ||
      typeof value.iv !== 'string' || typeof value.ciphertext !== 'string' || value.ciphertext.length > MAX_RECORD ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value.iv) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.ciphertext)) throw invalid();
  try { if (atob(value.iv).length !== 12 || atob(value.ciphertext).length < 16) throw invalid(); }
  catch { throw invalid(); }
  return { version: 1, iv: value.iv, ciphertext: value.ciphertext };
}

function overlaySnapshot(value) {
  if (!plain(value) || Object.keys(value).sort().join(',') !== 'funds,kind,updatedAt,version' ||
      value.kind !== RECORD_KIND || value.version !== 1 || typeof value.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.updatedAt)) || !plain(value.funds)) throw invalid();
  const next = copyJson(value);
  for (const [code, changes] of Object.entries(next.funds)) {
    if (!CODE.test(code) || !plain(changes) || Object.keys(changes).sort().join(',') !== 'added,deletedIds,updated' ||
        !Array.isArray(changes.added) || !Array.isArray(changes.updated) || !Array.isArray(changes.deletedIds)) throw invalid();
    const ids = new Set();
    for (const item of [...changes.added, ...changes.updated]) {
      transaction(item);
      if (ids.has(item.id)) throw invalid();
      ids.add(item.id);
    }
    for (const id of changes.deletedIds) {
      if (!ID(id) || ids.has(id)) throw invalid();
      ids.add(id);
    }
  }
  return next;
}

function mergeFunds(base, overlay) {
  const funds = copyJson(base);
  for (const [code, changes] of Object.entries(overlay.funds)) {
    const book = funds[code] ||= { transactions: [] };
    const deleted = new Set(changes.deletedIds);
    const replacements = new Map([...changes.updated, ...changes.added].map(item => [item.id, item]));
    const seen = new Set();
    const transactions = book.transactions.filter(item => !deleted.has(item.id)).map(item => {
      seen.add(item.id);
      return replacements.get(item.id) || item;
    });
    for (const item of [...changes.updated, ...changes.added]) if (!seen.has(item.id) && !deleted.has(item.id)) transactions.push(item);
    // Stable ordering permits inserting a past trade without disturbing same-day ordering.
    const date = item => /^\d{4}-\d{2}-\d{2}$/.test(item.date || '') ? item.date : String(item.submittedAt || '').slice(0, 10) || '9999-99-99';
    book.transactions = transactions.map((item, index) => ({ item, index })).sort((a, b) => date(a.item).localeCompare(date(b.item)) || a.index - b.index).map(({ item }) => copyJson(item));
  }
  return funds;
}

export async function createTransactionStore(session, initialFunds, options = {}) {
  let base, overlay, storage, observedRecord = null, closed = false, queue = Promise.resolve();
  const now = options.now || (() => new Date());
  const requireOpen = () => {
    if (closed || session?.closed === true) throw failure('transaction-closed', '交易记录已锁定，请重新解锁。');
  };
  const close = () => { closed = true; base = overlay = observedRecord = null; };
  const getFunds = () => { requireOpen(); return mergeFunds(base, overlay); };
  const replaceBase = funds => { requireOpen(); const next = baseSnapshot(funds); base = next; return getFunds(); };
  try {
    if (typeof session?.encryptLocal !== 'function' || typeof session?.decryptLocal !== 'function') throw failure('transaction-unavailable', '交易记录暂不可用。');
    requireOpen();
    base = baseSnapshot(initialFunds);
    overlay = { kind: RECORD_KIND, version: 1, funds: {}, updatedAt: new Date(now()).toISOString() };
    try {
      storage = Object.hasOwn(options, 'storage') ? options.storage : globalThis.localStorage;
      if (typeof storage?.getItem !== 'function' || typeof storage?.setItem !== 'function') throw new Error();
      observedRecord = storage.getItem(TRANSACTION_STORAGE_KEY) ?? null;
    } catch { throw failure('transaction-storage-unavailable', '本机存储不可用，交易记录未更改。'); }
    if (observedRecord !== null) {
      try {
        if (typeof observedRecord !== 'string' || observedRecord.length > MAX_RECORD + 4096) throw invalid();
        overlay = overlaySnapshot(await session.decryptLocal(encryptedRecord(JSON.parse(observedRecord))));
        requireOpen();
      } catch (error) {
        if (session.closed === true || error?.code === 'SESSION_CLOSED') throw failure('transaction-closed', '交易记录已锁定，请重新解锁。');
        throw failure('transaction-storage-invalid', '本机交易记录无法读取，原记录已保留。');
      }
    }
    requireOpen();
  } catch (error) {
    close();
    if (error?.code?.startsWith('transaction-')) throw error;
    throw failure('transaction-unavailable', '交易记录暂不可用。');
  }

  function commit(code, mutate) {
    try { requireOpen(); if (typeof code !== 'string' || !CODE.test(code)) throw invalid(); }
    catch (error) { return Promise.reject(error); }
    const pending = queue.then(async () => {
      requireOpen();
      let next = copyJson(overlay);
      const changes = next.funds[code] ||= { added: [], updated: [], deletedIds: [] };
      mutate(changes, getFunds()[code]?.transactions || []);
      let record;
      try {
        next.updatedAt = new Date(now()).toISOString();
        record = encryptedRecord(await session.encryptLocal(next));
      } catch (error) {
        if (closed || session.closed === true || error?.code === 'SESSION_CLOSED') throw failure('transaction-closed', '交易记录已锁定，请重新解锁。');
        throw failure('transaction-save-failed', '交易记录未保存，请重试。');
      }
      requireOpen();
      try {
        if ((storage.getItem(TRANSACTION_STORAGE_KEY) ?? null) !== observedRecord) throw failure('transaction-storage-conflict', '本机交易记录已在其他页面更改，请重新解锁后重试。');
        const serialized = JSON.stringify(record);
        storage.setItem(TRANSACTION_STORAGE_KEY, serialized);
        observedRecord = serialized;
      } catch (error) {
        if (error?.code === 'transaction-storage-conflict') throw error;
        throw failure('transaction-storage-unavailable', '本机存储不可用，交易记录未更改。');
      }
      requireOpen();
      overlay = next;
      next = null;
      return getFunds();
    });
    queue = pending.catch(() => {});
    return pending;
  }

  function add(code, value) {
    let item;
    try { requireOpen(); item = transaction(value, `local-${crypto.randomUUID()}`); }
    catch (error) { return Promise.reject(error?.code?.startsWith('transaction-') ? error : invalid()); }
    return commit(code, (changes, transactions) => {
      if (transactions.some(entry => entry.id === item.id) || changes.deletedIds.includes(item.id)) throw failure('transaction-duplicate', '交易记录已存在，请刷新后重试。');
      changes.added.push(item);
    });
  }
  function update(code, id, value) {
    let patch;
    try {
      requireOpen();
      if (!ID(id) || !plain(value) || (value.id !== undefined && value.id !== id)) throw invalid();
      patch = copyJson(value);
    } catch (error) { return Promise.reject(error); }
    return commit(code, (changes, transactions) => {
      const previous = transactions.find(item => item.id === id);
      if (!previous) throw failure('transaction-not-found', '交易记录已不存在，请刷新后重试。');
      const item = transaction({ ...previous, ...patch, id });
      const index = changes.added.findIndex(entry => entry.id === id);
      if (index >= 0) changes.added[index] = item;
      else { changes.updated = changes.updated.filter(entry => entry.id !== id); changes.updated.push(item); }
    });
  }
  function remove(code, id) {
    try { requireOpen(); if (!ID(id)) throw invalid(); }
    catch (error) { return Promise.reject(error); }
    return commit(code, (changes, transactions) => {
      if (!transactions.some(item => item.id === id)) throw failure('transaction-not-found', '交易记录已不存在，请刷新后重试。');
      const local = changes.added.some(item => item.id === id);
      changes.added = changes.added.filter(item => item.id !== id);
      changes.updated = changes.updated.filter(item => item.id !== id);
      if (!local || base[code]?.transactions.some(item => item.id === id)) changes.deletedIds.push(id);
    });
  }
  return { getFunds, replaceBase, add, update, remove, close };
}
