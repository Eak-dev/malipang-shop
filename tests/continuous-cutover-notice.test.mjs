import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {releaseContinuousCutoverNotice}=require('../dist/admin/continuous-cutover-notice.js');
const client=require('../dist/sheets/client.js'),notice=require('../dist/sheets/stable-edit-notice.js'),claim=require('../dist/sheets/stable-workbook-claim.js');
function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec(`CREATE TABLE stable_workbook_claims(spreadsheet_id TEXT PRIMARY KEY,operation_token TEXT,state TEXT,notice_stamp TEXT,notice_identity TEXT,phase TEXT,review_reason TEXT);
 CREATE TABLE stable_projection_writes(spreadsheet_id TEXT,operation_token TEXT);CREATE TABLE stable_expense_cancellation_writes(spreadsheet_id TEXT,operation_token TEXT);CREATE TABLE stable_recovery_operations(operation_token TEXT);CREATE TABLE sync_jobs(status TEXT);
 INSERT INTO stable_workbook_claims VALUES('book','claim','HELD',NULL,NULL,NULL,NULL);`);
 sql.exec(fs.readFileSync(new URL('../migrations/0031_continuous_cutover_operator.sql',import.meta.url),'utf8'));
 sql.exec("INSERT INTO continuous_cutover_operator VALUES('book','claim','NEW',NULL,'STARTING','now','now')");
 sql.exec("UPDATE stable_workbook_claims SET notice_stamp='2026-01-01 01:00:00',notice_identity='identity'");
 sql.exec("UPDATE continuous_cutover_operator SET state='HELD'; UPDATE continuous_cutover_operator SET state='RELEASING'");
 const DB={prepare(text){const st=sql.prepare(text);let args=[];return{bind(...a){args=a;return this},async first(){return st.get(...args)??null},async run(){const r=st.run(...args);return{success:true,meta:{changes:Number(r.changes)}}}}}};
 const env={DB,GOOGLE_SPREADSHEET_ID:'book',SHEET_EXPENSE_DAILY:'รายวัน',STABLE_PHASE1_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true'};
 const old={grid:client.getSheetGridInfo,update:client.batchUpdateSpreadsheetWithReply,style:notice.stableNoticeStyleFingerprint,owned:claim.stableWorkbookClaimOwned};
 let cells=['พักแก้ไฟล์','2026-01-01 01:00:00'],mode='ok',dispatches=0,requests;
 client.getSheetGridInfo=async()=>({sheetId:1815870717,rowCount:1000,columnCount:29});
 notice.stableNoticeStyleFingerprint=async(_env,id,s,t)=>id==='identity'&&cells[0]===s&&cells[1]===t?'a'.repeat(64):null;
 claim.stableWorkbookClaimOwned=async()=>true;
 client.batchUpdateSpreadsheetWithReply=async(_env,reqs,callback)=>{
  await callback();dispatches++;requests=reqs;if(mode==='human')cells[0]='human edit';
  const replies=reqs.map(({findReplace:f})=>{const index=f.range.startColumnIndex-1;if(cells[index]!==f.find)return{findReplace:{}};cells[index]=f.replacement;return{findReplace:{valuesChanged:1,occurrencesChanged:1}}});
  if(mode==='unknown')throw Error('UNKNOWN');return{replies};
 };
 return{env,sql,setMode(x){mode=x},get cells(){return cells},get requests(){return requests},get dispatches(){return dispatches},close(){client.getSheetGridInfo=old.grid;client.batchUpdateSpreadsheetWithReply=old.update;notice.stableNoticeStyleFingerprint=old.style;claim.stableWorkbookClaimOwned=old.owned;sql.close()}};
}
test('release journals intent, uses exact-cell CAS and verifies status and style',async()=>{const h=fixture();try{
 await releaseContinuousCutoverNotice(h.env,'claim');assert.equal(h.sql.prepare('SELECT state FROM continuous_cutover_notice_release').get().state,'VERIFIED');assert.equal(h.cells[0],'พร้อมแก้ไข');assert.equal(h.dispatches,1);
 assert.deepEqual(h.requests.map(r=>[r.findReplace.range.startColumnIndex,r.findReplace.matchEntireCell,r.findReplace.searchByRegex,r.findReplace.includeFormulas]),[[1,true,false,false],[2,true,false,false]]);
}finally{h.close()}});
test('a human cell edit after precheck is never overwritten; partial response remains in flight',async()=>{const h=fixture();try{
 h.setMode('human');await assert.rejects(()=>releaseContinuousCutoverNotice(h.env,'claim'),/PARTIAL_OR_UNKNOWN/);assert.equal(h.cells[0],'human edit');assert.equal(h.sql.prepare('SELECT state FROM continuous_cutover_notice_release').get().state,'IN_FLIGHT');
 await assert.rejects(()=>releaseContinuousCutoverNotice(h.env,'claim'));assert.equal(h.dispatches,1);
}finally{h.close()}});
test('lost acknowledgement remains in flight and is not resent',async()=>{const h=fixture();try{
 h.setMode('unknown');await assert.rejects(()=>releaseContinuousCutoverNotice(h.env,'claim'),/UNKNOWN/);assert.equal(h.sql.prepare('SELECT state FROM continuous_cutover_notice_release').get().state,'IN_FLIGHT');
 await assert.rejects(()=>releaseContinuousCutoverNotice(h.env,'claim'));assert.equal(h.dispatches,1);
}finally{h.close()}});
