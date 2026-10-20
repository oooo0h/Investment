// Public rule settings and synthetic display copy only. No account files or values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDisciplineActions, adjustDisciplineRule } from '../src/discipline-actions.js';

const below = Object.freeze({ status: 'below' });
const met = Object.freeze({ status: 'met' });
const base = { addBudget: 10000, addMultiplier: 1, sellMultiplier: 1, adjusted: false };
const adjusted = { addBudget: 5000, addMultiplier: .5, sellMultiplier: 2, adjusted: true };
const multipleRule = Object.freeze({
  id: 'annual-profit-multiple',
  title: '如果本年的年内涨幅收益率超过了 平均年化收益率 的 3倍，【一定】要适当止盈（减仓20%）',
  detail: '',
});
const absoluteRule = Object.freeze({
  id: 'annual-profit-100',
  title: '如果本年的年内涨幅收益率达到了100%，【一定】要大幅止盈（清除本金/卖出一半持仓，选金额大的）',
  detail: '',
});

test('only an explicit below exposure adjusts the public fixed action settings', () => {
  assert.deepEqual(getDisciplineActions(below), adjusted);
  for (const exposure of [met, { status: 'unknown' }, { status: 'unavailable' }, { status: 'below ' }, {}, null, undefined]) {
    assert.deepEqual(getDisciplineActions(exposure), base);
  }
  const derived = getDisciplineActions(below);
  derived.addBudget = 0;
  assert.deepEqual(getDisciplineActions(below), adjusted);
  assert.deepEqual(below, { status: 'below' });
});

test('6.2 doubles only its reduction action while keeping the 3x trigger unchanged', () => {
  const result = adjustDisciplineRule(multipleRule, below);
  assert.notEqual(result, multipleRule);
  assert.equal(result.id, multipleRule.id);
  assert.equal(result.title, multipleRule.title.replace('减仓20%', '减仓40%'));
  assert.equal(result.detail, '');
  assert.match(result.title, /年内涨幅收益率超过了 平均年化收益率 的 3倍/);
  assert.match(multipleRule.title, /减仓20%/);
});

test('6.1 caps the doubled at-least-half-position action at a full sale, preserving its 100% trigger', () => {
  const result = adjustDisciplineRule(absoluteRule, below);
  assert.equal(result.title, '如果本年的年内涨幅收益率达到了100%，【一定】要大幅止盈（全部卖出）');
  assert.ok(!result.title.includes('200%'));
  assert.ok(!result.title.includes('清除本金'));
  assert.ok(!result.title.includes('一半持仓'));
  assert.match(absoluteRule.title, /清除本金\/卖出一半持仓，选金额大的/);
});

test('unadjusted and unknown exposure statuses preserve original rule objects exactly', () => {
  for (const rule of [absoluteRule, multipleRule]) {
    for (const exposure of [met, { status: 'unknown' }, { status: 'unavailable' }, null, undefined]) {
      assert.equal(adjustDisciplineRule(rule, exposure), rule);
    }
  }
});

test('only the two sale clause IDs are supported; parent add copy and unknown rules stay intact', () => {
  for (const id of ['add-discipline', 'add-discipline-decline', 'annual-profit', 'us-exposure', 'unknown']) {
    const rule = Object.freeze({ id, title: '平均年化3倍，减仓20%，单次加仓【1万元】', detail: '清除本金/卖出一半持仓，选金额大的' });
    assert.equal(adjustDisciplineRule(rule, below), rule);
  }
  for (const value of [null, undefined, '', 0, [], {}]) assert.equal(adjustDisciplineRule(value, below), value);
});

test('action copy in detail is adjusted without changing unrelated trigger percentages in title or detail', () => {
  const rule = Object.freeze({
    id: 'annual-profit-multiple', title: '年内涨幅20%，超过平均年化收益率3倍，',
    detail: '参考阈值100%，【一定】要适当止盈（减仓20%）。',
  });
  const result = adjustDisciplineRule(rule, below);
  assert.equal(result.title, rule.title);
  assert.equal(result.detail, '参考阈值100%，【一定】要适当止盈（减仓40%）。');
  const absolute = Object.freeze({ id: 'annual-profit-100', title: '收益率达到100%，', detail: '【一定】要大幅止盈（清除本金/卖出一半持仓，选金额大的）' });
  assert.deepEqual(adjustDisciplineRule(absolute, below), { ...absolute, detail: '【一定】要大幅止盈（全部卖出）' });
});

test('sale percentages cap at 100% rather than exceeding a full position', () => {
  for (const [percent, expected] of [[0, 0], [20, 40], [25.5, 51], [49.99, 99.98], [50, 100], [80, 100], [100, 100], [150, 100]]) {
    const rule = { id: 'annual-profit-multiple', title: '收益率100%，平均年化3倍', detail: `减仓${percent}%` };
    const result = adjustDisciplineRule(rule, below);
    assert.equal(result.title, rule.title);
    assert.equal(result.detail, `减仓${expected}%`);
  }
});

test('recognized action spacing and legacy full-sale wording retain surrounding copy', () => {
  const rule = { id: 'annual-profit-multiple', title: '3倍，减仓 20 ％。', detail: '' };
  assert.equal(adjustDisciplineRule(rule, below).title, '3倍，减仓 40 ％。');
  const legacy = { id: 'annual-profit-100', title: '100%，大幅止盈（清除本金 / 卖出一半持仓等等）', detail: '' };
  assert.equal(adjustDisciplineRule(legacy, below).title, '100%，大幅止盈（全部卖出）');
});

test('unrecognized, absent or malformed action text never creates a guessed action', () => {
  for (const detail of ['按新规则执行。', '平均年化3倍、年内100%、参考20%', '减仓-20%', '减仓2e1%', '减仓NaN%', null, undefined]) {
    const rule = { id: 'annual-profit-multiple', title: '平均年化3倍', detail };
    assert.equal(adjustDisciplineRule(rule, below), rule);
  }
  const unrelated = { id: 'annual-profit-100', title: '100%，适当减仓20%', detail: '' };
  assert.equal(adjustDisciplineRule(unrelated, below), unrelated);
});

test('adjusting original rules repeatedly creates consistent independent copies without source mutation', () => {
  const original = structuredClone(multipleRule);
  const one = adjustDisciplineRule(multipleRule, below);
  const two = adjustDisciplineRule(multipleRule, below);
  assert.deepEqual(one, two);
  assert.notEqual(one, two);
  one.title = 'synthetic changed copy';
  assert.deepEqual(multipleRule, original);
  assert.match(two.title, /减仓40%/);
});
