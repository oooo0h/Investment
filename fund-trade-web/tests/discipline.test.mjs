// Read only the user's standing text and the public display model, never accounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as discipline from '../src/discipline.js';
import { evaluateUsExposure } from '../src/us-exposure.js';
import { evaluateAnnualDiscipline, evaluateAddDiscipline } from '../src/nav-annualized.js';
import { getDisciplineActions, adjustDisciplineRule } from '../src/discipline-actions.js';

const { DISCIPLINE_ENTRIES, parseDisciplineMarkdown } = discipline;
const EXPECTED = [
  ['us-exposure', '基金持有量按美股含量确定。', '如果美股含量低于40%，则【立刻】降低该基金持仓。'],
  ['us-exposure-adjustment', '美股含量不达标的基金，加仓金额/比例【减半】，卖出金额/比例【翻倍】。', ''],
  ['long-term', '一定要坚定长期持有。', '这是收益最大化的途径，但同时也是回撤最大的，一定要坚持下来。'],
  ['bond-reserve', '债基占总持仓的【1/6～1/3】，或债基持仓大于【5万元】。', '既可以做压舱石，也可以择机加仓。'],
  ['equity-scope', '基金的数量一定要精简，绝对不能开超市', '。目前暂定：银华、国富、广发、华夏。'],
  ['annual-profit', '止盈纪律', ''],
  ['annual-profit-100', '如果本年的年内涨幅收益率达到了100%，【一定】要大幅止盈（清除本金/卖出一半持仓，选金额大的）', ''],
  ['annual-profit-multiple', '如果本年的年内涨幅收益率超过了 平均年化收益率 的 3倍，【一定】要适当止盈（减仓20%）', ''],
  ['add-discipline', '加仓纪律， 加仓一定要是【少频次，高金额】的。', ''],
  ['add-discipline-decline', '自上次交易节点后，跌幅超过了 平均年化收益率 的2倍，进行一次加仓（1w元）', ''],
];
const CURRENT_SOURCE_EXPECTED = EXPECTED;

test('the fallback keeps four standing paragraphs and both groups without the deleted standalone frequency rule', () => {
  assert.deepEqual(DISCIPLINE_ENTRIES.map(entry => [entry.id, entry.title, entry.detail]), EXPECTED);
  assert.equal(new Set(DISCIPLINE_ENTRIES.map(entry => entry.id)).size, 10);
  assert.ok(!DISCIPLINE_ENTRIES.some(entry => entry.id === 'trade-frequency'));
  assert.ok(Object.isFrozen(DISCIPLINE_ENTRIES));
  assert.ok(DISCIPLINE_ENTRIES.every(entry => Object.isFrozen(entry)));
});

test('every current paragraph, parent heading and numbered condition retains its source text', async () => {
  const source = await readFile(new URL('../../交易纪律.md', import.meta.url), 'utf8');
  const paragraphs = source.split(/\r?\n/).filter(line => line.trim() && !/^#\s*交易纪律\s*$/.test(line));
  const plain = paragraphs.map(line => line.trim().replace(/^\d+(?:\.\d+)*(?:\.)?\s*/, '').replaceAll('**', '').replace(/\s+/g, ''));
  const parsed = parseDisciplineMarkdown(source);
  assert.deepEqual(plain, parsed.map(({ title, detail }) => (title + detail).replace(/\s+/g, '')));
  assert.deepEqual(parsed.map(({ id }) => id), EXPECTED.map(([id]) => id));
  assert.deepEqual(parsed.map(({ title, detail }) => (title + detail).replace(/\s+/g, '')), CURRENT_SOURCE_EXPECTED.map(([, title, detail]) => (title + detail).replace(/\s+/g, '')));
  const annual = parsed.find(entry => entry.id === 'annual-profit');
  assert.deepEqual(annual, { id: 'annual-profit', title: '止盈纪律', detail: '' });
  assert.match(parsed.find(entry => entry.id === 'annual-profit-100').title, /100%.*【一定】要大幅止盈/);
  assert.match(parsed.find(entry => entry.id === 'annual-profit-multiple').title, /3倍.*【一定】要适当止盈/);
  assert.match(parsed.find(entry => entry.id === 'add-discipline').title, /加仓纪律.*【少频次，高金额】/);
  assert.match(parsed.find(entry => entry.id === 'add-discipline-decline').title, /自上次交易节点后.*平均年化收益率.*2倍.*一次加仓/);
  assert.ok(!parsed.some(entry => entry.id === 'trade-frequency'));
});

test('the parser strips bold syntax, preserves emphasis brackets, and handles wrapped numbered rules', () => {
  const parsed = parseDisciplineMarkdown('\uFEFF# 交易纪律\r\n\r\n1. **原文主句。** 其余 **40%**\r\n   【立刻】照原文。\r\n\r\n8. 新增原文【保留】');
  assert.deepEqual(parsed, [
    { id: 'us-exposure', title: '原文主句。', detail: '其余 40% 【立刻】照原文。' },
    { id: 'discipline-8', title: '新增原文【保留】', detail: '' },
  ]);
});

test('emphasis inside an annual condition cannot reorder its threshold text', () => {
  const [entry] = parseDisciplineMarkdown('6.2 年内涨幅超过平均年化收益率的 **3倍**，【一定】要适当止盈。');
  assert.equal(entry.id, 'annual-profit-multiple');
  assert.equal(entry.title, '年内涨幅超过平均年化收益率的 3倍，【一定】要适当止盈。');
  assert.equal(entry.detail, '');
});

test('Chinese child markers without spaces and an unclosed bold heading preserve independent rules', () => {
  assert.deepEqual(parseDisciplineMarkdown('**基金持有量按美股含量确定。** 如果美股含量低于 **40%**，则降低持仓。\n\t1.1美股含量不达标，加仓【减半】，卖出【翻倍】。\n\n**加仓纪律，少频次高金额。\n7.1自上次交易节点后，跌幅超过平均年化收益率的2倍，进行一次加仓（1w元）'), [
    { id: 'us-exposure', title: '基金持有量按美股含量确定。', detail: '如果美股含量低于 40%，则降低持仓。' },
    { id: 'us-exposure-adjustment', title: '美股含量不达标，加仓【减半】，卖出【翻倍】。', detail: '' },
    { id: 'add-discipline', title: '加仓纪律，少频次高金额。', detail: '' },
    { id: 'add-discipline-decline', title: '自上次交易节点后，跌幅超过平均年化收益率的2倍，进行一次加仓（1w元）', detail: '' },
  ]);
  assert.deepEqual(parseDisciplineMarkdown('8. **用户完整正文'), [
    { id: 'discipline-8', title: '用户完整正文', detail: '' },
  ]);
});

test('nested rules keep independent stable identities and never become parent condition text', () => {
  assert.deepEqual(parseDisciplineMarkdown('6. 止盈纪律\n6.1 第一条件 **100%**\n6.2. 第二条件 **3倍**\n  6.3 用户新增条件\n    6.3.1 **更深层原文** 细节\n7. 另一条'), [
    { id: 'annual-profit', title: '止盈纪律', detail: '' },
    { id: 'annual-profit-100', title: '第一条件 100%', detail: '' },
    { id: 'annual-profit-multiple', title: '第二条件 3倍', detail: '' },
    { id: 'discipline-6-3', title: '用户新增条件', detail: '' },
    { id: 'discipline-6-3-1', title: '更深层原文', detail: '细节' },
    { id: 'add-discipline', title: '另一条', detail: '' },
  ]);
});

test('unnumbered known headings and child lines stay separate even without intervening blank lines', () => {
  assert.deepEqual(parseDisciplineMarkdown('止盈纪律\n6.1 条件一\n6.2 条件二\n加仓纪律， 加仓一定要是【少频次，高金额】的\n7.1 条件三'), [
    { id: 'annual-profit', title: '止盈纪律', detail: '' },
    { id: 'annual-profit-100', title: '条件一', detail: '' },
    { id: 'annual-profit-multiple', title: '条件二', detail: '' },
    { id: 'add-discipline', title: '加仓纪律， 加仓一定要是【少频次，高金额】的', detail: '' },
    { id: 'add-discipline-decline', title: '条件三', detail: '' },
  ]);
});

test('unknown unnumbered paragraphs and markdown headings are retained with stable content identities', () => {
  const original = parseDisciplineMarkdown('**用户额外主句。** 说明 **保留**\n  下一行仍为说明\n\n## 用户分组\n其余未知正文。');
  assert.deepEqual(original.map(({ title, detail }) => [title, detail]), [
    ['用户额外主句。', '说明 保留 下一行仍为说明'], ['用户分组', ''], ['其余未知正文。', ''],
  ]);
  assert.ok(original.every(entry => /^discipline-text-[a-f0-9]{16}$/.test(entry.id)));
  const inserted = parseDisciplineMarkdown('另一个新增段落。\n\n**用户额外主句。** 说明 **保留**\n  下一行仍为说明\n\n## 用户分组\n其余未知正文。');
  assert.deepEqual(inserted.slice(1), original);
  const repeated = parseDisciplineMarkdown('未知相同原文\n\n未知相同原文');
  assert.equal(repeated.length, 2);
  assert.equal(repeated[1].id, `${repeated[0].id}-2`);
});

test('incomplete or ambiguous documents fail as a whole instead of dropping rules', () => {
  for (const text of ['', '# 交易纪律', '1. 相同编号\n1. 不可覆盖', '1. ****', '6. 止盈\n6.1', '6. 止盈\n6.1 ', '6. 止盈\n6.', '6.1 相同子编号\n6.1. 不可覆盖', '6.0 无效层级']) {
    assert.throws(() => parseDisciplineMarkdown(text), { message: 'Invalid discipline document.' });
  }
});

test('the model contains display text only and no cancelled rule, monitoring thresholds or account data', () => {
  assert.deepEqual(Object.keys(discipline).sort(), ['DISCIPLINE_ENTRIES', 'parseDisciplineMarkdown']);
  for (const entry of DISCIPLINE_ENTRIES) {
    assert.deepEqual(Object.keys(entry).sort(), ['detail', 'id', 'title']);
    assert.ok(Object.values(entry).every(value => typeof value === 'string'));
  }
  const text = JSON.stringify(DISCIPLINE_ENTRIES);
  assert.doesNotMatch(text, /no-small-swings|thresholdPercent|actionPercent|before-decline|leveraged-us-exposure|定投重置|模拟成交|年度计划|触发状态/);
  assert.doesNotMatch(text, /\b(?:nav|shares|amount|cash|transactions|createdAt|asOf|submittedAt|valuationDate)\b/);
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}|\d+(?:\.\d+)?(?:元|份)/);
});

test('saved text and offline fallback feed the same exposure, sale and add thresholds', async () => {
  const source = await readFile(new URL('../../交易纪律.md', import.meta.url), 'utf8');
  const now = '2026-07-01T08:00:00Z';
  const days = (Date.parse('2026-07-01T00:00:00Z') - Date.parse('2023-01-01T00:00:00Z')) / 86400000;
  const annualizedHistory = [{ date: '2023-01-01', nav: 1 }, { date: '2026-07-01', nav: 1.1 ** (days / 365.2425) }];
  const currentHistory = last => [{ date: '2025-12-31', nav: 1 }, { date: '2026-01-02', nav: 1 }, { date: '2026-07-01', nav: last }];
  const disclosure = percent => ({ basis: 'equity-region-percent-of-nav', asOf: '2026-06-30', regions: [{ name: '美国', percent }], source: { title: 'Synthetic public disclosure', url: 'https://example.com/fund-report' } });
  for (const entries of [parseDisciplineMarkdown(source), DISCIPLINE_ENTRIES]) {
    const byId = id => entries.find(entry => entry.id === id);
    const exposure = evaluateUsExposure(byId('us-exposure'), disclosure(39.999));
    assert.equal(exposure.thresholdPercent, 40);
    assert.equal(exposure.status, 'below');
    assert.equal(evaluateUsExposure(byId('us-exposure'), disclosure(40)).status, 'met');
    assert.deepEqual(getDisciplineActions(exposure), { addBudget: 5000, addMultiplier: .5, sellMultiplier: 2, adjusted: true });
    assert.equal(getDisciplineActions({ status: 'met' }).addBudget, 10000);
    assert.match(adjustDisciplineRule(byId('annual-profit-multiple'), exposure).title, /3倍.*减仓40%/);
    assert.match(adjustDisciplineRule(byId('annual-profit-100'), exposure).title, /100%.*全部卖出/);
    const annual = (ruleId, last) => evaluateAnnualDiscipline(currentHistory(last), { rule: byId(ruleId), annualizedHistory, now });
    assert.equal(annual('annual-profit-100', 2).triggered, true);
    assert.equal(annual('annual-profit-100', 1.999999).triggered, false);
    assert.equal(annual('annual-profit-multiple', 1.3).triggered, false);
    assert.equal(annual('annual-profit-multiple', 1.300001).triggered, true);
    const add = decline => evaluateAddDiscipline(currentHistory(1.5), { rule: byId('add-discipline-decline'), annualizedHistory, now, tradePoint: { date: '2026-03-02', nav: 1.5 / (1 - decline) } });
    assert.equal(add(.2).triggered, false);
    assert.equal(add(.200001).triggered, true);
    assert.equal(add(.200001).multiple, 2);
  }
});
