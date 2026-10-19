// Public fund disclosures only. Percentages use fund net assets as the
// denominator, not the value of the equity portfolio or an investor's account.
// Countries/regions follow the listing markets in each report's section 7.2.
const report = (regions, metadata) => Object.freeze({
  asOf: '2026-06-30',
  basis: 'equity-region-percent-of-nav',
  ...metadata,
  regions: Object.freeze(regions.map(([name, percent]) => Object.freeze({ name, percent }))),
  source: Object.freeze(metadata.source),
});

export const REGION_DATA = Object.freeze({
  '005698': report([
    ['美国', 16.66],
    ['中国内地', 36.61],
    ['中国香港', 23.17],
  ], {
    publishedAt: '2026-08-31',
    totalPercent: 76.44,
    source: {
      title: '华夏全球科技先锋混合型证券投资基金（QDII）2026年中期报告',
      url: 'https://www.chinaamc.com/upload/resources/file/2026/08/31/010b766eb4fd4326b232f0aa4377a483.pdf',
    },
    note: '直接股票口径，不含ETF与衍生品穿透；含存托凭证，按上市交易市场统计。',
  }),
  '270023': report([
    ['美国', 46.65],
    ['中国', 17.43],
    ['中国香港', 12.81],
    ['日本', 7.56],
    ['韩国', 3.08],
  ], {
    publishedAt: '2026-08-31',
    totalPercent: 87.53,
    source: {
      title: '广发全球精选股票型证券投资基金2026年中期报告',
      url: 'https://www.gffunds.com.cn/jjgg/dqgg/202608/P020260831322788141588.pdf',
    },
    note: '直接股票口径，不含ETF与衍生品穿透；含存托凭证，按上市交易市场统计。',
  }),
  '016701': report([
    ['美国', 87.89],
    ['中国香港', 2.55],
  ], {
    publishedAt: '2026-08-29',
    totalPercent: 90.45,
    source: {
      title: '银华海外数字经济量化选股混合型发起式证券投资基金（QDII）2026年中期报告',
      url: 'https://pdf.dfcfw.com/pdf/H2_AN202608291828680755_1.pdf',
    },
    note: '直接股票及存托凭证口径，按上市交易市场统计；分项与合计存在四舍五入差异。',
  }),
  '006373': report([
    ['美国', 71.95],
    ['日本', 8.74],
    ['中国香港', 3.47],
    ['中国', 1.14],
  ], {
    publishedAt: '2026-08-31',
    totalPercent: 85.29,
    source: {
      title: '富兰克林国海全球科技互联混合型证券投资基金（QDII）2026年中期报告',
      url: 'https://www.ftsfund.com/ftp/upload/file/202608/28/PELfmhqycOkMVkFw.pdf',
    },
    note: '直接股票及存托凭证口径，按上市交易市场统计；分项与合计存在四舍五入差异。',
  }),
});
