import assert from 'node:assert/strict';

export function decimal(value) {
  if (value === null || value === undefined || ['', '--', '---', '-'].includes(String(value).trim())) return null;
  const text = String(value).trim();
  assert.match(text, /^[+-]?\d+(?:\.\d+)?$/, 'Invalid public decimal');
  assert.ok(Number.isFinite(Number(text)), 'Non-finite public decimal');
  return text;
}

function decimalKey(value) {
  const text = decimal(value);
  if (text === null) return null;
  const negative = text.startsWith('-');
  const [integer, fraction = ''] = text.replace(/^[+-]/, '').split('.');
  const digits = (integer.replace(/^0+(?=\d)/, '') || '0') + (fraction.replace(/0+$/, '') ? '.' + fraction.replace(/0+$/, '') : '');
  return negative && digits !== '0' ? '-' + digits : digits;
}

export function normalizeSourceRow(row) {
  assert.match(row.FSRQ ?? '', /^\d{4}-\d{2}-\d{2}$/);
  const nav = decimal(row.DWJZ);
  assert.ok(nav !== null && Number(nav) > 0, 'Missing or non-positive public unit NAV');
  return { date: row.FSRQ, nav, accumulated_nav: decimal(row.LJJZ), daily_growth_pct: decimal(row.JZZZL), event: String(row.FHSP || row.FHFCZ || ''), source: '天天基金 f10/lsjz（公开第三方）' };
}

export function validateHistory(doc) {
  assert.match(doc.code, /^\d{6}$/);
  assert.equal(doc.count, doc.rows.length);
  assert.ok(doc.rows.length >= 5, 'Insufficient archive history');
  const dates = doc.rows.map(row => row.date);
  assert.equal(new Set(dates).size, dates.length, 'Duplicate archived dates');
  assert.deepEqual(dates, [...dates].sort(), 'Unsorted archived dates');
  assert.equal(doc.first_date, dates[0]);
  assert.equal(doc.last_date, dates.at(-1));
  for (const row of doc.rows) {
    assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(decimal(row.nav) !== null && Number(row.nav) > 0);
    decimal(row.accumulated_nav);
    decimal(row.daily_growth_pct);
  }
}

// Changes are compared by exact decimal value; archive precision and older rows
// are retained. A source regression is an explicit conflict, never a deletion.
export function mergeRecentWindow(old, incoming, { asOf, sourceTotal } = {}) {
  validateHistory(old);
  const rows = incoming.map(normalizeSourceRow).sort((a, b) => a.date.localeCompare(b.date));
  assert.ok(rows.length >= 5, 'Fewer than five published dates');
  const byDate = new Map(rows.map(row => [row.date, row]));
  assert.equal(byDate.size, rows.length, 'Duplicate source dates');
  assert.ok(rows.at(-1).date <= asOf, 'Source contains a future NAV date');
  assert.ok(rows.at(-1).date >= old.last_date, 'Source is behind the current archive');
  assert.ok(rows[0].date <= old.rows.at(-5).date, 'Window does not cover the last five archived dates and the gap');
  const oldByDate = new Map(old.rows.map(row => [row.date, row]));
  const conflicts = [];
  for (const previous of old.rows.filter(row => row.date >= rows[0].date)) {
    if (!byDate.has(previous.date)) conflicts.push({ date: previous.date, field: 'date', reason: 'Archived date missing from source window' });
  }
  const changes = [];
  const addedDates = [];
  const merged = new Map(old.rows.map(row => [row.date, row]));
  for (const row of rows) {
    const previous = oldByDate.get(row.date);
    if (!previous) {
      addedDates.push(row.date);
      merged.set(row.date, row);
      continue;
    }
    const fields = [];
    for (const field of ['nav', 'accumulated_nav', 'daily_growth_pct']) {
      if (decimal(row[field]) === null && decimal(previous[field]) !== null) {
        conflicts.push({ date: row.date, field, reason: 'Source now omits an archived value' });
      } else if (decimalKey(previous[field]) !== decimalKey(row[field])) fields.push(field);
    }
    if (String(previous.event ?? '') !== row.event) fields.push('event');
    if (fields.length) {
      changes.push({ date: row.date, fields, previous, current: row });
      merged.set(row.date, row);
    }
  }
  const mergedRows = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (Number.isInteger(sourceTotal) && sourceTotal !== mergedRows.length) conflicts.push({ field: 'source_total_count', reason: 'Source total differs from preserved archive plus window', source_total: sourceTotal, merged_count: mergedRows.length });
  return { rows: mergedRows, added_dates: addedDates, revisions: changes, conflicts, latest_date: rows.at(-1).date, checked_dates: rows.slice(-5).map(row => row.date), window_first_date: rows[0].date, window_count: rows.length, changed: addedDates.length > 0 || changes.length > 0 };
}
