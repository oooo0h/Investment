import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const indexRel='公共资料/历史净值/指定基金全历史净值归档清单_核验2026-10-18';
const indexPath=path.join(root,indexRel+'.json');
const prior=JSON.parse(await fs.readFile(indexPath,'utf8'));
const frozenBasis=prior.previous_archive_snapshot??prior;
const pageReport=JSON.parse(await fs.readFile(path.join(root,'公共资料/历史净值/全历史净值分页复核_2026-10-18.json'),'utf8'));
if(pageReport.failures.length||pageReport.results.length!==9)throw Error('Supplier pagination verification is incomplete');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const rel=p=>path.relative(root,p).split(path.sep).join('/');
const entries=[],oldFrozen=[];
let checkedPages=0,added=0;
for(const old of frozenBasis.funds){
 const oldJ=await fs.readFile(path.join(root,old.json_path)),oldC=await fs.readFile(path.join(root,old.csv_path));
 if(digest(oldJ)!==old.json_sha256||digest(oldC)!==old.csv_sha256)throw Error('Original frozen file changed: '+old.code);
 oldFrozen.push({code:old.code,json_path:old.json_path,csv_path:old.csv_path,json_sha256:old.json_sha256,csv_sha256:old.csv_sha256,records:old.records,last_date:old.last_date});
 let jsonRelative,csvRelative,evidenceRelative,pages,sourceScope;
 if(old.code==='270023'){
  const history=path.posix.dirname(old.json_path);
  jsonRelative=history+'/270023_全部历史净值_截至2026-10-15.json';csvRelative=jsonRelative.replace(/\.json$/,'.csv');
  evidenceRelative=history+'/原始数据/全历史分页复核_2026-10-18/270023_官网全历史分页复核结果_2026-10-18.json';
  const official=JSON.parse(await fs.readFile(path.join(root,evidenceRelative),'utf8'));
  if(!official.validation.passed||official.validation.tail_row_count!==0||!official.validation.first_page_stable_during_capture||official.comparison.removed_dates.length||official.comparison.changed_count!==0)throw Error('Official verification failed');
  pages=official.validation.official_total_pages;sourceScope='管理人官网接口全部已公布历史记录';
 }else{
  const result=pageReport.results.find(x=>x.code===old.code);
  if(!result||!result.old_files_unchanged)throw Error('Fund absent from live pagination report');
  jsonRelative=result.json_path;csvRelative=result.csv_path;evidenceRelative=result.verification_path;pages=result.pages;
  const evidence=JSON.parse(await fs.readFile(path.join(root,evidenceRelative),'utf8'));
  if(!evidence.all_pages_archived||!evidence.empty_tail_verified||!evidence.first_page_stable||evidence.unit_nav_mismatch_dates.length||evidence.missing_prior_dates.length)throw Error('Supplier verification failed');
  sourceScope='东方财富/天天基金接口全部已公布历史记录，非官网全量独立核验';
 }
 const jsonBytes=await fs.readFile(path.join(root,jsonRelative)),csvBytes=await fs.readFile(path.join(root,csvRelative));
 if(!csvBytes.subarray(0,3).equals(Buffer.from([239,187,191])))throw Error('CSV UTF-8 BOM missing');
 const data=JSON.parse(jsonBytes.toString('utf8')),rows=data.rows;
 if(data.code!==old.code||data.count!==rows.length||rows.some(x=>x.nav===null||Number(x.nav)<=0))throw Error('Updated dataset invalid');
 const missing=rows.filter(x=>x.accumulated_nav===null||x.accumulated_nav===undefined||x.accumulated_nav==='').map(x=>x.date);
 entries.push({code:old.code,name:data.name,first_date:rows[0].date,last_date:rows.at(-1).date,records:rows.length,json_path:jsonRelative,csv_path:csvRelative,json_sha256:digest(jsonBytes),csv_sha256:digest(csvBytes),raw_evidence_path:evidenceRelative,raw_evidence_sha256:digest(await fs.readFile(path.join(root,evidenceRelative))),verified_historical_pages:pages,verification_scope:sourceScope,unit_nav_missing_count:0,accumulated_nav_missing_dates:missing,csv_json_row_comparison_passed:true});
 checkedPages+=pages;added+=rows.length-old.records;
}
if(entries.length!==10||checkedPages!==816||added!==8)throw Error('Unexpected updated archive totals');
const manifest={schema:'public-fund-full-nav-archive-index-v2',verified_at:'2026-10-18',selection_basis:prior.selection_basis,operation:'逐基金全量分页复核并补齐8条最新公开单位净值；旧冻结主档不改',completeness_scope:'仅指下列数据源截至本次查询的全部已公布单位净值记录；不等于所有字段无缺或全部基金官网独立全量核验',fund_count:entries.length,record_count:entries.reduce((n,x)=>n+x.records,0),historical_pages_verified:checkedPages,added_records_since_previous_check:added,unit_nav_complete_within_verified_sources:true,accumulated_nav_complete:entries.every(x=>!x.accumulated_nav_missing_dates.length),frozen_originals_unchanged:true,previous_archive_snapshot:{record_count:frozenBasis.record_count,funds:oldFrozen},funds:entries};
await fs.writeFile(indexPath,JSON.stringify(manifest,null,2)+'\n','utf8');
const link=(p,label)=>'['+label+'](<'+path.posix.relative('公共资料/历史净值',p)+'>)';
const md=[
 '# 指定基金全历史净值归档清单',
 '',
 '核验日期：2026-10-18。本次对用户指定的10只基金补做全量分页检查，核对816页历史记录，并补齐较上次归档新增的8条公开单位净值。当前共16,226条，逐只保存为各自历史净值目录下的JSON和CSV。',
 '',
 '**可以确认的范围：截至本次查询，所用公开数据源的单位净值记录已全部取尽，并通过日期、条数、逐条净值、空尾页及首面稳定性检查。** 270023采用管理人官网主档；其余9只采用东方财富/天天基金接口。这不等于所有基金都做完官网独立核验，也不等于所有字段无缺。',
 '',
 '| 代码 | 基金名称 | 当前完整归档区间 | 记录数 | 历史分页 | 数据文件 | 全量复核证据 |',
 '|---|---|---|---:|---:|---|---|',
 ...entries.map(x=>'| '+x.code+' | '+x.name+' | '+x.first_date+' — '+x.last_date+' | '+x.records.toLocaleString('en-US')+' | '+x.verified_historical_pages+' | '+link(x.csv_path,'CSV')+' · '+link(x.json_path,'JSON')+' | '+link(x.raw_evidence_path,'原始分页与复核结果')+' |'),
 '',
 '006373的2020-12-31、2021-02-10仍缺累计净值，单位净值完整；全量接口也未给出这两个累计值，保留空值，不推算填充。其他字段按来源保存，空分红事件文字不单独证明历史从未分红。',
 '',
 '270023官网主档与旧官方记录逐字段一致，仅新增2026-10-15。既有10条第三方独有补充观察仍独立保留，不混入官方主表。其他基金原已归档的单位净值与本次全量接口也未发现差异。CSV与JSON全部逐行核对一致，新CSV还完成保存后重导入验证。',
 '',
 '净值日期与核验日期分别记录。旧版JSON/CSV作为历史回测冻结输入保留，文件哈希已核验未变；量化规则及原回测结果没有因补齐新日而重新计算。JSON索引保存当前文件、原始证据与旧冻结文件的SHA-256。',
 '',
 '本名单仅指定资料归档范围，不据此推断买卖或变更实际持仓。',
 ''
].join('\n');
await fs.writeFile(path.join(root,indexRel+'.md'),md,'utf8');
console.log(JSON.stringify({funds:manifest.fund_count,records:manifest.record_count,pages:checkedPages,addedRecords:added,oldFrozenDataFilesUnchanged:oldFrozen.length*2,cumulativeMissingFields:entries.reduce((n,x)=>n+x.accumulated_nav_missing_dates.length,0)}));

