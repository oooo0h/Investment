import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDisciplineSource } from '../scripts/discipline-source.mjs';
import { DISCIPLINE_ENTRIES } from '../src/discipline.js';

async function fixture(t) {
  const prefix = path.join(path.resolve(tmpdir()), 'discipline-source-');
  const workspace = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(path.resolve(workspace).startsWith(prefix));
    await rm(workspace, { recursive: true, force: true });
  });
  return { workspace, file: path.join(workspace, '交易纪律.md'), store: await createDisciplineSource({ workspace }) };
}

test('source reads only the root discipline text and versions actual saved contents', async t => {
  const { workspace, file, store } = await fixture(t);
  const original = '# 交易纪律\n\n1. **第一句。** 【其余原文】\n';
  await writeFile(file, original);
  await writeFile(path.join(workspace, 'unrelated.txt'), 'not a discipline source');
  const first = await store.snapshot();
  assert.equal(first.status, 'valid');
  assert.equal(first.revision, createHash('sha256').update(original).digest('hex'));
  assert.deepEqual(first.entries, [{ id: 'us-exposure', title: '第一句。', detail: '【其余原文】' }]);
  await writeFile(path.join(workspace, 'unrelated.txt'), 'unrelated edit');
  const unchanged = await store.snapshot();
  assert.equal(unchanged.revision, first.revision);
  assert.equal(unchanged.entries, first.entries);
  await writeFile(file, original + '\n2. 用户新保存的一句。\n');
  const changed = await store.snapshot();
  assert.notEqual(changed.revision, first.revision);
  assert.equal(changed.entries.length, 2);
  assert.equal(await readFile(file, 'utf8'), original + '\n2. 用户新保存的一句。\n');
  assert.deepEqual((await readdir(workspace)).sort(), ['unrelated.txt', '交易纪律.md'].sort());
});

test('missing or partial documents retain fallback or the last complete source and recover', async t => {
  const { file, store } = await fixture(t);
  const missing = await store.snapshot();
  assert.equal(missing.status, 'invalid');
  assert.equal(missing.revision, null);
  assert.equal(missing.entries, DISCIPLINE_ENTRIES);
  await writeFile(file, '1. 第一份有效原文。\n');
  const first = await store.snapshot();
  await writeFile(file, '1.');
  const invalid = await store.snapshot();
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.revision, first.revision);
  assert.equal(invalid.entries, first.entries);
  await rm(file);
  assert.equal((await store.snapshot()).revision, first.revision);
  await writeFile(file, '1. 后续有效原文。\n');
  const restored = await store.snapshot();
  assert.equal(restored.status, 'valid');
  assert.notEqual(restored.revision, first.revision);
  assert.equal(restored.entries[0].title, '后续有效原文。');
});

test('saving one nested condition refreshes only its original wording and incomplete child saves retain lastgood', async t => {
  const { file, store } = await fixture(t);
  const document = '6. 止盈纪律\n6.1 达到100%【一定】大幅止盈\n6.2 超过3倍【一定】适当止盈\n';
  await writeFile(file, document);
  const first = await store.snapshot();
  assert.equal(first.status, 'valid');
  assert.deepEqual(first.entries.map(entry => entry.id), ['annual-profit', 'annual-profit-100', 'annual-profit-multiple']);
  await writeFile(file, document.replace('适当止盈', '适当止盈，按用户新文字'));
  const changed = await store.snapshot();
  assert.notEqual(changed.revision, first.revision);
  assert.deepEqual(changed.entries.slice(0, 2), first.entries.slice(0, 2));
  assert.equal(changed.entries[2].title, '超过3倍【一定】适当止盈，按用户新文字');
  await writeFile(file, '6. 止盈纪律\n6.1 达到100%【一定】大幅止盈\n6.2');
  const invalid = await store.snapshot();
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.revision, changed.revision);
  assert.equal(invalid.entries, changed.entries);
  await writeFile(file, document);
  assert.equal((await store.snapshot()).revision, first.revision);
});

test('source keeps unnumbered standing rules and newly saved add-position groups without restoring deleted rules', async t => {
  const { file, store } = await fixture(t);
  const document = '# 交易纪律\n\n**一定要坚定长期持有。** 用户说明。\n\n止盈纪律\n6.1 用户止盈原文\n\n加仓纪律， 加仓一定要是【少频次，高金额】的\n7.1 自上次操作节点后，用户加仓原文';
  await writeFile(file, document);
  const first = await store.snapshot();
  assert.equal(first.status, 'valid');
  assert.deepEqual(first.entries.map(entry => entry.id), ['long-term', 'annual-profit', 'annual-profit-100', 'add-discipline', 'add-discipline-decline']);
  assert.ok(!first.entries.some(entry => entry.id === 'trade-frequency'));
  await writeFile(file, document.replace('用户加仓原文', '更新的加仓原文'));
  const changed = await store.snapshot();
  assert.notEqual(changed.revision, first.revision);
  assert.deepEqual(changed.entries.slice(0, -1), first.entries.slice(0, -1));
  assert.equal(changed.entries.at(-1).title, '自上次操作节点后，更新的加仓原文');
  assert.equal(await readFile(file, 'utf8'), document.replace('用户加仓原文', '更新的加仓原文'));
});

test('saved handwritten child numbers and incomplete bold formatting remain live source text', async t => {
  const { file, store } = await fixture(t);
  const document = '**基金持有量按美股含量确定。** 如果美股含量低于 **40%**，则降低持仓。\n1.1美股含量不达标的基金，加仓【减半】，卖出【翻倍】。\n\n**加仓纪律，少频次高金额。\n7.1跌幅超过平均年化收益率的2倍，进行一次加仓（1w元）';
  await writeFile(file, document);
  const result = await store.snapshot();
  assert.equal(result.status, 'valid');
  assert.deepEqual(result.entries.map(entry => entry.id), ['us-exposure', 'us-exposure-adjustment', 'add-discipline', 'add-discipline-decline']);
  assert.match(result.entries[0].detail, /40%/);
  assert.equal(result.entries[1].title, '美股含量不达标的基金，加仓【减半】，卖出【翻倍】。');
  assert.equal(await readFile(file, 'utf8'), document);
});
