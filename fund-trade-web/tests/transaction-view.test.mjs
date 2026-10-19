// All values here are invented fixtures, never account files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTransactionEditor, renderTransactionDelete, renderTransactionPreview } from '../src/transaction-view.js';

const editor = { code: '005698', id: null, draft: { date: '2026-10-19', type: 'buy', amount: '123.45', nav: '', feeRate: '', status: 'pending' } };
const options = { editor, today: '2026-10-19' };

test('new entries provide exactly the six supported types and infer only processing or confirmed status', () => {
  const markup = renderTransactionEditor(options);
  assert.equal((markup.match(/<option /g) || []).length, 6);
  assert.match(markup, /name="status" type="hidden" value="pending"/);
  assert.match(markup, /进行中|补充净值后自动确认/);
  assert.doesNotMatch(markup, /未记录|未计入|撤单|name="status"[^>]*<option/);
  assert.match(markup, /name="nav" type="text"[^>]*placeholder="进行中可留空"/);
  assert.match(markup, /name="date" type="text" inputmode="numeric"[^>]*value="2026\/10\/19"/);
});

test('a valid positive NAV changes the displayed status while invalid text cannot auto-confirm', () => {
  for (const nav of ['0', '-1', 'abc', 'Infinity', '1e2']) {
    const markup = renderTransactionEditor({ ...options, editor: { ...editor, draft: { ...editor.draft, nav } } });
    assert.match(markup, /name="status" type="hidden" value="pending"/);
  }
  const markup = renderTransactionEditor({ ...options, editor: { ...editor, draft: { ...editor.draft, nav: '1.2345' } } });
  assert.match(markup, /name="status" type="hidden" value="confirmed"/);
  assert.match(markup, /保存后计入持仓/);
});

test('amount entry stays masked by default and provides a separate local visibility control', () => {
  const hidden = renderTransactionEditor(options);
  assert.match(hidden, /name="amount" type="password"/);
  assert.match(hidden, /data-action="transaction-amount-visibility" aria-label="显示输入金额与份额" aria-pressed="false"/);
  const visible = renderTransactionEditor({ ...options, amountVisible: true });
  assert.match(visible, /name="amount" type="text"/);
  assert.match(visible, /aria-label="隐藏输入金额与份额" aria-pressed="true"/);
});

test('computed shares and fees respect the page privacy mode', () => {
  const result = { error: '', preview: { shares: 12.345678, fee: 1.23, status: 'confirmed' } };
  const masked = renderTransactionPreview(result);
  assert.equal((masked.match(/aria-label="已隐藏"/g) || []).length, 2);
  assert.doesNotMatch(masked, /12\.345678|1\.23/);
  const visible = renderTransactionPreview(result, { visible: true });
  assert.match(visible, /12\.35/);
  assert.equal(result.preview.shares, 12.345678, 'display rounding never changes the calculation input');
  assert.match(visible, /1\.23/);
});

test('delete confirmation contains only type and date and requires a second explicit action', () => {
  const markup = renderTransactionDelete({ removal: { id: 'invented', type: 'sell', date: '2026-10-19', amount: 123.45, shares: 99.123 } });
  assert.match(markup, /role="alertdialog" aria-modal="true"/);
  assert.match(markup, /2026-10-19 · 卖出/);
  assert.match(markup, /data-action="transaction-cancel"/);
  assert.match(markup, /data-action="transaction-delete-confirm"/);
  assert.doesNotMatch(markup, /123\.45|99\.123|invented/);
});

test('draft and error content is escaped without adding executable markup', () => {
  const markup = renderTransactionEditor({ ...options, editor: { ...editor, draft: { ...editor.draft, amount: '" onfocus="alert(1)' } }, error: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(markup, /<img| value="" onfocus|<script/);
  assert.match(markup, /&lt;img/);
  assert.match(markup, /&quot; onfocus=&quot;/);
});

test('the SIP switch mirrors buy or SIP and is hidden for every other transaction type', () => {
  for (const type of ['buy', 'sip']) {
    const markup = renderTransactionEditor({ ...options, editor: { ...editor, draft: { ...editor.draft, type } } });
    assert.match(markup, /class="transaction-sip-control">/);
    assert.match(markup, new RegExp(`data-action="transaction-sip-toggle" role="switch" aria-label="定投" aria-checked="${type === 'sip'}"`));
  }
  for (const type of ['sell', 'reinvest', 'dividend', 'transfer-in']) {
    const markup = renderTransactionEditor({ ...options, editor: { ...editor, draft: { ...editor.draft, type } } });
    assert.match(markup, /class="transaction-sip-control" hidden>/);
  }
});

test('busy transaction forms disable the SIP switch along with the other editing controls', () => {
  const markup = renderTransactionEditor({ ...options, busy: true });
  assert.match(markup, /data-action="transaction-sip-toggle"[^>]* disabled>/);
});

test('shares and both fee inputs are directly visible while every sensitive numeric input starts masked', () => {
  const markup = renderTransactionEditor(options);
  assert.match(markup, /name="shares" type="password"/);
  assert.match(markup, /name="feeAmount" type="password"/);
  assert.match(markup, /class="transaction-fee-rate"|class="transaction-field transaction-fee-rate"/);
  assert.match(markup, /class="transaction-field transaction-fee-amount"/);
  assert.match(markup, /name="feeRate" type="text"/);
  assert.doesNotMatch(markup, /<details|transaction-fee-free|transaction-date-wheel|transaction-date-toggle|type="date"/);
});
