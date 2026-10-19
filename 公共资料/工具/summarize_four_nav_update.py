"""Verify public NAV pairs/evidence and publish the four-fund audit and pointer.

This does not author CSVs, modify frozen inputs, or change scheduled tasks.
Candidate CSVs must already have been exported and checked before this step.
"""
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

ROOT = Path(__file__).resolve().parents[2]
CODES = ['270023', '005698', '016701', '006373']
HEADERS = ['基金代码', '基金名称', '净值日期', '单位净值', '累计净值', '日增长率(%)', '分红事件', '数据来源']


def project_path(value):
    result = (ROOT / value).resolve()
    assert result.is_relative_to(ROOT), 'Path outside project'
    return result


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def verify_pair(result):
    jp, cp = project_path(result['json_path']), project_path(result['csv_path'])
    assert digest(jp) == result['json_sha256'], 'JSON changed after capture'
    if result.get('csv_sha256'):
        assert digest(cp) == result['csv_sha256'], 'CSV changed after capture'
    doc = load(jp)
    rows = doc['rows']
    assert doc['code'] == result['code'] and doc['count'] == len(rows)
    dates = [row['date'] for row in rows]
    assert dates == sorted(set(dates))
    assert dates[0] == doc['first_date'] and dates[-1] == doc['last_date'] == result['last_date']
    data = cp.read_bytes()
    assert data.startswith(b'\xef\xbb\xbf'), 'CSV must retain UTF-8 BOM'
    assert b'\r\n' in data, 'CSV line ending changed'
    saved = list(csv.reader(io.StringIO(data.decode('utf-8-sig'), newline='')))
    assert len(saved) == len(rows) + 1
    if doc['code'] == '270023':
        assert saved[0] == ['净值日期', '单位净值', '累计净值', '官网单位净值日增长率（%）', '基金代码', '份额类别']
        for source, row in zip(rows, saved[1:]):
            assert len(row) == 6 and row[0] == source['date'] and row[4:] == [doc['code'], doc['share_class']]
            for index, field in enumerate(['nav', 'accumulated_nav', 'daily_growth_pct'], 1):
                assert (row[index] == '') == (source.get(field) is None)
                if source.get(field) is not None:
                    assert Decimal(row[index]) == Decimal(str(source[field]))
    else:
        assert saved[0] == HEADERS
        for source, row in zip(rows, saved[1:]):
            expected = [doc['code'], doc['name'], source['date'], source['nav'], source.get('accumulated_nav'), source.get('daily_growth_pct'), source.get('event', ''), source.get('source', doc.get('source', ''))]
            assert row == ['' if item is None else str(item) for item in expected], 'CSV differs from JSON'
    return {'csv_json_row_comparison_passed': True, 'csv_sha256': digest(cp), 'json_sha256': digest(jp), 'records': len(rows), 'missing_unit_nav_dates': [row['date'] for row in rows if row.get('nav') is None], 'missing_accumulated_nav_dates': [row['date'] for row in rows if row.get('accumulated_nav') is None], 'missing_growth_dates': [row['date'] for row in rows if row.get('daily_growth_pct') is None]}


def atomic_text(path, text):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(text, encoding='utf-8')
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--date', required=True)
    parser.add_argument('--three', required=True)
    parser.add_argument('--official', required=True)
    args = parser.parse_args()
    datetime.strptime(args.date, '%Y-%m-%d')
    third = load(project_path(args.three))
    official_path = project_path(args.official)
    official = load(official_path)
    assert third['execution_date'] == official['execution_date'] == args.date
    results = list(third['results']) + [dict(official, verification_path=args.official, verification_sha256=digest(official_path), checked_dates=official.get('recent_five_verified_dates', []), conflicts=official.get('source_conflicts', []))]
    assert len({item['code'] for item in results}) == len(results)
    failures = list(third.get('failures', []))
    manifest_files = sorted((ROOT / '公共资料/历史净值').glob('指定基金全历史净值归档清单_核验????-??-??.json'))
    current = load(manifest_files[-1])
    current_by_code = {entry['code']: entry for entry in current['funds']}
    verified = []
    for result in results:
        try:
            assert result['code'] in CODES
            assert not result.get('failure') and not result.get('conflicts'), 'Source failure or unresolved conflict'
            checks = verify_pair(result)
            entry = current_by_code[result['code']]
            # Compare the current pointer again. Never overwrite a newer run's
            # main archive entry with the startup manifest snapshot.
            prior_path = result.get('old_json_path', result.get('previous_json_path', result['json_path']))
            prior_hash = result.get('old_json_sha256', result.get('previous_json_sha256', result['json_sha256']))
            assert (entry['json_path'], entry['json_sha256']) in [(prior_path, prior_hash), (result['json_path'], result['json_sha256'])], 'Current archive pointer changed concurrently; recheck source before publishing'
            assert digest(project_path(result['verification_path'])) == result['verification_sha256']
            for evidence in result.get('raw_evidence', []):
                assert digest(project_path(evidence['path'])) == evidence['sha256']
            if result.get('raw_evidence_path'):
                assert digest(project_path(result['raw_evidence_path'])) == result['raw_evidence_sha256']
            old_jp = project_path(prior_path)
            assert digest(old_jp) == prior_hash, 'Frozen JSON changed'
            if result.get('old_csv_path'):
                assert digest(project_path(result['old_csv_path'])) == result['old_csv_sha256'], 'Frozen CSV changed'
            result = {**result, **checks, 'status': 'updated' if result.get('added_dates') or result.get('revisions') else 'unchanged', 'added_count': len(result.get('added_dates', [])), 'revision_count': len(result.get('revisions', []))}
            auxiliary = project_path(str(Path(result['json_path']).parent / '原始数据' / f'官网辅助核对_{args.date}' / f"{result['code']}_官网辅助核对结果_{args.date}.json"))
            if auxiliary.exists():
                result['supplementary_check_path'] = auxiliary.relative_to(ROOT).as_posix()
                result['supplementary_check_sha256'] = digest(auxiliary)
                auxiliary_data = load(auxiliary)
                result['supplementary_check_scope'] = auxiliary_data['comparison_scope']
                if auxiliary_data.get('raw_evidence'):
                    auxiliary_raw = auxiliary_data['raw_evidence']
                    assert digest(project_path(auxiliary_raw['path'])) == auxiliary_raw['sha256'], 'Supplementary evidence changed'
            verified.append(result)
        except Exception as exc:
            failures.append({'code': result.get('code'), 'status': 'failed', 'error': str(exc)})
    missing = set(CODES) - {item['code'] for item in results} - {item['code'] for item in failures}
    failures.extend({'code': code, 'status': 'failed', 'error': 'Missing fund result'} for code in sorted(missing))
    verified.sort(key=lambda item: CODES.index(item['code']))
    now = datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(timespec='seconds')
    report = {'schema': 'four-fund-public-nav-incremental-audit-v1', 'execution_date': args.date, 'checked_at': now, 'scope': CODES, 'source_manifest_path': manifest_files[-1].relative_to(ROOT).as_posix(), 'full_history_refetched_this_run': False, 'results': verified, 'failures': failures, 'added_records': sum(item['added_count'] for item in verified), 'revised_records': sum(item['revision_count'] for item in verified), 'all_four_verified': len(verified) == 4 and not failures, 'frozen_originals_unchanged': not failures, 'disclosure_time_note': '接口抓取时间不等于正式披露时间；各接口未提供可统一确认的披露时刻。', 'supplementary_scopes': [{'code': item['code'], 'scope': item['supplementary_check_scope']} for item in verified if item.get('supplementary_check_scope')]}
    archive = ROOT / '公共资料/历史净值'
    out = archive / f'四基金净值更新_{args.date}.json'
    # Retain earlier same-day summaries in the append-only source run folder.
    if out.exists():
        previous = load(out)
        report['previous_same_day_checks'] = previous.get('previous_same_day_checks', []) + [{'checked_at': previous.get('checked_at'), 'added_records': previous.get('added_records'), 'revised_records': previous.get('revised_records'), 'failures': previous.get('failures', []), 'verification_paths': [item['verification_path'] for item in previous.get('results', [])]}]
    text = '# 四基金历史净值更新核验\n\n' + f'执行日期：{args.date}。完成核验时间：{now}。本次只查近期窗口与缺口，没有重新下载全历史。\n\n'
    text += '| 代码 | 基金 | 来源 | 最新净值日 | 最近五个公布日 | 新增 | 修订 | 结果 |\n|---|---|---|---|---|---:|---:|---|\n'
    for item in verified:
        label = '已更新并校验' if item['status'] == 'updated' else '已校验、无变化'
        text += f"| {item['code']} | {item['name']} | {'管理人官网' if item['code'] == '270023' else '东方财富/天天基金'} | {item['last_date']} | {', '.join(item['checked_dates'])} | {item['added_count']} | {item['revision_count']} | {label} |\n"
    text += '\n净值归属日与执行日分别记录，尚未正式披露的日期不补造。'
    text += ('本次无新增或修订，不另建重复主档。' if not report['added_records'] and not report['revised_records'] else f"本次新增{report['added_records']}条、修订{report['revised_records']}条；旧主档保留。") + '\n\n'
    text += '累计净值和日增长率缺值按来源保留，不推算。广发既有10条第三方独有观察与官网主档分开，均未修改。\n\n'
    for scope in report['supplementary_scopes']:
        text += f"- {scope['code']}官网辅助核验范围：{scope['scope']}。\n"
    text += '\n'
    for item in verified:
        text += f"- {item['code']}：[JSON](../../{item['json_path']}) · [CSV](../../{item['csv_path']}) · [本次原始证据与核验结果](../../{item['verification_path']})；记录{item['records']}条，累计净值缺{len(item['missing_accumulated_nav_dates'])}日、日增长率缺{len(item['missing_growth_dates'])}日。JSON SHA-256：`{item['json_sha256']}`；CSV SHA-256：`{item['csv_sha256']}`。\n"
    text += '\n所有成功项已保存后重读，逐行核对JSON/CSV字段、行数、日期顺序与唯一性，并复核原始证据哈希。旧主档和研究冻结输入未修改，未改账户或量化规则。\n'
    if failures:
        text += '\n失败项：\n' + '\n'.join(f"- {item['code']}：{item['error']}" for item in failures) + '\n'
    atomic_text(out, json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    atomic_text(out.with_suffix('.md'), text)
    if len(verified) == 4 and not failures:
        pointer = {'schema': 'four-fund-public-nav-current-v1', 'updated_at': now, 'execution_date': args.date, 'scope': CODES, 'audit_path': out.relative_to(ROOT).as_posix(), 'funds': [{key: item[key] for key in ['code', 'name', 'first_date', 'last_date', 'records', 'json_path', 'csv_path', 'json_sha256', 'csv_sha256', 'verification_path', 'verification_sha256', 'checked_dates', 'csv_json_row_comparison_passed']} for item in verified]}
        atomic_text(archive / '四基金历史净值当前入口.json', json.dumps(pointer, ensure_ascii=False, indent=2) + '\n')
        atomic_text(archive / '四基金历史净值当前入口.md', '# 四基金历史净值当前入口\n\n' + f"最近核验：{now}。[完整更新记录](四基金净值更新_{args.date}.md) · [机器可读入口](四基金历史净值当前入口.json)。\n\n" + '\n'.join(f"- {item['code']} {item['name']}：截至{item['last_date']}，[CSV](../../{item['csv_path']}) · [JSON](../../{item['json_path']})。" for item in verified) + '\n\n旧的全量核验清单仍保留，本入口只更新指定四只基金的当前读取位置。\n')
    assert load(out)['all_four_verified'] == (len(verified) == 4 and not failures)
    print(json.dumps({'report': out.relative_to(ROOT).as_posix(), 'verified_funds': len(verified), 'added_records': report['added_records'], 'revised_records': report['revised_records'], 'failures': failures}, ensure_ascii=False))
    return bool(failures)


if __name__ == '__main__':
    raise SystemExit(main())
