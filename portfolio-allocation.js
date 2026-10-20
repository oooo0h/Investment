// Values are consumed in memory. The result contains proportions only.
export function calculatePortfolioAllocation(positions, codes) {
  const unavailable = () => ({ status: 'unavailable', shares: {} });
  if (!Array.isArray(positions) || !Array.isArray(codes) || !codes.length || new Set(codes).size !== codes.length || positions.length !== codes.length) return unavailable();
  const values = new Map();
  for (const row of positions) {
    if (!row || !codes.includes(row.code) || values.has(row.code) || !Number.isFinite(row.marketValue) || row.marketValue < 0) return unavailable();
    values.set(row.code, row.marketValue);
  }
  const total = [...values.values()].reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) return unavailable();
  return { status: 'available', shares: Object.fromEntries(codes.map(code => [code, values.get(code) / total])) };
}

export function holdingLimitFrom(rule) {
  if (rule?.id !== 'us-exposure' || typeof rule.title !== 'string' || typeof rule.detail !== 'string' || rule.title.length + rule.detail.length > 20000) return null;
  const text = `${rule.title}${rule.detail}`.replace(/\*\*|【|】|\s/g, '').replaceAll('％', '%');
  const matches = [...text.matchAll(/降低该基金持仓至总持仓的(\d+(?:\.\d+)?)%/g)];
  if (matches.length !== 1) return null;
  const end = text.slice(matches[0].index + matches[0][0].length);
  if (!/^(?:$|[，,。；;])/.test(end)) return null;
  const percent = Number(matches[0][1]);
  return Number.isFinite(percent) && percent > 0 && percent <= 100 ? percent / 100 : null;
}

export function evaluateHoldingLimit(exposure, rule, allocationRatio) {
  const targetRatio = holdingLimitFrom(rule);
  const result = { status: 'unavailable', targetRatio, allocationRatio: Number.isFinite(allocationRatio) && allocationRatio >= 0 && allocationRatio <= 1 ? allocationRatio : null };
  if (exposure?.status === 'met') return { ...result, status: 'not-applicable' };
  if (exposure?.status !== 'below' || targetRatio === null || result.allocationRatio === null) return result;
  return { ...result, status: result.allocationRatio > targetRatio ? 'above' : 'within' };
}
