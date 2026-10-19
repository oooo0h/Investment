"""Public RMB A NAVs only. No account data. Common-window descriptive statistics."""
from pathlib import Path
from datetime import date
import json, sys, math
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(Path(__file__).resolve().parent/'tmp/three-fund-stats-deps'))
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager

NAMES={'006373':'国富全球科技互联','016701':'银华海外数字经济','161620':'融通核心价值','017144':'华宝海外新能源汽车'}
CODES=list(NAMES)
BASE='006373'
FETCH='2026-10-15'
series={}
for c in CODES:
    p=next((ROOT/'基金').glob(f'{c}*/历史净值/{c}_公开日净值_抓取{FETCH}.json'))
    rows=json.loads(p.read_text(encoding='utf-8'))
    assert len({x['date'] for x in rows})==len(rows)
    assert all(x['nav']>0 and not x['event'] for x in rows), 'Adjust distributions/splits before analysis'
    series[c]=pd.Series({pd.Timestamp(x['date']):x['nav'] for x in rows}).sort_index()
common=pd.concat(series,axis=1,join='inner').dropna().sort_index()
start,end=common.index[0],common.index[-1]
def before(d):return common.index[common.index<=pd.Timestamp(d)][-1]
def metrics(s):
    s=s.dropna();r=s.pct_change().dropna()
    years=(s.index[-1]-s.index[0]).days/365.25
    freq=len(r)/years; total=s.iloc[-1]/s.iloc[0]-1
    cagr=(1+total)**(1/years)-1
    dd=s/s.cummax()-1;trough=dd.idxmin();peak=s.loc[:trough].idxmax()
    rec=s[(s.index>trough)&(s>=s.loc[peak])]
    return {'start':str(s.index[0].date()),'end':str(s.index[-1].date()),'observations':len(s),
      'total_return_pct':float(total*100),'cagr_pct':float(cagr*100),
      'volatility_pct':float(r.std(ddof=1)*np.sqrt(freq)*100),
      'sharpe_rf0':float(r.mean()/r.std(ddof=1)*np.sqrt(freq)),
      'mdd_pct':float(dd.min()*100),'current_drawdown_pct':float(dd.iloc[-1]*100),
      'mdd_peak':str(peak.date()),'mdd_trough':str(trough.date()),
      'mdd_recovery':str(rec.index[0].date()) if len(rec) else None,
      'mdd_recovery_days':(rec.index[0]-peak).days if len(rec) else None,
      'worst_observation_return_pct':float(r.min()*100)}
full={c:metrics(series[c].loc[start:end]) for c in CODES}
sensitivity={c:metrics(common[c]) for c in CODES}
report_checks=[]
expected_returns={
 '006373':{6:90.47,12:119.98,36:245.60},
 '016701':{6:26.32,12:43.78,36:103.88},
 '161620':{6:18.61,12:41.50,36:57.70},
 '017144':{6:-1.67,12:9.10,36:52.30}}
for c,expectations in expected_returns.items():
    s=series[c];b=pd.Timestamp('2026-06-30')
    for months,expected in expectations.items():
        target=(b-pd.DateOffset(months=months))+pd.offsets.MonthEnd(0)
        a=s.index[s.index<=target][-1]
        actual=(s.loc[b]/s.loc[a]-1)*100
        assert abs(actual-expected)<.03,(c,months,actual,expected)
        report_checks.append({'code':c,'months':months,'report_return_pct':expected,'computed_pct':float(actual)})
annual={}
for year in range(2019,end.year+1):
    annual[str(year)]={}
    for c,s in series.items():
        if s.index[0]>pd.Timestamp(f'{year}-12-31'):annual[str(year)][c]=None;continue
        a=s.index[s.index<=pd.Timestamp(f'{year-1}-12-31')]
        partial=not len(a)
        begin=s.index[0] if partial else a[-1]
        finish=s.index[s.index<=min(end,pd.Timestamp(f'{year}-12-31'))][-1]
        annual[str(year)][c]={'return_pct':float((s.loc[finish]/s.loc[begin]-1)*100),
          'start':str(begin.date()),'end':str(finish.date()),'partial_inception_year':partial}
month_end=common.groupby(common.index.to_period('M')).tail(1)
month_end=month_end[month_end.index.to_period('M')<end.to_period('M')]
logret=np.log(month_end/month_end.shift(1)).dropna()
monthly=np.expm1(logret)
corr=monthly.corr();rankcorr=monthly.corr(method='spearman')
windows={}
for y in [1,2,3]:
    a=before(end-pd.DateOffset(years=y))
    if a>=start:windows[str(y)]={c:metrics(series[c].loc[a:end]) for c in CODES}
rolling={}
for y in [1,2,3]:
    samples=[]
    for b in month_end.index:
        target=b-pd.DateOffset(years=y)
        if target<start:continue
        a=before(target);years=(b-a).days/365.25
        samples.append({'start':str(a.date()),'end':str(b.date()),'cagr_pct':{c:float(((common.loc[b,c]/common.loc[a,c])**(1/years)-1)*100) for c in CODES}})
    rolling[str(y)]={'n':len(samples),'summary':{c:{
        'min_cagr_pct':min(x['cagr_pct'][c] for x in samples),
        'median_cagr_pct':float(np.median([x['cagr_pct'][c] for x in samples])),
        'max_cagr_pct':max(x['cagr_pct'][c] for x in samples),
        'positive_fraction_pct':sum(x['cagr_pct'][c]>0 for x in samples)/len(samples)*100
    } for c in CODES},'samples':samples}

# Paired exploratory comparisons vs the existing Guofu holding. This is NOT an alpha regression.
tests=[]
for c in CODES[1:]:
    d=(logret[c]-logret[BASE]).to_numpy();n=len(d);mean=float(d.mean());e=d-mean
    item={'candidate':c,'baseline':BASE,'months':n}
    for lagmax in [3,6]:
        meat=float(e@e)
        for lag in range(1,lagmax+1):meat+=2*(1-lag/(lagmax+1))*float(e[lag:]@e[:-lag])
        se=math.sqrt(meat/n**2*n/(n-1))
        item[f'p_hac{lagmax}_raw']=math.erfc(abs(mean/se)/math.sqrt(2))
    item['annualized_log_return_difference_pp']=mean*1200
    item['monthly_estimated_cagr_difference_pp']=float((np.expm1(logret[c].mean()*12)-np.expm1(logret[BASE].mean()*12))*100)
    tests.append(item)
for lag in [3,6]:
    order=np.argsort([x[f'p_hac{lag}_raw'] for x in tests]);prev=0
    for rank,i in enumerate(order):
        prev=max(prev,min(1.,tests[i][f'p_hac{lag}_raw']*(len(tests)-rank)))
        tests[i][f'p_hac{lag}_holm']=prev
rng=np.random.default_rng(20261015)
arr=logret.to_numpy();B=10000;n=len(arr)
for block in [3,6]:
    beginnings=rng.integers(0,n,size=(B,math.ceil(n/block)))
    idx=((beginnings[:,:,None]+np.arange(block))%n).reshape(B,-1)[:,:n]
    sim=np.expm1(arr[idx].mean(axis=1)*12)*100
    for item in tests:
        delta=sim[:,CODES.index(item['candidate'])]-sim[:,0]
        item[f'bootstrap_block{block}_marginal95ci_cagr_difference_pp']=[float(v) for v in np.quantile(delta,[.025,.975])]
mixes={}
for c in CODES[1:]:
    r=monthly[[BASE,c]].mean(axis=1)
    mixes[c]={'guofu_weight_pct':50,'candidate_weight_pct':50,
      'monthly_annualized_volatility_pct':float(r.std()*np.sqrt(12)*100),
      'sample_estimated_cagr_pct':float(np.expm1(np.log1p(r).mean()*12)*100)}
monthly_metrics={c:{'annualized_volatility_pct':float(monthly[c].std()*np.sqrt(12)*100),
 'sample_estimated_cagr_pct':float(np.expm1(logret[c].mean()*12)*100)} for c in CODES}
subperiods={}
for label,a,b in [('2026上半年','2025-12-31','2026-06-30'),('2026下半年至今','2026-06-30',str(end.date()))]:
    aa,bb=before(a),before(b)
    subperiods[label]={c:float((common.loc[bb,c]/common.loc[aa,c]-1)*100) for c in CODES}
out=ROOT/'公共资料/投资研究'
stem=f'006373_016701_161620_017144_收益风险比较_截至{end.date()}'
result={'fetch_date':FETCH,'codes':NAMES,'common_start':str(start.date()),'common_end':str(end.date()),
 'validated_report_checks':report_checks,
 'daily_common_observations':len(common),'monthly_complete_observations':len(logret),
 'full_period':full,'own_inceptions':{c:str(s.index[0].date()) for c,s in series.items()},
 'common_date_risk_sensitivity':sensitivity,'annual_returns':annual,'trailing_windows':windows,
 'rolling':rolling,'pearson_monthly':corr.to_dict(),'spearman_monthly':rankcorr.to_dict(),
 'pair_tests':tests,'monthly_metrics':monthly_metrics,'illustrative_equal_weight_monthly_rebalanced':mixes,
 'subperiod_returns_pct':subperiods,
 'method':'Public RMB A NAV ratios, no distribution/split events; returns after product expenses, before investor fees. Own daily observations within identical endpoint dates; annualization uses observed frequency. Complete monthly returns July 2023 to September 2026 (June month-end baseline). Paired log-return mean contrasts vs Guofu with Newey-West Bartlett HAC lag 3 and 6, asymptotic normal p, Holm over 3 baseline comparisons. Paired circular block bootstrap 10000 draws, blocks 3 and 6 months, marginal 95% CIs not familywise corrected. No risk-factor adjustment; not manager alpha or future forecast. Rolling samples overlap; strategy changes limit comparability.',
 'sources':{c:f'https://fund.eastmoney.com/pingzhongdata/{c}.js' for c in CODES}}
(out/f'{stem}.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
font=Path('C:/Windows/Fonts/msyh.ttc')
if font.exists():font_manager.fontManager.addfont(str(font));plt.rcParams['font.family']=font_manager.FontProperties(fname=str(font)).get_name()
plt.rcParams['axes.unicode_minus']=False
colors={'006373':'#21846c','016701':'#447da5','161620':'#9572b3','017144':'#c37a30'}
fig,axs=plt.subplots(2,1,figsize=(12,8.8),gridspec_kw={'height_ratios':[1.15,1]})
fig.patch.set_facecolor('#fcfcfa')
for ax in axs:
    ax.set_facecolor('#fcfcfa');ax.spines[['top','right']].set_visible(False);ax.grid(axis='y',alpha=.18);ax.set_axisbelow(True)
for c in CODES:
    axs[0].plot(common.index,(common[c]/common[c].iloc[0]-1)*100,color=colors[c],label=NAMES[c],lw=1.5)
    s=series[c].loc[start:end];axs[1].plot(s.index,(s/s.cummax()-1)*100,color=colors[c],lw=1.3)
axs[0].set_ylabel('累计收益率（%）');axs[0].legend(frameon=False,ncol=2,loc='upper left')
axs[0].axhline(0,color='#888888',lw=.6)
axs[1].set_ylabel('距区间内此前高点（%）');axs[1].axhline(0,color='#888888',lw=.6)
axs[1].set_title('同一区间的回撤路径',loc='left',fontsize=12)
fig.suptitle('国富与三只候选：同日起点的收益与回撤',x=.08,ha='left',fontsize=18,y=.985)
fig.text(.08,.94,f'人民币A类 | {start.date()}—{end.date()} | 融通期间持仓转向美股，历史不等于现配置',fontsize=10,color='#555555')
fig.text(.08,.02,'公开净值，非账户收益；已扣基金运作费用，未扣投资者申赎费。月内与历史更早回撤可能不同。数据核验：2026-10-15。',fontsize=9,color='#555555')
fig.subplots_adjust(left=.085,right=.97,top=.89,bottom=.08,hspace=.28)
fig.savefig(out/f'{stem}.png',dpi=160);plt.close(fig)
compact={k:result[k] for k in ['common_start','common_end','daily_common_observations','monthly_complete_observations','full_period','annual_returns','pearson_monthly','pair_tests','monthly_metrics','illustrative_equal_weight_monthly_rebalanced','subperiod_returns_pct']}
print(json.dumps(compact,ensure_ascii=False,indent=2))
print('JSON',out/f'{stem}.json')
