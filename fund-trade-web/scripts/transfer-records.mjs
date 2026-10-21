// Transfer pairing metadata only: fund codes, workbook rows, dates and state.
// Amounts and shares stay in the workbooks and are never duplicated here.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FILE = 'local/transfer-records.json';
const STATUSES = new Set(['awaiting', 'filled', 'reviewed', 'partial']);
const code = value => typeof value === 'string' && /^\d{6}$/.test(value);
const row = value => Number.isInteger(value) && value >= 2 && value <= 100000;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function normalize(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid transfer record.');
  if (typeof record.id !== 'string' || !/^transfer-[a-z0-9-]{6,80}$/i.test(record.id)) throw new Error('Invalid transfer record.');
  if (!code(record.outCode) || !code(record.inCode) || record.outCode === record.inCode) throw new Error('Invalid transfer record.');
  if (!row(record.outRow) || !row(record.inRow)) throw new Error('Invalid transfer record.');
  if (!date(record.orderDate) || !date(record.navDate) || !['before', 'after'].includes(record.cutoff)) throw new Error('Invalid transfer record.');
  if (!STATUSES.has(record.status) || !stamp(record.createdAt)) throw new Error('Invalid transfer record.');
  const next = { id: record.id, outCode: record.outCode, inCode: record.inCode, outRow: record.outRow, inRow: record.inRow,
    orderDate: record.orderDate, navDate: record.navDate, cutoff: record.cutoff, status: record.status,
    createdAt: record.createdAt };
  if (record.filledAt !== undefined) { if (!stamp(record.filledAt)) throw new Error('Invalid transfer record.'); next.filledAt = record.filledAt; }
  if (record.reviewedAt !== undefined) { if (!stamp(record.reviewedAt)) throw new Error('Invalid transfer record.'); next.reviewedAt = record.reviewedAt; }
  if (record.note !== undefined) { if (typeof record.note !== 'string' || record.note.length > 200) throw new Error('Invalid transfer record.'); next.note = record.note; }
  return next;
}

export async function readTransferRecords({ root }) {
  let bytes;
  try { bytes = await readFile(path.join(root, FILE), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  let payload;
  try { payload = JSON.parse(bytes); } catch { throw new Error('Invalid transfer records.'); }
  if (!payload || payload.version !== 1 || !Array.isArray(payload.records)) throw new Error('Invalid transfer records.');
  const seen = new Set();
  return payload.records.map(record => {
    const next = normalize(record);
    if (seen.has(next.id)) throw new Error('Invalid transfer records.');
    seen.add(next.id);
    return next;
  });
}

export async function writeTransferRecords({ root }, records) {
  const list = records.map(normalize);
  const seen = new Set();
  for (const record of list) { if (seen.has(record.id)) throw new Error('Invalid transfer records.'); seen.add(record.id); }
  const directory = path.join(root, 'local');
  await mkdir(directory, { recursive: true });
  const target = path.join(root, FILE);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, records: list }, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
  return list;
}

// Pending transfers stay visible but never block the whole fund summary. The
// reviewed state returns to the normal workbook-estimated status.
export function applyTransferStates(transactions, codeValue, records) {
  const byId = new Map();
  for (const record of records) {
    if (record.outCode === codeValue) byId.set(`${codeValue}-workbook-${record.outRow}`, record);
    if (record.inCode === codeValue) byId.set(`${codeValue}-workbook-${record.inRow}`, record);
  }
  if (!byId.size) return transactions;
  return transactions.map(transaction => {
    const record = byId.get(transaction.id);
    if (!record) return transaction;
    const paired = { ...transaction, transferId: record.id, dateBasis: 'nav', submittedAt: record.orderDate, orderDate: record.orderDate };
    if (record.status === 'reviewed') return { ...paired, transferStatus: 'reviewed' };
    return { ...paired, status: 'pending', sourceStatus: 'processing',
      transferStatus: record.status === 'filled' ? 'review' : record.status };
  });
}

export function transferCounts(records) {
  return records.reduce((counts, record) => {
    if (record.status === 'reviewed') counts.reviewed += 1;
    else if (record.status === 'filled') counts.review += 1;
    else counts.awaiting += 1;
    return counts;
  }, { awaiting: 0, review: 0, reviewed: 0, total: records.length });
}
