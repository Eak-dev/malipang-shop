import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),workbook=require('../dist/sheets/stable-workbook-claim.js');
const {bootstrapContinuousReportViews}=require('../dist/sheets/report-view-bootstrap.js');
const {ledgerCarrierFormulas,rawCarrierHeaders,detailCarrierHeaders}=require('../dist/sheets/atomic-expense-ledger-template.js');

function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(`CREATE TABLE stable_workbook_claims(spreadsheet_id TEXT PRIMARY KEY,operation_token TEXT,state TEXT);
 CREATE TABLE stable_projection_writes(spreadsheet_id TEXT,state TEXT);CREATE TABLE stable_expense_cancellation_writes(spreadsheet_id TEXT,state TEXT);
 INSERT INTO stable_workbook_claims VALUES('book','claim','HELD');`);sqlite.exec(fs.readFileSync(new URL('../migrations/0029_continuous_report_cutover.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){const stmt=sqlite.prepare(sql);let args=[];return{bind(...v){args=v;return this},async run(){const r=stmt.run(...args);return{success:true,meta:{changes:Number(r.changes)}}},async first(){return stmt.get(...args)??null}}}};
 const env={DB,GOOGLE_SPREADSHEET_ID:'book',GOOGLE_SERVICE_ACCOUNT_EMAIL:'service',GOOGLE_PRIVATE_KEY_BASE64:'key',STABLE_PHASE1_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',CONTINUOUS_REPORT_CUTOVER_ENABLED:'true',SHEET_EXPENSE_RAW:'V52_EXPENSE_RAW',SHEET_PURCHASE_DETAILS:'รายละเอียดการซื้อ',CONTINUOUS_DAILY_SHEET:'รายวันต่อเนื่อง_แบบร่าง',CONTINUOUS_DAILY_SHEET_ID:'3',CONTINUOUS_RAW_SHEET:'raw_new',CONTINUOUS_RAW_SHEET_ID:'4',CONTINUOUS_DETAIL_SHEET:'detail_new',CONTINUOUS_DETAIL_SHEET_ID:'5',CONTINUOUS_RAW_VIEW_ID:'6',CONTINUOUS_DETAIL_VIEW_ID:'7'};
 const before=[{sheetId:1,title:'V52_EXPENSE_RAW',rowCount:1000,columnCount:26},{sheetId:2,title:'รายละเอียดการซื้อ',rowCount:1000,columnCount:20},{sheetId:3,title:'รายวันต่อเนื่อง_แบบร่าง',rowCount:1000,columnCount:29}];
 let sheets=before.map(x=>({...x})),requests=[],mode='ok',dispatches=0;
 const originals={props:client.getSpreadsheetSheetProperties,formula:client.batchGetSheetFormulaValues,effective:client.batchGetSheetEffectiveSerialValues,values:client.batchGetSheetValues,update:client.batchUpdateSpreadsheetWithReply,claim:workbook.stableWorkbookClaimOwned};
 client.getSpreadsheetSheetProperties=async()=>sheets.map(x=>({...x}));workbook.stableWorkbookClaimOwned=async()=>true;
 client.batchUpdateSpreadsheetWithReply=async(_env,reqs,beforeDispatch)=>{await beforeDispatch();dispatches++;requests=reqs;
  if(mode==='unknown')throw Error('NETWORK_UNKNOWN');
  for(const r of reqs)if(r.addSheet){const p=r.addSheet.properties;sheets.push({sheetId:p.sheetId,title:p.title,rowCount:p.gridProperties.rowCount,columnCount:p.gridProperties.columnCount});}
  return{replies:reqs.map(()=>({}))};
 };
 const ledger=(projection,id)=>{
  const header=projection==='EXPENSE_RAW'?[...rawCarrierHeaders,'Sales_Addback_Basis']:detailCarrierHeaders;
  const markers=requests.find(r=>r.updateCells?.start?.sheetId===id&&r.updateCells.start.columnIndex===25).updateCells.rows.map(r=>r.values[0].userEnteredValue.stringValue);
  const formula=[header],effective=[header];for(let row=2;row<=1000;row++){
   const f=[],e=[],forms=ledgerCarrierFormulas(projection,row);for(const [c,v] of Object.entries(forms)){f[Number(c)]=v;e[Number(c)]=''}
   f[25]=mode==='drift'&&row===7?'changed':markers[row-2];e[25]=f[25];formula.push(f);effective.push(e);
  }return{formula,effective};
 };
 client.batchGetSheetFormulaValues=async()=>{const a=ledger('EXPENSE_RAW',4),b=ledger('DETAIL',5),raw=requests.find(r=>r.updateCells?.start?.sheetId===6).updateCells.rows[0].values[0].userEnteredValue.formulaValue,detail=requests.find(r=>r.updateCells?.start?.sheetId===7).updateCells.rows[0].values[0].userEnteredValue.formulaValue;return[a.formula,b.formula,[[raw]],[[detail]]];};
 client.batchGetSheetEffectiveSerialValues=async()=>[ledger('EXPENSE_RAW',4).effective,ledger('DETAIL',5).effective];
 client.batchGetSheetValues=async()=>[[['Expense_ID']],[['Purchase_Item_ID']]];
 return{env,sqlite,setMode(x){mode=x},get dispatches(){return dispatches},close(){client.getSpreadsheetSheetProperties=originals.props;client.batchGetSheetFormulaValues=originals.formula;client.batchGetSheetEffectiveSerialValues=originals.effective;client.batchGetSheetValues=originals.values;client.batchUpdateSpreadsheetWithReply=originals.update;workbook.stableWorkbookClaimOwned=originals.claim;sqlite.close()}};
}
test('bootstraps exactly four new sheets and verifies all markers, headers and views',async()=>{const h=fixture();try{
 assert.deepEqual(await bootstrapContinuousReportViews(h.env,'claim'),{stage:'VIEWS',verifiedSheets:4});assert.equal(h.dispatches,1);
 const created=await client.getSpreadsheetSheetProperties(h.env);assert.equal(created.find(s=>s.sheetId===6).rowCount,9999);assert.equal(created.find(s=>s.sheetId===7).rowCount,9999);
 const row=h.sqlite.prepare("SELECT state,cell_count,manifest_json FROM continuous_report_cutover_attempts WHERE stage='VIEWS'").get();assert.equal(row.state,'VERIFIED');assert.equal(row.cell_count,4);assert.equal(JSON.parse(row.manifest_json).length,4);
 }finally{h.close()}});
test('unknown provider result and marker drift remain in flight without automatic retry',async()=>{for(const mode of ['unknown','drift']){const h=fixture();try{
 h.setMode(mode);await assert.rejects(()=>bootstrapContinuousReportViews(h.env,'claim'));
 assert.equal(h.sqlite.prepare("SELECT state FROM continuous_report_cutover_attempts WHERE stage='VIEWS'").get().state,'IN_FLIGHT');
 await assert.rejects(()=>bootstrapContinuousReportViews(h.env,'claim'));assert.equal(h.dispatches,1);
 }finally{h.close()}}});
test('existing helper ID or disabled gate prevents dispatch',async()=>{const h=fixture();try{
 h.env.CONTINUOUS_RAW_SHEET_ID='1';await assert.rejects(()=>bootstrapContinuousReportViews(h.env,'claim'),/TARGET_UNVERIFIED/);assert.equal(h.dispatches,0);
 h.env.CONTINUOUS_REPORT_CUTOVER_ENABLED='false';await assert.rejects(()=>bootstrapContinuousReportViews(h.env,'claim'),/DISABLED/);assert.equal(h.dispatches,0);
 }finally{h.close()}});
test('legacy ledger configuration must match the formula sources',async()=>{const h=fixture();try{
 h.env.SHEET_EXPENSE_RAW='another_raw';await assert.rejects(()=>bootstrapContinuousReportViews(h.env,'claim'),/DISABLED/);assert.equal(h.dispatches,0);
 }finally{h.close()}});
