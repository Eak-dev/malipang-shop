import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),health=require('../dist/sheets/continuous-report-health.js'),{planPublicationSnapshot}=require('../dist/sheets/publication-snapshot-plan.js');
test('snapshot plan includes all projection, report and manifest ranges with exact target identities',async()=>{
 const original=health.planInstalledReportFormulas;
 try{
  const names=['draft','รายวัน','raw','detail','V52_EXPENSE_RAW_ALL','V52_PURCHASE_DETAIL_ALL','97_EXPENSE_CLEAN','publication','report'],sheets=names.map((title,i)=>({sheetId:i+1,title,rowCount:i===6?4500:1000,columnCount:i===6?8:29}));
  const env={DB:{},GOOGLE_SPREADSHEET_ID:'book',CONTINUOUS_DAILY_SHEET:'draft',CONTINUOUS_DAILY_SHEET_ID:'1',SHEET_EXPENSE_DAILY:'รายวัน',CONTINUOUS_RAW_SHEET:'raw',CONTINUOUS_RAW_SHEET_ID:'3',CONTINUOUS_DETAIL_SHEET:'detail',CONTINUOUS_DETAIL_SHEET_ID:'4'};
  health.planInstalledReportFormulas=async()=>[{sheet:sheets[8],minRow:5,maxRow:20,minColumn:2,maxColumn:4,entries:[]}];
  const specs=await planPublicationSnapshot(env,sheets,{sheetId:8,sheetName:'publication',rows:1000});assert.equal(specs.length,9);assert.deepEqual(specs.at(-1),{sheetId:9,sheetName:'report',rows:1000,columns:29,startRow:5,endRow:20,startColumn:2,endColumn:4});
  await assert.rejects(planPublicationSnapshot(env,sheets,{sheetId:7,sheetName:'publication',rows:1000}),/TARGET/);
 }finally{health.planInstalledReportFormulas=original;}
});
