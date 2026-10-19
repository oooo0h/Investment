"""Public RMB-A NAV analysis only; no personal account data or amounts."""
from pathlib import Path
import sys, json, math, calendar
from datetime import date

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent / 'tmp/three-fund-stats-deps'))
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager

CODES = ['005698', '270023', '006373']
NAMES = {'005698': '华夏全球科技先锋', '270023': '广发全球精选', '006373': '国富全球科技互联'}
FETCH = '2026-10-15'
frames, raw = {}, {}
for code in CODES:
    path = next((ROOT / '基金').glob(f'{code}*/历史净值/{code}_公开日净值_抓取{FETCH}.json'))
    rows = json.loads(path.read_text(encoding='utf-8'))
    assert len({x['date'] for x in rows}) == len(rows)
    assert all(x['nav'] > 0 for x in rows)
    assert not [x for x in rows if x['date'] >= '2018-11-20' and x['event']], 'Distribution adjustment required'
    raw[code] = rows
    frames[code] = pd.Series({pd.Timestamp(x['date']): x['nav'] for x in rows}, name=code).sort_index()

common = pd.concat(frames, axis=1, join='inner').dropna().sort_index()
start, end = common.index[0], common.index[-1]
outdir = ROOT / '公共资料/投资研究'
stem = f'005698_270023_006373_历年收益统计_截至{end.date()}'

def metric(series):
    s = series.dropna()
    r = s.pct_change().dropna()
    years = (s.index[-1] - s.index[0]).days / 365.25
    dd = s / s.cummax() - 1
    trough = dd.idxmin()
    peak = s.loc[:trough].idxmax()
    recovery = s[(s.index > trough) & (s >= s.loc[peak])]
    growth = float(s.iloc[-1] / s.iloc[0] - 1)
    cagr = (1 + growth) ** (1 / years) - 1
    frequency = len(r) / years
    vol = float(r.std(ddof=1) * np.sqrt(frequency))
    threshold = r.quantile(.05)
    return dict(start=str(s.index[0].date()), end=str(s.index[-1].date()), observations=len(s),
        total_return_pct=growth*100, cagr_pct=cagr*100, volatility_pct=vol*100,
        annual_observations=frequency,
        sharpe_rf0=float(r.mean()/r.std(ddof=1)*np.sqrt(frequency)),
        mdd_pct=float(dd.min()*100), peak=str(peak.date()), trough=str(trough.date()),
        recovery=str(recovery.index[0].date()) if len(recovery) else None,
        recovery_calendar_days=(recovery.index[0]-peak).days if len(recovery) else None,
        underwater_days_so_far=(s.index[-1]-peak).days if not len(recovery) else None,
        current_drawdown_pct=float(dd.iloc[-1]*100),
        worst_day_pct=float(r.min()*100), expected_shortfall_5pct=float(r[r <= threshold].mean()*100),
        calmar=float(cagr/abs(dd.min())))

# Each fund's own daily NAVs within the identical endpoint window retain local-market observations.
full = {c: metric(frames[c].loc[start:end]) for c in CODES}
common_daily_metrics = {c: metric(common[c]) for c in CODES}
def before(ts):
    return common.index[common.index <= pd.Timestamp(ts)][-1]

annual = {}
for year in range(2019, end.year + 1):
    a, b = before(f'{year-1}-12-31'), before(f'{year}-12-31')
    annual[str(year)] = {c: float((common.loc[b,c]/common.loc[a,c]-1)*100) for c in CODES}

# Independent checks against disclosed annual / interim return tables.
checks=[('005698','2025-12-31',1,15.49),('006373','2025-12-31',1,26.71),
 ('005698','2025-12-31',3,146.00),
 ('005698','2025-12-31',5,44.83),('006373','2025-12-31',3,142.46),
 ('006373','2025-12-31',5,104.79)]
for c,finish,y,expected in checks:
    b=before(finish); a=before(b-pd.DateOffset(years=y))
    actual=(common.loc[b,c]/common.loc[a,c]-1)*100
    assert abs(actual-expected)<.02,(c,finish,y,actual,expected)
for c,expected in [('005698',90.04),('270023',61.99),('006373',90.47)]:
    actual=(common.loc[before('2026-06-30'),c]/common.loc[before('2025-12-31'),c]-1)*100
    assert abs(actual-expected)<.02,(c,actual,expected)

# Full months only: baseline November 2018 month-end, returns December 2018 to September 2026.
month_end = common.groupby(common.index.to_period('M')).tail(1)
month_end = month_end[month_end.index.to_period('M') < end.to_period('M')]
monthly_log = np.log(month_end / month_end.shift(1)).dropna()
monthly_simple = np.expm1(monthly_log)
pearson = monthly_simple.corr()
spearman = monthly_simple.corr(method='spearman')

windows = {}
for y in [1,3,5,7]:
    a = before(end - pd.DateOffset(years=y))
    windows[str(y)] = {c: metric(frames[c].loc[a:end]) for c in CODES}

rolling = {}
for y in [1,3,5]:
    samples = []
    for finish in month_end.index:
        target = finish - pd.DateOffset(years=y)
        if target < start: continue
        begin = before(target)
        years = (finish-begin).days/365.25
        samples.append({'start':str(begin.date()),'end':str(finish.date()),
          'annualized_pct':{c:float(((common.loc[finish,c]/common.loc[begin,c])**(1/years)-1)*100) for c in CODES}})
    rolling[str(y)] = {'count':len(samples),'summary':{c:{
        'min_cagr_pct':min(x['annualized_pct'][c] for x in samples),
        'median_cagr_pct':float(np.median([x['annualized_pct'][c] for x in samples])),
        'max_cagr_pct':max(x['annualized_pct'][c] for x in samples),
        'positive_fraction_pct':100*sum(x['annualized_pct'][c]>0 for x in samples)/len(samples)
    } for c in CODES},'samples':samples}

# Paired monthly log-return comparisons, HAC/Newey-West lag 6, asymptotic p, Holm correction.
pairs = [('006373','005698'), ('270023','005698'), ('006373','270023')]
tests=[]
for a,b in pairs:
    diff = (monthly_log[a]-monthly_log[b]).to_numpy()
    n=len(diff)
    mean=float(diff.mean())
    residual=diff-mean
    meat=float(residual@residual)
    for lag in range(1,7):
        meat += 2*(1-lag/7)*float(residual[lag:]@residual[:-lag])
    se=math.sqrt(meat/n**2*n/(n-1))
    p=math.erfc(abs(mean/se)/math.sqrt(2))
    tests.append({'a':a,'b':b,'n':n,'monthly_log_mean_diff':mean,
        'annual_log_mean_diff_pp':mean*1200,
        'hac_se':se,'p_raw':p})
order=np.argsort([x['p_raw'] for x in tests])
previous=0.
for rank,i in enumerate(order):
    previous=max(previous,min(1.,tests[i]['p_raw']*(len(tests)-rank)))
    tests[i]['p_holm']=previous

# Circular moving-block bootstrap, paired across funds. CI on CAGR percentage-point differences.
rng=np.random.default_rng(20261015)
arr=monthly_log.to_numpy()
B=10000
bootstrap={}
for block in [6,12]:
    n=len(arr)
    beginnings=rng.integers(0,n,size=(B,math.ceil(n/block)))
    idx=((beginnings[:,:,None]+np.arange(block))%n).reshape(B,-1)[:,:n]
    sim=np.expm1(arr[idx].mean(axis=1)*12)*100
    result=[]
    for a,b in pairs:
        delta=sim[:,CODES.index(a)]-sim[:,CODES.index(b)]
        result.append({'a':a,'b':b,'ci95_cagr_diff_pp':[float(x) for x in np.quantile(delta,[.025,.975])]})
    bootstrap[str(block)]=result
for i,(a,b) in enumerate(pairs):
    tests[i]['monthly_estimated_cagr_diff_pp']=float((np.expm1(monthly_log[a].mean()*12)-np.expm1(monthly_log[b].mean()*12))*100)
    tests[i]['bootstrap12_ci95_cagr_diff_pp']=bootstrap['12'][i]['ci95_cagr_diff_pp']
    tests[i]['bootstrap6_ci95_cagr_diff_pp']=bootstrap['6'][i]['ci95_cagr_diff_pp']

subperiods={}
for label,a,b in [('2019—2022','2018-12-31','2022-12-31'),('2023—2025','2022-12-31','2025-12-31'),('2026上半年','2025-12-31','2026-06-30'),('2026下半年至今','2026-06-30',str(end.date()))]:
    aa,bb=before(a),before(b)
    subperiods[label]={c:metric(frames[c].loc[aa:bb]) for c in CODES}

# Equal-weight monthly-rebalanced combinations: descriptive diversification, no optimization.
equal_weight={}
for combo in [('005698','270023'),('005698','006373'),('270023','006373'),tuple(CODES)]:
    r=monthly_simple[list(combo)].mean(axis=1)
    equal_weight['+'.join(combo)]={'monthly_return_vol_annualized_pct':float(r.std()*np.sqrt(12)*100),
      'estimated_cagr_pct':float(np.expm1(np.log1p(r).mean()*12)*100)}

result={'fetch_date':FETCH,'common_start':str(start.date()),'common_end':str(end.date()),
 'validation_checks_passed':len(checks)+3,
 'common_daily_observations':len(common),'names':NAMES,'annual_returns_pct':annual,
 'full_period':full,'common_dates_daily_sensitivity':common_daily_metrics,'trailing_windows':windows,
 'monthly_observations':len(monthly_log),'monthly_start':str(monthly_log.index[0].date()),'monthly_end':str(monthly_log.index[-1].date()),
 'pearson_monthly':pearson.to_dict(),'spearman_monthly':spearman.to_dict(),'pair_tests':tests,
 'rolling':rolling,'subperiods':subperiods,'equal_weight_monthly':equal_weight,
 'method':{'returns':'NAV ratios; no distributions or splits in common window; after fund expenses, before investor fees',
 'daily_risk':'own observations within identical dates; annualization uses observed return count / elapsed years',
 'statistics':'Complete-month paired log returns; HAC/Newey-West 6 lags, asymptotic normal p; Holm across 3 comparisons; circular paired block bootstrap 10000 draws, blocks 12 and 6 months, fixed seed',
 'limitations':'Overlapping rolling windows are descriptive, not independent trials or future probabilities. Historical product returns are not isolated manager alpha. Different regional allocations, FX, leverage and fee histories. No forecasting or causal attribution.'},
 'sources':{c:f'https://fund.eastmoney.com/pingzhongdata/{c}.js' for c in CODES}}
(outdir/f'{stem}.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')

# Static analytical figure, public return indices only.
font=Path('C:/Windows/Fonts/msyh.ttc')
if font.exists():
    font_manager.fontManager.addfont(str(font))
    plt.rcParams['font.family']=font_manager.FontProperties(fname=str(font)).get_name()
plt.rcParams['axes.unicode_minus']=False
colors={'005698':'#c14f46','270023':'#447da5','006373':'#21846c'}
fig,axs=plt.subplots(3,1,figsize=(12,13.6),gridspec_kw={'height_ratios':[1.2,1.1,.85]})
fig.patch.set_facecolor('#fcfcfa')
for ax in axs:
    ax.set_facecolor('#fcfcfa'); ax.spines[['top','right']].set_visible(False)
    ax.grid(axis='y',alpha=.17); ax.set_axisbelow(True)
years=list(annual)
x=np.arange(len(years)); width=.25
for i,c in enumerate(CODES):
    vals=[annual[y][c] for y in years]
    bars=axs[0].bar(x+(i-1)*width,vals,width,color=colors[c],label=NAMES[c])
    for bar,v in zip(bars,vals): axs[0].text(bar.get_x()+width/2,v+(1.5 if v>=0 else -1.5),f'{v:.1f}',ha='center',va='bottom' if v>=0 else 'top',fontsize=8)
axs[0].set_xticks(x,[y if y!='2026' else '2026年内*' for y in years])
axs[0].set_ylabel('年度收益率（%）'); axs[0].axhline(0,color='#777777',lw=.7)
axs[0].legend(frameon=False,ncol=3,loc='upper left')
axs[0].margins(y=.23)
axs[0].set_title('历年涨跌幅：相同人民币A类，2026为未完成年度',loc='left',fontsize=13,pad=16)
for c in CODES:
    axs[1].plot(common.index,common[c]/common[c].iloc[0]*100,color=colors[c],label=NAMES[c],lw=1.5)
    s=frames[c].loc[start:end]
    axs[2].plot(s.index,(s/s.cummax()-1)*100,color=colors[c],lw=1.2)
axs[1].set_ylabel('收益指数（共同起点=100）')
axs[1].set_title('相同起点的累计表现',loc='left',fontsize=13,pad=12)
axs[2].set_ylabel('距此前高点（%）'); axs[2].set_title('回撤路径',loc='left',fontsize=13,pad=12)
axs[2].axhline(0,color='#777777',lw=.7)
fig.suptitle('三只全球科技类QDII：收益与回撤',x=.075,ha='left',fontsize=20,y=.986)
fig.text(.075,.955,f'比较区间 {start.date()} — {end.date()}  |  公开净值，非个人账户收益',fontsize=10,color='#555555')
fig.text(.075,.018,'*2026截至10月13日。净值已扣基金运作费用，未扣个人申赎费。数据：东方财富公开日净值；计算日期2026-10-15。',fontsize=9,color='#555555')
fig.subplots_adjust(top=.92,bottom=.065,left=.085,right=.97,hspace=.4)
fig.savefig(outdir/f'{stem}.png',dpi=160)
plt.close(fig)

def pct(v): return f'{v:.2f}%'
lines=[f'# 三基金历年收益与统计比较：截至{end.date()}','',
 f'计算日期：{FETCH}。人民币A类005698、270023、006373。共同区间{start.date()}至{end.date()}，完整月度样本{len(monthly_log)}个。',
 '净值为公开产品数据，不涉及个人账户。区间内未发现分红拆分；收益已扣基金运作费用，未扣投资者申赎费。','',
 '## 主要发现','',
 '共同全周期内，国富复合收益更高，波动和最大回撤更低；广发长期收益高于华夏，但二者历史最深回撤均超过54%。国富对华夏的配对收益差通过本次检验；另两组未达到5%显著性标准。此结果只适用于既有样本。',
 '国富优势并非每个阶段都存在：2023—2025三年累计收益为广发约149.3%、华夏146.0%、国富142.5%；更突出的差距来自2019—2022的抗跌及2026年表现。2026年上半年华夏与国富均上涨约90%，但下半年截至10月13日华夏回撤式下跌约39.3%，广发、国富各跌约17.7%、17.9%。这里下半年数字是区间收益，不是最大回撤。',
 '月度相关系数约0.82—0.87，三只具有明显共同涨跌特征，不能把产品数量等同于风险充分分散。完整年度仅7个；滚动区间相互重叠，正收益样本比例不代表未来盈利概率。','',
 '## 完整年度与2026年内收益','', '| 年份 | 华夏005698 | 广发270023 | 国富006373 |','|---|---:|---:|---:|']
for y in annual: lines.append('| '+('2026年内，未满一年' if y=='2026' else y)+' | '+' | '.join(pct(annual[y][c]) for c in CODES)+' |')
lines+=['','2018不放入年度排名：三只成立时间不同，国富仅有成立后约一个多月的数据。各年取上一年末和本年末最近共同净值日；2026取最新共同净值日。','',
 '## 相同长期区间','', '| 指标 | 华夏 | 广发 | 国富 |','|---|---:|---:|---:|']
for label,key in [('累计收益','total_return_pct'),('复合年化收益','cagr_pct'),('年化波动','volatility_pct'),('最大回撤','mdd_pct'),('当前距区间内前高','current_drawdown_pct'),('最差日收益','worst_day_pct'),('日收益最差5%平均值','expected_shortfall_5pct')]:
    lines.append('| '+label+' | '+' | '.join(pct(full[c][key]) for c in CODES)+' |')
for label,key in [('夏普比率（无风险利率设为0）','sharpe_rf0'),('卡玛比率（年化收益/最大回撤绝对值）','calmar')]:
    lines.append('| '+label+' | '+' | '.join(f'{full[c][key]:.2f}' for c in CODES)+' |')
lines+=['','波动和夏普使用各基金同一端点范围内自身全部日净值，年化频率为实际收益观测数/实际年数，避免假定中外节假日相同。另以三只共同日期重复风险计算，结果保存在JSON中用于敏感性核验。夏普不是相对市场指数的超额收益指标。','',
 '## 历史最深回撤恢复','', '| 基金 | 高点 | 低点 | 恢复原高点 | 高点到恢复天数 |','|---|---|---|---|---:|']
for c in CODES:
    m=full[c]; lines.append(f"| {NAMES[c]} | {m['peak']} | {m['trough']} | {m['recovery'] or '截至终点未恢复'} | {m['recovery_calendar_days'] or '未恢复'} |")
lines+=['','## 近期固定持有窗口','', '| 窗口 | 华夏年化 | 广发年化 | 国富年化 |','|---|---:|---:|---:|']
for y in windows: lines.append('| 近'+y+'年 | '+' | '.join(pct(windows[y][c]['cagr_pct']) for c in CODES)+' |')
lines+=['','## 月末滚动持有收益','', '| 持有期 | 基金 | 样本数 | 年化最差 | 年化中位数 | 年化最好 | 正收益样本占比 |','|---|---|---:|---:|---:|---:|---:|']
for y in rolling:
    for c in CODES:
        m=rolling[y]['summary'][c]
        lines.append(f"| {y}年 | {NAMES[c]} | {rolling[y]['count']} | {pct(m['min_cagr_pct'])} | {pct(m['median_cagr_pct'])} | {pct(m['max_cagr_pct'])} | {pct(m['positive_fraction_pct'])} |")
lines+=['','样本相互重叠；以上占比不是独立试验胜率，更不是未来盈利概率。滚动终点只用完整月末，起点取相应周年日或之前最近共同净值日。','',
 '## 收益差距的统计证据','',
 f'使用{len(monthly_log)}个完整月度收益（2018年12月至2026年9月）。对配对月度对数收益差拟合截距模型，以6期Newey-West/HAC标准误考虑异方差和自相关，使用渐近正态p值，并对3组两两比较做Holm校正。另进行10000次配对循环移动区块bootstrap，区块12个月；以6个月区块检查敏感性。置信区间衡量历史样本不确定性，不是未来收益预测区间。','',
 '| 比较（前者减后者） | 月度样本推算年化收益差 | 12个月区块95%区间 | 6个月区块95%区间 | Holm校正p值 |','|---|---:|---|---|---:|']
for t in tests:
    ci=t['bootstrap12_ci95_cagr_diff_pp']; ci6=t['bootstrap6_ci95_cagr_diff_pp']
    lines.append(f"| {NAMES[t['a']]}－{NAMES[t['b']]} | {t['monthly_estimated_cagr_diff_pp']:.2f}个百分点 | [{ci[0]:.2f}, {ci[1]:.2f}]个百分点 | [{ci6[0]:.2f}, {ci6[1]:.2f}]个百分点 | {t['p_holm']:.4f} |")
lines+=['','p值检验的是月度对数收益均值差；bootstrap区间使用两基金月度样本推算CAGR之差，估计量不同，不能把两者当成同一个检验。表中bootstrap区间为各组边际95%区间，未对多重比较作区间校正；p值已用Holm校正。不能由p值不显著推断产品等效；也不能由显著推断未来领先或经理能力。','',
 '## 月度收益相关性','', '| Pearson相关系数 | 华夏 | 广发 | 国富 |','|---|---:|---:|---:|']
for c in CODES: lines.append('| '+NAMES[c]+' | '+' | '.join(f'{pearson.loc[c,d]:.3f}' for d in CODES)+' |')
lines+=['','Spearman秩相关、分阶段收益、三基金等权组合描述统计见JSON。相关性衡量共同涨跌，不衡量持仓重复率。等权组合按月再平衡、未扣再平衡交易费用，不是优化或配置建议。','',
 '## 分阶段表现','', '| 阶段 | 华夏累计 | 广发累计 | 国富累计 |','|---|---:|---:|---:|']
for label,values in subperiods.items(): lines.append('| '+label+' | '+' | '.join(pct(values[c]['total_return_pct']) for c in CODES)+' |')
lines+=['','## 解读边界','',
 '- 2019—2025只有7个完整年度，不能根据年度排名或7个年度观测做强推断。',
 '- 统计比较的是基金产品历史结果，未控制市场、地区、行业、杠杆和汇率因子，不等于经理alpha或因果归因。',
 '- 组合地区、杠杆、经理、费用和规模会变；共同全周期也不等于现任经理任职期。国富2026年9月由双经理转为单经理，广发早期任职结构不同。',
 '- 华夏2018年4月至11月的历史以及广发2010年至2018年的历史未进入公平比较；可另作单基金完整历史分析。',
 '- 月度数据会平滑日内和月内回撤，最大回撤使用日净值。年末正收益不代表年内没有深度亏损。',
 '- 采用6与12个月区块只是有限敏感性检查，不能消除结构变化和样本长度有限的问题。','',
 '## 来源与复现','']
lines.append(f'- 通过{len(checks)+3}项报告交叉核验：2025年度、3年/5年累计收益以及2026年上半年收益，误差均小于0.02个百分点。')
for c in CODES: lines.append(f'- {c}：https://fund.eastmoney.com/pingzhongdata/{c}.js；原始脚本和规范化日净值保存于对应基金历史净值目录。')
lines += ['- 官网交叉核对：https://m.chinaamc.com/fund/005698/index.shtml；https://www.gffunds.com.cn/funds/?fundcode=270023；https://www.ftsfund.com/qxjj/jjxq/006373。',
 '- 复现脚本：公共资料/工具/analyze_three_qdii.py。',f'- 机器结果：{stem}.json。',f'- 图：{stem}.png。','']
(outdir/f'{stem}.md').write_text('\n'.join(lines),encoding='utf-8')
compact={k:result[k] for k in ['common_start','common_end','annual_returns_pct','full_period','monthly_observations','pair_tests','pearson_monthly']}
compact['rolling_summary']={y:{'n':v['count'],'summary':v['summary']} for y,v in rolling.items()}
compact['subperiods']={p:{c:v[c]['total_return_pct'] for c in CODES} for p,v in subperiods.items()}
print(json.dumps(compact,ensure_ascii=False,indent=2))
print('OUTPUT',outdir/f'{stem}.md')
