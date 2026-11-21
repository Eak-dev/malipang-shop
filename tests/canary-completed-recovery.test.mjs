import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),notice=require('../dist/sheets/stable-edit-notice.js'),canary=require('../dist/admin/continuous-canary-operator.js');
const {stepCompletedCanaryRecovery}=require('../dist/admin/canary-completed-recovery.js');
const expense='exp_canary_'+'a'.repeat(32),trace='trace_canary_'+'b'.repeat(32);
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE continuous_canary_operator(spreadsheet_id TEXT,expense_id TEXT,item_id TEXT,trace_id TEXT,line_user_id TEXT,state TEXT,duplicate_epoch_id TEXT);
 CREATE TABLE expense_events(expense_id TEXT,status TEXT,version INTEGER,description TEXT,amount_satang INTEGER,trace_id TEXT,line_user_id TEXT);
 CREATE TABLE sync_jobs(job_id TEXT,entity_type TEXT,entity_key TEXT,entity_version INTEGER,status TEXT,lease_token TEXT,lease_until TEXT,updated_at TEXT);
 CREATE TABLE sync_alert_incidents(kind TEXT,source_id TEXT,state TEXT,closed_at TEXT);
 CREATE TABLE stable_workbook_claims(spreadsheet_id TEXT,operation_token TEXT,state TEXT,phase TEXT,review_reason TEXT,notice_stamp TEXT,notice_identity TEXT);
 CREATE TABLE stable_recovery_epochs(epoch_id TEXT PRIMARY KEY,spreadsheet_id TEXT,state TEXT,target_type TEXT,target_key TEXT,target_version INTEGER,updated_at TEXT);
 CREATE TABLE stable_recovery_operations(epoch_id TEXT,operation_token TEXT,state TEXT,verified_at TEXT);
 CREATE TABLE stable_source_revision(singleton INTEGER,revision INTEGER);
 CREATE TABLE stable_projection_writes(spreadsheet_id TEXT,entity_type TEXT,entity_id TEXT,projection TEXT,source_version INTEGER,state TEXT,sheet_id INTEGER,sheet_name TEXT,source_digest TEXT,operation_token TEXT);
 CREATE TABLE stable_expense_projection_preimages(spreadsheet_id TEXT,entity_type TEXT,entity_id TEXT,projection TEXT,sheet_id INTEGER,sheet_name TEXT,source_version INTEGER,source_digest TEXT);
 CREATE TABLE atomic_daily_marker_reservations(spreadsheet_id TEXT,sheet_id INTEGER,entity_id TEXT,source_version INTEGER,operation_token TEXT);
 CREATE TABLE stable_expense_cancellation_writes(entity_type TEXT,entity_id TEXT,state TEXT);
 CREATE TABLE staff_config_sync_outbox(status TEXT);
 CREATE TABLE failed_jobs(queue_name TEXT,job_key TEXT,status TEXT,error TEXT);`);
 sqlite.exec(readFileSync(new URL('../migrations/0065_canary_completed_recovery.sql',import.meta.url),'utf8'));
 sqlite.prepare("INSERT INTO continuous_canary_operator VALUES('book',?,'item',?,'synthetic','ARMED_CONFIRM',NULL)").run(expense,trace);
 sqlite.prepare("INSERT INTO expense_events VALUES(?,'CONFIRMED',1,'[SYSTEM TEST] Synthetic expense - cancel after verification',100,?,'synthetic')").run(expense,trace);
 sqlite.prepare("INSERT INTO sync_jobs VALUES('job','EXPENSE',?,1,'COMPLETED',NULL,NULL,'done')").run(expense);
 sqlite.exec("INSERT INTO sync_alert_incidents VALUES('JOB','job','CLOSED','done');INSERT INTO stable_workbook_claims VALUES('book','claim','REVIEW','OPERATION','STABLE_EXPENSE_COMPLETION_UNCERTAIN','old','notice');INSERT INTO stable_source_revision VALUES(1,3)");
 sqlite.prepare("INSERT INTO stable_recovery_epochs VALUES('epoch','book','ARMED','EXPENSE',?,1,'old')").run(expense);sqlite.exec("INSERT INTO stable_recovery_operations VALUES('epoch','claim','ADMITTED',NULL)");
 for(const [projection,id,sheet] of [['DAILY',expense,1],['EXPENSE_RAW',expense,2],['DETAIL',expense+'|item',3]]){
  sqlite.prepare("INSERT INTO stable_projection_writes VALUES('book','EXPENSE',?,?,1,'VERIFIED',?,'sheet','digest','token')").run(id,projection,sheet);
  sqlite.prepare("INSERT INTO stable_expense_projection_preimages VALUES('book','EXPENSE',?,?,?,'sheet',1,'digest')").run(id,projection,sheet);
  sqlite.prepare("INSERT INTO atomic_daily_marker_reservations VALUES('book',?,?,1,'token')").run(sheet,id);
 }
 class Statement{constructor(sql){this.sql=sql;this.args=[]}bind(...args){this.args=args;return this}async first(){return sqlite.prepare(this.sql).get(...this.args)??null}async all(){return{success:true,results:sqlite.prepare(this.sql).all(...this.args)}}runSync(){const s=sqlite.prepare(this.sql);return /^\s*SELECT\b/i.test(this.sql)?{success:true,results:s.all(...this.args),meta:{changes:0}}:{success:true,meta:{changes:Number(s.run(...this.args).changes)}}}async run(){return this.runSync()}}
 const DB={prepare:sql=>new Statement(sql),async batch(stmts){sqlite.exec('BEGIN');try{const results=stmts.map(x=>x.runSync());sqlite.exec('COMMIT');return results}catch(error){sqlite.exec('ROLLBACK');throw error}}};
 const env={DB,GOOGLE_SPREADSHEET_ID:'book',CANARY_UNWRITTEN_RECOVERY_ENABLED:'true',CONTINUOUS_CANARY_OPERATOR_ENABLED:'true'},old={proof:canary.verifyCompletedCanaryProvider,style:notice.stableNoticeStyleFingerprint,write:client.batchUpdateSpreadsheetWithReply};
 let status='พักแก้ไฟล์',stamp='old',writes=0,mode='ok',proof=true;
 canary.verifyCompletedCanaryProvider=async(_env,id)=>proof&&id===expense;
 notice.stableNoticeStyleFingerprint=async(_env,id,s,t)=>id==='notice'&&s===status&&t===stamp?'f'.repeat(64):null;
 client.batchUpdateSpreadsheetWithReply=async(_env,requests,before)=>{await before();const f=requests[0].findReplace,key=f.range.startColumnIndex===2?'stamp':'status';if((key==='stamp'?stamp:status)!==f.find)return{replies:[{findReplace:{}}]};if(key==='stamp')stamp=f.replacement;else status=f.replacement;writes++;if(mode===key+'-lost')throw Error('lost');return{replies:[{findReplace:{valuesChanged:1,occurrencesChanged:1}}]};};
 return {sqlite,env,setMode:v=>{mode=v},setProof:v=>{proof=v},writes:()=>writes,close(){canary.verifyCompletedCanaryProvider=old.proof;notice.stableNoticeStyleFingerprint=old.style;client.batchUpdateSpreadsheetWithReply=old.write;sqlite.close()}};
}

test('completed Canary closes only after positive provider and notice proofs',async()=>{const h=fixture();try{
 assert.equal(await stepCompletedCanaryRecovery(h.env,'PROBE'),'READY');assert.equal(await stepCompletedCanaryRecovery(h.env,'TIME'),'IN_PROGRESS');assert.equal(await stepCompletedCanaryRecovery(h.env,'PROBE_STATUS'),'READY');assert.equal(await stepCompletedCanaryRecovery(h.env,'STATUS'),'IN_PROGRESS');assert.equal(await stepCompletedCanaryRecovery(h.env,'COMMIT'),'COMPLETE');
 assert.equal(h.writes(),2);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);assert.equal(h.sqlite.prepare('SELECT state FROM stable_recovery_epochs').get().state,'COMPLETE');assert.equal(h.sqlite.prepare('SELECT state FROM stable_recovery_operations').get().state,'VERIFIED');assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'COMPLETED');
 }finally{h.close()}});
test('lost provider acknowledgment retains the exact fence and never repeats the write',async()=>{for(const mode of ['stamp-lost','status-lost']){const h=fixture();try{
 if(mode==='status-lost')assert.equal(await stepCompletedCanaryRecovery(h.env,'TIME'),'IN_PROGRESS');h.setMode(mode);const phase=mode==='stamp-lost'?'TIME':'STATUS';assert.equal(await stepCompletedCanaryRecovery(h.env,phase),'HELD');const before=h.writes();assert.equal(await stepCompletedCanaryRecovery(h.env,phase),'HELD');assert.equal(h.writes(),before);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 }finally{h.close()}}});
test('proof failure, source drift, or changed review state cannot release the claim',async()=>{const h=fixture();try{
 h.setProof(false);assert.equal(await stepCompletedCanaryRecovery(h.env,'TIME'),'HELD');assert.equal(h.writes(),0);h.setProof(true);assert.equal(await stepCompletedCanaryRecovery(h.env,'TIME'),'IN_PROGRESS');h.sqlite.exec('UPDATE stable_source_revision SET revision=4');assert.equal(await stepCompletedCanaryRecovery(h.env,'STATUS'),'HELD');assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 }finally{h.close()}});
