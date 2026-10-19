import { unlockVault } from './vault.js';
import { normalizeBondEntries, normalizeFreeCashFlow } from './bond-model.js?v=20261019-free-cash-flow';

export const BOND_STORAGE_KEY = 'fund-ledger:bonds:local:v1';

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function snapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['funds', 'bonds', 'freeCashFlow', 'updatedAt'].includes(key)) ||
      (value.funds !== undefined && (!value.funds || typeof value.funds !== 'object' || Array.isArray(value.funds) || Object.keys(value.funds).length)) ||
      typeof value.updatedAt !== 'string' || !value.updatedAt || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error('Invalid bond record.');
  let freeCashFlow;
  try { freeCashFlow = normalizeFreeCashFlow(value.freeCashFlow); }
  catch { throw new Error('Invalid bond record.'); }
  return { bonds: normalizeBondEntries(value.bonds), freeCashFlow, updatedAt: value.updatedAt };
}

function encryptedRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'ciphertext,iv,version' ||
      value.version !== 1 || typeof value.iv !== 'string' || !value.iv || typeof value.ciphertext !== 'string' || !value.ciphertext || value.ciphertext.length > 1048576) throw new Error('Invalid encrypted local record.');
  return { version: 1, iv: value.iv, ciphertext: value.ciphertext };
}

export async function createBondStore(session, initial, options = {}) {
  let current = null;
  let closed = false;
  let queue = Promise.resolve();
  let storage;
  const now = options.now || (() => new Date());
  function requireOpen() {
    if (closed || session?.closed === true) throw failure('bond-closed', '债基记录已锁定，请重新解锁。');
  }
  function getSnapshot() {
    requireOpen();
    return { bonds: current.bonds.map(entry => ({ ...entry })), freeCashFlow: current.freeCashFlow, updatedAt: current.updatedAt };
  }
  function close() {
    closed = true;
    current = null;
    session?.close?.();
  }
  try {
    if (typeof session?.encryptLocal !== 'function' || typeof session?.decryptLocal !== 'function' || typeof session?.close !== 'function') throw failure('bond-unavailable', '债基记录暂不可用。');
    requireOpen();
    let saved;
    try {
      storage = Object.hasOwn(options, 'storage') ? options.storage : globalThis.localStorage;
      if (typeof storage?.getItem !== 'function' || typeof storage?.setItem !== 'function') throw new Error();
      saved = storage.getItem(BOND_STORAGE_KEY);
    } catch { throw failure('bond-storage-unavailable', '本机存储不可用，债基记录未更改。'); }
    if (saved !== null && saved !== undefined) {
      try {
        const record = encryptedRecord(JSON.parse(saved));
        current = snapshot(await session.decryptLocal(record));
        requireOpen();
      } catch (error) {
        if (closed || session.closed === true || error?.code === 'SESSION_CLOSED') throw failure('bond-closed', '债基记录已锁定，请重新解锁。');
        throw failure('bond-storage-invalid', '本机债基记录无法读取，原记录已保留。');
      }
    } else {
      try { current = snapshot(initial); }
      catch { throw failure('bond-unavailable', '债基记录暂不可用。'); }
    }
    requireOpen();
  } catch (error) {
    close();
    throw error;
  }

  function save(entries) {
    let bonds;
    try { requireOpen(); bonds = normalizeBondEntries(entries); }
    catch (error) { return Promise.reject(error?.code === 'bond-closed' ? error : failure('bond-invalid', '请检查债基记录后重试。')); }
    const pending = queue.then(async () => {
      requireOpen();
      let next, record;
      try {
        next = { bonds, freeCashFlow: current.freeCashFlow, updatedAt: new Date(now()).toISOString() };
        record = encryptedRecord(await session.encryptLocal(next));
      } catch (error) {
        if (closed || session.closed === true || error?.code === 'SESSION_CLOSED') throw failure('bond-closed', '债基记录已锁定，请重新解锁。');
        throw failure('bond-save-failed', '债基记录未保存，请重试。');
      }
      requireOpen();
      try { storage.setItem(BOND_STORAGE_KEY, JSON.stringify(record)); }
      catch { throw failure('bond-storage-unavailable', '本机存储不可用，债基记录未更改。'); }
      requireOpen();
      current = next;
      return getSnapshot();
    });
    queue = pending.catch(() => {});
    return pending;
  }

  function saveFreeCashFlow(value) {
    let freeCashFlow;
    try { requireOpen(); freeCashFlow = normalizeFreeCashFlow(value); }
    catch (error) { return Promise.reject(error?.code === 'bond-closed' ? error : failure('bond-invalid', '请输入有效的自由现金流金额。')); }
    const pending = queue.then(async () => {
      requireOpen();
      let next, record;
      try {
        next = { bonds: current.bonds, freeCashFlow, updatedAt: new Date(now()).toISOString() };
        record = encryptedRecord(await session.encryptLocal(next));
      } catch (error) {
        if (closed || session.closed === true || error?.code === 'SESSION_CLOSED') throw failure('bond-closed', '债基记录已锁定，请重新解锁。');
        throw failure('bond-save-failed', '自由现金流未保存，请重试。');
      }
      requireOpen();
      try { storage.setItem(BOND_STORAGE_KEY, JSON.stringify(record)); }
      catch { throw failure('bond-storage-unavailable', '本机存储不可用，自由现金流未更改。'); }
      requireOpen();
      current = next;
      return getSnapshot();
    });
    queue = pending.catch(() => {});
    return pending;
  }
  return { getSnapshot, save, saveFreeCashFlow, close };
}

export async function openBondStore(password, options = {}) {
  let session = null;
  try {
    const initial = await unlockVault(password, {
      url: './data/bonds.enc.json', fetchFn: options.fetchFn,
      onSession: opened => { session = opened; },
    });
    password = '';
    return await createBondStore(session, initial, options);
  } catch (error) {
    session?.close();
    if (typeof error?.code === 'string' && error.code.startsWith('bond-')) throw error;
    throw failure('bond-unavailable', '债基记录暂不可用。');
  } finally { password = ''; }
}
