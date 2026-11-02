// Public fund percentages transcribed from the user's comparison screenshot.
// The screenshot does not specify a reporting or publication date; its receipt
// date must not be presented as either. No investor account values are stored.
const source = Object.freeze({
  type: 'user-screenshot',
  title: '用户提供的上市地区配置截图',
  updatedAt: '2026-10-28',
  url: null,
});
const report = (regions, totalPercent, roundingNote = '') => Object.freeze({
  asOf: null,
  publishedAt: null,
  basis: 'equity-region-percent-of-nav',
  totalPercent,
  regions: Object.freeze(regions.map(([name, percent]) => Object.freeze({ name, percent }))),
  source,
  note: `股票及存托凭证，按上市交易市场统计；来源为用户提供截图，统计截止日及公告日待确认。${roundingNote}`,
});

export const REGION_DATA = Object.freeze({
  '005698': report([
    ['美国', 26.17],
    ['中国内地', 36.53],
    ['中国香港', 16.72],
  ], 79.43, '分项与合计保留截图原值，存在0.01个百分点的差异，未作归一化。'),
  '006373': report([
    ['美国', 79.85],
    ['中国内地', 1.17],
    ['中国香港', 2.79],
    ['日本', 4.52],
  ], 88.32, '分项与合计保留截图原值，存在0.01个百分点的差异，未作归一化。'),
  '016701': report([
    ['美国', 87.52],
    ['中国香港', 2.48],
  ], 90.00),
  '270023': report([
    ['美国', 55.62],
    ['中国内地', 16.06],
    ['中国香港', 8.22],
    ['日本', 4.50],
    ['韩国', 4.52],
  ], 88.92),
});
