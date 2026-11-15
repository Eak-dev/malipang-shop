import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const client=require('../dist/sheets/client.js'),route=require('../dist/sheets/continuous-daily-route.js'),insert=require('../dist/sheets/insert-daily-writer.js'),ledger=require('../dist/sheets/atomic-expense-ledger-writer.js'),planner=require('../dist/sheets/stable-expense-projection-plan.js'),daily=require('../dist/sheets/daily-expense.js'),legacy=require('../dist/sheets/legacy-daily-coverage.js'),health=require('../dist/sheets/continuous-report-health.js');
const {verifyStableExpenseProjections,verifyStableExpensePostpublication}=require('../dist/sheets/stable-expense-final-check.js');

test('staged final verifies raw/detail preimages and their absence; published check verifies exact report identity',async()=>{
 const changes=[[client,'getSheetGridInfo'],[client,'batchGetSheetFormulaValues'],[client,'batchGetSheetEffectiveSerialValues'],[route,'assertContinuousDailyActivated'],[insert,'verifyInsertedDailyFinalSnapshot'],[ledger,'resolveCarrierLedgerTarget'],[ledger,'verifyCarrierLedgerSnapshot'],[planner,'planStableExpenseProjections'],[daily,'resolvePayment'],[legacy,'readLegacyDailyCoverage'],[health,'readContinuousReportHealth']];
 const originals=changes.map(([o,k])=>o[k]);let report,phase,digestStatements=0,tamper=false;
 try{
  route.assertContinuousDailyActivated=async()=>({sheet:'draft',sheetId:2});
  planner.planStableExpenseProjections=()=>({record:{transactionDate:'2026-11-15',paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'ingredients'},raw:['raw'],details:[{itemId:'item_1',values:['detail']}]});
  daily.resolvePayment=()=>({postingYear:2026,postingMonth:11,postingDay:15});
  legacy.readLegacyDailyCoverage=async()=>({coverage:{status:'VERIFIED',year:2026,month:11}});
  insert.verifyInsertedDailyFinalSnapshot=async(...args)=>{phase=args[9]?.phase;};
  ledger.resolveCarrierLedgerTarget=(_env,type)=>type==='EXPENSE_RAW'?{sheet:'raw',sheetId:3}:{sheet:'detail',sheetId:4};
  ledger.verifyCarrierLedgerSnapshot=(snapshot,_rows,_columns,type,expected)=>{if(tamper&&type==='DETAIL')throw Error('TAMPERED_DETAIL');assert.equal(expected.expenseId,'exp_test');return 2;};
  client.getSheetGridInfo=async(_env,name)=>name==='draft'?{sheetId:2,rowCount:5,columnCount:29}:name==='raw'?{sheetId:3,rowCount:2,columnCount:26}:{sheetId:4,rowCount:2,columnCount:26};
  client.batchGetSheetFormulaValues=async(_env,ranges)=>ranges.map(()=>[[],['carrier']]);
  client.batchGetSheetEffectiveSerialValues=async(_env,ranges)=>ranges.map(()=>[[],['carrier']]);
  health.readContinuousReportHealth=async(_env,expected,config)=>{report={expected,config};return 'OK';};
  const DB={prepare:()=>({bind(){return this;}}),batch:async statements=>{digestStatements=statements.length;return statements.map(()=>({success:true,results:[{ok:1}]}));}};
  const env={DB,GOOGLE_SPREADSHEET_ID:'book',SHEET_EXPENSE_DAILY:'legacy',SHEET_EXPENSE_RAW:'legacy_raw',SHEET_PURCHASE_DETAILS:'legacy_detail',CONTINUOUS_DAILY_SHEET:'draft'};
  const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_test',entityVersion:1},source={expense:{amount_satang:123,transaction_date:'2026-11-15'},digest:'a'.repeat(64)};
  const journals=[{entity_id:'exp_test',projection:'DAILY',sheet_id:2,sheet_name:'draft'},{entity_id:'exp_test',projection:'EXPENSE_RAW',sheet_id:3,sheet_name:'raw'},{entity_id:'exp_test|item_1',projection:'DETAIL',sheet_id:4,sheet_name:'detail'}].map(j=>({...j,source_version:1,source_digest:source.digest,state:'VERIFIED',operation_token:'claim-token'}));
  const publication={sheet:'publication',rows:100,markers:new Map([['exp_test',{state:'STAGED',version:1}]])};
  await verifyStableExpenseProjections(env,job,source,journals,{...publication,phase:'STAGED'});
  assert.equal(phase,'STAGED');assert.equal(digestStatements,2);assert.deepEqual(report,{expected:{expenseId:'exp_test',absent:true,absentFromViews:true},config:{dailySheet:'draft'}});
  const specs=[{sheetId:2,sheetName:'draft',rows:5,columns:29},{sheetId:3,sheetName:'raw',rows:2,columns:26},{sheetId:4,sheetName:'detail',rows:2,columns:26}],snapshot={specs,metadata:specs.map(s=>({sheetId:s.sheetId,title:s.sheetName,rowCount:s.rows,columnCount:s.columns})),formula:specs.map(()=>[[],['carrier']]),effective:specs.map(()=>[[],['carrier']])};
  client.getSheetGridInfo=async()=>{throw Error('UNEXPECTED_GET');};client.batchGetSheetFormulaValues=async()=>{throw Error('UNEXPECTED_GET');};client.batchGetSheetEffectiveSerialValues=async()=>{throw Error('UNEXPECTED_GET');};
  await verifyStableExpenseProjections(env,job,source,journals,{...publication,phase:'STAGED'},undefined,snapshot);
  client.getSheetGridInfo=async(_env,name)=>name==='draft'?{sheetId:2,rowCount:5,columnCount:29}:name==='raw'?{sheetId:3,rowCount:2,columnCount:26}:{sheetId:4,rowCount:2,columnCount:26};
  client.batchGetSheetFormulaValues=async(_env,ranges)=>ranges.map(()=>[[],['carrier']]);client.batchGetSheetEffectiveSerialValues=async(_env,ranges)=>ranges.map(()=>[[],['carrier']]);
  tamper=true;await assert.rejects(verifyStableExpenseProjections(env,job,source,journals,{...publication,phase:'STAGED'}),/TAMPERED_DETAIL/);tamper=false;
  publication.markers.set('exp_test',{state:'PUBLISHED',version:1});await verifyStableExpensePostpublication(env,job,source,journals,publication);
  assert.equal(phase,'PUBLISHED');assert.deepEqual(report.expected.itemIds,['item_1']);assert.equal(report.expected.amountSatang,123);
  publication.markers.set('exp_test',{state:'STAGED',version:1});await assert.rejects(verifyStableExpensePostpublication(env,job,source,journals,publication),/STABLE_FINAL_PUBLICATION/);
 }finally{changes.forEach(([o,k],i)=>{o[k]=originals[i];});}
});

test('staged absence includes both view ID columns and rejects errors',()=>{
 const h=['Date','Expense_ID / Legacy row','Description','Amount','Wallet','Category','Source','Sales_Addback_Basis'];
 const row={clean:[h],rawIds:[['Expense_ID']],detailIds:[['Purchase_Item_ID','Expense_ID']]},expected={expenseId:'exp_test',absent:true,absentFromViews:true};
 assert.equal(health.verifyContinuousReportRows(row,expected),'OK');
 row.rawIds.push(['exp_test']);assert.equal(health.verifyContinuousReportRows(row,expected),'INVALID');row.rawIds.pop();
 row.detailIds.push(['item_1','exp_test']);assert.equal(health.verifyContinuousReportRows(row,expected),'INVALID');row.detailIds.pop();
 row.detailIds.push(['#N/A']);assert.equal(health.verifyContinuousReportRows(row,expected),'INVALID');
});
test('staged and postpublication report reads fail closed at full report capacity',()=>{
 const h=['Date','Expense_ID / Legacy row','Description','Amount','Wallet','Category','Source','Sales_Addback_Basis'];
 const rows={clean:[h,...Array.from({length:4499},(_,i)=>[1,`exp_${i}`,'x',1,'SHOP_BANK','ingredients','V52_CONFIRMED',''])],rawIds:[['Expense_ID']],detailIds:[['Purchase_Item_ID','Expense_ID']]};
 assert.equal(health.verifyContinuousReportRows(rows,{expenseId:'exp_test',absent:true,absentFromViews:true}),'CAPACITY');
});
