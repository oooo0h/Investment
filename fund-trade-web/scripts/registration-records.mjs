// Website registration metadata: the workbook keeps the NAV date in column A,
// while the real order date and cutoff stay here. No amounts or shares.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FILE = 'local/registration-records.json';
const CODE = /^\d{6}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MODES = new Set(['buy', 'sell']);
const STATUSES = new Set(['filled', 'awaiting']);

function normalize(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid registration record.');
  if (typeof record.id !== 'string' || !/^registration-[a-z0-9-]{6,80}$/i.test(record.id)) throw new Error('Invalid registration record.');
  if (!CODE.test(record.code) || !Number.isInteger(record.row) || record.row < 2 || record.row > 100000) throw new Error('Invalid registration record.');
  if (!MODES.has(record.mode) || !DATE.test(record.orderDate) || !DATE.test(record.navDate) || !['before', 'after'].includes(record.cutoff)) throw new Error('Invalid registration record.');
  if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) throw new Error('Invalid registration record.');
  const status = record.status ?? 'filled';
  if (!STATUSES.has(status)) throw new Error('Invalid registration record.');
  return { id: record.id, code: record.code, row: record.row, mode: record.mode, orderDate: record.orderDate,
    navDate: record.navDate, cutoff: record.cutoff, status, createdAt: record.createdAt };
}

export async function readRegistrationRecords({ root }) {
  let bytes;
  try { bytes = await readFile(path.join(root, FILE), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  let payload;
  try { payload = JSON.parse(bytes); } catch { throw new Error('Invalid registration records.'); }
  if (!payload || payload.version !== 1 || !Array.isArray(payload.records)) throw new Error('Invalid registration records.');
  const seen = new Set();
  return payload.records.map(record => {
    const next = normalize(record);
    if (seen.has(next.id)) throw new Error('Invalid registration records.');
    seen.add(next.id);
    return next;
  });
}

export async function writeRegistrationRecords({ root }, records) {
  const list = records.map(normalize);
  const seen = new Set();
  for (const record of list) { if (seen.has(record.id)) throw new Error('Invalid registration records.'); seen.add(record.id); }
  await mkdir(path.join(root, 'local'), { recursive: true });
  const target = path.join(root, FILE);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, records: list }, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
  return list;
}

export function applyRegistrationStates(transactions, code, records) {
  const byId = new Map(records.filter(record => record.code === code).map(record => [`${code}-workbook-${record.row}`, record]));
  if (!byId.size) return transactions;
  return transactions.map(transaction => {
    const record = byId.get(transaction.id);
    if (!record) return transaction;
    const base = { ...transaction, dateBasis: 'nav', submittedAt: record.orderDate, orderDate: record.orderDate,
      navDate: record.navDate, registrationId: record.id, registrationStatus: record.status };
    return record.status === 'awaiting'
      ? { ...base, status: 'pending', sourceStatus: 'processing' }
      : base;
  });
}
