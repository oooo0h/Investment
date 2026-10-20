/** Public official NAV capture and immutable comparison; no account data. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const code='270023', name='广发全球精选股票（QDII）人民币A', capture='2026-10-18';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const navDir=path.join(root,'历史净值');
const rawDir=path.join(navDir,'原始数据',`全历史分页复核_${capture}`);
await fs.mkdir(rawDir,{recursive:true});
const checkedAt=()=>new Date(Date.now()+8*3600000).toISOString().replace('Z','+08:00');
const urlFor=(page)=>'https://www.gffunds.com.cn/apistore/JsonService?'+new URLSearchParams({service:'MarketPerformance',method:'NAV',op:'queryNAVByFundcode',fundcode:code,startdate:'20100818',enddate:'20261018',orderby:'NAVDATE_DESC',pagelines:'20',curpage:String(page)});
const attempts=[];
async function request(page,label=`NAV page ${page}`){
  const url=urlFor(page);
  let err;
  for(let attempt=1;attempt<=4;attempt++){
    try {
      const fetched_at=checkedAt();
      const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
      const raw_text=await response.text();
      const record={label,url,attempt,fetched_at,http_status:response.status,server_date:response.headers.get('date'),content_type:response.headers.get('content-type'),raw_text};
      const rawFile=path.join(rawDir,`${label.replaceAll(' ','_')}_attempt${attempt}.json`);
      await fs.writeFile(rawFile,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
      attempts.push({label,url,attempt,http_status:response.status,raw_file:rawFile});
      if(!response.ok)throw Error(`HTTP ${response.status}`);
      const j=JSON.parse(raw_text);
      if(String(j.errorno)!=='20000')throw Error(`API ${j.errorno}`);
      return j;
    }catch(e){err=e;if(attempt<4)await new Promise(r=>setTimeout(r,300*attempt));}
  }
  throw Error(`${label}: ${err?.message}`);
}
const first=await request(1);
const total=Number(first.totalrows), pages=Number(first.totalpages), size=20;
if(!Number.isInteger(total)||pages!==Math.ceil(total/size))throw Error('Invalid official page metadata');
const data=new Array(pages);data[0]=first;
let next=2;
await Promise.all(Array.from({length:4},async()=>{while(next<=pages){const p=next++;data[p-1]=await request(p);}}));
const tail=await request(pages+1,'NAV empty tail');
const firstFinal=await request(1,'NAV page 1 final consistency check');
const issues=[];
for(let i=0;i<pages;i++){
  const p=data[i];
  if(Number(p.curpage)!==i+1||Number(p.totalrows)!==total||Number(p.totalpages)!==pages||Number(p.pagelines)!==size)issues.push(`Metadata mismatch page ${i+1}`);
  if(!Array.isArray(p.data)||p.data.length!==Math.min(size,total-i*size))issues.push(`Length mismatch page ${i+1}`);
}
const tailEmpty=(Array.isArray(tail.data)&&tail.data.length===0)||(tail.data===''&&Number(tail.totalrows)===0&&Number(tail.totalpages)===0);
if(!tailEmpty)issues.push('Nonempty tail');
if(Number(firstFinal.totalrows)!==total||JSON.stringify(firstFinal.data)!==JSON.stringify(first.data))issues.push('First page changed during fetch');
const date=v=>v===null||v===undefined||v===''||v==='00000000'?null:String(v).replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');
const number=v=>v===null||v===undefined||v===''?null:Number(v);
const source=data.flatMap(p=>p.data);
const rows=source.map(r=>({date:date(r.NAVDATE),nav:number(r.NAVUNIT),accumulated_nav:number(r.NAVACCUMULATED),daily_growth_pct:number(r.DAYINCREMENTRATE),previous_nav:number(r.PRENAVUNIT),previous_accumulated_nav:number(r.PRENAVACCUMULATED),previous_nav_date:date(r.PRENAVEDATE)})).sort((a,b)=>a.date.localeCompare(b.date));
if(source.some(r=>r.FUNDCODE!==code||r.FUNDNAME!==name))issues.push('Wrong fund code or share class');
if(rows.length!==total||new Set(rows.map(r=>r.date)).size!==total)issues.push('Merged count or duplicate date mismatch');
if(rows.some(r=>!/^\d{4}-\d{2}-\d{2}$/.test(r.date)||r.date<'2010-08-18'||r.date>capture))issues.push('Date outside query or malformed');
if(rows.some(r=>!(r.nav>0)||!Number.isFinite(r.nav)||!(r.accumulated_nav>0)||!Number.isFinite(r.accumulated_nav)))issues.push('Invalid unit or accumulated NAV');
const oldPath=path.join(navDir,'270023_全部历史净值_截至2026-10-14.json');
const old=JSON.parse(await fs.readFile(oldPath,'utf8'));
const oldMap=new Map(old.rows.map(r=>[r.date,r])),newMap=new Map(rows.map(r=>[r.date,r]));
const fields=['nav','accumulated_nav','daily_growth_pct','previous_nav','previous_accumulated_nav','previous_nav_date'];
const added=rows.filter(r=>!oldMap.has(r.date));
const removed=old.rows.filter(r=>!newMap.has(r.date));
const changed=rows.filter(r=>oldMap.has(r.date)&&fields.some(f=>r[f]!==oldMap.get(r.date)[f])).map(r=>({date:r.date,old:oldMap.get(r.date),new:r}));
if(removed.length)issues.push('Official history removed old dates');
const validation={passed:issues.length===0,issues,official_total_rows:total,official_total_pages:pages,reported_page_size:size,merged_row_count:rows.length,unique_date_count:new Set(rows.map(r=>r.date)).size,all_page_row_counts_match:!issues.some(i=>i.includes('Length')),tail_page:pages+1,tail_row_count:tailEmpty?0:null,first_page_stable_during_capture:!issues.includes('First page changed during fetch'),all_rows_match_code_and_share_class:!issues.includes('Wrong fund code or share class'),historical_release_timestamps_available:false};
const comparison={previous_path:oldPath,previous_count:old.count,previous_first_date:old.first_date,previous_last_date:old.last_date,added_dates:added.map(r=>r.date),added_count:added.length,removed_dates:removed.map(r=>r.date),changed_count:changed.length,changed_rows:changed};
const audit={code,name,checked_at:checkedAt(),source_type:'fund_manager_official_public_API',query_start_date:'2010-08-18',query_end_date:capture,first_date:rows[0].date,last_date:rows.at(-1).date,count:rows.length,validation,comparison,attempt_count:attempts.length,raw_directory:rawDir,requests:attempts};
await fs.writeFile(path.join(rawDir,'270023_官网全历史分页复核结果_2026-10-18.json'),JSON.stringify(audit,null,2)+'\n',{flag:'wx'});
if(issues.length)throw Error(issues.join('; '));
const normalized={...old,checked_at:checkedAt(),sources:[...Array.from({length:pages},(_,i)=>urlFor(i+1)),urlFor(pages+1),'https://www.gffunds.com.cn/funds/?fundcode=270023'],query_end_date:capture,first_date:rows[0].date,last_date:rows.at(-1).date,count:rows.length,validation,raw_archive_path:rawDir,raw_archive_initial_diagnostic:null,raw_archive_initial_diagnostic_resolution:null,comparison_to_previous_archive:comparison,public_dividend_records_checked_at:old.checked_at,public_dividend_records_note:'Inherited from prior official archive. Dividend data were not refreshed in this NAV completeness audit.',rows};
const outPath=path.join(navDir,`${code}_全部历史净值_截至${normalized.last_date}.json`);
await fs.writeFile(outPath,JSON.stringify(normalized,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({outPath,count:rows.length,first_date:normalized.first_date,last_date:normalized.last_date,validation,comparison:{added_count:added.length,added_dates:added.map(r=>r.date),removed_count:removed.length,changed_count:changed.length},rawDir},null,2));
