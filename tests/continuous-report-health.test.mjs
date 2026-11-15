import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),{verifyContinuousReportRows,verifyInstalledReportFormulas}=require('../dist/sheets/continuous-report-health.js');
const header=['Date','Expense_ID / Legacy row','Description','Amount','Wallet','Category','Source','Sales_Addback_Basis'],serial=(Date.UTC(2026,10,15)-Date.UTC(1899,11,30))/86400000;
function fixture(){return{rows:{clean:[header,[serial,'exp_one','item',1.23,'SHOP_BANK','ingredients','V52_CONFIRMED','']],rawIds:[['Expense_ID'],['exp_one']],detailIds:[['Purchase_Item_ID','Expense_ID'],['item_1','exp_one']]},expected:{expenseId:'exp_one',transactionDate:'2026-11-15',amountSatang:123,wallet:'SHOP_BANK',category:'ingredients',itemIds:['item_1']}};}
test('exact expense identity, amount, date, wallet, category and item coverage are required',()=>{
 const {rows,expected}=fixture();assert.equal(verifyContinuousReportRows(rows,expected),'OK');
 for(const change of [x=>x.clean[1][1]='exp_other',x=>x.clean[1][3]=2,x=>x.clean[1][4]='CASH_DRAWER',x=>x.detailIds[1][0]='item_other',x=>x.detailIds.push(['item_extra','exp_one']),x=>x.rawIds.push(['exp_one'])]){const x=structuredClone(rows);change(x);assert.equal(verifyContinuousReportRows(x,expected),'INVALID');}
});
test('report capacity and spill errors stop new writes before 34 loses rows',()=>{
 const {rows}=fixture();rows.clean=[header,...Array.from({length:4499},(_,i)=>[serial,`exp_${i}`,'item',1,'SHOP_BANK','ingredients','V52_CONFIRMED',''])];assert.equal(verifyContinuousReportRows(rows),'CAPACITY');
 rows.clean=[header,['#REF!']];assert.equal(verifyContinuousReportRows(rows),'INVALID');
});
test('cancellation verification requires the exact ID to disappear from normalized output',()=>{
 const {rows}=fixture();assert.equal(verifyContinuousReportRows(rows,{expenseId:'exp_one',absent:true}),'INVALID');rows.clean=[header];assert.equal(verifyContinuousReportRows(rows,{expenseId:'exp_one',absent:true}),'OK');
});
test('each installed report formula must match its verified manifest and sheet identity',async()=>{
 const old=client.batchGetSheetFormulaValues,sha=x=>createHash('sha256').update(x).digest('hex');
 const sheets=[{sheetId:1,title:'97_EXPENSE_CLEAN',rowCount:4500,columnCount:8},{sheetId:2,title:'34_OWNER_DAILY_CASH',rowCount:100,columnCount:8}];
 const entries=[{sheetId:1,sheetName:'97_EXPENSE_CLEAN',row:2,column:1,after:sha('=A1')},{sheetId:1,sheetName:'97_EXPENSE_CLEAN',row:2,column:8,after:sha('=H1')},{sheetId:2,sheetName:'34_OWNER_DAILY_CASH',row:46,column:2,after:sha('=A46')}];
 let manifest=JSON.stringify(entries),digest=sha(manifest),values=[[['=A1',null,null,null,null,null,null,'=H1']],[['=A46']]];
 const env={GOOGLE_SPREADSHEET_ID:'book',DB:{prepare(sql){assert.match(sql,/stage='REPORTS'/);return{bind(){return this},async first(){return{manifest_json:manifest,manifest_digest:digest,cell_count:entries.length}}}}}};
 client.batchGetSheetFormulaValues=async(_env,ranges)=>{assert.deepEqual(ranges,["'97_EXPENSE_CLEAN'!A2:H2","'34_OWNER_DAILY_CASH'!B46:B46"]);return values};
 try{
  assert.deepEqual(await verifyInstalledReportFormulas(env,sheets),sheets);
  values=[[['=changed',null,null,null,null,null,null,'=H1']],[['=A46']]];await assert.rejects(()=>verifyInstalledReportFormulas(env,sheets),/REPORT_HEALTH_FORMULA/);
  values=[[['=A1',null,null,null,null,null,null,'=H1']],[['=A46']]];await assert.rejects(()=>verifyInstalledReportFormulas(env,[{...sheets[0],sheetId:7},sheets[1]]),/REPORT_HEALTH_TARGET/);
  digest='0'.repeat(64);await assert.rejects(()=>verifyInstalledReportFormulas(env,sheets),/REPORT_HEALTH_MANIFEST/);
  const duplicate=[entries[0],entries[0],entries[2]];manifest=JSON.stringify(duplicate);digest=sha(manifest);await assert.rejects(()=>verifyInstalledReportFormulas(env,sheets),/REPORT_HEALTH_TARGET/);
 }finally{client.batchGetSheetFormulaValues=old;}
});
