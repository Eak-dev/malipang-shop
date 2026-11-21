import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';import {combinedLedgerSpillFormulas} from '../scripts/combined-ledger-report-formulas.mjs';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),{readContinuousReportHealth}=require('../dist/sheets/continuous-report-health.js');
test('grouped snapshot verifies report formulas, manifests and effective identities without fresh reads',async()=>{
 const methods=['getSpreadsheetSheetProperties','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues'],old=methods.map(k=>client[k]);
 try{
  for(const key of methods)client[key]=async()=>{throw Error('UNEXPECTED_PROVIDER_READ');};
  const names=['V52_EXPENSE_RAW','raw','รายละเอียดการซื้อ','detail','V52_EXPENSE_RAW_ALL','V52_PURCHASE_DETAIL_ALL','97_EXPENSE_CLEAN','report'],metadata=names.map((title,i)=>({sheetId:i+1,title,rowCount:i===6?4500:i===4||i===5?3:2,columnCount:i===6?8:i===4?18:i===5?20:26}));
  const hash=s=>createHash('sha256').update(s).digest('hex'),views=JSON.stringify([{sheetId:2,title:'raw',kind:'LEDGER'},{sheetId:4,title:'detail',kind:'LEDGER'},{sheetId:5,title:names[4],kind:'VIEW'},{sheetId:6,title:names[5],kind:'VIEW'}]),reportFormula='=1+1',reports=JSON.stringify([{sheetId:8,sheetName:'report',row:2,column:1,after:hash(reportFormula)}]);
  const DB={prepare:sql=>({bind(){return this;},first:async()=>sql.includes("stage='VIEWS'")?{manifest_json:views,manifest_digest:hash(views)}:{manifest_json:reports,manifest_digest:hash(reports),cell_count:1}})};
  const env={DB,GOOGLE_SPREADSHEET_ID:'book',SHEET_EXPENSE_RAW:'V52_EXPENSE_RAW',SHEET_PURCHASE_DETAILS:'รายละเอียดการซื้อ',CONTINUOUS_RAW_SHEET:'raw',CONTINUOUS_DETAIL_SHEET:'detail',CONTINUOUS_DAILY_SHEET:'draft'};
  const f=combinedLedgerSpillFormulas({rawNew:'raw',detailNew:'detail',rawCombined:names[4],detailCombined:names[5],rawOldRows:2,rawNewRows:2,detailOldRows:2,detailNewRows:2,publishedDaily:'draft'});
  const specs=[{sheetId:5,sheetName:names[4],rows:3,columns:18,startRow:1,endRow:3,startColumn:1,endColumn:1},{sheetId:6,sheetName:names[5],rows:3,columns:20,startRow:1,endRow:3,startColumn:1,endColumn:2},{sheetId:7,sheetName:names[6],rows:4500,columns:8},{sheetId:8,sheetName:'report',rows:2,columns:26,startRow:2,endRow:2,startColumn:1,endColumn:1}],snapshot={metadata,specs,formula:[[[f.raw]],[[f.detail]],[],[[reportFormula]]],effective:[[['Expense_ID']],[['Purchase_Item_ID','Expense_ID']],[['Date','Expense_ID / Legacy row','Description','Amount','Wallet','Category','Source','Sales_Addback_Basis']],[['']]]};
  assert.equal(await readContinuousReportHealth(env,{expenseId:'exp_test',absent:true,absentFromViews:true},{dailySheet:'draft'},undefined,snapshot),'OK');
  snapshot.formula[3][0][0]='=0';await assert.rejects(readContinuousReportHealth(env,undefined,{dailySheet:'draft'},undefined,snapshot),/REPORT_HEALTH_FORMULA/);
 }finally{methods.forEach((k,i)=>client[k]=old[i]);}
});
