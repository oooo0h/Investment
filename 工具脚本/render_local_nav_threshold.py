"""Audit registered public-NAV outputs and render per-fund scientific PNGs.

Read-only to source NAV, research JSON, locks, protocols, and reports. Only PNG
files are produced. No investor/account inputs are read.
"""
from __future__ import annotations

import sys
sys.dont_write_bytecode = True

import argparse
import datetime as dt
import hashlib
import itertools
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = (.4, .3, .2, .3)
CASE_LABELS = [
    ('hindsight_calmar', '收益回撤比最优'),
    ('hindsight_max_return', '收益最高'),
    ('hindsight_min_drawdown', '回撤最低'),
    ('annual_hold', '年度买入持有'),
    ('monthly', '年度到账预算按月投入'),
    ('reference40_30', '原40/30参考'),
    ('chronological_frozen', '2025年底选定参数回看全历史'),
]


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def close(actual, expected):
    assert math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-9), (actual, expected)


def independent_rank(records, floor, cap):
    eligible = [r for r in records if not r.get('pruned') and r['calmar'] is not None
                and r['twr_annualized_pct'] > 0.
                and r['twr_annualized_pct'] >= floor - 1e-10
                and r['peak_extra_over_regular_pct'] <= cap * 100 + 1e-9]
    def key(r):
        return (-round(r['calmar'], 12), r['tactical_buy_count'] + r['tactical_sell_count'],
                r['extra_contributed_norm'], sum(abs(a-b) for a,b in zip(r['rule'], REFERENCE)),
                r['rule'])
    return sorted(eligible, key=key)


def rule_text(rule):
    return ('无阈值调仓' if rule is None else
            f'涨{rule[0]*100:g}%卖{rule[2]*100:g}%；跌{rule[1]*100:g}%加{rule[3]*100:g}%')


def unlimited_rule_text(rule):
    if rule is None:
        return '年度买入持有，无主动调仓'
    up, down, sell, buy = rule
    return ((f'涨{up*100:g}%卖{sell*100:g}%' if sell else '不上涨卖出') + '；' +
            (f'跌{down*100:g}%加{buy*100:g}%' if buy else '不下跌加仓'))


def audit(result_path):
    r = read(result_path)
    p = r['protocol']
    unlimited = p['schema'] == 'public-nav-threshold-unlimited-funding-v1'
    stem = result_path.with_suffix('')
    suffix = lambda s: Path(str(stem) + s + '.json')
    report = Path(str(stem) + '_研究报告.md').read_text(encoding='utf-8')
    registered = read(suffix('_预设'))
    assert p == registered
    source = ROOT / p['source_path']
    assert sha(source) == r['source_sha256'] == p['source_sha256']
    config = (ROOT / p['config_path'] if unlimited else
              result_path.parent.parent/'scripts'/(p['fund_code']+'_量化研究配置_2026-10-18.json'))
    assert sha(config) == p['config_sha256']
    config_data = read(config)
    for key, filename in [
        ('engine_sha256', 'annual_threshold_backtest.py'),
        ('grid_library_sha256', 'annual_threshold_study.py'),
        ('settlement_stress_tool_sha256', 'annual_threshold_settlement.py'),
        ('research_tool_sha256', ('research_local_nav_threshold_unlimited.py' if unlimited else
                                  'research_local_nav_threshold.py')),
    ]:
        assert sha(Path(__file__).with_name(filename)) == p[key], filename
    if unlimited:
        assert sha(Path(__file__).with_name('research_local_nav_threshold.py')) == p['base_research_tool_sha256']
        comparison_stem = str(stem).replace('_无补款上限量化研究_', '_年度阈值量化研究_')
        assert sha(Path(comparison_stem+'_预设.json')) == p['constrained_comparison_preset_sha256']
    source_rows = read(source)['rows']
    assert len(source_rows) == p['source_rows']
    assert sum(dt.date.fromisoformat(x['date']).weekday() < 5 for x in source_rows) == p['analysis_rows']
    grid = read(suffix('_全历史网格'))
    thresholds = [.05, .10, .15, .20, .25, .30, .40, .50, .60]
    fractions = [0., .05, .10, .15, .20, .30, .50]
    expected_rules = {(a if c else .4, b if d else .3, c, d)
                      for a,b,c,d in itertools.product(thresholds, thresholds, fractions, fractions)}
    assert len(expected_rules) == 3025 == len(grid) == r['grid_count'] == p['canonical_grid_count']
    assert len({tuple(x['rule']) for x in grid}) == 3025
    assert {tuple(x['rule']) for x in grid} == expected_rules
    cap = math.inf if unlimited else p['constraints']['at_every_observation_extra_to_cumulative_annual_budget_max']
    if unlimited:
        assert p['constraints']['funding_cap'] is None
        assert config_data['funding_cap'] is None
        assert not any(x.get('pruned') for x in grid)
    floor = max(0., r['cases']['annual_hold']['summary']['twr_annualized_pct'])
    close(r['full_history_return_floor_pct'], floor)
    ranked = independent_rank(grid, floor, cap)
    assert len(ranked) == r['eligible_count']
    assert ranked[:20] == r['top20']
    assert ranked[0]['rule'] == r['main_selected_rule']
    score_ties = [x for x in ranked if abs(x['calmar']-ranked[0]['calmar']) <= 1e-12]
    assert len(score_ties) == r['score_ties']['primary_count']
    assert [x['rule'] for x in score_ties] == r['score_ties']['primary_rules']
    assert len({x['path_signature'] for x in score_ties}) == r['score_ties']['primary_path_count']
    assert sum(bool(x.get('pruned')) for x in grid) == r['funding_pruned_count']
    best_return = max(ranked, key=lambda x: (x['twr_annualized_pct'], -x['max_drawdown_pct'],
                                            -x['extra_contributed_norm']))
    lowest_drawdown = min(ranked, key=lambda x: (x['max_drawdown_pct'], -x['twr_annualized_pct'], x['rule']))
    assert best_return['rule'] == r['cases']['hindsight_max_return']['summary']['rule']
    assert lowest_drawdown['rule'] == r['cases']['hindsight_min_drawdown']['summary']['rule']
    for key, case in r['cases'].items():
        s, daily = case['summary'], case['daily']
        days = (dt.date.fromisoformat(daily[-1]['date']) - dt.date.fromisoformat(daily[0]['date'])).days
        close(s['twr_annualized_pct'], (daily[-1]['twr_index'] ** (365.2425/days) - 1.) * 100.)
        peak, mdd = 1., 0.
        regular = extra = 0.
        for day in daily:
            peak = max(peak, day['twr_index'])
            mdd = max(mdd, 1. - day['twr_index']/peak)
            close(day['drawdown_pct'], (day['twr_index']/peak - 1.) * 100.)
            regular += day['regular_today_norm']
            extra += day['extra_today_norm']
        close(s['max_drawdown_pct'], mdd * 100.)
        close(s['regular_contributed_norm'], regular)
        close(s['extra_contributed_norm'], extra)
        if s['calmar'] is not None:
            close(s['calmar'], s['twr_annualized_pct']/s['max_drawdown_pct'])
        # Independently verify reported money-weighted rate against dated flows.
        origin = dt.date.fromisoformat(case['cashflows'][0]['date'])
        rate = s['xirr_pct']/100.
        npv = sum(x['value']/(1.+rate)**((dt.date.fromisoformat(x['date'])-origin).days/365.)
                  for x in case['cashflows'])
        assert abs(npv) < 1e-7, (key, 'XIRR residual', npv)
    table_rows = [(key,label,r['cases'][key]['summary']) for key,label in CASE_LABELS if key in r['cases']]
    if unlimited:
        comparison = read(Path(comparison_stem+'.json'))
        table_rows = [
            ('hindsight_calmar', '无上限：收益回撤比最优', r['cases']['hindsight_calmar']['summary']),
            ('hindsight_max_return', '无上限：收益最高', r['cases']['hindsight_max_return']['summary']),
            ('hindsight_min_drawdown', '无上限：回撤最低', r['cases']['hindsight_min_drawdown']['summary']),
            ('annual_hold', '年度买入持有', r['cases']['annual_hold']['summary']),
            ('comparison', '原50%约束对照', comparison['cases']['hindsight_calmar']['summary']),
        ]
    for key, label, s in table_rows:
        if key not in r['cases']:
            assert unlimited and key == 'comparison'
        rule_label = unlimited_rule_text(s['rule']) if unlimited else rule_text(s['rule'])
        expected_row = (f'| {label} | {rule_label} | {s["twr_annualized_pct"]:.2f}% | '
                        f'{s["max_drawdown_pct"]:.2f}% | {s["calmar"]:.4f} | {s["xirr_pct"]:.2f}% | ' +
                        (f'{s["extra_over_regular_pct"]:.2f}% | ' if unlimited else '') +
                        f'{s["peak_extra_over_regular_pct"]:.2f}% | {s["tactical_buy_count"]}/{s["tactical_sell_count"]} |')
        assert expected_row in report, (key, 'report row mismatch')
    order_checks = []
    fullgrid_time = suffix('_全历史网格').stat().st_mtime_ns
    for fold in r['chronological_folds']:
        year = int(fold['lock']['test_start'][:4])
        lock_path, test_path = suffix('_参数锁定'+str(year)), suffix('_时序检验'+str(year))
        assert sha(lock_path) == fold['lock_sha256']
        assert read(lock_path) == fold['lock']
        assert read(test_path) == fold
        assert lock_path.stat().st_mtime_ns <= test_path.stat().st_mtime_ns <= fullgrid_time
        train_grid = read(suffix('_训练网格'+str(year-1)))
        assert len(train_grid) == 3025
        selected = independent_rank(train_grid, fold['lock']['return_floor_pct'], cap)
        assert (selected[0] if selected else None) == fold['lock']['selected']
        assert fold['lock']['train_end'] < fold['lock']['test_start']
        assert fold['lock']['test_not_evaluated_before_lock']
        assert fold['lock']['full_grid_not_evaluated_before_lock']
        order_checks.append(year)
    last = r['chronological_folds'][-1]
    assert r['main_training_selected_rule'] == last['lock']['selected']['rule']
    a, b = last['continuous_test'], last['continuous_hold']
    if unlimited:
        for fold in r['chronological_folds']:
            s = fold['lock']['selected']
            expected_row = (f'| {fold["lock"]["test_start"][:4]} | '
                            f'{unlimited_rule_text(s["rule"] if s else None)} | '
                            f'{fold["continuous_test"]["twr_return_pct"]:.2f}% | '
                            f'{fold["continuous_hold"]["twr_return_pct"]:.2f}% | '
                            f'{fold["continuous_test"]["max_drawdown_pct"]:.2f}% | '
                            f'{fold["continuous_peak_extra_over_regular_pct"]:.2f}% |')
            assert expected_row in report
    else:
        expected_row = (f'| 延续训练期仓位和现金的2026年区间 | {a["twr_return_pct"]:.2f}% | '
                        f'{b["twr_return_pct"]:.2f}% | {a["max_drawdown_pct"]:.2f}% | '
                        f'{b["max_drawdown_pct"]:.2f}% |')
        assert expected_row in report
    # Check all sensitivity rows against the frozen JSON without rerunning or
    # selecting a different parameter in any scenario.
    sensitivity = r['sensitivities']['hindsight_calmar']
    scenarios = [(f'延迟{x["lag"]}个净值观察日', x) for x in sensitivity['lag']] + [
        (f'标准申购费{config_data["standard_buy_fee"]*100:g}%', sensitivity['standard_subscription']),
        ('零交易费', sensitivity['zero_fees']),
        ('包括周末会计净值', sensitivity['all_accounting_dates']),
        ('从日常申购开放起算', sensitivity['ordinary_subscription_open']),
        (f'赎回款延后{config_data["redemption_settlement_workdays"]}个周一至周五到账',
         sensitivity['redemption_settlement_stress']),
    ]
    if unlimited:
        scenarios = [(label.replace('零交易费','无交易费').replace('包括周末会计净值','含周末会计净值')
                      .replace('从日常申购开放起算','从日常申购开放日起算').replace('赎回款延后','赎回延后'), item)
                     for label,item in scenarios]
    for label, item in scenarios:
        expected_row = (f'| {label} | {item["twr_annualized_pct"]:.2f}% | '
                        f'{item["max_drawdown_pct"]:.2f}% | {item["peak_extra_over_regular_pct"]:.2f}% |')
        assert expected_row in report, ('sensitivity table', label)
    return r, {
        'code': p['fund_code'], 'audit': 'PASS', 'source_sha256': r['source_sha256'],
        'grid_rules_checked': len(grid), 'chronological_lock_hashes_and_file_order_checked': order_checks,
        'report_rows_and_rule_order_checked': True, 'all_daily_CAGR_drawdown_XIRR_checked': True,
        'config_sha_checked': True,
        'scope': ('Main unlimited-funding research; all 3025 rules nonpruned.' if unlimited else
                  'Comparison experiment constrained by 50% cumulative extra-funding cap; not uncapped main research.'),
        '2026_funding_cap_breached': last['funding_cap_breached_after_lock'],
        '2026_frozen_peak_extra_over_regular_pct': last['continuous_peak_extra_over_regular_pct'],
    }


def render(result_path, r):
    try:
        import matplotlib
    except ModuleNotFoundError:
        # Optional local plotting dependency cache; audit-only mode needs none.
        import sys
        import tempfile
        cache = Path(tempfile.gettempdir())/'codex-nav-plot-dependencies'
        if not cache.is_dir():
            raise RuntimeError('PNG rendering requires matplotlib; --audit-only does not.')
        sys.path.insert(0, str(cache))
        import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    from matplotlib import font_manager
    from matplotlib.ticker import FuncFormatter
    font_manager.fontManager.addfont('C:/Windows/Fonts/msyh.ttc')
    plt.rcParams.update({'font.family': 'Microsoft YaHei', 'axes.unicode_minus': False,
                         'font.size': 10, 'figure.facecolor': 'white', 'savefig.facecolor': 'white'})
    fig, axes = plt.subplots(2, 1, figsize=(11.8, 8.2), sharex=True,
                             gridspec_kw={'height_ratios':[1.55,1.], 'hspace':.12})
    colors = ['#B74347', '#246B9A', '#6F6789']
    specs = [('hindsight_calmar', '全历史事后候选', '-'),
             ('annual_hold', '年度买入持有', '-'),
             ('chronological_frozen', '2025年底冻结参数：全历史回放', '--')]
    for (key, label, linestyle), color in zip(specs, colors):
        if key not in r['cases']:
            continue
        daily = r['cases'][key]['daily']
        dates = [dt.date.fromisoformat(x['date']) for x in daily]
        axes[0].plot(dates, [(x['twr_index']-1.)*100 for x in daily], label=label,
                     color=color, linewidth=1.8 if key != 'chronological_frozen' else 1.35,
                     linestyle=linestyle)
        axes[1].plot(dates, [x['drawdown_pct'] for x in daily], color=color,
                     linewidth=1.5, linestyle=linestyle)
    for ax in axes:
        ax.axvspan(dt.date(2026, 1, 1), dt.date.fromisoformat(r['protocol']['source_end']),
                   color='#DFE9E2', alpha=.38, zorder=-5)
        ax.axhline(0., color='#7D858C', linewidth=.7)
        ax.grid(axis='y', color='#DDE2E6', linewidth=.65)
        ax.spines[['top','right']].set_visible(False)
        ax.spines[['left','bottom']].set_color('#A6AEB5')
        ax.yaxis.set_major_formatter(FuncFormatter(lambda value, _: f'{value:.0f}%'))
    axes[0].set_ylabel('累计 TWR 收益率')
    axes[1].set_ylabel('相对历史高点回撤')
    axes[0].legend(loc='upper left', frameon=False, fontsize=9)
    datespan = (dt.date.fromisoformat(r['protocol']['source_end']) -
                dt.date.fromisoformat(r['protocol']['source_start'])).days
    locator = mdates.YearLocator(2) if datespan > 6*365 else mdates.MonthLocator(bymonth=(1,7))
    axes[1].xaxis.set_major_locator(locator)
    axes[1].xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m'))
    axes[1].set_xlim(dt.date.fromisoformat(r['protocol']['source_start']),
                     dt.date.fromisoformat(r['protocol']['source_end']))
    p = r['protocol']
    unlimited = p['schema'] == 'public-nav-threshold-unlimited-funding-v1'
    experiment_label = '无补款上限主研究' if unlimited else '资金上限约束比较'
    fig.suptitle(f'{p["fund_code"]}  {p["fund_name"]}：{experiment_label}', x=.09, y=.975, ha='left', fontsize=16)
    winner, hold = r['cases']['hindsight_calmar']['summary'], r['cases']['annual_hold']['summary']
    funding_note = '不设外部补款上限，入金不计收益' if unlimited else '附加假设：累计补款≤累计年度预算50%'
    subtitle = (f'{p["source_start"]} — {p["source_end"]}  |  {funding_note}\n'
                f'事后候选：{rule_text(winner["rule"])}  |  '
                f'候选年化 {winner["twr_annualized_pct"]:.2f}% / 回撤 {winner["max_drawdown_pct"]:.2f}%'
                f'    年度持有年化 {hold["twr_annualized_pct"]:.2f}% / 回撤 {hold["max_drawdown_pct"]:.2f}%')
    fig.text(.09, .93, subtitle, ha='left', va='top', fontsize=10, linespacing=1.65, color='#3A4248')
    funding_peak = r['chronological_folds'][-1]['continuous_peak_extra_over_regular_pct']
    fig.text(.09, .864, f'2025年底冻结规则：过程补款比例峰值 {funding_peak:.2f}%（分母为当时累计年度预算）',
             ha='left', va='top', fontsize=9, color='#545D64')
    fig.text(.09, .035,
             '输入：本地公开净值；扣交易费，分离外部入金。所有曲线为归一化收益，不含账户金额。\n'
             '浅色区为2026年；冻结参数的训练期路径也为历史回放。全历史候选含事后选参，时序切割并非前瞻实盘验证。',
             fontsize=9, color='#545D64', va='bottom', linespacing=1.6)
    fig.subplots_adjust(left=.09, right=.98, top=.82, bottom=.13)
    output = result_path.with_name(result_path.stem+'_研究图.png')
    fig.savefig(output, dpi=190)
    plt.close(fig)
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--audit-only', action='store_true')
    parser.add_argument('--comparison', action='store_true', help='Audit/render old capped comparison instead of main unlimited run')
    parser.add_argument('--codes', nargs='+', default=['006373','018124','015789'])
    args = parser.parse_args()
    for code in args.codes:
        folder = next((ROOT/'基金').glob('*/'+code+'_*'))/'研究'
        experiment = '年度阈值量化研究' if args.comparison else '无补款上限量化研究'
        matches = list(folder.glob(code+'_'+experiment+'_截至????-??-??.json'))
        assert len(matches) == 1
        result, findings = audit(matches[0])
        if not args.audit_only:
            findings['chart'] = str(render(matches[0], result))
        print(json.dumps(findings, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
