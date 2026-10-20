"""Validate the six selected public NAV archives and publish an audit/pointer.

Reads the current fixed-name JSON/CSV archives. It never authors spreadsheets,
changes NAV records, infers holdings, or rewrites the all-fund index.
"""

import sys
sys.dont_write_bytecode = True
import argparse
import csv
import hashlib
import io
import json
import os
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / '公共资料/历史净值'
CODES = ['270023', '005698', '016701', '006373', '006485', '006663']
HEADERS = ['日期', '净值', '日增长率']


def file(value):
    path = (ROOT / value).resolve()
    assert path.is_relative_to(ROOT), 'Path outside project'
    return path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def pair(entry):
    jp, cp = file(entry['json_path']), file(entry['csv_path'])
    assert jp.name == entry['code'] + '_全部历史净值.json', 'Candidate is not a published current archive'
    assert sha(jp) == entry['json_sha256'] and sha(cp) == entry['csv_sha256'], 'Current pair differs from index hash'
    doc = load(jp)
    assert doc['code'] == entry['code']
    dates = [row['date'] for row in doc['rows']]
    assert dates == sorted(set(dates)), 'Duplicate or unsorted NAV date'
    assert len(dates) == doc['count'] == entry['records']
    assert dates[0] == doc['first_date'] == entry['first_date']
    assert dates[-1] == doc['last_date'] == entry['last_date']
    data = cp.read_bytes()
    assert data.startswith(b'\xef\xbb\xbf') and b'\r\n' in data
    saved = list(csv.reader(io.StringIO(data.decode('utf-8-sig'), newline='')))
    assert saved[0] == HEADERS and len(saved) == len(dates) + 1
    for source, row in zip(doc['rows'], saved[1:]):
        assert len(row) == 3 and row[0] == source['date']
        assert Decimal(row[1]) == Decimal(str(source['nav'])) > 0
        if source.get('daily_growth_pct') in (None, ''):
            assert row[2] == ''
        else:
            assert row[2].endswith('%') and Decimal(row[2][:-1]) == Decimal(str(source['daily_growth_pct']))
        # The CSV uses the source decimal text, including trailing zeros.
        if isinstance(source['nav'], str):
            assert row[1] == source['nav']
        if isinstance(source.get('daily_growth_pct'), str):
            assert row[2] == source['daily_growth_pct'] + '%'
    # The sole fund-folder table must be current, not just the machine pair.
    import openpyxl
    xp = file(entry['xlsx_path'])
    assert sha(xp) == entry['xlsx_sha256'], 'Current Excel differs from index hash'
    workbook = openpyxl.load_workbook(xp, read_only=True, data_only=True)
    try:
        table = list(workbook['全部历史净值'].values)
        assert table[0] == tuple(HEADERS) and len(table) == doc['count'] + 1
        from datetime import date, timedelta
        for actual, source in zip(table[1:], doc['rows']):
            day = actual[0].date().isoformat() if isinstance(actual[0], datetime) else (date(1899, 12, 30) + timedelta(days=int(actual[0]))).isoformat()
            assert day == source['date'] and Decimal(str(actual[1])) == Decimal(str(source['nav']))
            if source.get('daily_growth_pct') in (None, ''):
                assert actual[2] is None
            else:
                assert abs(Decimal(str(actual[2])) * 100 - Decimal(str(source['daily_growth_pct']))) < Decimal('1e-10')
    finally:
        workbook.close()
    return doc


def atomic(path, text):
    staged = path.with_name(path.name + '.tmp')
    staged.write_text(text, encoding='utf-8')
    os.replace(staged, path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--date', required=True)
    parser.add_argument('--five', required=True)
    parser.add_argument('--official', required=True)
    args = parser.parse_args()
    datetime.strptime(args.date, '%Y-%m-%d')
    five = load(file(args.five))
    official_path = file(args.official)
    official = load(official_path)
    assert five['execution_date'] == official['execution_date'] == args.date
    source_index = ARCHIVE / '全基金历史净值当前入口.json'
    current = load(source_index)
    entries = {item['code']: item for item in current['funds']}
    inputs = list(five['results']) + [dict(official, verification_path=args.official, verification_sha256=sha(official_path))]
    assert len({item['code'] for item in inputs}) == len(inputs)
    results, failures = [], list(five.get('failures', []))
    for result in inputs:
        code = result['code']
        try:
            assert code in CODES and not result.get('failure')
            assert not result.get('conflicts', result.get('source_conflicts', []))
            entry = entries[code]
            assert result['json_path'] == entry['json_path'] and result['csv_path'] == entry['csv_path'], 'Current pointer changed or candidate not published'
            assert result['json_sha256'] == entry['json_sha256'] and result['csv_sha256'] == entry['csv_sha256']
            doc = pair(entry)
            checked = result.get('checked_dates', result.get('recent_five_verified_dates', []))
            assert checked == [row['date'] for row in doc['rows'][-5:]], 'Latest five published dates were not verified'
            assert sha(file(result['verification_path'])) == result['verification_sha256']
            for evidence in result.get('raw_evidence', []):
                assert sha(file(evidence['path'])) == evidence['sha256']
            if result.get('raw_evidence_path'):
                assert sha(file(result['raw_evidence_path'])) == result['raw_evidence_sha256']
            old_path = result.get('old_json_path', result.get('previous_json_path'))
            old_hash = result.get('old_json_sha256', result.get('previous_json_sha256'))
            if old_path and old_hash:
                assert sha(file(old_path)) == old_hash, 'Previous archive changed during capture'
            if result.get('old_csv_path'):
                assert sha(file(result['old_csv_path'])) == result['old_csv_sha256']
            added, revised = len(result.get('added_dates', [])), len(result.get('revisions', []))
            results.append({**entry, 'source': result.get('source', entry.get('source')), 'checked_at': result['checked_at'], 'checked_dates': checked, 'status': 'updated' if added or revised else 'unchanged', 'added_dates': result.get('added_dates', []), 'added_count': added, 'revision_count': revised, 'revisions': result.get('revisions', []), 'missing_accumulated_nav_dates': [row['date'] for row in doc['rows'] if row.get('accumulated_nav') in (None, '')], 'missing_growth_dates': [row['date'] for row in doc['rows'] if row.get('daily_growth_pct') in (None, '')], 'verification_path': result['verification_path'], 'verification_sha256': result['verification_sha256'], 'raw_evidence': result.get('raw_evidence', []), 'raw_evidence_path': result.get('raw_evidence_path'), 'raw_evidence_sha256': result.get('raw_evidence_sha256'), 'csv_json_row_comparison_passed': True, 'prior_files_unchanged': True, 'full_history_refetched_this_run': False})
        except Exception as error:
            failures.append({'code': code, 'status': 'failed', 'error': str(error)})
    for missing in set(CODES) - {item['code'] for item in inputs} - {item['code'] for item in failures}:
        failures.append({'code': missing, 'status': 'failed', 'error': 'Missing fund result'})
    results.sort(key=lambda item: CODES.index(item['code']))
    # Re-read current entries immediately before publishing, retaining changes
    # from other tasks rather than overwriting the shared all-fund index.
    fresh = {item['code']: item for item in load(source_index)['funds']}
    for item in results:
        for key in ['json_path', 'csv_path', 'json_sha256', 'csv_sha256']:
            assert item[key] == fresh[item['code']][key], 'Concurrent pointer change before publication'
    now = datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(timespec='seconds')
    report = {'schema': 'six-fund-public-nav-incremental-audit-v1', 'execution_date': args.date, 'checked_at': now, 'scope': CODES, 'source_index_path': source_index.relative_to(ROOT).as_posix(), 'source_index_sha256_at_completion': sha(source_index), 'table_columns': HEADERS, 'results': results, 'failures': failures, 'all_six_verified': len(results) == 6 and not failures, 'added_records': sum(item['added_count'] for item in results), 'revised_records': sum(item['revision_count'] for item in results), 'full_history_refetched_this_run': False, 'disclosure_time_note': '抓取时间与净值归属日分别记录；接口未统一提供可确认的正式披露时间。', 'recovered_scan_issue': '首次目录扫描遇到并行整理后的基金分组，未请求净值即停止；改为按代码跨分组唯一定位后，最终逐只完成核验。'}
    output = ARCHIVE / f'六基金净值更新_{args.date}.json'
    if output.exists():
        previous = load(output)
        report['previous_same_day_checks'] = previous.get('previous_same_day_checks', []) + [{'checked_at': previous['checked_at'], 'verification_paths': [item['verification_path'] for item in previous['results']], 'failures': previous.get('failures', [])}]
    text = f'# 六基金历史净值更新核验\n\n执行日期：{args.date}。完成核验：{now}。本次读取现行固定文件名主档，只请求最新窗口与实际缺口，未重下全历史。\n\n'
    text += '| 代码 | 基金 | 最新净值日 | 最近五个已公布日期 | 新增 | 修订 | 结果 |\n|---|---|---|---|---:|---:|---|\n'
    for item in results:
        text += f"| {item['code']} | {item['name']} | {item['last_date']} | {', '.join(item['checked_dates'])} | {item['added_count']} | {item['revision_count']} | {'已更新' if item['status'] == 'updated' else '已核验、无变化'} |\n"
    text += '\n各CSV均保持当前“日期、净值、日增长率”三列，UTF-8 BOM、来源小数精度及百分数表示已与JSON逐行核对；JSON内的累计净值、来源及缺值记录保留。\n\n'
    text += '270023以管理人官网主档为准，既有10条第三方补充观察独立保留。其余五只沿用东方财富/天天基金既有来源，不冒称官网独立全量核验。休市与尚未披露的日期不补造。\n\n'
    for item in results:
        text += f"- {item['code']}：[JSON](../../{item['json_path']}) · [CSV](../../{item['csv_path']}) · [原始响应与本次核验](../../{item['verification_path']})；累计净值缺{len(item['missing_accumulated_nav_dates'])}日，日增长率缺{len(item['missing_growth_dates'])}日；记录{item['records']}条。JSON SHA-256：`{item['json_sha256']}`；CSV SHA-256：`{item['csv_sha256']}`。\n"
    text += '\n首次扫描时适逢目录分组整理，扫描失败发生在请求净值之前；已按实际分组重新定位并完成核验。旧四基金入口、旧报告与研究结果保留；未改账户、量化规则、定时调度或Git。\n'
    if failures:
        text += '\n失败：\n' + '\n'.join(f"- {item['code']}：{item['error']}" for item in failures) + '\n'
    atomic(output, json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    atomic(output.with_suffix('.md'), text)
    if report['all_six_verified']:
        pointer = {'schema': 'six-fund-public-nav-current-v1', 'updated_at': now, 'scope': CODES, 'storage_policy': current.get('storage_policy'), 'table_columns': HEADERS, 'audit_path': output.relative_to(ROOT).as_posix(), 'funds': [{key: item[key] for key in ['code', 'name', 'records', 'first_date', 'last_date', 'json_path', 'csv_path', 'json_sha256', 'csv_sha256', 'source', 'checked_dates', 'verification_path', 'verification_sha256']} for item in results]}
        atomic(ARCHIVE / '六基金历史净值当前入口.json', json.dumps(pointer, ensure_ascii=False, indent=2) + '\n')
        for entry in pointer['funds']:
            current_entry = entries[entry['code']]
            entry.update(xlsx_path=current_entry['xlsx_path'], xlsx_sha256=current_entry['xlsx_sha256'])
        atomic(ARCHIVE / '六基金历史净值当前入口.json', json.dumps(pointer, ensure_ascii=False, indent=2) + '\n')
        atomic(ARCHIVE / '六基金历史净值当前入口.md', f'# 六基金历史净值当前入口\n\n最近核验：{now}。[本次完整核验](六基金净值更新_{args.date}.md) · [机器可读入口](六基金历史净值当前入口.json)。基金根目录直接保留一份Excel。\n\n' + '\n'.join(f"- {item['code']} {item['name']}：截至{item['last_date']}，[Excel](../../{item['xlsx_path']})。" for item in results) + '\n\n原四基金入口及历史核验资料保留。本入口只覆盖上述六个代码，不推断账户交易或持仓。\n')
        assert load(ARCHIVE / '六基金历史净值当前入口.json')['scope'] == CODES
    assert load(output)['all_six_verified'] == report['all_six_verified']
    print(json.dumps({'report': output.relative_to(ROOT).as_posix(), 'verified_funds': len(results), 'added_records': report['added_records'], 'revised_records': report['revised_records'], 'failures': failures}, ensure_ascii=False))
    return bool(failures)


if __name__ == '__main__':
    raise SystemExit(main())
