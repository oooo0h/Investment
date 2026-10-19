// Imported records are for display, never a reconstruction of current holdings.
const CODES = ['006485', '006663'];
const TYPES = new Set(['buy', 'sell', 'transfer-in', 'transfer-out']);
const CANCELLED = new Set(['cancelled', 'canceled', '撤单', '已撤单', '已撤销']);
const FIELDS = new Set(['id', 'submittedAt', 'date', 'type', 'amount', 'shares', 'sharesBasis', 'requestedShares', 'confirmedAmount', 'confirmedDate', 'nav', 'navDate', 'fee', 'status', 'sourceStatus', 'note']);
const invalid = () => { throw new Error('Invalid bond transactions.'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function date(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid();
  const stamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function numeric(value, positive = false) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (positive && value === 0)) invalid();
  return value;
}
export function normalizeBondTransactions(value) {
  if (value === undefined) return Object.fromEntries(CODES.map(code => [code, []]));
  if (!object(value) || Object.keys(value).some(code => !CODES.includes(code))) invalid();
  return Object.fromEntries(CODES.map(code => {
    const rows = value[code] ?? [];
    if (!Array.isArray(rows) || rows.length > 10000) invalid();
    const ids = new Set();
    return [code, rows.flatMap(row => {
      if (!object(row)) invalid();
      if (CANCELLED.has(row.status) || CANCELLED.has(row.sourceStatus)) return [];
      if (Object.keys(row).some(key => !FIELDS.has(key)) || typeof row.id !== 'string' || !row.id.trim() || row.id.length > 256 || ids.has(row.id) || !TYPES.has(row.type)) invalid();
      ids.add(row.id);
      const submittedAt = row.submittedAt || null;
      if (submittedAt !== null && (typeof submittedAt !== 'string' || submittedAt.length > 64 || /[\u0000-\u001f]/.test(submittedAt))) invalid();
      if (submittedAt !== null) date(submittedAt.slice(0, 10));
      const status = row.status ?? 'pending', sourceStatus = row.sourceStatus ?? (status === 'pending' ? 'unverified' : null);
      if (!['confirmed', 'pending'].includes(status) || ![null, 'confirmed', 'processing', 'unverified', 'calculated'].includes(sourceStatus)) invalid();
      const sharesBasis = row.sharesBasis ?? 'reported';
      if (!['reported', 'calculated'].includes(sharesBasis)) invalid();
      const shares = numeric(row.shares), nav = numeric(row.nav, true);
      if (status === 'confirmed' && (!(shares > 0) || !(nav > 0))) invalid();
      const note = row.note ?? null;
      if (note !== null && (typeof note !== 'string' || note.length > 4000 || /\u0000/.test(note))) invalid();
      return [{ id: row.id, submittedAt, date: date(row.date), type: row.type, amount: numeric(row.amount), shares, sharesBasis, requestedShares: numeric(row.requestedShares), confirmedAmount: numeric(row.confirmedAmount), confirmedDate: date(row.confirmedDate), nav, navDate: date(row.navDate), fee: numeric(row.fee), status, sourceStatus, note }];
    })];
  }));
}
