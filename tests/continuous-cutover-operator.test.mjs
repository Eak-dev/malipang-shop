import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {operateContinuousCutover}=require('../dist/admin/continuous-cutover-operator.js');
const notice=require('../dist/sheets/stable-edit-notice.js');
const claim=require('../dist/sheets/stable-workbook-claim.js');
const views=require('../dist/sheets/report-view-bootstrap.js');

function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec(`CREATE TABLE stable_workbook_claims(spreadsheet_id TEXT PRIMARY KEY,operation_token TEXT,state TEXT,notice_stamp TEXT,notice_identity TEXT,created_at TEXT,updated_at TEXT,phase TEXT,review_reason TEXT);
 CREATE TABLE stable_recovery_epochs(epoch_id TEXT,spreadsheet_id TEXT,state TEXT);CREATE TABLE stable_recovery_operations(epoch_id TEXT,state TEXT,operation_token TEXT);CREATE TABLE stable_projection_writes(spreadsheet_id TEXT,state TEXT,operation_token TEXT);CREATE TABLE stable_expense_cancellation_writes(spreadsheet_id TEXT,state TEXT,operation_token TEXT);
 CREATE TRIGGER stable_projection_no_delete BEFORE DELETE ON stable_projection_writes BEGIN SELECT RAISE(ABORT,'retained'); END;
 CREATE TRIGGER stable_projection_no_replace BEFORE INSERT ON stable_projection_writes WHEN 0 BEGIN SELECT RAISE(ABORT,'retained'); END;
 CREATE TRIGGER stable_projection_transition BEFORE UPDATE ON stable_projection_writes BEGIN SELECT RAISE(ABORT,'retained'); END;
 CREATE TABLE sync_jobs(status TEXT);CREATE TABLE staff_config_sync_outbox(status TEXT);CREATE TABLE continuous_report_cutover_attempts(spreadsheet_id TEXT,stage TEXT,state TEXT,manifest_json TEXT,manifest_digest TEXT,cell_count INTEGER);CREATE TABLE continuous_daily_cutovers(spreadsheet_id TEXT,state TEXT,claim_token TEXT);CREATE TABLE stable_source_revision(singleton INTEGER,revision INTEGER);INSERT INTO stable_source_revision VALUES(1,0);`);
 sql.exec(fs.readFileSync(new URL('../migrations/0031_continuous_cutover_operator.sql',import.meta.url),'utf8'));
 const DB={prepare(text){const st=sql.prepare(text);let args=[];return{bind(...v){args=v;return this},async run(){const r=st.run(...args);return{success:true,meta:{changes:Number(r.changes)}}},async first(){return st.get(...args)??null},async all(){return{success:true,results:st.all(...args)}},_st:st,_args:()=>args}},async batch(statements){sql.exec('BEGIN');try{const out=[];for(const s of statements){if(s._st.columns().length){s._st.all(...s._args());out.push({success:true});}else{const r=s._st.run(...s._args());out.push({success:true,meta:{changes:Number(r.changes)}})}}sql.exec('COMMIT');return out}catch(e){sql.exec('ROLLBACK');throw e}}};
 const env={DB,GOOGLE_SPREADSHEET_ID:'book',STABLE_PHASE1_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',CONTINUOUS_REPORT_CUTOVER_ENABLED:'true',CONTINUOUS_CUTOVER_OPERATOR_ENABLED:'true',CONTINUOUS_DAILY_ENABLED:'false'};
 const old={begin:notice.beginStableNotice,paused:notice.stableNoticePaused,owned:claim.stableWorkbookClaimOwned,bootstrap:views.bootstrapContinuousReportViews};let bootstrapCalls=0;
 notice.beginStableNotice=async(_env,token)=>{sql.prepare("UPDATE stable_workbook_claims SET notice_stamp='stamp',notice_identity='identity' WHERE operation_token=?").run(token)};
 notice.stableNoticePaused=async(_env,stamp,identity)=>stamp==='stamp'&&identity==='identity';
 claim.stableWorkbookClaimOwned=async(_env,token)=>!!sql.prepare("SELECT 1 FROM stable_workbook_claims WHERE operation_token=? AND state='HELD' AND notice_stamp IS NOT NULL").get(token);
 views.bootstrapContinuousReportViews=async()=>{bootstrapCalls++;throw Error('GOOGLE_OUTCOME_UNKNOWN')};
 return{env,sql,get bootstrapCalls(){return bootstrapCalls},close(){notice.beginStableNotice=old.begin;notice.stableNoticePaused=old.paused;claim.stableWorkbookClaimOwned=old.owned;views.bootstrapContinuousReportViews=old.bootstrap;sql.close()}};
}
test('operator defaults disabled and rejects invalid actions before mutation',async()=>{const h=fixture();try{
 h.env.CONTINUOUS_CUTOVER_OPERATOR_ENABLED='false';await assert.rejects(()=>operateContinuousCutover(h.env,'START'),/DISABLED/);
 h.env.CONTINUOUS_CUTOVER_OPERATOR_ENABLED='true';await assert.rejects(()=>operateContinuousCutover(h.env,'unknown'),/DISABLED/);
 assert.equal(h.sql.prepare('SELECT count(*) AS n FROM stable_workbook_claims').get().n,0);
}finally{h.close()}});
test('existing REVIEW cannot be adopted, released or changed by START',async()=>{const h=fixture();try{
 h.sql.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state) VALUES('book','original','REVIEW')");
 await assert.rejects(()=>operateContinuousCutover(h.env,'START'));
 assert.deepEqual({...h.sql.prepare('SELECT operation_token,state FROM stable_workbook_claims').get()},{operation_token:'original',state:'REVIEW'});
 assert.equal(h.sql.prepare('SELECT count(*) AS n FROM continuous_cutover_operator').get().n,0);
}finally{h.close()}});
test('unknown provider write retains REVIEW and cannot be automatically retried',async()=>{const h=fixture();try{
 assert.deepEqual(await operateContinuousCutover(h.env,'START'),{action:'START',ok:true});
 await assert.rejects(()=>operateContinuousCutover(h.env,'VIEWS'),/GOOGLE_OUTCOME_UNKNOWN/);
 assert.equal(h.sql.prepare('SELECT state FROM continuous_cutover_operator').get().state,'REVIEW');
 assert.equal(h.sql.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 await assert.rejects(()=>operateContinuousCutover(h.env,'VIEWS'),/NOT_HELD/);assert.equal(h.bootstrapCalls,1);
}finally{h.close()}});
test('active recovery epoch or worker lease prevents start',async()=>{for(const command of ["INSERT INTO stable_recovery_epochs VALUES('epoch','book','ARMED')","INSERT INTO sync_jobs VALUES('PROCESSING')","INSERT INTO staff_config_sync_outbox VALUES('PROCESSING')"]){const h=fixture();try{
 h.sql.exec(command);await assert.rejects(()=>operateContinuousCutover(h.env,'START'));
 assert.equal(h.sql.prepare('SELECT count(*) AS n FROM stable_workbook_claims').get().n,0);
}finally{h.close()}}});
test('out-of-order phase is rejected without changing the held claim',async()=>{const h=fixture();try{
 await operateContinuousCutover(h.env,'START');await assert.rejects(()=>operateContinuousCutover(h.env,'REPORTS'),/STAGE_NOT_READY/);
 assert.equal(h.sql.prepare('SELECT state FROM continuous_cutover_operator').get().state,'HELD');assert.equal(h.sql.prepare('SELECT state FROM stable_workbook_claims').get().state,'HELD');
}finally{h.close()}});
async function reviewFixture(h){
 h.sql.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,notice_stamp,notice_identity,created_at,phase,review_reason) VALUES('book','original','REVIEW','stamp','identity','created','OPERATION','STABLE_DAILY_REVIEW')");
 const data=JSON.stringify(['book','original','stamp','identity','created','OPERATION','STABLE_DAILY_REVIEW']);
 h.env.CONTINUOUS_CUTOVER_PREWRITE_REVIEW_ENABLED='true';h.env.CONTINUOUS_CUTOVER_REVIEW_FINGERPRINT=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data))).toString('hex');
}
test('only an exact pinned prewrite REVIEW is adopted and recorded',async()=>{const h=fixture();try{
 await reviewFixture(h);assert.deepEqual(await operateContinuousCutover(h.env,'START_REVIEW'),{action:'START_REVIEW',ok:true});
 assert.deepEqual({...h.sql.prepare('SELECT origin,state,original_fingerprint FROM continuous_cutover_operator').get()},{origin:'PREWRITE_REVIEW',state:'HELD',original_fingerprint:h.env.CONTINUOUS_CUTOVER_REVIEW_FINGERPRINT});
 assert.equal(h.sql.prepare('SELECT state FROM stable_workbook_claims').get().state,'HELD');
}finally{h.close()}});
test('pin drift, projection evidence, wrong phase or missing journal trigger leaves original REVIEW unchanged',async()=>{for(const variant of ['pin','projection','phase','trigger']){const h=fixture();try{
 await reviewFixture(h);if(variant==='pin')h.env.CONTINUOUS_CUTOVER_REVIEW_FINGERPRINT='0'.repeat(64);if(variant==='projection')h.sql.exec("INSERT INTO stable_projection_writes VALUES('book','VERIFIED','original')");if(variant==='phase')h.sql.exec("UPDATE stable_workbook_claims SET phase='BEGIN_NOTICE'");if(variant==='trigger')h.sql.exec('DROP TRIGGER stable_projection_no_delete');
 await assert.rejects(()=>operateContinuousCutover(h.env,'START_REVIEW'));assert.equal(h.sql.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');assert.equal(h.sql.prepare('SELECT count(*) n FROM continuous_cutover_operator').get().n,0);
}finally{h.close()}}});
test('operator stages connect through activation and gated release with exact transient receipt IDs',async()=>{const h=fixture();
 const ctrl=require('../dist/sheets/report-cutover-controller.js'),cutover=require('../dist/sheets/continuous-daily-cutover.js'),client=require('../dist/sheets/client.js'),noticeRelease=require('../dist/admin/continuous-cutover-notice.js');
 const old={stage:ctrl.runContinuousReportCutoverStage,capture:ctrl.captureContinuousReportInputs,cutover:cutover.continuousDailyCutoverStatements,properties:client.getSpreadsheetSheetProperties,read:client.batchGetSheetFormulaValues,release:noticeRelease.releaseContinuousCutoverNotice};
 try{
  Object.assign(h.env,{SHEET_EXPENSE_DAILY:'old',CONTINUOUS_DAILY_SHEET:'new',CONTINUOUS_DAILY_SHEET_ID:'2',CONTINUOUS_RAW_SHEET:'raw_new',CONTINUOUS_RAW_SHEET_ID:'3',CONTINUOUS_DETAIL_SHEET:'detail_new',CONTINUOUS_DETAIL_SHEET_ID:'4'});
  const sha=async text=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))).toString('hex');
  const reportFormula='=SUM(A1:A2)',entry={sheetId:5,sheetName:'report',row:1,column:1,after:await sha(reportFormula)},manifest=JSON.stringify([entry]),digest=await sha(manifest);
  const insertStage=stage=>h.sql.prepare("INSERT INTO continuous_report_cutover_attempts VALUES('book',?,'VERIFIED',?,?,1)").run(stage,manifest,digest);
  views.bootstrapContinuousReportViews=async()=>{insertStage('VIEWS');return{stage:'VIEWS',verifiedSheets:4}};
  ctrl.runContinuousReportCutoverStage=async(_env,_token,stage)=>{insertStage(stage);return{stage,verifiedCells:1}};
  ctrl.captureContinuousReportInputs=async()=>({stage:'REPORTS'});
  client.getSpreadsheetSheetProperties=async()=>[{sheetId:1,title:'old',rowCount:1000,columnCount:29},{sheetId:2,title:'new',rowCount:1000,columnCount:29},{sheetId:3,title:'raw_new',rowCount:1000,columnCount:26},{sheetId:4,title:'detail_new',rowCount:1000,columnCount:26},{sheetId:5,title:'report',rowCount:5,columnCount:5}];
  client.batchGetSheetFormulaValues=async(_env,ranges)=>ranges.map(()=>[[reportFormula]]);
  let received;
  cutover.continuousDailyCutoverStatements=(env,input)=>{received=input.mustBeCancelledOrAbsentExpenseIds;return[env.DB.prepare("INSERT INTO continuous_daily_cutovers VALUES(?,'ACTIVE',?)").bind(input.book,input.claim)]};
  noticeRelease.releaseContinuousCutoverNotice=async(env,token)=>{
   await env.DB.prepare("INSERT INTO continuous_cutover_notice_release(spreadsheet_id,operation_token,sheet_id,paused_stamp,ready_stamp,ready_status,style_digest,state,created_at) VALUES('book',?,1,'stamp','ready','พร้อมแก้ไข',?,'IN_FLIGHT','now')").bind(token,'a'.repeat(64)).run();
   await env.DB.prepare("UPDATE continuous_cutover_notice_release SET state='VERIFIED',verified_at='now'").run();
  };
  for(const action of ['START','VIEWS','DAILY_J','REPORTS'])assert.equal((await operateContinuousCutover(h.env,action)).ok,true);
  await assert.rejects(()=>operateContinuousCutover(h.env,'ACTIVATE',['invalid']),/RECEIPTS_INVALID/);
  assert.equal((await operateContinuousCutover(h.env,'ACTIVATE',['exp_first','exp_second'])).ok,true);assert.deepEqual(received,['exp_first','exp_second']);
  assert.equal((await operateContinuousCutover(h.env,'RELEASE')).ok,true);
  assert.equal(h.sql.prepare('SELECT state FROM continuous_cutover_operator').get().state,'COMPLETE');assert.equal(h.sql.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);assert.equal(h.env.STABLE_RECOVERY_GATE_ENABLED,'true');
 }finally{ctrl.runContinuousReportCutoverStage=old.stage;ctrl.captureContinuousReportInputs=old.capture;cutover.continuousDailyCutoverStatements=old.cutover;client.getSpreadsheetSheetProperties=old.properties;client.batchGetSheetFormulaValues=old.read;noticeRelease.releaseContinuousCutoverNotice=old.release;h.close()}
});
