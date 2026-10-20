import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const asOf=process.argv.find(x=>x.startsWith('--as-of='))?.slice(8);
if(!/^\d{4}-\d{2}-\d{2}$/.test(asOf??''))throw Error('Use --as-of=YYYY-MM-DD');
const manifestPath=path.join(root,'公共资料/历史净值/指定基金全历史净值归档清单_核验2026-10-18.json');
const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
const allowedCodes=['005698','006373','000216','009608','018124','015789','019454','022459','016701'];
const selected=process.argv.find(x=>x.startsWith('--codes='))?.slice(8);
const codes=selected?selected.split(','):allowedCodes;
if(codes.some(x=>!allowedCodes.includes(x)))throw Error('Unknown verification code');
const resume=process.argv.includes('--resume');
const headers={'User-Agent':'Mozilla/5.0','Referer':'https://fundf10.eastmoney.com/','Cache-Control':'no-cache'};
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const rel=p=>path.relative(root,p).split(path.sep).join('/');
const emit=(event,fields={})=>console.log(JSON.stringify({event,...fields}));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
 return value;
}
function decimal(v){
 if(v===null||v===undefined||v===''||v==='--'||v==='---')return null;
 const s=String(v).trim();if(!/^[+-]?\d+(?:\.\d+)?$/.test(s)||!Number.isFinite(Number(s)))throw Error('Invalid public numeric value');
 return s;
}
function equal(a,b){a=decimal(a);b=decimal(b);return a===null||b===null?a===b:Number(a)===Number(b);}
async function request(code,page,end='',allowEmpty=false){
 const url=new URL('https://api.fund.eastmoney.com/f10/lsjz');
 for(const [k,v]of Object.entries({fundCode:code,pageIndex:page,pageSize:20,startDate:'',endDate:end,_:Date.now()}))url.searchParams.set(k,String(v));
 for(let attempt=1;attempt<=4;attempt++){
  try{
   const response=await fetch(url,{headers,signal:AbortSignal.timeout(25000)});
   if(!response.ok)throw Error('HTTP '+response.status);
   const body=await response.json();
   if(body.ErrCode!==0)throw Error('Public API returned error');
   if(!Array.isArray(body.Data?.LSJZList)&&!(allowEmpty&&Number(body.TotalCount)===0))throw Error('Public API returned no historical list');
   return {url:url.href,captured_at:new Date().toISOString(),response:body};
  }catch(e){if(attempt===4)throw e;emit('retry',{code,page,attempt});await pause(attempt*800);}
 }
}
async function saveRaw(folder,label,record){
 const output=path.join(folder,label+'.json');
 if(await fs.stat(output).catch(()=>null)){
  if(!resume)throw Error('Refuse to overwrite raw verification evidence');
  const previous=JSON.parse(await fs.readFile(output,'utf8'));
  if(JSON.stringify(canonical(previous.response))!==JSON.stringify(canonical(record.response)))throw Error('Archived evidence disagrees with retry response');
  return output;
 }
 await fs.writeFile(output,JSON.stringify(record,null,2)+'\n','utf8');
 return output;
}
async function verifyFund(entry){
 const oldJsonPath=path.join(root,entry.json_path),oldCsvPath=path.join(root,entry.csv_path);
 const oldJsonBytes=await fs.readFile(oldJsonPath),oldCsvBytes=await fs.readFile(oldCsvPath);
 const old=JSON.parse(oldJsonBytes.toString('utf8')), history=path.dirname(oldJsonPath),oldByDate=new Map(old.rows.map(r=>[r.date,r]));
 const evidence=path.join(history,'原始数据','全历史分页复核_'+asOf);
 await fs.mkdir(evidence,{recursive:true});
 const head=await request(entry.code,1);
 await saveRaw(evidence,entry.code+'_最新首面',head);
 const latest=head.response.Data.LSJZList[0]?.FSRQ;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(latest??''))throw Error('Missing latest NAV date');
 const pinned=await request(entry.code,1,latest);
 const total=Number(pinned.response.TotalCount),size=Number(pinned.response.PageSize),pages=Math.ceil(total/size);
 if(!Number.isInteger(total)||total<old.rows.length||size!==20)throw Error('Unexpected source total/page size');
 await saveRaw(evidence,entry.code+'_lsjz_page001',pinned);
 const rawPages=new Map([[1,pinned]]),pageHashes=[];
 let next=2,complete=1,failure=null;
 async function worker(){
  while(!failure&&next<=pages){
   const page=next++;
   try{
    const record=await request(entry.code,page,latest);
    if(Number(record.response.TotalCount)!==total||Number(record.response.PageSize)!==size||Number(record.response.PageIndex)!==page)throw Error('Pinned pagination changed');
    const output=await saveRaw(evidence,entry.code+'_lsjz_page'+String(page).padStart(3,'0'),record);
    rawPages.set(page,record);pageHashes.push({page,path:rel(output),sha256:digest(await fs.readFile(output))});
    complete++;if(complete%40===0||complete===pages)emit('pages',{code:entry.code,completed:complete,total:pages});
   }catch(e){failure=e;}
  }
 }
 emit('fund-start',{code:entry.code,pages,sourceRecords:total,previousRecords:old.rows.length,latest});
 await Promise.all(Array.from({length:Math.min(6,pages-1)},worker));
 if(failure)throw failure;
 const combined=[];
 for(let page=1;page<=pages;page++){
  const record=rawPages.get(page);if(!record)throw Error('Missing archived page');
  const rows=record.response.Data.LSJZList,expected=page<pages?size:total-size*(pages-1);
  if(rows.length!==expected)throw Error('Page row count mismatch');
  combined.push(...rows);
 }
 const tail=await request(entry.code,pages+1,latest,true);
 await saveRaw(evidence,entry.code+'_空尾页',tail);
 if((tail.response.Data?.LSJZList?.length??0)!==0)throw Error('Tail page contains unaccounted rows');
 const repeat=await request(entry.code,1,latest);
 await saveRaw(evidence,entry.code+'_首面稳定复查',repeat);
 if(Number(repeat.response.TotalCount)!==total||JSON.stringify(canonical(repeat.response.Data.LSJZList))!==JSON.stringify(canonical(pinned.response.Data.LSJZList)))throw Error('Source first page changed during capture');
 const sourceRows=combined.map(r=>({date:r.FSRQ,nav:decimal(r.DWJZ),accumulated_nav:decimal(r.LJJZ),daily_growth_pct:decimal(r.JZZZL),event:r.FHSP||r.FHFCZ||'',source:'天天基金 f10/lsjz 全量分页'})).sort((a,b)=>a.date.localeCompare(b.date));
 const sourceByDate=new Map(sourceRows.map(r=>[r.date,r]));
 if(sourceRows.length!==total||sourceByDate.size!==total||sourceRows[0].date!==old.first_date||sourceRows.at(-1).date!==latest||sourceRows.some(r=>!r.nav||Number(r.nav)<=0))throw Error('Full source coverage is invalid');
 const missingOld=[],unitMismatches=[],accMismatches=[],accFilled=[];
 for(const previous of old.rows){
  const found=sourceByDate.get(previous.date);
  if(!found){missingOld.push(previous.date);continue;}
  if(!equal(previous.nav,found.nav))unitMismatches.push(previous.date);
  if(previous.accumulated_nav!==null&&previous.accumulated_nav!==undefined&&previous.accumulated_nav!==''&&found.accumulated_nav!==null&&!equal(previous.accumulated_nav,found.accumulated_nav))accMismatches.push(previous.date);
  if((previous.accumulated_nav===null||previous.accumulated_nav===undefined||previous.accumulated_nav==='')&&found.accumulated_nav!==null)accFilled.push(previous.date);
 }
 if(missingOld.length||unitMismatches.length||accMismatches.length)throw Error('Historical source disagreement: '+JSON.stringify({missingOld,unitMismatches,accMismatches}));
 const rows=sourceRows.map(r=>{const previous=oldByDate.get(r.date);return {...r,accumulated_nav:r.accumulated_nav??decimal(previous?.accumulated_nav)};});
 const added=rows.filter(r=>!oldByDate.has(r.date)).map(r=>r.date);
 const pageOnePath=path.join(evidence,entry.code+'_lsjz_page001.json');
 pageHashes.push({page:1,path:rel(pageOnePath),sha256:digest(await fs.readFile(pageOnePath))});pageHashes.sort((a,b)=>a.page-b.page);
 const verification={schema:'public-nav-full-pagination-verification-v1',code:entry.code,verified_at:asOf,source:'天天基金/东方财富 f10/lsjz；第三方单一供应商，非管理人官网全量独立核验',latest_source_date:latest,pinned_end_date:latest,source_total_count:total,source_page_size:size,source_page_count:pages,source_unique_dates:sourceByDate.size,all_pages_archived:true,all_page_counts_match:true,empty_tail_verified:true,first_page_stable:true,first_date:rows[0].date,previous_last_date:old.last_date,previous_count:old.rows.length,previous_json_path:entry.json_path,previous_json_sha256:digest(oldJsonBytes),previous_csv_sha256:digest(oldCsvBytes),missing_prior_dates:missingOld,unit_nav_mismatch_dates:unitMismatches,accumulated_nav_mismatch_dates:accMismatches,accumulated_nav_filled_dates:accFilled,added_dates:added,missing_accumulated_nav_dates:rows.filter(r=>r.accumulated_nav===null).map(r=>r.date),raw_pages:pageHashes};
 let outputJson=oldJsonPath;
 if(latest!==old.last_date){
  outputJson=path.join(history,entry.code+'_全部历史净值_截至'+latest+'.json');
  if(await fs.stat(outputJson).catch(()=>null))throw Error('Refuse to overwrite existing dated NAV dataset');
  const payload={...old,downloaded_at:new Date().toISOString(),first_date:rows[0].date,last_date:latest,count:rows.length,source:'天天基金（东方财富）f10/lsjz 全历史分页核验，第三方公开净值',reuse:{files:[entry.json_path],previous_unique_dates:old.rows.length,added_unique_dates:added.length,action:'逐页全量对照并保存新增日期；保留历史冻结主档'},validation:{api_total_count:total,pages,unique_date_count:rows.length,duplicate_dates:0,all_pages_pinned_end_date:latest,all_pages_archived:true,full_page_row_comparison_passed:true,prior_dates_missing:missingOld,prior_unit_nav_mismatches:unitMismatches,prior_accumulated_nav_mismatches:accMismatches,missing_accumulated_nav_count:verification.missing_accumulated_nav_dates.length,official_independent_full_validation:false},rows};
  await fs.writeFile(outputJson,JSON.stringify(payload,null,2)+'\n','utf8');
 }
 verification.json_path=rel(outputJson);verification.csv_path=rel(outputJson.replace(/\.json$/,'.csv'));verification.new_dataset=outputJson!==oldJsonPath;verification.records=rows.length;
 const verificationPath=path.join(evidence,entry.code+'_全历史分页复核结果.json');
 await fs.writeFile(verificationPath,JSON.stringify(verification,null,2)+'\n','utf8');
 if(digest(await fs.readFile(oldJsonPath))!==digest(oldJsonBytes)||digest(await fs.readFile(oldCsvPath))!==digest(oldCsvBytes))throw Error('Frozen original changed unexpectedly');
 const result={code:entry.code,name:old.name,records:rows.length,first_date:rows[0].date,last_date:latest,pages,json_path:verification.json_path,csv_path:verification.csv_path,verification_path:rel(verificationPath),added_dates:added,accumulated_nav_missing_dates:verification.missing_accumulated_nav_dates,new_dataset:verification.new_dataset,old_files_unchanged:true,json_sha256:digest(await fs.readFile(outputJson))};
 emit('fund-verified',result);
 return result;
}
const results=[],failures=[];
for(const code of codes){
 try{const entry=manifest.funds.find(f=>f.code===code);if(!entry)throw Error('Code absent from selected archive');results.push(await verifyFund(entry));}
 catch(e){failures.push({code,message:e.message});emit('fund-error',{code,message:e.message});}
}
const output=path.join(root,'公共资料/历史净值/全历史净值分页复核_'+asOf+'.json');
let allResults=results,allFailures=failures;
if(await fs.stat(output).catch(()=>null)){
 if(!resume)throw Error('Verification summary exists');
 const prior=JSON.parse(await fs.readFile(output,'utf8'));
 allResults=[...prior.results.filter(x=>!codes.includes(x.code)),...results];
 allFailures=[...prior.failures.filter(x=>!codes.includes(x.code)),...failures];
}
const report={schema:'selected-nav-pagination-verification-v1',verified_at:asOf,source_scope:'所用供应商内的全量历史分页；不等同管理人官网独立逐日核验',results:allResults,failures:allFailures};
await fs.writeFile(output,JSON.stringify(report,null,2)+'\n','utf8');
emit('complete',{verifiedFunds:allResults.length,newDatasets:allResults.filter(x=>x.new_dataset).length,addedRecords:allResults.reduce((n,x)=>n+x.added_dates.length,0),pages:allResults.reduce((n,x)=>n+x.pages,0),failures:allFailures,summary:rel(output)});
if(allFailures.length)process.exitCode=1;

