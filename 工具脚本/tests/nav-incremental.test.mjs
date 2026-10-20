import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecentWindow } from '../nav_incremental_core.mjs';

const rows = Array.from({ length: 6 }, (_, index) => ({ date: `2026-10-${String(8 + index).padStart(2, '0')}`, nav: '2.0000', accumulated_nav: '2.0000', daily_growth_pct: '0.00', event: '', source: 'archive' }));
const old = { code: '005698', count: rows.length, first_date: rows[0].date, last_date: rows.at(-1).date, rows };
const source = row => ({ FSRQ: row.date, DWJZ: row.nav, LJJZ: row.accumulated_nav, JZZZL: row.daily_growth_pct, FHSP: row.event });
test('fills the whole gap and retains untouched archive rows and precision', () => {
  const incoming = [...rows.slice(1), { ...rows[0], date: '2026-10-14', nav: '2.123400' }, { ...rows[0], date: '2026-10-15', nav: '2.2000' }].map(source);
  const result = mergeRecentWindow(old, incoming, { asOf: '2026-10-19', sourceTotal: 8 });
  assert.deepEqual(result.added_dates, ['2026-10-14', '2026-10-15']);
  assert.equal(result.rows[0], old.rows[0]);
  assert.equal(result.rows.at(-2).nav, '2.123400');
  assert.equal(result.conflicts.length, 0);
});
test('same numeric decimal with different trailing zeros is idempotent', () => {
  const incoming = rows.map(row => source({ ...row, nav: '2', accumulated_nav: '2.0' }));
  const result = mergeRecentWindow(old, incoming, { asOf: '2026-10-19', sourceTotal: 6 });
  assert.equal(result.changed, false);
  assert.equal(result.rows.at(-1).nav, '2.0000');
});
test('retains explicit revision evidence and refuses source regression', () => {
  const incoming = rows.map(source);
  incoming.at(-1).DWJZ = '2.0001';
  incoming.at(-2).LJJZ = null;
  const result = mergeRecentWindow(old, incoming, { asOf: '2026-10-19', sourceTotal: 6 });
  assert.equal(result.revisions[0].previous.nav, '2.0000');
  assert.equal(result.revisions[0].current.nav, '2.0001');
  assert.equal(result.conflicts[0].field, 'accumulated_nav');
});
test('rejects insufficient overlap, duplicate dates and future dates', () => {
  assert.throws(() => mergeRecentWindow(old, rows.slice(2).map(source), { asOf: '2026-10-19' }));
  assert.throws(() => mergeRecentWindow(old, [...rows, rows[0]].map(source), { asOf: '2026-10-19' }), /Duplicate/);
  assert.throws(() => mergeRecentWindow(old, [...rows, { ...rows[0], date: '2026-10-20' }].map(source), { asOf: '2026-10-19' }), /future/);
});
test('missing previously archived source date and changed total remain conflicts', () => {
  const result = mergeRecentWindow(old, rows.filter(row => row.date !== '2026-10-11').map(source), { asOf: '2026-10-19', sourceTotal: 7 });
  assert.ok(result.conflicts.some(item => item.field === 'date'));
  assert.ok(result.conflicts.some(item => item.field === 'source_total_count'));
});
