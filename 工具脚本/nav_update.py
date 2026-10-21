"""Double-click NAV launchers: public data only; logs/staging stay in 临时文件."""
import sys
sys.dont_write_bytecode = True
import argparse
import copy
import csv
from contextlib import contextmanager, redirect_stdout
import io
from datetime import datetime, timezone, timedelta
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
TEMP = ROOT / '临时文件/净值更新'
ARCHIVE = ROOT / '公共资料/历史净值'
INDEX = ARCHIVE / '全基金历史净值当前入口.json'
CHILD = '更新本基金净值.cmd'
TZ = timezone(timedelta(hours=8))
RUNTIME = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def load(p):
    return json.loads(p.read_text(encoding='utf-8-sig'))


def save(p, value):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def stamp():
    return datetime.now(TZ).isoformat(timespec='seconds')


def discover():
    folders = sorted(p.resolve() for p in (ROOT / '基金/持仓基金').iterdir()
                     if p.is_dir() and re.match(r'^\d{6}_', p.name))
    require(len(folders) == len({p.name[:6] for p in folders}), '发现同一基金代码有多个文件夹')
    entries = load(INDEX)['funds']
    require({p.name[:6] for p in folders} == {e['code'] for e in entries if Path(e['xlsx_path']).parts[:2] == ('基金', '持仓基金')}, '持仓基金文件夹与当前净值索引不一致')
    return folders


@contextmanager
def locked(name):
    """OS releases the byte lock even when a CMD window is closed abruptly."""
    import msvcrt
    TEMP.mkdir(parents=True, exist_ok=True)
    with (TEMP / name).open('a+b') as handle:
        handle.seek(0, 2)
        if handle.tell() == 0:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise RuntimeError('已有净值更新正在运行，请等其结束后重试') from None
        try:
            yield
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


class Log:
    def __init__(self, p):
        self.handle = p.open('a', encoding='utf-8')

    def __call__(self, message):
        line = message if re.match(r'^\[\d{2}:\d{2}:\d{2}\]', message) else f'[{datetime.now(TZ):%H:%M:%S}] {message}'
        print(line, flush=True)
        self.handle.write(line + '\n')
        self.handle.flush()

    def close(self):
        self.handle.close()


class Source:
    def __init__(self, directory, log):
        self.directory, self.log, self.counter = directory, log, 0

    def get(self, base, params):
        url = base + '?' + urlencode(params)
        for attempt in range(1, 4):
            try:
                request = Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://fundf10.eastmoney.com/'})
                with urlopen(request, timeout=20) as response:
                    raw = response.read().decode('utf-8-sig')
                body = json.loads(raw)
                self.counter += 1
                save(self.directory / f'响应_{self.counter:03}.json', {'url': url, 'captured_at': stamp(), 'response': body})
                return body
            except Exception as error:
                if attempt == 3:
                    raise RuntimeError(f'公开净值接口连续3次请求失败（{type(error).__name__}）') from None
                self.log(f'请求暂未成功，正在重试 {attempt}/3')
                time.sleep(attempt * 0.7)


def number(value):
    if value is None or str(value).strip() in ('', '-', '--', '---'):
        return None
    text = str(value).strip()
    require(re.fullmatch(r'[+-]?\d+(?:\.\d+)?', text), '公开净值含无效数字')
    require(Decimal(text).is_finite(), '公开净值含无效数字')
    return text


def validate(doc, asof):
    rows = doc['rows']
    dates = [r['date'] for r in rows]
    require(len(rows) >= 5 and doc['count'] == len(rows), '历史净值条数异常')
    require(dates == sorted(set(dates)), '历史净值有重复或未排序日期')
    require((dates[0], dates[-1]) == (doc['first_date'], doc['last_date']), '历史首末日期异常')
    for row in rows:
        require(datetime.strptime(row['date'], '%Y-%m-%d').date().isoformat() == row['date'] <= asof, '净值日期无效或晚于执行日期')
        require(number(row['nav']) is not None and Decimal(str(row['nav'])) > 0, '净值必须为正数')
        for field in ('accumulated_nav', 'daily_growth_pct'):
            number(row.get(field))


def eastmoney(old, asof, source):
    def page(i, end=''):
        data = source.get('https://api.fund.eastmoney.com/f10/lsjz',
                          dict(fundCode=old['code'], pageIndex=i, pageSize=20, startDate='', endDate=end))
        require(data.get('ErrCode') == 0 and isinstance(data.get('Data', {}).get('LSJZList'), list), '第三方接口结构异常')
        require(int(data['PageIndex']) == i and int(data['PageSize']) == 20, '分页参数异常')
        return data
    head = page(1)
    require(bool(head['Data']['LSJZList']), '未返回净值')
    latest = head['Data']['LSJZList'][0]['FSRQ']
    require(old['last_date'] <= latest <= asof, '接口末日早于当前主档或晚于执行日期')
    first = page(1, latest)
    total = int(first['TotalCount'])
    rows = list(first['Data']['LSJZList'])
    i = 1
    while rows[-1]['FSRQ'] > old['rows'][-5]['date']:
        require(i * 20 < total, '分页未覆盖已有历史的最近5日')
        i += 1
        nextpage = page(i, latest)
        require(int(nextpage['TotalCount']) == total and bool(nextpage['Data']['LSJZList']), '分页数据发生变化')
        rows.extend(nextpage['Data']['LSJZList'])
    repeat = page(1, latest)
    require(int(repeat['TotalCount']) == total and repeat['Data'] == first['Data'], '抓取期间源数据发生变化，请重试')
    normalized = [dict(date=r['FSRQ'], nav=number(r['DWJZ']), accumulated_nav=number(r.get('LJJZ')),
                       daily_growth_pct=number(r.get('JZZZL')), event=str(r.get('FHSP') or r.get('FHFCZ') or ''),
                       source='天天基金 f10/lsjz（公开第三方）') for r in rows]
    return normalized, total


def official(old, asof, source):
    require(old['code'] == '270023' and old.get('share_class') == '人民币A'
            and old.get('source_type') == 'fund_manager_official_public_API', '官网主档身份异常')
    start = old['rows'][-5]['date']
    def page(i):
        data = source.get('https://www.gffunds.com.cn/apistore/JsonService',
                          dict(service='MarketPerformance', method='NAV', op='queryNAVByFundcode',
                               fundcode=old['code'], startdate=start.replace('-', ''), enddate=asof.replace('-', ''),
                               orderby='NAVDATE_DESC', pagelines=20, curpage=i))
        require(str(data.get('errorno')) == '20000', '官网接口返回错误')
        return data
    first = page(1)
    total, pages = int(first['totalrows']), int(first['totalpages'])
    require(total >= 5 and pages == (total + 19) // 20, '官网分页总数异常')
    raw = []
    for i in range(1, pages + 1):
        part = first if i == 1 else page(i)
        require(int(part['curpage']) == i and int(part['pagelines']) == 20
                and int(part['totalrows']) == total and int(part['totalpages']) == pages
                and len(part['data']) == min(20, total - (i - 1) * 20), '官网分页结构异常')
        raw.extend(part['data'])
    tail = page(pages + 1)
    require(tail['data'] == [] or (tail['data'] == '' and int(tail['totalrows']) == 0), '官网尾页非空')
    again = page(1)
    require(int(again['totalrows']) == total and again['data'] == first['data'], '抓取期间官网数据变化，请重试')
    def day(value):
        return None if value in (None, '', '00000000') else datetime.strptime(str(value), '%Y%m%d').strftime('%Y-%m-%d')
    rows = []
    for r in raw:
        require(r['FUNDCODE'] == old['code'] and r['FUNDNAME'] == old['name'], '官网代码或份额类别不一致')
        row = dict(date=day(r['NAVDATE']), nav=number(r['NAVUNIT']), accumulated_nav=number(r.get('NAVACCUMULATED')),
                   daily_growth_pct=number(r.get('DAYINCREMENTRATE')), previous_nav=number(r.get('PRENAVUNIT')),
                   previous_accumulated_nav=number(r.get('PRENAVACCUMULATED')), previous_nav_date=day(r.get('PRENAVEDATE')))
        require(start <= row['date'] <= asof, '官网返回窗口外日期')
        rows.append(row)
    dates = {r['date'] for r in rows}
    require(all(not r['previous_nav_date'] or r['previous_nav_date'] < start or r['previous_nav_date'] in dates for r in rows), '官网前一净值日期存在缺口')
    return rows, None


def merge(old, fresh, asof, total=None):
    validate(old, asof)
    fresh = sorted(fresh, key=lambda r: r['date'])
    require(len(fresh) >= 5 and len(fresh) == len({r['date'] for r in fresh}), '窗口日期重复或条数不足')
    require(fresh[0]['date'] <= old['rows'][-5]['date'] and old['last_date'] <= fresh[-1]['date'] <= asof, '窗口未覆盖历史末尾或日期倒退')
    dates = {r['date'] for r in fresh}
    require(all(r['date'] in dates for r in old['rows'] if r['date'] >= fresh[0]['date']), '源数据缺失已有历史日期，已停止覆盖')
    combined = {r['date']: r for r in old['rows']}
    added, revisions = [], []
    numeric = ['nav', 'accumulated_nav', 'daily_growth_pct'] + (['previous_nav', 'previous_accumulated_nav'] if old['code'] == '270023' else [])
    for row in fresh:
        previous = combined.get(row['date'])
        if previous is None:
            added.append(row['date'])
            combined[row['date']] = row
            continue
        changed = []
        for field in numeric:
            before, after = number(previous.get(field)), number(row.get(field))
            require(before is None or after is not None, '源数据缺失已归档数值，已停止覆盖')
            if (Decimal(before) if before is not None else None) != (Decimal(after) if after is not None else None):
                changed.append(field)
        for field in (['previous_nav_date'] if old['code'] == '270023' else ['event']):
            if (previous.get(field) or '') != (row.get(field) or ''):
                changed.append(field)
        if changed:
            revisions.append(dict(date=row['date'], fields=changed, before=previous, after=row))
            combined[row['date']] = row
    result = copy.deepcopy(old)
    result['rows'] = sorted(combined.values(), key=lambda r: r['date'])
    result.update(count=len(result['rows']), last_date=result['rows'][-1]['date'])
    require(total is None or total == result['count'], '接口总条数与保留历史不一致，需单独核验')
    validate(result, asof)
    return result, added, revisions


def stream(command, log, env=None):
    process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               encoding='utf-8', errors='replace')
    try:
        for line in process.stdout:
            if line.strip():
                log(line.rstrip())
        return process.wait()
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait()


def runtime_node():
    configured = os.environ.get('FUND_NAV_NODE')
    if configured:
        found = configured if Path(configured).is_file() else shutil.which(configured)
        require(found, 'FUND_NAV_NODE 指向的Node.js不可用')
        return str(found)
    candidate = RUNTIME / 'node/bin/node.exe'
    found = str(candidate) if candidate.is_file() else shutil.which('node')
    require(found, '未找到Node.js运行环境')
    return found


def replace_transaction(replacements, directory, after=None):
    """Backup before mutation, rollback handled failures; journal survives crashes."""
    backup = directory / '回滚备份'
    backup.mkdir(parents=True, exist_ok=True)
    originals = []
    for i, (target, staged) in enumerate(replacements):
        prior = backup / str(i)
        shutil.copy2(target, prior)
        originals.append((target, prior, sha(target)))
    journal = TEMP / '待恢复事务.json'
    require(not journal.exists(), '存在中断事务，请先恢复')
    save(journal, {'created_at': stamp(), 'files': [dict(target=str(t), backup=str(b), sha256=h) for t, b, h in originals]})
    try:
        for target, staged in replacements:
            os.replace(staged, target)
        if after:
            after()
    except BaseException:
        for target, prior, digest in originals:
            if sha(target) != digest:
                shutil.copy2(prior, target)
        journal.unlink()
        raise
    journal.unlink()


def recover(log):
    journal = TEMP / '待恢复事务.json'
    if not journal.exists():
        return
    files = load(journal)['files']
    for item in files:
        target, backup = Path(item['target']).resolve(), Path(item['backup']).resolve()
        require(target.is_relative_to(ROOT) and not target.is_relative_to(ROOT / '临时文件')
                and backup.is_relative_to(TEMP) and sha(backup) == item['sha256'], '中断事务备份核验失败')
    for item in files:
        target, backup = Path(item['target']), Path(item['backup'])
        if not target.exists() or sha(target) != item['sha256']:
            shutil.copy2(backup, target)
    journal.unlink()
    log('已恢复上次中断时的完整主档，可重新更新')


def update(folder, directory, asof, check_only, log):
    import organize_single_nav as archive_tool
    code = folder.name[:6]
    index = load(INDEX)
    entry = next(e for e in index['funds'] if e['code'] == code)
    targets = {kind: (ROOT / entry[kind + '_path']).resolve() for kind in ('json', 'csv', 'xlsx')}
    combined_xlsx = (folder / f'{code}_交易记录.xlsx').resolve()
    legacy_xlsx = (folder / f'{code}_全部历史净值.xlsx').resolve()
    require(targets['json'] == ARCHIVE / '维护数据' / code / f'{code}_全部历史净值.json'
            and targets['csv'] == targets['json'].with_suffix('.csv')
            and targets['xlsx'] in (combined_xlsx, legacy_xlsx), '索引路径不符合当前基金目录')
    for kind, target in targets.items():
        require(sha(target) == entry[kind + '_sha256'], f'{kind}主档哈希变化，请核对当前入口')
    old = load(targets['json'])
    require(old['code'] == code, '主档基金代码不一致')
    validate(old, asof)
    archive_tool.verify(old, targets['xlsx'])
    with targets['csv'].open(encoding='utf-8-sig', newline='') as handle:
        actual = list(csv.reader(handle))
    expected = [['日期', '净值', '日增长率']] + [[r['date'], str(r['nav']), '' if r.get('daily_growth_pct') in (None, '') else str(r['daily_growth_pct']) + '%'] for r in old['rows']]
    require(actual == expected, '已有CSV与完整主档不一致')
    log(f'{code} 校验通过，已有 {old["count"]} 条，截至 {old["last_date"]}')
    source = Source(directory, log)
    fresh, total = official(old, asof, source) if code == '270023' else eastmoney(old, asof, source)
    doc, added, revisions = merge(old, fresh, asof, total)
    result = dict(code=code, checked_at=stamp(), latest_date=doc['last_date'], records=doc['count'],
                  added=len(added), revisions=len(revisions), status='unchanged')
    if not added and not revisions:
        log(f'{code} 已是最新已公布净值（{doc["last_date"]}），无需改写')
    elif check_only:
        result['status'] = 'checked_pending_update'
        log(f'{code} 检查完成：可新增 {len(added)} 条、修订 {len(revisions)} 条；检查模式未写入主档')
    else:
        doc['incremental_update'] = dict(checked_at=stamp(), query_end_date=asof,
                                         query_start_date=old['rows'][-5]['date'], added_dates=added,
                                         revisions=revisions, previous_json_sha256=entry['json_sha256'],
                                         raw_evidence_path=directory.relative_to(ROOT).as_posix(),
                                         full_history_refetched=False, third_party_supplement_merged=False)
        if isinstance(doc.get('validation'), dict):
            doc['prior_validation'] = old['validation']
        doc['validation'] = dict(mode='incremental_recent_window', passed=True, total_rows=doc['count'],
                                 source_first_page_stable=True, full_history_refetched_this_run=False)
        staged_json = directory / f'{code}_全部历史净值.json'
        save(staged_json, doc)
        staged_csv = staged_json.with_suffix('.csv')
        with staged_csv.open('w', encoding='utf-8-sig', newline='') as handle:
            writer = csv.writer(handle)
            writer.writerow(['日期', '净值', '日增长率'])
            writer.writerows([r['date'], str(r['nav']), '' if r.get('daily_growth_pct') in (None, '') else str(r['daily_growth_pct']) + '%'] for r in doc['rows'])
        log(f'{code} 正在生成并逐行核验完整Excel：新增 {len(added)} 条，修订 {len(revisions)} 条')
        command = [runtime_node(), str(ROOT / '工具脚本/export_single_nav_workbook.mjs'), '--stage', f'--codes={code}', f'--input={staged_json}', f'--output-dir={directory}']
        require(stream(command, log) == 0, 'Excel生成或复读核验失败，原文件保留')
        staged_xlsx = directory / targets['xlsx'].name
        archive_tool.verify(doc, staged_xlsx)
        # Capture and guard every index before replacing any of the three masters.
        pointers = sorted(ARCHIVE.glob('*基金历史净值当前入口.*'))
        snapshots = {p: sha(p) for p in [*targets.values(), *pointers]}
        for kind, target in targets.items():
            require(sha(target) == entry[kind + '_sha256'], '生成期间主档发生变化，原文件保留')
        require(load(INDEX) == index, '生成期间索引发生变化，原文件保留')
        replacements = list(zip(targets.values(), [staged_json, staged_csv, staged_xlsx]))
        for i, pointer in enumerate(pointers):
            staged_pointer = directory / f'索引备份_{i}'
            shutil.copy2(pointer, staged_pointer)
            replacements.append((pointer, staged_pointer))
        require(all(sha(p) == digest for p, digest in snapshots.items()), '发布前主档或索引变化')
        def refresh_and_verify():
            output = io.StringIO()
            with redirect_stdout(output):
                archive_tool.refresh()
            for line in output.getvalue().splitlines():
                log(line)
            current = next(e for e in load(INDEX)['funds'] if e['code'] == code)
            require(all(sha(target) == current[kind + '_sha256'] for kind, target in targets.items()), '发布后索引核验失败')
        replace_transaction(replacements, directory, refresh_and_verify)
        result['status'] = 'updated'
        log(f'{code} 更新成功：完整历史 {doc["count"]} 条，截至 {doc["last_date"]}')
    save(directory / '结果.json', result)
    return result


def batch(folders, run, args, log):
    results = []
    with locked('批量运行.lock'):
        for i, folder in enumerate(folders, 1):
            code, script = folder.name[:6], folder / CHILD
            log(f'[{i}/{len(folders)}] 开始 {folder.name}')
            if not script.is_file():
                log(f'{code} 失败：缺少子脚本')
                results.append(dict(code=code, status='failed'))
                continue
            env = dict(os.environ, FUND_NAV_RUN_DIR=str(run), PYTHONIOENCODING='utf-8', PYTHONDONTWRITEBYTECODE='1')
            extra = ' --check-only' if args.check_only else ''
            command = f'"{os.environ.get("COMSPEC", "cmd.exe")}" /d /s /c ""{script}" --no-pause{extra}"'
            exitcode = stream(command, log, env)
            resultpath = run / code / '结果.json'
            result = load(resultpath) if resultpath.exists() else dict(code=code, status='failed')
            result['code'] = code
            if exitcode:
                result['status'] = 'failed'
            results.append(result)
            log(f'[{i}/{len(folders)}] {code} {"失败" if exitcode else "完成"}')
    failed = sum(r['status'] == 'failed' for r in results)
    save(run / '汇总.json', dict(checked_at=stamp(), funds=len(results), failed=failed, results=results))
    log(f'全部结束：共 {len(results)} 只，成功 {len(results)-failed} 只，失败 {failed} 只')
    return 1 if failed else 0


def main():
    parser = argparse.ArgumentParser(description='同步当前持仓基金或全部持仓基金的最新已公布净值')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--held', action='store_true')
    group.add_argument('--fund-dir', type=Path)
    parser.add_argument('--no-pause', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--check-only', action='store_true', help='仅查询核验，不改写正式净值文件')
    args = parser.parse_args()
    inherited = os.environ.get('FUND_NAV_RUN_DIR') if args.fund_dir else None
    run = Path(inherited).resolve() if inherited else TEMP / datetime.now(TZ).strftime('%Y%m%d_%H%M%S_%f')
    require(run.is_relative_to(TEMP) and run != TEMP, '日志目录必须位于临时文件/净值更新下')
    directory = run / args.fund_dir.resolve().name[:6] if args.fund_dir else run
    directory.mkdir(parents=True, exist_ok=True)
    log = Log(directory / ('执行日志.log' if args.fund_dir else '总日志.log'))
    try:
        folders = discover()
        log('净值同步开始（最新已公布净值；休市日不补造记录）')
        log(f'日志位置：{directory}')
        if args.held:
            return batch(folders, run, args, log)
        folder = args.fund_dir.resolve()
        require(folder in folders, '子脚本必须在已登记的唯一基金目录运行')
        with locked('主档更新.lock'):
            recover(log)
            update(folder, directory, datetime.now(TZ).date().isoformat(), args.check_only, log)
        return 0
    except Exception as error:
        log(f'任务失败：{error}')
        save(directory / '结果.json', dict(status='failed', checked_at=stamp(), error=str(error)))
        return 1
    finally:
        log.close()


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    raise SystemExit(main())
