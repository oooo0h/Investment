// Pure evaluation of a standing rule against public fund disclosures only.
// A missing rule or disclosure is unknown, never a zero-percent allocation.
function thresholdFrom(rule) {
  if (!rule || rule.id !== 'us-exposure' || typeof rule.title !== 'string'
    || typeof rule.detail !== 'string' || rule.title.length + rule.detail.length > 20000) return null;
  const text = `${rule.title}\n${rule.detail}`.replace(/\*\*|【|】/g, '').replace(/\s+/g, '').replaceAll('％', '%');
  const matches = [...text.matchAll(/美股含量低于(\d+(?:\.\d+)?)%/g)];
  if (matches.length !== 1 || (text.match(/美股含量低于/g) || []).length !== 1) return null;
  const match = matches[0], following = text.slice(match.index + match[0].length);
  // Require an explicit end to the condition. Approximate, ranged and compound
  // thresholds cannot silently turn into a single strict comparison.
  if (!/^(?:$|[，,。；;！？!?]|则|时|就|应|需|须|必须|立刻|立即)/.test(following)
    || /^[，,]?(?:或者|或|以及|且|并且|同时|大约|约|左右|上下|[~～至到])/.test(following)) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 && value <= 100 ? value : null;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function publicSource(value) {
  if (!value || typeof value.title !== 'string' || !value.title.trim()
    || value.title.length > 1000 || typeof value.url !== 'string' || value.url.length > 4000
    || /[\u0000-\u001f]/.test(value.title + value.url)) return null;
  try {
    const url = new URL(value.url), host = url.hostname.replace(/\.$/, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')
      || /\.(?:localhost|local|internal|invalid|test)$/.test(host)) return null;
    return { title: value.title.trim(), url: url.href };
  } catch { return null; }
}

function disclosureFrom(disclosure) {
  if (!disclosure || disclosure.basis !== 'equity-region-percent-of-nav'
    || !validDate(disclosure.asOf) || !Array.isArray(disclosure.regions)
    || !disclosure.regions.length) return null;
  const source = publicSource(disclosure.source);
  if (!source) return null;
  const publishedAt = disclosure.publishedAt ?? null;
  if (publishedAt !== null && (!validDate(publishedAt) || publishedAt < disclosure.asOf)) return null;
  const names = new Set();
  let usPercent = null;
  for (const region of disclosure.regions) {
    if (!region || typeof region.name !== 'string' || !region.name.trim()
      || typeof region.percent !== 'number' || !Number.isFinite(region.percent)
      || region.percent < 0 || region.percent > 100) return null;
    const name = region.name.trim();
    if (names.has(name)) return null;
    names.add(name);
    if (name === '美国') usPercent = region.percent;
  }
  return usPercent === null ? null : { usPercent, asOf: disclosure.asOf, publishedAt, source };
}

/** Evaluate raw public percentages; gapPercent is the nonnegative shortfall. */
export function evaluateUsExposure(rule, disclosure) {
  const thresholdPercent = thresholdFrom(rule), report = disclosureFrom(disclosure);
  const result = {
    status: 'unavailable', thresholdPercent, usPercent: null, gapPercent: null,
    asOf: null, publishedAt: null, source: null,
    ...report,
  };
  if (thresholdPercent !== null && report !== null) {
    result.status = report.usPercent < thresholdPercent ? 'below' : 'met';
    result.gapPercent = Math.max(0, thresholdPercent - report.usPercent);
  }
  return result;
}
