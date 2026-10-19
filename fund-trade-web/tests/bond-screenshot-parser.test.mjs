import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTransfer, parseList } from '../../公共资料/工具/bond-screenshot-parser.mjs';
const line = (text, x, y) => ({ text, words: [{ text, x, y, width: 150, height: 20 }] });
const field = (label, value, y) => [line(label, 20, y), line(value, 400, y)];
test('conversion confirmation fields retain each leg, fee and NAV date without using a completion deadline as a confirmation date', () => {
  const ocr = { lines: [line('01月03日24点前完成转换', 100, 10),
    ...field('转出基金', '来源基金', 100), ...field('申请转出份额', '3.00份', 150),
    ...field('确认转出份额', '3.00份', 200), ...field('单位净值', '1.0000(01-02)', 250),
    ...field('转出金额', '3.00元', 300), ...field('转入基金', '目标基金', 350),
    ...field('确认转入份额', '5.00份', 400), ...field('单位净值', '0.5000(01-02)', 450),
    ...field('转入金额', '2.50元', 500), ...field('手续费', '0.02元', 550),
    ...field('退回金额', '0.48元', 600), ...field('申请时间', '2024-01-02 14:00:00', 650)] };
  const [out, incoming] = parseTransfer(ocr, '006663', '006485');
  assert.equal(out.fee, .02); assert.equal(out.confirmedAmount, 3);
  assert.equal(incoming.confirmedAmount, 2.5); assert.equal(incoming.fee, null);
  assert.equal(out.navDate, '2024-01-02'); assert.equal(out.confirmedDate, null);
  assert.equal(incoming.confirmedDate, null);
});
test('list-only rows preserve missing fields and distinguish cancelled and processing orders', () => {
  const ocr = { lines: [line('买入', 20, 100), line('1.00元', 400, 100),
    line('2024-01-02 10:00:00', 20, 150), line('已撤单', 400, 150),
    line('转换（转出）', 20, 350), line('2.00份', 400, 350),
    line('2024-01-03 10:00:00', 20, 400), line('交易进行中', 400, 400)] };
  const [cancelled, processing] = parseList(ocr, '006663', 0);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(processing.sourceStatus, 'processing');
  assert.equal(processing.shares, null); assert.equal(processing.requestedShares, 2);
  assert.equal(processing.nav, null); assert.equal(processing.fee, null);
});
