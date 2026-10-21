// Local-mode transaction registration. Amounts stay in the request, Python
// process and workbooks; only status, dates and row numbers are returned.
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transactionSourcePath } from './live-data.mjs';
import { FUND_CODES } from '../src/funds.js';
import { BOND_CODES } from '../src/bond-model.js';
import { navDateForOrder } from '../src/trading-calendar.js';
import { buyFee, subscriptionDiffFee, FEE_RULES } from '../src/fee-rules.js';
import { readTransferRecords, writeTransferRecords, transferCounts } from './transfer-records.mjs';
import { readRegistrationRecords, writeRegistrationRecords } from './registration-records.mjs';

const WRITER = fileURLToPath(new URL('./write-workbook.py', import.meta.url));
const PAIR_WRITER = fileURLToPath(new URL('./write-transfer.py', import.meta.url));
const FEE_CALC = fileURLToPath(new URL('./compute-sell-fee.py', import.meta.url));
const INDEX = '公共资料/历史净值/全基金历史净值当前入口.json';
const ALLOWED = new Set([...FUND_CODES, ...BOND_CODES]);
const CODE = /^\d{6}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT = /^(?:\d{1,9})(?:\.\d{1,2})?$/;
const SHARES = /^(?:\d{1,9})(?:\.\d{1,6})?$/;
const beijingToday = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

export class RegistrationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (message, code = 'registration-invalid') => { throw new RegistrationError(code, message); };

function amount(value, { max = 1e9, label = '金额' } = {}) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!AMOUNT.test(text)) fail(`请填写有效的${label}，最多两位小数。`);
  const number = Number(text);
  if (!Number.isFinite(number) || number <= 0 || number > max) fail(`请填写有效的${label}。`);
  return round(number, 2);
}
function shares(value) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!SHARES.test(text)) fail('请填写有效的份额，最多六位小数。');
  const number = Number(text);
  if (!Number.isFinite(number) || number <= 0 || number > 1e9) fail('请填写有效的份额。');
  return round(number, 6);
}
function fee(value, label = '手续费') {
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(text)) fail(`请填写有效的${label}，最多两位小数。`);
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number > 1e9) fail(`请填写有效的${label}。`);
  return round(number, 2);
}
function fundCode(value) {
  if (typeof value !== 'string' || !CODE.test(value) || !ALLOWED.has(value)) fail('请选择有效的持仓基金。');
  return value;
}
function date(value) {
  if (typeof value !== 'string' || !DATE.test(value)) fail('请填写有效的下单日期。');
  const stamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) fail('请填写有效的下单日期。');
  if (value > beijingToday()) fail('下单日期不能晚于今天。');
  return value;
}
function sellTiers(code) {
  const rule = FEE_RULES[code];
  if (!rule) fail('该基金缺少赎回费率规则。', 'registration-fee');
  return rule.sell.map(tier => [tier.belowDays === Infinity ? 1e12 : tier.belowDays, tier.rate]);
}

function runPython(pythonPath, script, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, ['-B', '-X', 'utf8', script], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
    });
    let output = '', settled = false;
    const failRun = () => { if (!settled) { settled = true; output = ''; reject(new RegistrationError('registration-write-failed', '写入未完成，请确认表格未被 Excel 占用后重试。')); } };
    const timer = setTimeout(() => { child.kill(); failRun(); }, 30000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 1048576) { child.kill(); failRun(); } });
    child.stderr.resume();
    child.on('error', failRun);
    child.stdin.on('error', failRun);
    child.on('close', code => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) return failRun();
      try { const result = JSON.parse(output); output = ''; settled = true; resolve(result); } catch { failRun(); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function readIndex(workspace) {
  let payload;
  try { payload = JSON.parse(await readFile(path.join(workspace, INDEX), 'utf8')); }
  catch { throw new RegistrationError('registration-unavailable', '净值入口暂不可用，稍后重试。'); }
  if (!payload || !Array.isArray(payload.funds)) throw new RegistrationError('registration-unavailable', '净值入口暂不可用，稍后重试。');
  return payload;
}

function sourceFor(index, workspace, code) {
  const entry = index.funds.find(fund => fund.code === code);
  if (!entry || !entry.json_path) throw new RegistrationError('registration-unavailable', '该基金暂未接入交易表。');
  const relative = transactionSourcePath(entry);
  return { entry, relative, full: path.resolve(workspace, relative) };
}

async function expectedHash(full) {
  try { return sha256(await readFile(full)); }
  catch { throw new RegistrationError('registration-unavailable', '交易表暂不可用，稍后重试。'); }
}

async function navFor(workspace, index, code, navDate) {
  const entry = index.funds.find(fund => fund.code === code);
  if (!entry?.json_path) return null;
  try {
    const document = JSON.parse(await readFile(path.resolve(workspace, entry.json_path), 'utf8'));
    const row = Array.isArray(document.rows) ? document.rows.find(item => item.date === navDate) : null;
    const nav = row ? Number(row.nav) : null;
    return Number.isFinite(nav) && nav > 0 ? nav : null;
  } catch { return null; }
}

async function latestNavFor(workspace, index, code) {
  const entry = index.funds.find(fund => fund.code === code);
  if (!entry?.json_path) return null;
  try {
    const document = JSON.parse(await readFile(path.resolve(workspace, entry.json_path), 'utf8'));
    const row = Array.isArray(document.rows) ? document.rows.at(-1) : null;
    const nav = row ? Number(row.nav) : null;
    return Number.isFinite(nav) && nav > 0 ? nav : null;
  } catch { return null; }
}

export function createLocalTransactionStore({ workspace, root, pythonPath, now = () => new Date() }) {
  let queue = Promise.resolve();
  const serial = task => {
    const pending = queue.then(task, task);
    queue = pending.catch(() => {});
    return pending;
  };
  const writerFor = (index, code) => sourceFor(index, workspace, code);

  async function appendOne(index, code, cells) {
    const source = writerFor(index, code);
    const result = await runPython(pythonPath, WRITER, {
      workspace, code, path: source.relative, expected_sha256: await expectedHash(source.full), action: 'append', cells,
    });
    if (!result?.ok || !Number.isInteger(result.row)) fail('写入未完成，请重试。', 'registration-write-failed');
    return result.row;
  }

  async function appendPair(index, outCode, outCells, inCode, inCells) {
    const out = writerFor(index, outCode), inside = writerFor(index, inCode);
    const result = await runPython(pythonPath, PAIR_WRITER, {
      workspace, action: 'append_pair', items: [
        { code: outCode, path: out.relative, expected_sha256: await expectedHash(out.full), cells: outCells },
        { code: inCode, path: inside.relative, expected_sha256: await expectedHash(inside.full), cells: inCells },
      ],
    });
    if (!result?.ok || !Array.isArray(result.items) || result.items.length !== 2) fail('写入未完成，请重试。', 'registration-write-failed');
    return result.items.map(item => item.row);
  }

  async function updateOne(index, code, row, expect, cells) {
    const source = writerFor(index, code);
    const result = await runPython(pythonPath, WRITER, {
      workspace, code, path: source.relative, expected_sha256: await expectedHash(source.full),
      action: 'update', row, expect, cells,
    });
    if (!result?.ok) fail('表格更新未完成，请重试。', 'registration-write-failed');
    return result;
  }

  async function updatePair(index, out, inside) {
    const outSource = writerFor(index, out.code), inSource = writerFor(index, inside.code);
    const result = await runPython(pythonPath, PAIR_WRITER, {
      workspace, action: 'update_pair', items: [
        { code: out.code, path: outSource.relative, expected_sha256: await expectedHash(outSource.full), row: out.row, expect: out.expect, cells: out.cells },
        { code: inside.code, path: inSource.relative, expected_sha256: await expectedHash(inSource.full), row: inside.row, expect: inside.expect, cells: inside.cells },
      ],
    });
    if (!result?.ok) fail('表格更新未完成，请重试。', 'registration-write-failed');
    return result;
  }

  async function readRow(index, code, row, expect) {
    const source = writerFor(index, code);
    const result = await runPython(pythonPath, WRITER, {
      workspace, code, path: source.relative, action: 'read', row, expect,
    });
    if (!result?.ok || !result.values) fail('表格读取未完成，请重试。', 'registration-read-failed');
    return result.values;
  }

  async function computeRedemption(index, code, row, nav, outShares, saleDate) {
    const source = writerFor(index, code);
    return runPython(pythonPath, FEE_CALC, {
      workspace, code, path: source.relative, exclude_row: row ?? null,
      nav, shares: outShares, sale_date: saleDate, tiers: sellTiers(code),
    });
  }

  async function recordRegistration(record) {
    try {
      const records = await readRegistrationRecords({ root });
      records.push(record);
      await writeRegistrationRecords({ root }, records);
    } catch { /* The workbook row is authoritative; order-date metadata is best effort. */ }
  }

  async function create(input = {}) {
    return serial(async () => {
      const mode = input.mode;
      if (!['buy', 'sell', 'transfer'].includes(mode)) fail('请选择买入、卖出或转换。');
      const orderDate = date(input.date);
      const cutoff = input.cutoff === 'after' ? 'after' : input.cutoff === 'before' ? 'before' : fail('请选择15点前或15点后。');
      let navDate;
      try { navDate = navDateForOrder(orderDate, cutoff); }
      catch { fail('交易日历暂未覆盖该日期，请在表格中手动登记。', 'registration-calendar'); }
      const index = await readIndex(workspace);

      if (mode === 'buy') {
        const code = fundCode(input.code);
        const value = amount(input.amount);
        const feeInfo = buyFee(code, value);
        if (!feeInfo) fail('该基金缺少买入费率规则。', 'registration-fee');
        if (feeInfo.fee >= value) fail('手续费不能达到或超过买入金额。');
        const row = await appendOne(index, code, { A: navDate, D: '买入', E: value, F: feeInfo.fee });
        await recordRegistration({ id: `registration-${randomUUID()}`, code, row, mode, orderDate, navDate, cutoff,
          status: 'filled', createdAt: new Date(now()).toISOString() });
        return { ok: true, mode, code, navDate, orderDate, row };
      }

      if (mode === 'sell') {
        const code = fundCode(input.code);
        const outShares = shares(input.outShares);
        const nav = await navFor(workspace, index, code, navDate);
        const cells = { A: navDate, D: '卖出', C: outShares };
        let status = 'awaiting';
        if (nav) {
          let feeInfo;
          try { feeInfo = await computeRedemption(index, code, null, nav, outShares, navDate); }
          catch { fail('赎回费计算失败，请检查该基金历史交易是否完整。', 'registration-fee'); }
          if (!feeInfo?.ok) {
            if (feeInfo?.error === 'insufficient') fail('卖出份额超过当前持仓。');
            fail('赎回费计算失败，请检查该基金历史交易是否完整。', 'registration-fee');
          }
          cells.B = nav; cells.E = feeInfo.net; cells.F = feeInfo.fee;
          status = 'filled';
        } else {
          // No NAV yet: still reject a share count above the committed lots
          // using the latest public NAV only for the availability check.
          const checkNav = await latestNavFor(workspace, index, code);
          if (checkNav) {
            let check = null;
            try { check = await computeRedemption(index, code, null, checkNav, outShares, navDate); }
            catch { /* A later reconcile will re-check once the NAV is available. */ }
            if (check && check.ok === false && check.error === 'insufficient') fail('卖出份额超过当前持仓。');
          }
        }
        const row = await appendOne(index, code, cells);
        await recordRegistration({ id: `registration-${randomUUID()}`, code, row, mode, orderDate, navDate, cutoff,
          status, createdAt: new Date(now()).toISOString() });
        return { ok: true, mode, code, navDate, orderDate, row, awaiting: status === 'awaiting' };
      }

      const outCode = fundCode(input.code);
      const inCode = fundCode(input.targetCode);
      if (outCode === inCode) fail('转出基金和转入基金不能相同。');
      const outShares = shares(input.outShares);
      const checkNav = (await navFor(workspace, index, outCode, navDate)) || (await latestNavFor(workspace, index, outCode));
      if (checkNav) {
        let check = null;
        try { check = await computeRedemption(index, outCode, null, checkNav, outShares, navDate); }
        catch { /* The later reconcile will re-check the lots. */ }
        if (check && check.ok === false && check.error === 'insufficient') fail('转出份额超过当前持仓。');
      }
      const [outRow, inRow] = await appendPair(index, outCode,
        { A: navDate, D: '卖出', C: outShares },
        inCode, { A: navDate, D: '转入' });
      const records = await readTransferRecords({ root });
      const record = {
        id: `transfer-${randomUUID()}`, outCode, inCode, outRow, inRow,
        orderDate, navDate, cutoff, status: 'awaiting', createdAt: new Date(now()).toISOString(),
      };
      records.push(record);
      await writeTransferRecords({ root }, records);
      return { ok: true, mode, code: outCode, targetCode: inCode, navDate, orderDate, row: outRow, inRow, transferId: record.id };
    });
  }

  async function list() {
    const records = await readTransferRecords({ root });
    return { records, counts: transferCounts(records) };
  }

  async function reconcileRegistrations(index) {
    const records = await readRegistrationRecords({ root });
    let updated = 0, pending = 0, changed = false;
    for (const record of records) {
      if (record.status !== 'awaiting' || record.mode !== 'sell') continue;
      const nav = await navFor(workspace, index, record.code, record.navDate);
      if (!nav) { pending += 1; continue; }
      let row;
      try { row = await readRow(index, record.code, record.row, { date: record.navDate, kind: '卖出' }); }
      catch { pending += 1; continue; }
      const outShares = numeric(row.C) ? row.C : null;
      if (!outShares) { pending += 1; continue; }
      let feeInfo;
      try { feeInfo = await computeRedemption(index, record.code, record.row, nav, outShares, record.navDate); }
      catch { pending += 1; continue; }
      if (!feeInfo?.ok) { pending += 1; continue; }
      try {
        await updateOne(index, record.code, record.row, { date: record.navDate, kind: '卖出', shares: outShares },
          { B: nav, E: feeInfo.net, F: feeInfo.fee });
      } catch { pending += 1; continue; }
      record.status = 'filled'; changed = true; updated += 1;
    }
    if (changed) await writeRegistrationRecords({ root }, records);
    return { updated, pending };
  }

  async function reconcile() {
    return serial(async () => {
      const index = await readIndex(workspace);
      const sales = await reconcileRegistrations(index);
      const records = await readTransferRecords({ root });
      let updated = sales.updated, pending = sales.pending, changed = false;
      for (const record of records) {
        if (record.status !== 'awaiting') continue;
        const outNav = await navFor(workspace, index, record.outCode, record.navDate);
        const inNav = await navFor(workspace, index, record.inCode, record.navDate);
        if (!outNav || !inNav) { pending += 1; continue; }
        let outRow, inRow;
        try {
          outRow = await readRow(index, record.outCode, record.outRow, { date: record.navDate, kind: '卖出' });
          inRow = await readRow(index, record.inCode, record.inRow, { date: record.navDate, kind: '转入' });
        } catch { pending += 1; continue; }
        const outShares = numeric(outRow.C) ? outRow.C : null;
        if (!outShares) { pending += 1; record.note = '转出份额待核对'; changed = true; continue; }
        const complete = numeric(outRow.B) && numeric(outRow.E)
          && numeric(inRow.B) && numeric(inRow.E) && numeric(inRow.C);
        if (!complete) {
          let feeInfo;
          try { feeInfo = await computeRedemption(index, record.outCode, record.outRow, outNav, outShares, record.navDate); }
          catch { pending += 1; record.note = '赎回费待核对'; changed = true; continue; }
          if (!feeInfo?.ok) { pending += 1; record.note = '赎回份额待核对'; changed = true; continue; }
          const inFeeInfo = subscriptionDiffFee(record.outCode, record.inCode, feeInfo.net);
          const inAmount = feeInfo.net;
          const inShares = round((inAmount - inFeeInfo.fee) / inNav, 6);
          if (inShares <= 0) { pending += 1; continue; }
          try {
            await updatePair(index,
              { code: record.outCode, row: record.outRow, expect: { date: record.navDate, kind: '卖出', shares: outShares }, cells: { B: outNav, E: feeInfo.net, F: feeInfo.fee } },
              { code: record.inCode, row: record.inRow, expect: { date: record.navDate, kind: '转入' }, cells: { B: inNav, C: inShares, E: inAmount, F: inFeeInfo.fee } });
          } catch { pending += 1; continue; }
        }
        record.status = 'filled'; delete record.note; record.filledAt = new Date(now()).toISOString(); changed = true; updated += 1;
      }
      if (changed) await writeTransferRecords({ root }, records);
      return { ok: true, updated, pending };
    });
  }

  async function review(input = {}) {
    return serial(async () => {
      const records = await readTransferRecords({ root });
      const record = records.find(item => item.id === input.id);
      if (!record) fail('该转换记录已不存在，请刷新后重试。', 'registration-not-found');
      if (record.status !== 'filled') fail('该转换尚未到核对阶段。', 'registration-state');
      const outAmount = amount(input.outAmount, { label: '实际转出到账金额' });
      const inAmount = amount(input.inAmount, { label: '实际转入金额' });
      const outFee = fee(input.outFee) ?? 0;
      const inFee = fee(input.inFee) ?? 0;
      if (outFee >= outAmount) fail('转出手续费不能达到或超过转出金额。');
      if (inFee >= inAmount) fail('转入手续费不能达到或超过转入金额。');
      const index = await readIndex(workspace);
      const outRow = await readRow(index, record.outCode, record.outRow, { date: record.navDate, kind: '卖出' });
      const outShares = numeric(outRow.C) ? outRow.C : null;
      if (!Number.isFinite(outShares) || outShares <= 0) fail('转出份额缺失，请先在表格中补全。', 'registration-state');
      const inRow = await readRow(index, record.inCode, record.inRow, { date: record.navDate, kind: '转入' });
      const inNav = Number(inRow.B);
      if (!Number.isFinite(inNav) || inNav <= 0) fail('转入净值缺失，请稍后重试。', 'registration-state');
      const inShares = input.inShares === undefined || input.inShares === '' ? round((inAmount - inFee) / inNav, 6) : shares(input.inShares);
      if (inShares <= 0) fail('请填写有效的转入份额。');
      await updatePair(index,
        { code: record.outCode, row: record.outRow, expect: { date: record.navDate, kind: '卖出', shares: outShares }, cells: { E: outAmount, F: outFee } },
        { code: record.inCode, row: record.inRow, expect: { date: record.navDate, kind: '转入' }, cells: { E: inAmount, F: inFee, C: inShares } });
      record.status = 'reviewed'; record.reviewedAt = new Date(now()).toISOString();
      delete record.note;
      await writeTransferRecords({ root }, records);
      return { ok: true, difference: round(outAmount - inAmount, 2) };
    });
  }

  return { create, list, reconcile, review };
}
