// Structural publication checks. These functions never decrypt or log inputs.
const invalidEnvelope = () => { throw new Error('Invalid encrypted envelope.'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const base64 = (value, length) => typeof value === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  && Buffer.from(value, 'base64').toString('base64') === value && (length === undefined || Buffer.from(value, 'base64').length === length);
const calendar = Array.from({ length: 366 }, (_, index) => new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(5, 10).replace('-', ''));
export function validateEncryptedEnvelope(value) {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'ciphertext,iterations,iv,kdf,keys,version'
    || value.version !== 2 || value.kdf !== 'PBKDF2-SHA256' || value.iterations !== 600000
    || !base64(value.iv, 12) || !base64(value.ciphertext) || Buffer.from(value.ciphertext, 'base64').length < 16
    || !object(value.keys) || Object.keys(value.keys).length !== calendar.length) invalidEnvelope();
  for (const day of calendar) {
    const key = value.keys[day];
    if (!object(key) || Object.keys(key).sort().join(',') !== 'ciphertext,iv,salt'
      || !base64(key.salt, 16) || !base64(key.iv, 12) || !base64(key.ciphertext, 48)) invalidEnvelope();
  }
  return value;
}
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export function validatePublicNav(value, code) {
  const fail = () => { throw new Error('Invalid public NAV.'); };
  const fields = new Set(['code', 'name', 'history', 'firstDate', 'lastDate', 'count', 'verifiedAt', 'sourceLabel', 'source', 'sourcePath', 'supplementaryCount', 'sourceType', 'asOf']);
  if (!object(value) || value.code !== code || !/^\d{6}$/.test(code) || Object.keys(value).some(key => !fields.has(key)) || !Array.isArray(value.history) || !value.history.length) fail();
  let prior = '';
  for (const row of value.history) {
    if (!object(row) || Object.keys(row).some(key => !['date', 'nav', 'navRaw', 'accumulatedNavRaw', 'dailyGrowthPctRaw'].includes(key))
      || !validDate(row.date) || row.date <= prior || !Number.isFinite(row.nav) || row.nav <= 0) fail();
    prior = row.date;
  }
  if (value.count !== undefined && value.count !== value.history.length || value.firstDate !== undefined && value.firstDate !== value.history[0].date
    || value.lastDate !== undefined && value.lastDate !== prior || value.asOf !== undefined && value.asOf !== prior) fail();
  return value;
}
