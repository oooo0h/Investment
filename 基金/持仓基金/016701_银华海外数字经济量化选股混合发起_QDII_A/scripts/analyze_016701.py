"""Public fund return statistics only; no personal account data."""
from pathlib import Path
import sys,json,math
FUND=Path(__file__).resolve().parents[1]
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'公共资料/工具/tmp/three-fund-stats-deps'))
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager

rows=json.loads((FUND/'历史净值/016701_公开日净值_抓取2026-10-15.json').read_text(encoding='utf-8'))
assert all(x['nav']>0 and not x['event'] for x in rows)
s=pd.Series({pd.Timestamp(x['date']):x['nav'] for x in rows}).sort_index()
assert len(s)==len(rows)
start,end=s.index[0],s.index[-1]
years=(end-start).days/365.25
dd=s/s.cummax()-1
trough=dd.idxmin();peak=s.loc[:trough].idxmax()
recover=s[(s.index>trough)&(s>=s.loc[peak])]
month_end=s.groupby(s.index.to_period('M')).tail(1)
month_end=month_end[month_end.index.to_period('M')<end.to_period('M')]
mr=month_end.pct_change().dropna()
monthly_log=np.log1p(mr)
annual={}
for y in range(start.year,end.year+1):
    a=s.index[s.index<=pd.Timestamp(f'{y-1}-12-31')]
    a=a[-1] if len(a) else start
    b=s.index[s.index<=pd.Timestamp(f'{y}-12-31')][-1]
    annual[str(y)]={'start':str(a.date()),'end':str(b.date()),'return_pct':float((s.loc[b]/s.loc[a]-1)*100)}
episodes=[]
peak_day=s.index[0];peak_val=s.iloc[0];low_day=peak_day;low=peak_val
for d,v in s.items():
    if v>=peak_val:
        if low<peak_val:
            episodes.append({'peak':str(peak_day.date()),'trough':str(low_day.date()),'recovery':str(d.date()),'decline_pct':float((low/peak_val-1)*100),'underwater_days':(d-peak_day).days})
        peak_day,peak_val,low_day,low=d,v,d,v
    elif v<low:low_day,low=d,v
if low<peak_val:
    episodes.append({'peak':str(peak_day.date()),'trough':str(low_day.date()),'recovery':None,'decline_pct':float((low/peak_val-1)*100),'underwater_days':(end-peak_day).days})
rolling={}
for m in [12,24,36]:
    rr=np.expm1(monthly_log.rolling(m).sum()).dropna()
    annualized=np.expm1(monthly_log.rolling(m).sum()*12/m).dropna()
    rolling[str(m)]={'samples':len(rr),'min_total_pct':float(rr.min()*100),'median_total_pct':float(rr.median()*100),
       'max_total_pct':float(rr.max()*100),'positive_fraction_pct':float((rr>0).mean()*100),
       'min_annualized_pct':float(annualized.min()*100),'median_annualized_pct':float(annualized.median()*100)}
# Net return checks against the June interim report.
checks=[]
for months,expected in [(6,26.32),(12,43.78),(36,103.88)]:
    b=pd.Timestamp('2026-06-30');target=(b-pd.DateOffset(months=months))+pd.offsets.MonthEnd(0)
    a=s.index[s.index<=target][-1]
    actual=(s.loc[b]/s.loc[a]-1)*100
    assert abs(actual-expected)<.03
    checks.append({'months':months,'reported_pct':expected,'computed_pct':float(actual)})
halves={}
for label,a,b in [('2026H1','2025-12-31','2026-06-30'),('2026H2_to_latest','2026-06-30',str(end.date()))]:
    aa=s.index[s.index<=pd.Timestamp(a)][-1];bb=s.index[s.index<=pd.Timestamp(b)][-1]
    halves[label]=float((s.loc[bb]/s.loc[aa]-1)*100)
result={'fund_code':'016701','share_class':'人民币A','fetched_at':'2026-10-15','start':str(start.date()),'end':str(end.date()),
 'observations':len(s),'cumulative_return_pct':float((s.iloc[-1]/s.iloc[0]-1)*100),
 'cagr_pct':float(((s.iloc[-1]/s.iloc[0])**(1/years)-1)*100),
 'mdd_pct':float(dd.min()*100),'peak':str(peak.date()),'trough':str(trough.date()),
 'recovery':str(recover.index[0].date()) if len(recover) else None,
 'recovery_calendar_days':(recover.index[0]-peak).days if len(recover) else None,
 'current_drawdown_pct':float(dd.iloc[-1]*100),'latest_historical_peak_date':str(s.idxmax().date()),
 'monthly_observations':len(mr),'monthly_first':str(mr.index[0].date()),'monthly_last':str(mr.index[-1].date()),
 'monthly_annualized_volatility_pct':float(mr.std(ddof=1)*np.sqrt(12)*100),
 'monthly_sharpe_rf0':float(mr.mean()/mr.std(ddof=1)*np.sqrt(12)),
 'positive_month_fraction_pct':float((mr>0).mean()*100),'best_month':str(mr.idxmax().date()),'best_month_pct':float(mr.max()*100),
 'worst_month':str(mr.idxmin().date()),'worst_month_pct':float(mr.min()*100),
 'annual_returns':annual,'halves':halves,'drawdown_episodes':sorted(episodes,key=lambda x:x['decline_pct'])[:6],
 'rolling_monthly':rolling,'report_checks':checks,
 'method':'Public NAV ratios; no distributions/splits found. After product expenses, before investor fees. Early NAVs weekly; drawdown is observed-NAV drawdown. Monthly risk uses 42 completed monthly returns April 2023–September 2026; first month March is only a baseline. Rolling windows overlap, sample frequencies are not future probabilities. Annualized return uses actual calendar days/365.25. No benchmark factor regression or manager-alpha estimate.'}
out=FUND/'研究';out.mkdir(exist_ok=True)
stem=f'016701_全周期收益风险_截至{end.date()}'
(out/f'{stem}.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
font=Path('C:/Windows/Fonts/msyh.ttc')
if font.exists():font_manager.fontManager.addfont(str(font));plt.rcParams['font.family']=font_manager.FontProperties(fname=str(font)).get_name()
plt.rcParams['axes.unicode_minus']=False
fig,axs=plt.subplots(2,1,figsize=(11,8),gridspec_kw={'height_ratios':[1.25,1]})
fig.patch.set_facecolor('#fcfcfa')
for ax in axs:
    ax.set_facecolor('#fcfcfa');ax.spines[['top','right']].set_visible(False);ax.grid(axis='y',alpha=.18);ax.set_axisbelow(True)
axs[0].plot(s.index,(s/s.iloc[0]-1)*100,color='#447da5',lw=1.6)
axs[0].set_ylabel('成立以来累计收益（%）')
axs[0].annotate(f'截至{end.date()}\n累计收益 {result["cumulative_return_pct"]:.1f}%',xy=(end,(s.iloc[-1]/s.iloc[0]-1)*100),xytext=(-135,-42),textcoords='offset points',fontsize=10,arrowprops={'arrowstyle':'-','color':'#777777'})
axs[1].plot(s.index,dd*100,color='#b45a52',lw=1.4);axs[1].fill_between(s.index,dd*100,0,color='#b45a52',alpha=.08)
axs[1].set_ylabel('距此前最高净值（%）')
axs[1].annotate(f'最大回撤 {result["mdd_pct"]:.1f}%\n{peak.date()} → {trough.date()}',xy=(trough,dd.min()*100),xytext=(18,30),textcoords='offset points',fontsize=10,arrowprops={'arrowstyle':'-','color':'#777777'})
fig.suptitle('银华海外数字经济016701：收益与回撤',x=.09,ha='left',fontsize=18,y=.985)
fig.text(.09,.935,f'人民币A类 | {start.date()}—{end.date()} | 公开基金净值，非个人账户收益',fontsize=10,color='#555555')
fig.text(.09,.02,'历史仅始于2023年，未覆盖2022科技熊市。净值已扣基金运作费用，未扣投资者申赎费；数据核验于2026-10-15。',fontsize=9,color='#555555')
fig.subplots_adjust(top=.88,bottom=.08,left=.09,right=.97,hspace=.3)
fig.savefig(out/f'{stem}.png',dpi=160);plt.close(fig)
print(json.dumps(result,ensure_ascii=False,indent=2))
print('OUTPUT',out/f'{stem}.json')
