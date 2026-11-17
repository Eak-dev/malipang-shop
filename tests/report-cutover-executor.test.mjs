import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const client=require('../dist/sheets/client.js');
const workbook=require('../dist/sheets/stable-workbook-claim.js');
const {continuousDailyHelperFormulas}=require('../dist/sheets/continuous-daily-plan.js');
const {executeContinuousReportCutover}=require('../dist/sheets/report-cutover-executor.js');

function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(`CREATE TABLE stable_workbook_claims(spreadsheet_id TEXT PRIMARY KEY,operation_token TEXT,state TEXT);
 CREATE TABLE stable_projection_writes(spreadsheet_id TEXT,state TEXT);
 CREATE TABLE stable_expense_cancellation_writes(spreadsheet_id TEXT,state TEXT);
 INSERT INTO stable_workbook_claims VALUES('book','claim','HELD');`);
 sqlite.exec(fs.readFileSync(new URL('../migrations/0029_continuous_report_cutover.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){const statement=sqlite.prepare(sql);let args=[];return {bind(...values){args=values;return this},async run(){const r=statement.run(...args);return{success:true,meta:{changes:Number(r.changes)}}},async first(){return statement.get(...args)??null}}}};
 const env={DB,GOOGLE_SPREADSHEET_ID:'book',GOOGLE_SERVICE_ACCOUNT_EMAIL:'service',GOOGLE_PRIVATE_KEY_BASE64:'key',STABLE_PHASE1_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',CONTINUOUS_REPORT_CUTOVER_ENABLED:'true'};
 const snapshot={sheetId:7,sheetName:'รายวันต่อเนื่อง_แบบร่าง',rowCount:10,columnCount:29,formula:Array.from({length:10},()=>[])};
 for(let row=4;row<=10;row++)snapshot.formula[row-1][9]=continuousDailyHelperFormulas(row)[9];
 const cells=snapshot.formula.map(r=>[r[9]??null]);let dispatched=0,mode='ok',owned=true;
 const originals={get:client.getSheetGridInfo,read:client.batchGetSheetFormulaValues,update:client.batchUpdateSpreadsheetWithReply,claim:workbook.stableWorkbookClaimOwned};
 client.getSheetGridInfo=async()=>({sheetId:7,rowCount:10,columnCount:29});
 client.batchGetSheetFormulaValues=async()=>[cells.slice(3,10).map(r=>[r[0]])];
 workbook.stableWorkbookClaimOwned=async()=>owned;
 client.batchUpdateSpreadsheetWithReply=async(_env,requests,before)=>{
  await before();dispatched++;
  const replies=[];
  for(const [i,r] of requests.entries()){
   if(mode==='unknown'&&i===1)throw Error('NETWORK_UNKNOWN');
   const p=r.findReplace,index=p.range.startRowIndex;
   if(cells[index][0]!==p.find){replies.push({findReplace:{}});continue}
   cells[index][0]=p.replacement;replies.push({findReplace:{formulasChanged:1,occurrencesChanged:1}});
  }
  if(mode==='partial')replies[1]={findReplace:{}};
  return{replies};
 };
 return{env,snapshot,sqlite,cells,setMode(x){mode=x},setOwned(x){owned=x},get dispatched(){return dispatched},close(){client.getSheetGridInfo=originals.get;client.batchGetSheetFormulaValues=originals.read;client.batchUpdateSpreadsheetWithReply=originals.update;workbook.stableWorkbookClaimOwned=originals.claim;sqlite.close()}};
}

test('manual-J migration journals exact hashes, writes once and verifies every formula',async()=>{const h=fixture();try{
 const result=await executeContinuousReportCutover(h.env,'claim',{stage:'DAILY_J',snapshot:h.snapshot});
 assert.deepEqual(result,{stage:'DAILY_J',verifiedCells:7});assert.equal(h.dispatched,1);
 const row=h.sqlite.prepare('SELECT state,cell_count,manifest_json FROM continuous_report_cutover_attempts').get();assert.equal(row.state,'VERIFIED');assert.equal(row.cell_count,7);
 const entries=JSON.parse(row.manifest_json);assert.equal(entries.length,7);assert.match(entries[0].before,/^[0-9a-f]{64}$/);assert.doesNotMatch(row.manifest_json,/SUMIFS/);
 await assert.rejects(()=>executeContinuousReportCutover(h.env,'claim',{stage:'DAILY_J',snapshot:h.snapshot}));assert.equal(h.dispatched,1);
 }finally{h.close()}});
test('unknown provider result remains IN_FLIGHT and never permits a second dispatch',async()=>{const h=fixture();try{
 h.setMode('unknown');await assert.rejects(()=>executeContinuousReportCutover(h.env,'claim',{stage:'DAILY_J',snapshot:h.snapshot}),/NETWORK_UNKNOWN/);
 assert.equal(h.sqlite.prepare('SELECT state FROM continuous_report_cutover_attempts').get().state,'IN_FLIGHT');
 await assert.rejects(()=>executeContinuousReportCutover(h.env,'claim',{stage:'DAILY_J',snapshot:h.snapshot}));assert.equal(h.dispatched,1);
 }finally{h.close()}});
test('partial provider result remains IN_FLIGHT and missing claim or feature gate sends nothing',async()=>{const h=fixture();try{
 h.setMode('partial');await assert.rejects(()=>executeContinuousReportCutover(h.env,'claim',{stage:'DAILY_J',snapshot:h.snapshot}),/PARTIAL_OR_UNKNOWN/);
 assert.equal(h.sqlite.prepare('SELECT state FROM continuous_report_cutover_attempts').get().state,'IN_FLIGHT');assert.equal(h.dispatched,1);
 }finally{h.close()}
 const disabled=fixture();try{disabled.env.CONTINUOUS_REPORT_CUTOVER_ENABLED='false';await assert.rejects(()=>executeContinuousReportCutover(disabled.env,'claim',{stage:'DAILY_J',snapshot:disabled.snapshot}),/DISABLED/);assert.equal(disabled.dispatched,0)}finally{disabled.close()}
 const noClaim=fixture();try{noClaim.setOwned(false);await assert.rejects(()=>executeContinuousReportCutover(noClaim.env,'claim',{stage:'DAILY_J',snapshot:noClaim.snapshot}),/CLAIM_UNVERIFIED/);assert.equal(noClaim.dispatched,0)}finally{noClaim.close()}});
