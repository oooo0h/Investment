import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';

const toolDir=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(toolDir,'../..');
const tmp=path.join(toolDir,'tmp');
const requireBundle=createRequire(path.join(tmp,'entry.mjs'));
const {Workbook}=await import(pathToFileURL(requireBundle.resolve('@oai/artifact-tool')).href);
const headers=['基金代码','基金名称','净值日期','单位净值','累计净值','日增长率(%)','分红事件','数据来源'];
const results=[];
const numeric=x=>x===null||x===undefined||x===''?null:Number(x);
const csvCell=x=>/[",\r\n]/.test(String(x))?'"'+String(x).replace(/"/g,'""')+'"':String(x);
function decimal(x,source){
  if(source===null||source===undefined||source===''){
    assert.ok(x===null||x===undefined||x==='');return '';
  }
  assert.equal(x,Number(source));
  const digits=String(source).split('.')[1]?.length??0;
  const output=Number(x).toFixed(digits);
  assert.equal(Number(output),Number(source));return output;
}

for(const code of ['016701','016702']){
  const matches=[];
  for(const group of ['持仓基金','观察基金']){
    let funds=[];
    try{funds=await fs.readdir(path.join(root,'基金',group));}catch{continue;}
    for(const name of funds) if(name.startsWith(code+'_')) matches.push(path.join(group,name));
  }
  assert.equal(matches.length,1);
  const dir=path.join(root,'基金',matches[0],'历史净值');
  const files=(await fs.readdir(dir)).filter(x=>x.startsWith(code+'_全部历史净值_截至')&&x.endsWith('.json')).sort();
  assert.ok(files.length);
  const inputPath=path.join(dir,files.at(-1));
  const doc=JSON.parse((await fs.readFile(inputPath,'utf8')).replace(/^\uFEFF/,''));
  const rows=doc.rows;
  assert.equal(doc.code,code);assert.equal(rows.length,doc.count);
  assert.equal(new Set(rows.map(x=>x.date)).size,rows.length);
  const workbook=Workbook.create();
  const sheet=workbook.worksheets.add(code);sheet.showGridLines=false;
  const last=rows.length+1;
  sheet.getRange(`A1:H${last}`).values=[headers,...rows.map(x=>[code,doc.name,x.date,numeric(x.nav),numeric(x.accumulated_nav),numeric(x.daily_growth_pct),x.event??'',x.source??doc.source])];
  sheet.getRange(`A1:H${last}`).format.font={name:'Arial',size:10};
  // ISO dates and six-digit identifiers preserve the requested raw archive format.
  sheet.getRange(`A2:C${last}`).setNumberFormat('@');
  sheet.getRange(`D2:E${last}`).setNumberFormat('0.0000');
  sheet.getRange(`F2:F${last}`).setNumberFormat('0.00');
  sheet.getRange('A1:H1').format={fill:'#1F4E78',font:{name:'Arial',size:10,bold:true,color:'#FFFFFF'}};
  sheet.getRange(`A1:A${last}`).format.columnWidth=12;
  sheet.getRange(`B1:B${last}`).format.columnWidth=65;
  sheet.getRange(`C1:C${last}`).format.columnWidth=15;
  sheet.getRange(`D1:F${last}`).format.columnWidth=17;
  sheet.getRange(`G1:G${last}`).format.columnWidth=38;
  sheet.getRange(`H1:H${last}`).format.columnWidth=40;
  sheet.freezePanes.freezeRows(1);
  workbook.recalculate();
  await workbook.inspect({kind:'table',range:`${code}!A1:H4`,include:'values',tableMaxRows:4,tableMaxCols:8,maxChars:600});
  const readback=sheet.getRange(`A2:H${last}`).values;
  assert.equal(readback.length,rows.length);
  const out=readback.map((x,i)=>{
    const source=rows[i];
    assert.equal(x[0],code);assert.equal(x[1],doc.name);assert.equal(x[2],source.date);
    assert.equal(x[6]??'',source.event??'');assert.equal(x[7],source.source??doc.source);
    return [x[0],x[1],x[2],decimal(x[3],source.nav),decimal(x[4],source.accumulated_nav),decimal(x[5],source.daily_growth_pct),x[6]??'',x[7]];
  });
  const image=await workbook.render({sheetName:code,range:'A1:H4',scale:1,format:'png'});
  await fs.writeFile(path.join(tmp,`yinhua_nav_preview_${code}.png`),new Uint8Array(await image.arrayBuffer()));
  const text='\uFEFF'+[headers,...out].map(x=>x.map(csvCell).join(',')).join('\r\n')+'\r\n';
  const csvPath=inputPath.replace(/\.json$/,'.csv');await fs.writeFile(csvPath,text,'utf8');
  const saved=await fs.readFile(csvPath);
  assert.ok(saved.subarray(0,3).equals(Buffer.from([0xEF,0xBB,0xBF])));
  const imported=await Workbook.fromCSV(saved.toString('utf8').replace(/^\uFEFF/,''),{sheetName:'Check'});
  const verified=imported.worksheets.getItemAt(0).getRange(`A1:H${last}`).values;
  assert.deepEqual(verified[0],headers);
  for(let i=0;i<out.length;i++)assert.deepEqual(verified[i+1].map(x=>x==null?'':String(x)),out[i].map(String));
  results.push({code,count:rows.length,first_date:rows[0].date,last_date:rows.at(-1).date,csv_file:path.relative(root,csvPath).split(path.sep).join('/'),all_fields_verified:true});
}
await fs.writeFile(path.join(tmp,'yinhua_nav_csv_validation_2026-10-16.json'),JSON.stringify({outputs:results.length,results},null,2)+'\n','utf8');
console.log(JSON.stringify({outputs:results.length,rows:results.reduce((s,x)=>s+x.count,0),all_fields_verified:true}));
