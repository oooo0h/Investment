// Public fund identities and return ratios only. Never stores NAV or account data.
import { FUND_CODES } from './funds.js';
import { buildEstimatedNav, getEstimateDates } from './nav-estimates.js?v=20261020-nav-dates-trades';

export const NAV_ESTIMATE_STORAGE_KEY = 'fund-ledger:nav-estimates:v1';
export const MAX_NAV_ESTIMATES = 4000;
const SAVE_ERROR = 'Unable to save NAV estimates.';
const allowedCodes = new Set(FUND_CODES);

function normalizeEntry(entry, now) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
    || Object.keys(entry).sort().join(',') !== 'change,code,date'
    || !allowedCodes.has(entry.code)) return null;
  const safe = buildEstimatedNav([], [{ date: entry.date, change: entry.change }], { now }).pending[0];
  return safe ? { code: entry.code, date: safe.date, change: safe.change } : null;
}

function normalizedEntries(entries, now, strict) {
  if (!Array.isArray(entries) || entries.length > MAX_NAV_ESTIMATES || !getEstimateDates(now).yesterday) return null;
  const byFundDate = new Map();
  for (const entry of entries) {
    const normalized = normalizeEntry(entry, now);
    if (!normalized) {
      if (strict) return null;
      continue;
    }
    byFundDate.set(`${normalized.code}|${normalized.date}`, normalized);
  }
  return [...byFundDate.values()].sort((a, b) => FUND_CODES.indexOf(a.code) - FUND_CODES.indexOf(b.code) || a.date.localeCompare(b.date));
}

/** Invalid stored payloads are replaceable; inaccessible storage is unavailable. */
export function loadNavEstimates(options = {}) {
  const { storage, now = new Date() } = options && typeof options === 'object' ? options : {};
  let raw;
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    if (typeof target?.getItem !== 'function') return { entries: [], available: false };
    raw = target.getItem(NAV_ESTIMATE_STORAGE_KEY);
  } catch { return { entries: [], available: false }; }
  if (raw === null || raw === undefined) return { entries: [], available: true };
  try {
    const payload = typeof raw === 'string' ? JSON.parse(raw) : null;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).sort().join(',') !== 'entries,version' || payload.version !== 1) {
      return { entries: [], available: true };
    }
    return { entries: normalizedEntries(payload.entries, now, false) || [], available: true };
  } catch { return { entries: [], available: true }; }
}

/** Validate the whole update before writing; only normalized code/date/rate data persists. */
export function saveNavEstimates(entries, options = {}) {
  const { storage, now = new Date() } = options && typeof options === 'object' ? options : {};
  try {
    const normalized = normalizedEntries(entries, now, true);
    if (!normalized) throw new Error(SAVE_ERROR);
    const target = storage === undefined ? globalThis.localStorage : storage;
    if (typeof target?.setItem !== 'function') throw new Error(SAVE_ERROR);
    target.setItem(NAV_ESTIMATE_STORAGE_KEY, JSON.stringify({ version: 1, entries: normalized }));
    return normalized;
  } catch { throw new Error(SAVE_ERROR); }
}
