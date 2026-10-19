import { unlockVault } from './vault.js';
import { normalizeBondEntries, normalizeFreeCashFlow } from './bond-model.js';
import { normalizeBondHoldingLots } from './bond-holding-duration.js?v=20261019-bond-calculated-lots';
import { normalizeBondTransactions } from './bond-transactions.js?v=20261019-bond-calculated-lots';

// Legacy financial edits remain recoverable but are never read or modified.
export const BOND_STORAGE_KEY = 'fund-ledger:bonds:local:v1';
export const CASH_FLOW_STORAGE_KEY = 'fund-ledger:cash-flow:local:v1';
const fail = (code, message) => Object.assign(new Error(message), { code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function sourceSnapshot(value) {
  if (!object(value) || Object.keys(value).some(key => !['funds', 'bonds', 'freeCashFlow', 'holdingLots', 'transactions', 'updatedAt'].includes(key))
    || (value.funds !== undefined && (!object(value.funds) || Object.keys(value.funds).length))
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error('Invalid bond source.');
  return { bonds: normalizeBondEntries(value.bonds), freeCashFlow: normalizeFreeCashFlow(value.freeCashFlow),
    holdingLots: normalizeBondHoldingLots(value.holdingLots) || {}, transactions: normalizeBondTransactions(value.transactions), updatedAt: value.updatedAt };
}
function cashRecord(value) {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'freeCashFlow,updatedAt' || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error('Invalid cash flow record.');
  return { freeCashFlow: normalizeFreeCashFlow(value.freeCashFlow), updatedAt: value.updatedAt };
}
function encrypted(value) {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'ciphertext,iv,version' || value.version !== 1 || typeof value.iv !== 'string' || !value.iv || typeof value.ciphertext !== 'string' || !value.ciphertext || value.ciphertext.length > 1048576) throw new Error('Invalid encrypted record.');
  return value;
}
export async function createBondStore(session, initial, options = {}) {
  let source, cash = null, storage = null, cashError = null, closed = false, queue = Promise.resolve();
  const now = options.now || (() => new Date());
  const requireOpen = () => { if (closed || session?.closed) throw fail('bond-closed', '债基记录已锁定，请重新解锁。'); };
  const close = () => { closed = true; source = null; cash = null; session?.close?.(); };
  const getSnapshot = () => {
    requireOpen();
    return structuredClone({ ...source, freeCashFlow: cashError ? null : cash ? cash.freeCashFlow : source.freeCashFlow, cashFlowUnavailable: Boolean(cashError) });
  };
  try {
    if (typeof session?.encryptLocal !== 'function' || typeof session?.decryptLocal !== 'function' || typeof session?.close !== 'function') throw fail('bond-unavailable', '债基资料暂不可用。');
    requireOpen();
    try { source = sourceSnapshot(initial); } catch { throw fail('bond-unavailable', '债基资料暂不可用。'); }
    let saved;
    try {
      storage = Object.hasOwn(options, 'storage') ? options.storage : globalThis.localStorage;
      if (typeof storage?.getItem !== 'function' || typeof storage?.setItem !== 'function') throw new Error();
      saved = storage.getItem(CASH_FLOW_STORAGE_KEY);
    } catch { cashError = 'bond-storage-unavailable'; }
    if (saved !== null && saved !== undefined) {
      try { cash = cashRecord(await session.decryptLocal(encrypted(JSON.parse(saved)))); requireOpen(); }
      catch { requireOpen(); cashError = 'bond-storage-invalid'; }
    }
    requireOpen();
  } catch (error) { close(); throw error; }
  function saveFreeCashFlow(value) {
    let normalized;
    try { requireOpen(); if (cashError) throw fail(cashError, '本机现金流暂不可用，原记录已保留。'); normalized = normalizeFreeCashFlow(value); }
    catch (error) { return Promise.reject(error.code ? error : fail('bond-invalid', '请输入有效的自由现金流金额。')); }
    const pending = queue.then(async () => {
      requireOpen();
      const next = { freeCashFlow: normalized, updatedAt: new Date(now()).toISOString() };
      let record;
      try { record = encrypted(await session.encryptLocal(next)); }
      catch { requireOpen(); throw fail('bond-save-failed', '自由现金流未保存，请重试。'); }
      requireOpen();
      try { storage.setItem(CASH_FLOW_STORAGE_KEY, JSON.stringify(record)); }
      catch { throw fail('bond-storage-unavailable', '本机存储不可用，自由现金流未更改。'); }
      requireOpen(); cash = next; return getSnapshot();
    });
    queue = pending.catch(() => {}); return pending;
  }
  async function refresh() {
    requireOpen();
    let next;
    try { next = sourceSnapshot(await session.refresh()); }
    catch (error) { requireOpen(); if (error?.name === 'OperationError') throw error; throw fail('bond-unavailable', '债基资料更新未完成。'); }
    requireOpen(); source = next; return getSnapshot();
  }
  return { getSnapshot, saveFreeCashFlow, refresh, close };
}
export async function openBondStore(password, options = {}) {
  let session = null;
  try {
    const initial = await unlockVault(password, { url: './data/bonds.enc.json', fetchFn: options.fetchFn,
      requestTimeoutMs: options.requestTimeoutMs, requestAttempts: options.requestAttempts,
      onSession: opened => { session = opened; } });
    password = ''; return await createBondStore(session, initial, options);
  } catch (error) { session?.close(); if (error?.code?.startsWith('bond-')) throw error; throw fail('bond-unavailable', '债基资料暂不可用。'); }
  finally { password = ''; }
}
