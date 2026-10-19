// Public identities from the user's verified ten-fund archive list.
// Inclusion here does not imply an account holding or a transaction.
export const FUND_CATALOG = [
  { code: '005698', short: '华夏', navLabel: '华夏科技', initial: '华', name: '华夏全球科技先锋', fullName: '华夏全球科技先锋混合（QDII）A', brand: 'huaxia', category: '混合 · QDII · 人民币 A', rate: '0.15' },
  { code: '270023', short: '广发', navLabel: '广发全球', initial: '广', name: '广发全球精选', fullName: '广发全球精选股票（QDII）人民币A', brand: 'guangfa', category: '股票 · QDII · 人民币 A', rate: '0.16' },
  { code: '006373', short: '国富', navLabel: '国富科技', initial: '国', name: '国富全球科技互联', fullName: '国富全球科技互联混合（QDII）人民币A', brand: 'guofu', category: '混合 · QDII · 人民币 A', rate: '0.15' },
  { code: '016701', short: '银华', navLabel: '银华数字', initial: '银', name: '银华海外数字经济', fullName: '银华海外数字经济量化选股混合发起式（QDII）A', brand: 'yinhua', category: '混合 · QDII · 人民币 A', rate: null },
  { code: '000216', short: '华安黄金', navLabel: '华安黄金', initial: '金', name: '华安黄金ETF联接A', fullName: '华安黄金ETF联接A', brand: 'huaan', category: '黄金 · ETF 联接 · A', rate: null },
  { code: '009608', short: '广发500', navLabel: '广发500', initial: '广', name: '广发中证500指数增强A', fullName: '广发中证500指数增强A', brand: 'guangfa', category: '指数增强 · 中证500 · A', rate: null },
  { code: '018124', short: '先进制造', navLabel: '先进制造', initial: '制', name: '永赢先进制造智选A', fullName: '永赢先进制造智选混合发起A', brand: 'yongying', category: '混合 · 先进制造 · A', rate: null },
  { code: '015789', short: '高端装备', navLabel: '高端装备', initial: '装', name: '永赢高端装备智选A', fullName: '永赢高端装备智选混合发起A', brand: 'yongying', category: '混合 · 高端装备 · A', rate: null },
  { code: '019454', short: '中韩半导体', navLabel: '中韩半导体', initial: '芯', name: '华泰柏瑞中韩半导体ETF联接A', fullName: '华泰柏瑞中韩半导体ETF发起式联接（QDII）A', brand: 'huatai', category: 'ETF 联接 · QDII · 人民币 A', rate: null },
  { code: '022459', short: '易方达A500', navLabel: '易方达A500', initial: '易', name: '易方达中证A500ETF联接A', fullName: '易方达中证A500ETF联接A', brand: 'efund', category: 'ETF 联接 · 中证A500 · A', rate: null },
];

// The archive is retained; the page shows only the user's current selection.
const VISIBLE_CODES = ['016701', '006373', '270023', '005698'];
export const FUNDS = VISIBLE_CODES.map(code => {
  const fund = FUND_CATALOG.find(entry => entry.code === code);
  return { ...fund, navLabel: fund.short };
});
export const FUND_CODES = FUNDS.map(fund => fund.code);
