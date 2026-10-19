// Public rule constants only. Account inputs stay in memory and are not returned.
export const BOND_RESERVE_RULE = Object.freeze({
  minRatio: 1 / 6,
  maxRatio: 1 / 3,
  absoluteThreshold: 50000,
});

const validValue = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const unavailable = () => ({ status: 'unknown', ratio: null, reason: 'unavailable' });

function decimal(value) {
  const [coefficient, power = '0'] = value.toString().split('e');
  const [whole, fraction = ''] = coefficient.split('.');
  return { digits: BigInt(whole + fraction), power: Number(power) - fraction.length };
}

// Compare decimal inputs exactly at the inclusive proportional boundaries.
// Cross multiplication uses integers, avoiding both binary rounding and overflow.
function compareMultiple(value, multiple, reference) {
  const left = decimal(value);
  const right = decimal(reference);
  const power = Math.min(left.power, right.power);
  const a = left.digits * BigInt(multiple) * 10n ** BigInt(left.power - power);
  const b = right.digits * 10n ** BigInt(right.power - power);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Accept only numeric current market values. `complete` describes the equity
 * total: false means it is partial or unavailable, never a verified zero.
 * A known bond value may independently satisfy the strict absolute threshold.
 * The result exposes status and a ratio only; it contains no account amounts.
 */
export function evaluateBondReserve(input = {}) {
  const { equityValue, bondValue, complete = true } = input && typeof input === 'object' ? input : {};
  if (!validValue(bondValue)) return unavailable();

  const absoluteMet = bondValue > BOND_RESERVE_RULE.absoluteThreshold;
  if (complete !== true || !validValue(equityValue)) {
    return absoluteMet
      ? { status: 'met', ratio: null, reason: 'absolute-threshold' }
      : unavailable();
  }

  const scale = Math.max(equityValue, bondValue);
  if (scale === 0) return unavailable();
  const total = equityValue + bondValue;
  const ratio = Number.isFinite(total)
    ? bondValue / total
    : (bondValue / scale) / (equityValue / scale + bondValue / scale);
  // b / (e + b) >= 1/6 iff 5b >= e; <= 1/3 iff 2b <= e.
  const low = compareMultiple(bondValue, 5, equityValue) < 0;
  const high = compareMultiple(bondValue, 2, equityValue) > 0;
  if (!low && !high) return { status: 'met', ratio, reason: 'share-range' };
  if (absoluteMet) return { status: 'met', ratio, reason: 'absolute-threshold' };
  return { status: 'below', ratio, reason: low ? 'share-low' : 'share-high' };
}
