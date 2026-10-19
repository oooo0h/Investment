// User-defined public rule parameters, never actual account balances or trades.
const BASE_ADD_BUDGET = 10000;

/** The fixed budget is a rule setting, not an account amount. */
export function getDisciplineActions(exposure) {
  const adjusted = exposure?.status === 'below';
  return {
    addBudget: adjusted ? BASE_ADD_BUDGET / 2 : BASE_ADD_BUDGET,
    addMultiplier: adjusted ? .5 : 1,
    sellMultiplier: adjusted ? 2 : 1,
    adjusted,
  };
}

function doubledReduction(text) {
  return text.replace(/(减仓\s*)(\d+(?:\.\d+)?|\.\d+)(\s*[%％])/g, (match, action, percent, unit) => {
    const value = Number(percent);
    return Number.isFinite(value) ? `${action}${Math.min(100, value * 2)}${unit}` : match;
  });
}

function fullSale(text) {
  // This action selects at least half a position before doubling; 100% is its cap.
  // Match the action phrase itself, leaving the 100% trigger and all other text intact.
  return text.replace(/清除本金\s*[/／]\s*卖出一半持仓(?:\s*[，,]\s*选金额大的|\s*等等)?/g, '全部卖出');
}

/**
 * Derive display copy from an ORIGINAL rule without mutating it. Trigger text
 * is never scaled. Only the two current, recognized sale action IDs are supported.
 * Callers should keep the original rule as their source of truth.
 */
export function adjustDisciplineRule(rule, exposure) {
  if (!getDisciplineActions(exposure).adjusted || !rule || typeof rule !== 'object' || Array.isArray(rule)) return rule;
  const transform = rule.id === 'annual-profit-multiple' ? doubledReduction
    : rule.id === 'annual-profit-100' ? fullSale : null;
  if (!transform) return rule;
  const title = typeof rule.title === 'string' ? transform(rule.title) : rule.title;
  const detail = typeof rule.detail === 'string' ? transform(rule.detail) : rule.detail;
  return title === rule.title && detail === rule.detail ? rule : { ...rule, title, detail };
}
