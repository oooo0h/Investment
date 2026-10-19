const beijingToday = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
const valid = date => {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const stamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === date;
};

// Keep an ISO ledger date and a slash-separated display. Invalid days never roll.
export function parseTransactionDate(raw, { today = beijingToday() } = {}) {
  const fail = () => ({ date: null, display: '', error: '请输入有效日期，例如 1019 或 2026/10/19。' });
  if (typeof raw !== 'string' || !valid(today)) return fail();
  const text = raw.normalize('NFKC').trim().replace(/\s+/g, '');
  if (!text) return fail();
  if (/^(?:今天|今日|today)$/i.test(text)) return { date: today, display: today.replaceAll('-', '/'), error: '' };
  const currentYear = Number(today.slice(0, 4));
  let year = currentYear, month, day, match;
  if (/^\d{8}$/.test(text)) [year, month, day] = [text.slice(0, 4), text.slice(4, 6), text.slice(6)].map(Number);
  else if (/^\d{6}$/.test(text)) {
    year = Math.floor(currentYear / 100) * 100 + Number(text.slice(0, 2));
    if (year > currentYear + 20) year -= 100;
    month = Number(text.slice(2, 4)); day = Number(text.slice(4));
  } else if (/^\d{4}$/.test(text)) { month = Number(text.slice(0, 2)); day = Number(text.slice(2)); }
  else {
    const separated = text.replaceAll('年', '/').replaceAll('月', '/').replace(/日$/, '').replace(/[.-]/g, '/');
    if ((match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(separated))) [year, month, day] = match.slice(1).map(Number);
    else if ((match = /^(\d{1,2})\/(\d{1,2})$/.exec(separated))) [month, day] = match.slice(1).map(Number);
    else return fail();
  }
  if (!Number.isInteger(year) || year < 1000 || year > 9999 || !Number.isInteger(month) || !Number.isInteger(day)) return fail();
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return valid(date) ? { date, display: date.replaceAll('-', '/'), error: '' } : fail();
}
