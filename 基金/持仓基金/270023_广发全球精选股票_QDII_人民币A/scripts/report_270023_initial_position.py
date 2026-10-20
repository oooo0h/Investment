"""Render the inherited-position study without displaying account amounts.

Only public percentages, unitized return indexes and hypothetical budget ratios
are rendered.  Matplotlib is optional and never installed by this script.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import statistics
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

FUND = Path(__file__).resolve().parents[1]
STEM = '270023_初始持仓收益回撤优化_截至2026-10-15'
RESEARCH = FUND / '研究'
NAMES = {
    'balanced_hindsight': '平衡方案（事后最高 Calmar）',
    'highest_return_hindsight': '收益最高方案（事后）',
    'lowest_drawdown_positive_hindsight': '正收益最低回撤方案（事后）',
    'annual_hold': '年初新增后持有',
    'initial_hold': '仅初始仓持有不动',
    'matched_hold': '按平衡方案相同实际入金持有',
}


def summary(case):
    return case.get('summary', case)


def finite(value):
    return value is not None and math.isfinite(float(value))


def number(value, digits=2):
    return f'{float(value):.{digits}f}' if finite(value) else '—'


def pct(value, digits=2):
    return number(value, digits) + '%' if finite(value) else '—'


def signed(value, digits=2):
    return f'{float(value):+.{digits}f}' if finite(value) else '—'


def extra_pct(case):
    item = summary(case)
    denominator = item.get('initial_position_norm', 6.) + item.get('regular_total_norm', 0.)
    return item.get('extra_total_norm', 0.) / denominator * 100. if denominator else 0.


def numerical_checks(data, grid_path):
    """Check XIRR residuals and the declared finite-grid optimum separately."""
    residuals = []
    details = list(data['cases'].values()) + list(data['matched_hold'].values())
    for case in details:
        rate = summary(case).get('xirr_pct')
        if not finite(rate) or not case.get('cashflows'):
            continue
        flows = case['cashflows']
        origin = dt.date.fromisoformat(flows[0]['date'])
        discounted = [
            float(row['value_norm']) / (1. + rate / 100.) **
            ((dt.date.fromisoformat(row['date']) - origin).days / 365.2425)
            for row in flows
        ]
        scale = math.fsum(abs(value) for value in discounted)
        residuals.append(abs(math.fsum(discounted)) / scale if scale else 0.)
    check = {'xirr_max_relative_residual': max(residuals) if residuals else None,
             'grid_maximum_confirmed': False, 'grid_count': None}
    if grid_path.exists():
        grid = json.loads(grid_path.read_text(encoding='utf-8-sig'))
        records = grid['records']
        eligible = [row for row in records if row['twr_annualized_pct'] > 0 and finite(row.get('calmar'))]
        selected = summary(data['cases']['balanced_hindsight'])
        check['grid_count'] = len(records)
        check['grid_maximum_confirmed'] = bool(eligible) and abs(
            selected['calmar'] - max(row['calmar'] for row in eligible)) <= 1e-12
    return check


def funding_concentration(case):
    by_year = defaultdict(lambda: {'regular': 0., 'extra': 0.})
    for row in case.get('cashflows', []):
        if row.get('kind') in ('regular', 'extra'):
            by_year[row['date'][:4]][row['kind']] += abs(float(row['amount_norm']))
    positive = [(year, values) for year, values in by_year.items() if values['extra'] > 1e-12]
    if not positive:
        return '该方案没有发生计划外补款。'
    positive.sort(key=lambda item: item[1]['extra'], reverse=True)
    total = math.fsum(values['extra'] for _, values in positive)
    leading = positive[:3]
    share = math.fsum(values['extra'] for _, values in leading) / total * 100.
    comparable = [(year, values['extra'] / values['regular'] * 100.)
                  for year, values in positive if values['regular'] > 0]
    max_year, max_ratio = max(comparable, key=lambda item: item[1])
    return (f"平衡方案的补款主要集中在 {'、'.join(year for year, _ in leading)} 年，"
            f"这几年的追加合计占全部计划外补款的 {pct(share, 1)}。"
            f"单年最高出现在 {max_year} 年，计划外补款达到当年年度预算的 {pct(max_ratio, 0)}。"
            '这个年度比例与上表“初始存量加累计年度投入”的分母不同；'
            '即使允许无限补款，也需单独评估下跌阶段的追加资金压力。')


def rule_text(rule):
    if rule is None:
        return '无主动买卖'
    up, down, sell, buy = rule
    selling = f'上涨 {pct(up * 100, 0)} 卖出基金份额的 {pct(sell * 100, 0)}' if sell else '不主动卖出'
    buying = f'下跌 {pct(down * 100, 0)} 买入参考仓位的 {pct(buy * 100, 0)}' if buy else '不主动买入'
    return selling + '；' + buying


def comparison_table(cases):
    lines = [
        '| 方案 | TWR 年化 | XIRR | 最大回撤 | Calmar | 计划外补款比例 | 主动买入／卖出次数 |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ]
    for name, case in cases:
        s = summary(case)
        lines.append('| ' + ' | '.join([
            name, pct(s['twr_annualized_pct']), pct(s.get('xirr_pct')),
            pct(s['mdd_pct']), number(s.get('calmar'), 3), pct(extra_pct(s), 1),
            f"{s.get('tactical_buy_count', 0)}／{s.get('tactical_sell_count', 0)}",
        ]) + ' |')
    return lines


def plot_optional(data, target):
    """Try existing matplotlib locations; emit only return indexes and DD."""
    dependency_root = Path(tempfile.gettempdir()) / 'codex-quant-plots-20261018'
    for candidate in (dependency_root, dependency_root / 'Lib' / 'site-packages'):
        if candidate.exists():
            sys.path.insert(0, str(candidate))
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.dates as mdates
        import matplotlib.pyplot as plt
        from matplotlib import font_manager
    except (ImportError, OSError):
        return False
    chinese_font = None
    for path in (Path('C:/Windows/Fonts/msyh.ttc'), Path('C:/Windows/Fonts/simhei.ttf')):
        if path.exists():
            font_manager.fontManager.addfont(str(path))
            chinese_font = font_manager.FontProperties(fname=str(path)).get_name()
            break
    if chinese_font:
        plt.rcParams['font.sans-serif'] = [chinese_font, 'DejaVu Sans']
    plt.rcParams['axes.unicode_minus'] = False
    english = {
        'balanced_hindsight': 'Balance (hindsight)', 'annual_hold': 'Annual buy & hold',
        'initial_hold': 'Initial holding only', 'matched_hold': 'Same actual cash flows',
        'highest_return_hindsight': 'Highest return (hindsight)',
        'lowest_drawdown_positive_hindsight': 'Lowest drawdown, positive return',
    }
    keys = ['balanced_hindsight', 'annual_hold', 'initial_hold', 'matched_hold',
            'highest_return_hindsight', 'lowest_drawdown_positive_hindsight']
    palette = ['#167b74', '#204776', '#7a8391', '#bc7922', '#aa5171', '#7a62a6']
    cases = dict(data['cases'])
    cases['matched_hold'] = data['matched_hold']['balanced_hindsight']
    fig, axes = plt.subplots(2, 1, figsize=(13, 8), sharex=True,
                             gridspec_kw={'height_ratios': [1.65, 1]}, layout='constrained')
    try:
        for key, color in zip(keys, palette):
            daily = cases[key]['daily']
            dates = [dt.date.fromisoformat(row['date']) for row in daily]
            levels = [float(row['twr_index']) for row in daily]
            peak, drawdowns = 1., []
            for level in levels:
                peak = max(peak, level)
                drawdowns.append((level / peak - 1.) * 100.)
            label = NAMES[key] if chinese_font else english[key]
            linewidth = 2.1 if key == 'balanced_hindsight' else 1.25
            linestyle = '--' if key in ('initial_hold', 'matched_hold') else '-'
            axes[0].plot(dates, levels, label=label, color=color, linewidth=linewidth,
                         linestyle=linestyle, alpha=.95)
            axes[1].plot(dates, drawdowns, color=color, linewidth=linewidth,
                         linestyle=linestyle, alpha=.95)
        for ax in axes:
            ax.grid(True, color='#e2e6e9', linewidth=.7, alpha=.85)
            ax.spines[['top', 'right']].set_visible(False)
        axes[0].axhline(1., color='#aeb6bd', linewidth=.7)
        axes[1].axhline(0., color='#aeb6bd', linewidth=.7)
        axes[0].set_ylabel('TWR 单位净值（起点=1）' if chinese_font else 'Unitized TWR (initial = 1)')
        axes[1].set_ylabel('净值回撤（%）' if chinese_font else 'Drawdown (%)')
        axes[1].set_xlabel('净值日期' if chinese_font else 'NAV date')
        axes[1].xaxis.set_major_locator(mdates.YearLocator(2))
        axes[1].xaxis.set_major_formatter(mdates.DateFormatter('%Y'))
        axes[0].legend(loc='upper left', ncol=2, frameon=False, fontsize=9)
        fig.suptitle('270023｜已有持仓与年度新增：收益和回撤比较' if chinese_font
                     else '270023 | Inherited position: return and drawdown', fontsize=15)
        fig.savefig(target, dpi=175, facecolor='white')
    finally:
        plt.close(fig)
    return True


def write_report(data, destination, plot_path=None, exploration=None, audit=None, checks=None):
    protocol = data['protocol']
    cases = data['cases']
    balanced = summary(cases['balanced_hindsight'])
    hold = summary(cases['annual_hold'])
    matched = summary(data['matched_hold']['balanced_hindsight'])
    start = cases['annual_hold']['daily'][0]['date']
    end = cases['annual_hold']['daily'][-1]['date']
    grid_count = data.get('grid_size', protocol['grid']['count'])
    multi_a = exploration['selected']['A_median_calmar'] if exploration else None
    multi_b = exploration['selected']['B_worst_calmar_difference'] if exploration else None
    rolling_findings = []
    for length in (3, 5):
        windows = [row for row in data['rolling_windows'] if row['years'] == length]
        wins = both = 0
        for row in windows:
            a, b = summary(row['strategy']), summary(row['annual_hold'])
            better = a['twr_annualized_pct'] > b['twr_annualized_pct'] + 1e-10
            wins += better
            both += better and a['mdd_pct'] < b['mdd_pct'] - 1e-10
        if windows:
            rolling_findings.append(f'{length} 年窗口中仅 {wins}/{len(windows)} 个年化收益高于持有，'
                                    f'同时改善收益与回撤的窗口为 {both}/{len(windows)}')
    lines = [
        '# 270023 广发全球精选股票（QDII）人民币 A：已有持仓的收益与回撤研究',
        '', f'净值区间：{start}—{end}。整理日期：2026-10-18。', '',
        '## 结论与三个候选', '',
        f"在既定 {grid_count:,} 组有限规则中，平衡方案按扣费后 TWR 年化收益／最大回撤（Calmar）最高选出。"
        f"相对“年初新增后持有”，其年化收益差为 {signed(balanced['twr_annualized_pct'] - hold['twr_annualized_pct'])} 个百分点，"
        f"最大回撤{'降低' if balanced['mdd_pct'] <= hold['mdd_pct'] else '增加'} "
        f"{number(abs(balanced['mdd_pct'] - hold['mdd_pct']))} 个百分点。"
        '这是已观察历史上的有限网格最优，不代表未来或所有数学策略的全局最优。', '',
        '**全历史事后优势不能推定为稳健优势：**' + '；'.join(rolling_findings) + '。'
        '因此，应把它视作偏重控制回撤的历史候选，而不能据此认定它能在各种起点稳定增加收益。', '',
    ]
    if exploration:
        a, b = multi_a['aggregate'], multi_b['aggregate']
        full_a = summary(multi_a['full_window_case']['strategy'])
        lines.extend([
            f"看到主结果后，又对完整 {exploration['grid_size']:,} 组规则、{exploration['window_count']} 个起点窗口开展**新增事后探索**。"
            f"以窗口中位 Calmar 最高选出的 A 方案，全期年化 {pct(full_a['twr_annualized_pct'])}、"
            f"最大回撤 {pct(full_a['mdd_pct'])}、补款比例 {pct(extra_pct(full_a), 1)}，"
            f"但仅 {a['return_win_window_count']}/{a['window_count']} 个窗口收益胜过持有。"
            '若要求最大化最差窗口相对持有的 Calmar 差，B 方案直接选回不做战术买卖的年投持有，'
            f"最差差值为 {number(b['worst_calmar_difference'], 3)}。"
            '本次网格未找到每个窗口 Calmar 都严格高于持有的规则；新增探索不能作为独立验证。', '',
        ])
    for key in ('balanced_hindsight', 'highest_return_hindsight', 'lowest_drawdown_positive_hindsight'):
        s = summary(cases[key])
        lines.append(f"- **{NAMES[key]}**：{rule_text(s['rule'])}。TWR 年化 {pct(s['twr_annualized_pct'])}，"
                     f"最大回撤 {pct(s['mdd_pct'])}，Calmar {number(s.get('calmar'), 3)}。")
    lines.extend(['', '规则均为研究候选，尚待未来数据验证；本报告不据此变更当前量化规则入口。', '',
                  '## 与持有不动的比较', ''])
    tablecases = [(NAMES[key], cases[key]) for key in (
        'balanced_hindsight', 'highest_return_hindsight', 'lowest_drawdown_positive_hindsight',
        'annual_hold', 'initial_hold')]
    tablecases.append((NAMES['matched_hold'], data['matched_hold']['balanced_hindsight']))
    if exploration:
        tablecases.append(('多起点中位 Calmar 方案 A（事后探索）', multi_a['full_window_case']['strategy']))
    lines.extend(comparison_table(tablecases))
    lines.extend([
        '', '补款比例＝累计计划外补款／（初始存量＋累计年度计划投入）。次数按主动成交日计，分批买入会计为多次；年度固定买入不计入主动次数。', '',
        '**基准资金不同：**“仅初始仓持有不动”不接收任何年度新增资金，用于回答原仓不操作的表现；'
        '“年初新增后持有”接收相同年度计划资金；“相同实际入金持有”还在相同日期收到平衡方案实际追加的外部资金，'
        '按相同申购限额尽快买入。匹配的是外部入金，而非每笔主动买卖。', '',
        f"与相同实际入金持有相比，平衡方案 TWR 年化相差 {signed(balanced['twr_annualized_pct'] - matched['twr_annualized_pct'])} 个百分点，"
        f"最大回撤相差 {signed(balanced['mdd_pct'] - matched['mdd_pct'])} 个百分点（负值表示回撤更低）。"
        '收益率和风险的比较需与补款比例共同阅读，补款能力不是无成本资源。', '',
        'TWR 把外部现金流剔除后连乘，包含手续费及闲置现金影响；XIRR 将初始存量视为起点投入，'
        '再按实际入金日期及期末市值计算资金加权年化收益。两者回答的问题不同，XIRR 不用于选择最高 Calmar。'
        '最大回撤由 TWR 单位净值计算，不能用受追加资金抬升的账户资产曲线替代。', '',
        funding_concentration(cases['balanced_hindsight']), '',
    ])
    if plot_path:
        lines.extend([f'![TWR 单位净值与回撤对比]({plot_path.name})', '',
                      '图中仅含初始归一为 1 的收益净值和百分比回撤，不含账户金额。', ''])
    lines.extend(['## 历史锁参区间诊断', '',
                  '先用训练期选择 Calmar 最优规则，再将参数固定用于后续区间。下表各检验区间重新建立相同初始存量比例和持有年龄，'
                  '并按年度预算投入；不同锁定结果不拼接为一条组合业绩。', '',
                  '| 训练截至／检验区间 | 方案 | TWR 年化 | 最大回撤 | Calmar |',
                  '| --- | --- | ---: | ---: | ---: |'])
    for year in ('2021', '2026'):
        lock = data['locks'][year]
        fresh = 'test_reset_strategy' in lock and 'test_reset_annual_hold' in lock
        strategy_key = 'test_reset_strategy' if fresh else 'test_strategy'
        benchmark_key = 'test_reset_annual_hold' if fresh else 'test_annual_hold'
        scope = f"{lock['train_end']}／{lock['test_start']}—{lock['test_end']}"
        for label, key in (('锁定规则' if fresh else '连续历史状态诊断', strategy_key),
                           ('年初新增后持有', benchmark_key)):
            s = summary(lock[key])
            lines.append(f"| {scope} | {label} | {pct(s['twr_annualized_pct'])} | {pct(s['mdd_pct'])} | {number(s.get('calmar'), 3)} |")
    lines.append('')
    for year in ('2021', '2026'):
        lines.append(f"- {year} 检验锁定的规则：{rule_text(data['locks'][year]['selected']['rule'])}。")
    lines.extend(['',
        '原始结果另含所选固定规则从 2015 年开始连续运行、带入其历史持仓与现金状态的区间切片（test_strategy），'
        '这与上表区间起点重建账户的检验不同，不能混用。2026 年仅为截至净值截止日的年内区间，年化值对短期行情更敏感。', '',
        '**历史信息已经看过。** 净值和旧研究此前已可访问，本次时序诊断不声称使用从未触碰的数据；'
        '事后全历史选出的平衡方案与锁参方案须分开评价。参数封存后的未来观察才能增加真正前瞻证据。', '',
        '## 不同起点的三年与五年检验', '',
        '每个窗口重新建立相同“初始存量∶年度新增＝6∶1”、初始持有年龄 365 个自然日的账户，'
        '使用全历史事后平衡规则并与同窗口年初新增后持有比较。仅纳入完整自然年窗口；'
        '下表是参数稳定性与起点敏感性诊断，因已用全历史选参，不能解释为独立验证。', '',
        '| 窗口 | 数量 | 策略年化中位数 | 持有年化中位数 | 策略回撤中位数 | 持有回撤中位数 | 年化更高窗口 | 回撤更低窗口 | 两者均改善窗口 |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ])
    for years in (3, 5):
        windows = [row for row in data['rolling_windows'] if row['years'] == years]
        if not windows:
            continue
        strategies = [summary(row['strategy']) for row in windows]
        benchmarks = [summary(row['annual_hold']) for row in windows]
        better_return = [a['twr_annualized_pct'] > b['twr_annualized_pct'] + 1e-10 for a, b in zip(strategies, benchmarks)]
        better_dd = [a['mdd_pct'] < b['mdd_pct'] - 1e-10 for a, b in zip(strategies, benchmarks)]
        med = lambda rows, key: statistics.median(row[key] for row in rows)
        lines.append('| ' + ' | '.join([
            f'{years} 年', str(len(windows)), pct(med(strategies, 'twr_annualized_pct')),
            pct(med(benchmarks, 'twr_annualized_pct')), pct(med(strategies, 'mdd_pct')),
            pct(med(benchmarks, 'mdd_pct')), f'{sum(better_return)}/{len(windows)}',
            f'{sum(better_dd)}/{len(windows)}', f'{sum(a and b for a, b in zip(better_return, better_dd))}/{len(windows)}',
        ]) + ' |')
    lines.extend(['', '这些窗口彼此重叠，且来自同一只基金的一条历史路径；胜出窗口数是描述性计数，不是未来胜率或概率。', '',
    ])
    if exploration:
        lines.extend(['## 看到主结果后新增的多起点事后探索', '',
            f"将完整 {exploration['grid_size']:,} 组规则逐一放入 {exploration['window_count']} 个完整三年／五年窗口，"
            '每个窗口独立重建相同初始比例、持有年龄及年度预算。该选择目标在看到主研究结果后新增，'
            '仍然使用同一批已观察历史，不是新的样本外验证。', '',
            f"- **目标 A：最大化窗口 Calmar 中位数。** {rule_text(multi_a['aggregate']['rule'])}。"
            '若中位数并列，再按平均年化超额收益、平均补款、平均主动交易次数排序。',
            f"- **目标 B：最大化最差窗口的 Calmar 相对持有差。** {rule_text(multi_b['aggregate']['rule'])}。"
            '这就是年初新增后持有；无主动买卖时，形式上的涨跌阈值不参与执行。', '',
            '| 探索目标 | 窗口 Calmar 中位数 | 最差相对 Calmar 差 | 窗口年化中位数 | 窗口回撤中位数 | 收益胜持有窗口 | 回撤更低窗口 | 同时改善窗口 |',
            '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
        ])
        for label, selected in (('A：中位 Calmar', multi_a), ('B：最差相对 Calmar', multi_b)):
            a = selected['aggregate']
            lines.append('| ' + ' | '.join([
                label, number(a['median_calmar'], 3), signed(a['worst_calmar_difference'], 3),
                pct(a['median_twr_annualized_pct']), pct(a['median_mdd_pct']),
                f"{a['return_win_window_count']}/{a['window_count']}",
                f"{a['drawdown_win_window_count']}/{a['window_count']}",
                f"{a['dual_win_window_count']}/{a['window_count']}",
            ]) + ' |')
        a, b = multi_a['aggregate'], multi_b['aggregate']
        lines.extend(['',
            f"A 的窗口年化超额收益中位数为 {signed(a['median_annualized_excess_pct'])} 个百分点，"
            f"最差窗口相对持有的 Calmar 差为 {signed(a['worst_calmar_difference'], 3)}。"
            '它改善的是所选窗口中位风险收益指标，并不能解读为稳健增加收益。'
            'A 在全期未追加资金，也不意味着每个独立重建窗口都没有追加需求。', '',
            f"B 的最差相对差为 {number(b['worst_calmar_difference'], 3)}，对应全部窗口与持有完全一致。"
            '在本次完整有限网格和这些窗口内，没有每个窗口 Calmar 都严格更高的战术规则；'
            '这不证明所有可能策略都无效，也不代表持有在未来必定最优。'
            '窗口有重叠，胜出计数仍不是独立样本或未来概率。', '',
        ])
    lines.extend(['## 年度表现（连续平衡规则的区间切片）', '',
                  '| 年份 | 策略 TWR 收益 | 持有 TWR 收益 | 策略区间回撤 | 持有区间回撤 |',
                  '| --- | ---: | ---: | ---: | ---: |'])
    for row in data.get('annual_diagnostics', []):
        if not row.get('strategy') or not row.get('annual_hold'):
            continue
        a, b = row['strategy'], row['annual_hold']
        label = str(row['year']) + ('（截至截止日）' if row['year'] == int(end[:4]) and end[5:] != '12-31' else '')
        lines.append(f"| {label} | {pct(a['twr_return_pct'])} | {pct(b['twr_return_pct'])} | {pct(a['mdd_pct'])} | {pct(b['mdd_pct'])} |")
    lines.extend(['', '年度回撤只使用该年度起点之后的局部高点；它不等同于完整路径的最大回撤，不能把年度回撤简单相加。', '',
                  '## 交易与计价口径', '',
        '- 初始存量∶年度预算＝6∶1，初始老仓从样本首个净值按市值记账，持有年龄为 365 个自然日；'
        '先前盈亏不纳入本次收益，老仓不重复收取申购费。',
        '- 年度新增在每年首个样本净值日到位并进入固定买入队列，每日申购上限为年度预算的 50%；'
        '满额年度买入通常分两个净值观察日完成。首个非完整年度按剩余月份折算；主样本从 2015 年开始，无此折算影响。',
        '- 主动买入先使用现金，只有当日实际成交现金不足时才追加外部资金，累计补款不设上限；'
        '不提前把尚未成交的整个买入计划都算作补款。卖出资金按 FIFO 批次扣赎回费。',
        '- 信号以现金分红调整后的价格链计算涨跌，实际申赎份额仍按原始单位净值成交。'
        '任何买入成交或卖出成交都会重置参考日期和参考基金仓位；当前成交价须成为可见旧净值后才能参与新信号。'
        '主动卖出按当前基金份额的比例计算，主动买入按上次重置参考基金仓位的比例计算，并受日限额约束。',
        '- 年度固定买入优先，并可取消尚未完成的主动订单；主动买入跨日时保留原始预算，分批成交，'
        '不会每天按已变化的新仓位反复扩张同一订单。主动卖出仅能动用已确认且可卖出的份额。',
        '- 广发人民币 A 类申购费使用用户指定的 0.16%，净申购额＝申购总支出／1.0016。'
        '净值已包含管理费、托管费等日常基金运作费用，不再次重复扣除。',
        '- 赎回费按确认日期之间的自然日持有期分批计算：不足 7 天为 1.50%；7 天至不足 365 天为 0.50%；'
        '365 天至不足 730 天为 0.30%；730 天及以上为 0。',
        '- **本次按用户要求假设赎回款 T+2 可用。** 模型从卖出申请日向后计两个周一至周五工作日，'
        '这不是基金公司到账承诺，亦未完整排除境内外节假日；到期后在下一个样本观察日进入可用现金。',
        '- QDII 交易时点采用观察日近似：信号净值至少滞后 3 个有效净值观察日；'
        '申赎确认滞后 2 个观察日；新购份额最早在滞后 3 个观察日可卖。'
        '“T+1 限制”、申购确认和赎回资金到账是不同环节。该近似不能声称已经还原全部实际开放日、'
        '净值发布时间、境内外休市日、确认日与历史暂停申赎安排。',
        '- 申购待确认份额继续承担成交后的净值变化；卖出后未到账款列为现金应收，不能用于提前买入。'
        '现金分红在除息日形成应收、实际支付日后才可用，不视作新增外部资金，也不假设立即自动再投资。',
        '- 日内顺序为先按当日净值计量市场变化，再在同一净值节点计入外部资金并扣交易费；'
        'TWR 采用该节点分段连接，不能把入金简单当成整个交易日之前已经到位。'
        '决定交易的信号只使用滞后净值，当日未知成交净值不参与触发判断。',
        '- 现金收益按零处理；期末按市值及应收记账，不假定强制清仓，故不额外扣期末未发生的赎回费。', '',
        '## 选参范围与敏感性', '',
        f"有限网格去除无效重复规则后共有 {grid_count:,} 组；涨跌阈值与买卖比例以研究预设中的集合为界。"
        '平衡方案先要求 TWR 年化为正，再以 Calmar 从高到低排序；极小数值差按计算精度处理，'
        '相同分数优先补款较少、主动交易较少的规则。正收益最低回撤方案不施加额外收益保底，因此可能显著牺牲收益。', '',
    ])
    sensitivities = data.get('sensitivities', {})
    sensitivity_rows = []
    for key, parameter, label in (
        ('signal_lags', 'signal_lag', '信号滞后观察日'),
        ('redemption_delays', 'redemption_settlement_workdays', '赎回到账工作日'),
        ('initial_ages', 'initial_age_days', '初始持有自然日'),
    ):
        for case in sensitivities.get(key, []):
            s = summary(case)
            sensitivity_rows.append((f"{label}={s.get(parameter, '—')}", s))
    if sensitivities.get('standard_subscription'):
        sensitivity_rows.append(('申购费提高至 1.60% 的假设情景', summary(sensitivities['standard_subscription'])))
    if sensitivity_rows:
        lines.extend(['| 平衡参数固定，仅改变一项假设 | TWR 年化 | 最大回撤 | Calmar |',
                      '| --- | ---: | ---: | ---: |'])
        for label, s in sensitivity_rows:
            lines.append(f"| {label} | {pct(s['twr_annualized_pct'])} | {pct(s['mdd_pct'])} | {number(s.get('calmar'), 3)} |")
        lines.append('')
    neighbor_scores = [summary(case).get('calmar') for case in sensitivities.get('neighbors', [])]
    neighbor_scores = [value for value in neighbor_scores if finite(value)]
    if neighbor_scores:
        robust = sum(value >= balanced['calmar'] * .9 for value in neighbor_scores)
        lines.extend([f"平衡方案相邻一档参数的 Calmar 中位数为 {number(statistics.median(neighbor_scores), 3)}，"
                      f"范围 {number(min(neighbor_scores), 3)}—{number(max(neighbor_scores), 3)}；"
                      f"其中 {robust}/{len(neighbor_scores)} 达到中心方案 Calmar 的 90%。"
                      '这是局部参数平台诊断，不是泛化保证。', ''])
    extra_floor = cases.get('calmar_with_hold_return_floor')
    if extra_floor:
        s = summary(extra_floor)
        lines.extend([f"若另加“年化收益不低于年初新增后持有”这一比较条件，最高 Calmar 候选为：{rule_text(s['rule'])}；"
                      f"年化 {pct(s['twr_annualized_pct'])}，回撤 {pct(s['mdd_pct'])}，Calmar {number(s['calmar'], 3)}。"
                      '这是补充情景，不是用户设置的硬约束。', ''])
    lines.extend(['## 数据来源、局限与复核入口', '',
        '主样本从 2015 年开始，使用基金 2014 年投资范围转型后的完整自然年度，并延伸至本次净值截止日；'
        '避免把转型前历史与当前基金策略完全等同。原始净值、官方分红事件及输入核验资料仍按各自原始文件保留。', '',
        '日历近似、历史限购及暂停申赎未完整重建、固定使用当前折扣费率与当前赎回档位、'
        '零现金利息、有限信号家族、主动基金风格及经理变化均可能改变结果。'
        '除参数网格之外的策略尚未搜索，无法证明未来收益与回撤能同时改善。', '',
    ])
    if audit and audit.get('passed'):
        verification = '原主研究中的方案及其相同入金基准已经通过独立高精度 Decimal 账务重建，核对了份额、FIFO 费用、在途资金、分红及收益回撤计算；新增多起点 A／B 不在该次独立账务审计范围内。'
        if checks and finite(checks.get('xirr_max_relative_residual')):
            verification += (f"另以实际模拟现金流复核 XIRR，折现净现值的最大相对残差为 "
                             f"{checks['xirr_max_relative_residual']:.1e}。")
        if checks and checks.get('grid_maximum_confirmed'):
            verification += f"并从 {checks['grid_count']:,} 组完整网格重新确认了全历史最高 Calmar 候选。"
        verification += '这些核验确认声明模型内的数值与账务一致，不替代真实交易日历核验，也不能证明未来效果。'
        lines.extend([verification, ''])
    lines.extend([
        f'- 研究结果：[{STEM}.json]({STEM}.json)',
        f'- 研究预设：[{STEM}_预设.json]({STEM}_预设.json)',
        '- 可复核的原始净值文件：`' + protocol.get('source_path', '') + '`',
        '- 研究结果中的协议与缓存包含输入和引擎指纹，便于识别重算口径。', '',
    ])
    if exploration:
        lines.extend([f'- 新增事后探索：[{STEM}_多起点探索.json]({STEM}_多起点探索.json)', ''])
    if audit:
        lines.extend([f'- 独立账务核验：[{STEM}_核验.json]({STEM}_核验.json)', ''])
    destination.write_text('\n'.join(lines), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, default=RESEARCH / (STEM + '.json'))
    parser.add_argument('--output', type=Path, default=RESEARCH / (STEM + '_研究报告.md'))
    parser.add_argument('--no-plot', action='store_true')
    args = parser.parse_args()
    if not args.input.exists():
        print(json.dumps({'status': 'waiting_for_result', 'input': str(args.input)}, ensure_ascii=False))
        return 2
    data = json.loads(args.input.read_text(encoding='utf-8-sig'))
    exploration_path = args.input.with_name(args.input.stem + '_多起点探索.json')
    audit_path = args.input.with_name(args.input.stem + '_核验.json')
    exploration = json.loads(exploration_path.read_text(encoding='utf-8-sig')) if exploration_path.exists() else None
    audit = json.loads(audit_path.read_text(encoding='utf-8-sig')) if audit_path.exists() else None
    checks = numerical_checks(data, args.input.with_name(args.input.stem + '_全历史网格.json'))
    plot = args.output.with_name(STEM + '_对比图.png')
    generated = False
    if not args.no_plot:
        try:
            generated = plot_optional(data, plot)
        except Exception as exc:
            # Only the exception type is emitted; never dump research inputs.
            print(json.dumps({'plot_status': 'unavailable', 'reason_type': type(exc).__name__}))
    write_report(data, args.output, plot if generated else None, exploration, audit, checks)
    print(json.dumps({'status': 'complete', 'report': str(args.output),
                      'plot': str(plot) if generated else None}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
