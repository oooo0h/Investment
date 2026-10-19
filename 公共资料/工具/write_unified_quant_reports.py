"""Render one fund's registered public-NAV study without rerunning selection.

Only public NAV, normalized hypothetical cash flows and registered research
inputs are read. Existing research results are immutable. The current rule entry
is copied byte-for-byte to its own fund's history before it is updated.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
YEAR = 365.2425


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def pct(value):
    return f'{value:.2f}%' if isinstance(value, (int, float)) and math.isfinite(value) else '—'


def scalar(value, digits=4):
    return f'{value:.{digits}f}' if isinstance(value, (int, float)) and math.isfinite(value) else '—'


def rule_text(rule):
    if isinstance(rule, dict):
        rule = rule.get('rule')
    if not rule or (not rule[2] and not rule[3]):
        return '年度买入持有，无阈值调仓'
    up, down, sell, buy = rule
    return '；'.join((f'涨{up*100:g}%卖{sell*100:g}%' if sell else '不上涨卖出',
                     f'跌{down*100:g}%加{buy*100:g}%' if buy else '不下跌加仓'))


def summary(case):
    return case.get('summary', case)


def resolve_input(value, folder):
    path = Path(value)
    if path.is_absolute():
        return path.resolve()
    for base in (ROOT, folder):
        candidate = (base / path).resolve()
        if candidate.exists():
            return candidate
    raise FileNotFoundError(value)


def link(label, path, folder):
    relative = Path(os.path.relpath(Path(path), folder)).as_posix()
    return f'[{label}](<{relative}>)'


def fee_text(config):
    lower = 0
    intervals = []
    for upper, rate in config['redemption_tiers']:
        assert upper > lower
        intervals.append(f'{lower}至不足{upper}自然日：{rate*100:g}%')
        lower = upper
    intervals.append(f'{lower}自然日起：0%')
    return '；'.join(intervals)


def execution_text(config, protocol):
    cap = protocol['daily_buy_cap_norm']
    if cap is None:
        capacity = '本基金不设置日申购上限；全年累计外部补款也不设上限。'
    else:
        capacity = (f'本基金每日所有含费申购合计上限为完整年度假设预算的{cap*100:g}%（归一化{cap:g}）；'
                    '该额度同时约束年度计划买入与阈值加仓，使用现金或外部补款均占额度。全年累计外部补款不设上限。')
    events = protocol.get('dividend_events', [])
    distribution = (f'按{len(events)}条管理人公告现金分红事件处理：除息日按已有份额确认应收，'
                    '到公告支付日或之后首个净值观察日才成为可用现金，不自动再投，不使用累计净值交易。'
                    if events else '已核验资料未发现现金分红事件，使用空事件列表；不把累计净值另加为收益。')
    return '\n'.join([
        '1. 完整年度计划预算归一化为1；每年首个净值观察日先到账当年预算，旧仓继续持有。启动年按剩余月份折算，以后每年投入完整预算，包括尚未结束的最后一年。',
        '2. ' + capacity + '达到当日额度后的未成交预算排队至后续净值观察日，未成交部分不预先计为持仓或补款。',
        '3. 年度计划买入优先，取消上一年度尚未完成的阈值买入余量；队列未完成时不重复产生新阈值信号。每次实际部分成交都重置锚点。',
        '4. 上涨、下跌幅度相对最近实际成交的单位净值。卖出比例作用于执行时全部基金市值；加仓含费总预算按信号产生时、前次实际成交后全部基金市值乘加仓比例确定，排队期间不因价格变化扩大原订单。',
        f'5. 阈值信号延迟{protocol.get("lag_NAV_observations", 2)}个净值观察日执行，即使价格回归也执行；队列完成后从下一观察日重新判断信号。期末未到执行时点或未完成的订单不假定已经成交。',
        '6. 实际每次买入先用可用现金，不足部分才外部补足，不借款。外部入金从收益中剔除；现金零息、期末估值不强制赎回。基础模型卖出款立即可用，延后到账另做压力检验。',
        f'7. 含费申购按{config["buy_fee"]*100:g}%静态研究费率，净申购预算＝含费预算÷(1＋费率)；另测{config["standard_buy_fee"]*100:g}%官方普通档。费率假设不等于全历史实际渠道折扣；不重复扣净值已反映的基金运作费。',
        '8. 赎回采用FIFO，按自然日持有期分档：' + fee_text(config) + '。简化成交日近似确认日，未逐日重建实际份额确认。',
        '9. ' + distribution,
        f'10. 日常申购开放日为{config["subscription_open_date"]}。主样本从净值首日理想化持有，另检验从日常开放日起算；剔除周末不等于已还原完整开放日、公告时刻、暂停申赎和实际平台限制。',
        f'11. 赎回到账压力情景延后{config["redemption_settlement_workdays"]}个周一至周五：未到账资产计入应收但不能用于买入，现金不足仍由外部资金补足。该工作日代理没有复原全部境内外节假日和特殊延迟。',
    ]) + '\n'


def period_return(record, first, last):
    if 'twr_return_pct' in record:
        return record['twr_return_pct']
    days = (dt.date.fromisoformat(last) - dt.date.fromisoformat(first)).days
    return ((1 + record['twr_annualized_pct'] / 100) ** (days / YEAR) - 1) * 100


def test_cash_demand(result, fold):
    case = result['cases'].get('chronological_frozen', result['cases']['annual_hold'])
    assert summary(case).get('rule') == result.get('main_training_selected_rule')
    first, last = fold['lock']['test_start'], fold['lock']['test_end']
    rows = [row for row in case['daily'] if first <= row['date'] <= last]
    regular = sum(row['regular_today_norm'] for row in rows)
    extra = sum(row['extra_today_norm'] for row in rows)
    return extra / regular * 100 if regular else None


def archive_entry(entry, research_date):
    if not entry.exists():
        return None
    data = entry.read_bytes()
    archive = entry.parent / '历史规则归档' / f'{entry.stem}_统一量化前_{research_date}_{sha(entry)[:8]}.md'
    archive.parent.mkdir(parents=True, exist_ok=True)
    if archive.exists():
        assert archive.read_bytes() == data, 'Do not overwrite a different historical rule'
    else:
        archive.write_bytes(data)
    return archive


def write_new_or_equal(path, text):
    if path.exists():
        if path.read_text(encoding='utf-8') != text:
            raise FileExistsError('Registered report preserved: ' + str(path))
    else:
        path.write_text(text, encoding='utf-8')


def write_reports(result_path, config_path):
    result_path, config_path = Path(result_path).resolve(), Path(config_path).resolve()
    result, config = load(result_path), load(config_path)
    protocol = result['protocol']
    assert protocol['schema'] == 'unified-public-nav-quant-v1'
    code, cutoff = config['code'], config['cutoff']
    assert protocol['fund_code'] == code
    assert protocol['funding_cap'] is None and config['funding_cap'] is None
    assert sha(config_path) == protocol['config_sha256'], 'Configuration changed after registration'
    folders = list((ROOT / '基金').glob(code + '_*'))
    assert len(folders) == 1
    folder = folders[0] / '研究'
    assert result_path.parent == folder.resolve(), 'One result and report folder per fund'
    source = resolve_input(protocol['source_path'], folder)
    assert source.is_relative_to((folders[0] / '历史净值').resolve())
    assert sha(source) == protocol['source_sha256'] == result['source_sha256']
    raw = load(source)
    rows = raw['rows']
    assert rows[-1]['date'] == cutoff
    assert len(rows) == protocol['source_rows']
    research_date = protocol['created_at'][:10]
    name, stem = config['name'], result_path.stem
    report_path = folder / (stem + '_研究报告.md')
    entry_path = folder / f'{code}_量化规则_截至{cutoff}.md'
    cases = result['cases']
    winner, hold = summary(cases['hindsight_calmar']), summary(cases['annual_hold'])
    folds = result.get('chronological_folds', [])
    latest = next((fold for fold in reversed(folds) if fold['lock']['test_start'].startswith('2026')), None)
    cap = protocol['daily_buy_cap_norm']
    tiers = config['redemption_tiers']
    assert tiers and cap == config['daily_buy_cap_norm']
    assert len(winner['rule']) == 4
    fee_evidence = resolve_input(config['fee_evidence'], folder)
    events = protocol.get('dividend_events', [])
    null_accumulated = sum(row.get('accumulated_nav') is None for row in rows)
    differing_accumulated = sum(row.get('accumulated_nav') is not None and abs(float(row['accumulated_nav']) - float(row['nav'])) > 1e-9 for row in rows)
    assert not differing_accumulated or events, 'Unexplained accumulated/unit NAV difference'
    pre_open = sum(row['date'] < config['subscription_open_date'] for row in rows)
    headings = f'# {code} {name}：统一量化研究\n\n'
    text = headings + (f'研究日期：{research_date}；净值日期：{protocol["source_start"]}—{cutoff}。'
                       f'本地原始{len(rows)}条，主样本{protocol["analysis_rows"]}条。'
                       '全部计算使用假设归一化预算，未读取账户持仓、交易或实际金额。\n\n')
    text += '## 当前预算与申购口径\n\n'
    text += ('用户指定的本次假设年度预算为2万元，模型归一化为1；这是用于测算的假设，不代表真实账户金额。'
             '六只基金均不设置累计外部补款上限，不借款。\n\n')
    if cap is None:
        text += '本基金按用户约定不设置日申购上限。\n\n'
    else:
        text += (f'本基金单日含费申购合计上限为年度假设预算的{cap*100:g}%（归一化{cap:g}，对应本次假设1万元），'
                 '年度计划买入与阈值加仓共同占用；超出部分排队到后续观察日。'
                 '**这是单日申购额度，和旧研究“累计补款不超过累计年度预算50%”的筛选条件不同；旧累计约束已取消。**'
                 '假设额度不代表基金公告的实际额度，实际限制更低、暂停或比例确认时不能照此足额成交。\n\n')
    text += '## 数学目标\n\n'
    text += (f'穷举{result["grid_count"]}组互不重复参数：涨跌阈值为' +
             '、'.join(str(x) for x in protocol['threshold_grid_pct']) + '%，买卖比例为' +
             '、'.join(str(x) for x in protocol['trade_fraction_grid_pct']) + '%。零交易比例对应的无效阈值合并。\n\n')
    text += ('`CAGR = TWR末值^(365.2425/区间自然日数)－1`；'
             '`MDD = max(1－TWR_t/截至t历史最高TWR)`；`Calmar = CAGR/MDD`。'
             'TWR在外部资金流处分段链接，资产包括基金、可用现金及应收款，并计入交易费用；'
             'XIRR另计资金流日期和权重。\n\n')
    text += (f'主目标最大化Calmar，要求CAGR为正且不低于同期间、相同日申购额度下年度买入持有；'
             f'本次全历史收益底线为{pct(result["full_history_return_floor_pct"])}。'
             '同时列出同一约束下收益最高和回撤最低的候选。并列依次选实际主动成交少、外部补款少、接近40/30参考规则、参数字典顺序靠前者。'
             '这里的最优只限当前模型、有限网格与历史窗口。\n\n')
    text += '## 全历史事后结果\n\n'
    text += '| 方案 | 参数 | TWR年化 | 最大回撤 | Calmar | XIRR | 累计补款/累计年度预算 | 历史补款比例峰值 | 主动买/卖成交数 |\n|---|---|---:|---:|---:|---:|---:|---:|---:|\n'
    for key, label in [('hindsight_calmar', '收益回撤比最优'), ('hindsight_max_return', '收益最高'),
                       ('hindsight_min_drawdown', '回撤最低'), ('annual_hold', '年度买入持有'),
                       ('monthly', '年度预算按月投入'), ('previous_rule', '原参数按本次模型重放'),
                       ('reference40_30', '40/30参考'), ('chronological_frozen', '2025年底参数回看全历史')]:
        if key not in cases:
            continue
        record = summary(cases[key])
        text += (f'| {label} | {rule_text(record["rule"])} | {pct(record["twr_annualized_pct"])} | '
                 f'{pct(record["max_drawdown_pct"])} | {scalar(record.get("calmar"))} | {pct(record.get("xirr_pct"))} | '
                 f'{pct(record["extra_over_regular_pct"])} | {pct(record["peak_extra_over_regular_pct"])} | '
                 f'{record["tactical_buy_count"]}/{record["tactical_sell_count"]} |\n')
    ties = result.get('score_ties', result.get('ties', {}))
    text += (f'\n合格{result["eligible_count"]}组；无累计补款约束。Calmar并列'
             f'{ties.get("primary_count", "—")}组，实际交易路径{ties.get("primary_path_count", "—")}条。'
             '部分成交按实际成交次数计数，不等于独立信号次数。补款峰值的分母是当时已到账累计年度预算，所有比例均表示资金需求，不是收益或限制。\n\n'
             '**“原参数按本次模型重放”只保留旧参数，统一使用本次数据、费用、分红、排队与日额度重新计算，不能将其当成旧报告原始收益。**\n\n')
    if not winner['tactical_buy_count'] or not winner['tactical_sell_count']:
        text += ('主候选的' + ('下跌加仓' if not winner['tactical_buy_count'] else '上涨卖出') +
                 '在本窗口没有实际触发，相应阈值不能据此称已得到交易验证。\n\n')
    if winner['rule'][2] == .5 or winner['rule'][3] == .5:
        text += '主候选至少一项交易比例处于当前网格50%上界，不能据此宣称连续参数空间也最优。\n\n'
    text += '## 先锁定后检验\n\n'
    text += ('每个检验年仅使用此前至少730自然日资料选参，锁定文件先于当年检验保存，全部时序检验先于全历史事后搜索。'
             '训练没有合格规则时按预设回退年度持有，不看到测试结果后调整参数。属于事后时序切割诊断；2026年尚未结束，不是前瞻独立验证。\n\n')
    text += '| 检验年 | 当年前冻结规则 | 延续状态TWR收益 | 持有收益 | 区间最大回撤 | 截至检验结束的历史补款比例峰值 |\n|---|---|---:|---:|---:|---:|\n'
    for fold in folds:
        text += (f'| {fold["lock"]["test_start"][:4]} | {rule_text(fold["lock"]["selected"])} | '
                 f'{pct(fold["continuous_test"]["twr_return_pct"])} | {pct(fold["continuous_hold"]["twr_return_pct"])} | '
                 f'{pct(fold["continuous_test"]["max_drawdown_pct"])} | {pct(fold["continuous_peak_extra_over_regular_pct"])} |\n')
    if latest:
        first, last = latest['lock']['test_start'], latest['lock']['test_end']
        a, b = latest['continuous_test'], latest['continuous_hold']
        text += (f'\n2026年冻结参数：**{rule_text(result["main_training_selected_rule"])}**；检验区间{first}—{last}。'
                 f'承接训练期仓位、现金与交易状态后，区间TWR收益{pct(a["twr_return_pct"])}，持有{pct(b["twr_return_pct"])}；'
                 f'区间最大回撤分别为{pct(a["max_drawdown_pct"])}和{pct(b["max_drawdown_pct"])}。'
                 f'该检验区间新增补款/区间到账年度计划预算为{pct(test_cash_demand(result, latest))}，和上表历史累计比例峰值不同。\n\n')
        a, b = latest['standalone_test'], latest['standalone_hold']
        text += (f'仅在2026年重新启动的诊断：规则区间收益{pct(period_return(a, first, last))}，'
                 f'持有{pct(period_return(b, first, last))}；最大回撤分别{pct(a["max_drawdown_pct"])}和{pct(b["max_drawdown_pct"])}。'
                 '重新启动与承接状态是不同实验；承接区间重新设TWR基期和回撤峰值，各年度诊断不拼接成未经会计处理的组合收益。\n\n')
    text += '## 固定主候选的敏感性\n\n'
    text += '以下情景固定主候选参数，不因结果再选参，不能称为样本外检验。\n\n| 情景 | TWR年化 | 最大回撤 | 累计补款比例 | 补款比例峰值 |\n|---|---:|---:|---:|---:|\n'
    sensitivity = result['sensitivities']['hindsight_calmar']
    scenarios = [(f'延迟{record["lag"]}个净值观察日', record) for record in sensitivity['lag']]
    scenarios += [(f'标准申购费{config["standard_buy_fee"]*100:g}%', sensitivity['standard_subscription']),
                  ('零交易费', sensitivity['zero_fees']), ('包括周末会计净值', sensitivity['all_accounting_dates']),
                  ('从日常申购开放日起算', sensitivity['ordinary_subscription_open']),
                  (f'赎回延后{config["redemption_settlement_workdays"]}个周一至周五到账', sensitivity['redemption_settlement_stress'])]
    for label, record in scenarios:
        record = summary(record)
        text += (f'| {label} | {pct(record["twr_annualized_pct"])} | {pct(record["max_drawdown_pct"])} | '
                 f'{pct(record["extra_over_regular_pct"])} | {pct(record["peak_extra_over_regular_pct"])} |\n')
    neighboring = [summary(record) for record in sensitivity['neighbors']]
    if neighboring:
        text += (f'\n相邻一档参数{len(neighboring)}组：TWR年化范围'
                 f'{pct(min(record["twr_annualized_pct"] for record in neighboring))}—{pct(max(record["twr_annualized_pct"] for record in neighboring))}，'
                 f'最大回撤范围{pct(min(record["max_drawdown_pct"] for record in neighboring))}—{pct(max(record["max_drawdown_pct"] for record in neighboring))}。'
                 '各邻域是否达到收益底线需逐项判断，区间本身不是合格性证明。\n\n')
    matched = summary(result['matched_external_cashflow_hold']['hindsight_calmar'])
    text += (f'按完全相同日期收到相同年度预算和额外补款后持续买入持有，并应用相同日申购额度，XIRR为{pct(matched["xirr_pct"])}；'
             f'主候选为{pct(winner["xirr_pct"])}。该比较用于区分择时效果与追加资金，不能把补款本身当作收益。\n\n')
    text += '## 执行规则\n\n' + execution_text(config, protocol)
    text += '\n## 数据质量与适用范围\n\n'
    text += (f'原始净值区间{rows[0]["date"]}—{rows[-1]["date"]}；本地{len(rows)}条，'
             f'剔除{len(protocol.get("weekend_observations", []))}条周末会计观察后为{protocol["analysis_rows"]}条。'
             f'日常申购开放前有{pre_open}条。累计净值缺失{null_accumulated}条，未填造；'
             f'非空累计与单位净值有差异的观察{differing_accumulated}条。单位净值是价格与收益的基础，不采用附带日涨跌幅直接复算。\n\n')
    if code == '005698':
        text += '既有管理人99页全量核验匹配1978条；本地另有2018-04-17成立日记录，当前管理人分页未列该日，不能称该额外记录也完成官网逐笔核验。\n\n'
    if code == '270023':
        text += (f'主档来自管理人官网完整分页；既有第三方额外日期{config.get("third_party_only_date_count", 10)}条另存，不混入本次主样本。'
                 f'{config.get("regime_change_date", config.get("structural_break_date", "2014-06-09"))}前后基金投资范围发生转型，'
                 '同一代码长历史覆盖不同投资阶段，不能把所有年份视为同一稳定策略；具体公告见公开核验资料。\n\n')
    if events:
        text += f'已纳入{len(events)}条官方现金分红，原始单位净值与累计差额由事件累计金额对照。\n\n| 除息日 | 现金支付日 |\n|---|---|\n'
        for event in events:
            text += f'| {event["exdate"]} | {event["paydate"]} |\n'
        text += '\n'
    else:
        text += '本次分红列表为空，依据公开事件表、单位与累计净值对照及本基金数据核验资料；不据此宣称已经取得独立的完整拆分登记。\n\n'
    text += ('净值日期并非净值实际公布时刻，观察日延迟也不等同已重建真实成交。历史暂停、限购、比例确认、共同开放日与结算等待未完整还原。'
             '短历史、少量触发、费用假设、初始持有时点、网格边界和事后择参均限制未来推断；本研究候选尚未表示被采纳或实际执行。\n\n')
    text += '## 复核入口与历史记录\n\n'
    paths = [('输入净值', source), ('注册配置', config_path), ('完整结果、逐日路径与敏感性', result_path),
             ('公开数据与费率核验', fee_evidence)]
    for suffix, label in [('_预设', '冻结研究预设'), ('_全历史网格', f'全部{result["grid_count"]}组网格'),
                          ('_参数锁定2026', '2026参数锁定'), ('_时序检验2026', '2026锁定后检验')]:
        path = folder / (stem + suffix + '.json')
        if path.exists():
            paths.append((label, path))
    for key, label in [('preflight_evidence', '本次输入复核'), ('dividend_events_file', '官方分红事件'),
                       ('third_party_difference_evidence', '官网与第三方差异')]:
        if config.get(key):
            paths.append((label, resolve_input(config[key], folder)))
    text += ''.join('- ' + link(label, path, folder) + '\n' for label, path in paths)
    old_reports = sorted(path for path in folder.glob(code + '*研究报告.md') if path != report_path)
    if old_reports:
        text += '\n既有研究保留为其各自假设下的历史记录：\n\n'
        text += ''.join('- ' + link(path.stem, path, folder) + '\n' for path in old_reports)
    text += (f'\n输入SHA-256：`{protocol["source_sha256"]}`；配置SHA-256：`{protocol["config_sha256"]}`。'
             '原始净值、旧预设、旧网格和旧锁定结果未由报告生成器修改。\n')
    entry = (f'# {code} {name}：独立量化规则\n\n数据截至：{cutoff}；研究日期：{research_date}。适用份额：{code}。\n\n'
             '**状态：本地历史、有限网格的事后研究候选，尚未采纳或执行。**\n\n'
             f'全历史收益回撤比候选：**{rule_text(result["main_selected_rule"])}**。'
             f'TWR年化{pct(winner["twr_annualized_pct"])}，最大回撤{pct(winner["max_drawdown_pct"])}，Calmar {scalar(winner.get("calmar"))}；'
             f'年度持有年化{pct(hold["twr_annualized_pct"])}、最大回撤{pct(hold["max_drawdown_pct"])}。\n\n')
    entry += ('本次假设年度预算2万元归一化为1。累计外部补款不设上限；' +
              (f'本基金每日所有含费申购合计上限为年度预算的{cap*100:g}%（归一化{cap:g}，假设1万元），年度计划买入与阈值加仓共用；未成交预算排队。'
               if cap is not None else '本基金不设置日申购上限。') +
              '这不表示实际平台无限额。旧“累计补款≤累计年度预算50%”已不适用于当前入口。\n\n'
              f'主候选累计补款/累计年度计划预算{pct(winner["extra_over_regular_pct"])}，历史比例峰值{pct(winner["peak_extra_over_regular_pct"])}；'
              '这些是假设资金需求，不是收益，也不限制累计补款。\n\n')
    if latest:
        entry += (f'只用截至2025年底历史冻结的参数：**{rule_text(result["main_training_selected_rule"])}**。'
                  f'2026年承接状态TWR收益{pct(latest["continuous_test"]["twr_return_pct"])}，持有{pct(latest["continuous_hold"]["twr_return_pct"])}；'
                  f'区间新增补款/区间年度计划预算{pct(test_cash_demand(result, latest))}。'
                  '这组时序参数与全历史候选分别保存，不能用后者替代前者的检验结论。\n\n')
    entry += ('## 执行口径\n\n' + execution_text(config, protocol) +
              '\n参数只在所列网格和历史窗口内最优；交易比例处于网格边界或某方向未触发时，验证证据更有限。'
              '日申购限制、净值披露和实际确认仍需以当时公告及平台结果为准。\n\n' +
              link('完整研究报告', report_path, folder) + ' · ' + link('结果与逐日路径', result_path, folder) + ' · ' +
              link('公开数据与费率依据', fee_evidence, folder) + '\n')
    archive = None
    # Same content is idempotent. An old entry is preserved before replacement.
    if entry_path.exists() and entry_path.read_text(encoding='utf-8') != entry:
        archive = archive_entry(entry_path, research_date)
    write_new_or_equal(report_path, text)
    entry_path.write_text(entry, encoding='utf-8')
    return {'report': str(report_path), 'entry': str(entry_path),
            'previous_entry_archive': str(archive) if archive else None,
            'report_sha256': sha(report_path), 'entry_sha256': sha(entry_path)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('result', type=Path)
    parser.add_argument('config', type=Path)
    args = parser.parse_args()
    print(json.dumps(write_reports(args.result, args.config), ensure_ascii=False))
