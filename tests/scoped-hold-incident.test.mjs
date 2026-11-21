import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),notice=require('../dist/sheets/stable-edit-notice.js'),reports=require('../dist/sheets/continuous-report-health.js');
const {stepScopedHoldIncident}=require('../dist/admin/scoped-hold-incident.js');
const pin=createHash('sha256').update('claim\njob').digest('hex');
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(`
 CREATE TABLE expense_events(expense_id TEXT,status TEXT,version INTEGER);
 CREATE TABLE sync_jobs(job_id TEXT,entity_type TEXT,entity_key TEXT,entity_version INTEGER,status TEXT,last_error TEXT,attempt_count INTEGER,lease_token TEXT,lease_until TEXT,updated_at TEXT);
 CREATE TABLE sync_alert_incidents(kind TEXT,source_id TEXT,state TEXT);
 CREATE TABLE stable_workbook_claims(spreadsheet_id TEXT,operation_token TEXT,state TEXT,phase TEXT,review_reason TEXT,notice_stamp TEXT,notice_identity TEXT,created_at TEXT,updated_at TEXT);
 CREATE TABLE stable_recovery_epochs(state TEXT); CREATE TABLE stable_source_revision(singleton INTEGER,revision INTEGER);
 CREATE TABLE stable_projection_writes(entity_type TEXT,entity_id TEXT,state TEXT); CREATE TABLE stable_expense_cancellation_writes(entity_type TEXT,entity_id TEXT,state TEXT);
 CREATE TABLE sheet_row_index(entity_key TEXT); CREATE TABLE staff_config_sync_outbox(status TEXT); CREATE TABLE failed_jobs(queue_name TEXT,job_key TEXT,status TEXT,error TEXT);`);
 sqlite.exec(readFileSync(new URL('../migrations/0066_scoped_hold_incident.sql',import.meta.url),'utf8'));
 sqlite.exec("INSERT INTO expense_events VALUES('expense','CANCELLED',2); INSERT INTO sync_jobs VALUES('job','EXPENSE','expense',1,'REVIEW','STABLE_EXPENSE_CANCELLED_OR_SUPERSEDED',1,NULL,NULL,'2026-11-21T09:10:55.253Z'); INSERT INTO sync_jobs VALUES('undo','EXPENSE','expense',2,'PENDING',NULL,0,NULL,NULL,'2026-11-21T09:00:00.000Z'); INSERT INTO sync_alert_incidents VALUES('JOB','job','OPEN'); INSERT INTO stable_workbook_claims VALUES('book','claim','REVIEW','OPERATION','STABLE_EXPENSE_SOURCE_UNVERIFIED','old','notice','2026-11-21T09:10:36.195Z','2026-11-21T09:10:55.436Z'); INSERT INTO sync_alert_incidents VALUES('WORKBOOK','1','OPEN'); CREATE TRIGGER fixture_claim_release AFTER DELETE ON stable_workbook_claims BEGIN UPDATE sync_alert_incidents SET state='CLOSED' WHERE kind='WORKBOOK' AND source_id=CAST(OLD.rowid AS TEXT) AND state='OPEN'; END; INSERT INTO stable_source_revision VALUES(1,3)");
 class Statement{constructor(sql){this.sql=sql;this.args=[]}bind(...args){this.args=args;return this}async first(){return sqlite.prepare(this.sql).get(...this.args)??null}async all(){return{success:true,results:sqlite.prepare(this.sql).all(...this.args)}}runSync(){const s=sqlite.prepare(this.sql);if(/^\s*SELECT\b/i.test(this.sql))return{success:true,results:s.all(...this.args),meta:{changes:0}};const n=Number(s.run(...this.args).changes);return{success:true,meta:{changes:n===1&&this.sql.startsWith('DELETE FROM stable_workbook_claims')?2:n}}}async run(){return this.runSync()}}
 const DB={prepare:sql=>new Statement(sql),async batch(stmts){sqlite.exec('BEGIN');try{const results=stmts.map(x=>x.runSync());sqlite.exec('COMMIT');return results}catch(error){sqlite.exec('ROLLBACK');throw error}}};
 const env={DB,GOOGLE_SPREADSHEET_ID:'book',STABLE_PHASE1_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true',CONTINUOUS_DAILY_ENABLED:'true',CONTINUOUS_CANARY_OPERATOR_ENABLED:'false',CANARY_UNWRITTEN_RECOVERY_ENABLED:'false'},old={report:reports.readContinuousReportHealth,style:notice.stableNoticeStyleFingerprint,write:client.batchUpdateSpreadsheetWithReply};
 let status='พักแก้ไฟล์',stamp='old',writes=0,mode='ok',health=true;
 reports.readContinuousReportHealth=async()=>health?'OK':'CAPACITY';
 notice.stableNoticeStyleFingerprint=async(_env,id,s,t)=>id==='notice'&&s===status&&t===stamp?'f'.repeat(64):null;
 client.batchUpdateSpreadsheetWithReply=async(_env,requests,before)=>{await before();const f=requests[0].findReplace,key=f.range.startColumnIndex===2?'stamp':'status';if((key==='stamp'?stamp:status)!==f.find)return{replies:[{findReplace:{}}]};if(key==='stamp')stamp=f.replacement;else status=f.replacement;writes++;if(mode===key+'-lost')throw Error('lost');return{replies:[{findReplace:{valuesChanged:1,occurrencesChanged:1}}]};};
 return {sqlite,env,setMode:v=>{mode=v},setHealth:v=>{health=v},writes:()=>writes,close(){reports.readContinuousReportHealth=old.report;notice.stableNoticeStyleFingerprint=old.style;client.batchUpdateSpreadsheetWithReply=old.write;sqlite.close()}};
}
test('incident closes the single held claim only after positive proofs, preserving both jobs',async()=>{const h=fixture();try{
 assert.equal(await stepScopedHoldIncident(h.env,'PROBE',pin),'READY');assert.equal(await stepScopedHoldIncident(h.env,'TIME',pin),'IN_PROGRESS');assert.equal(await stepScopedHoldIncident(h.env,'PROBE_STATUS',pin),'READY');assert.equal(await stepScopedHoldIncident(h.env,'STATUS',pin),'IN_PROGRESS');assert.equal(await stepScopedHoldIncident(h.env,'COMMIT',pin),'COMPLETE');
 assert.equal(h.writes(),2);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);assert.deepEqual(h.sqlite.prepare('SELECT status FROM sync_jobs ORDER BY entity_version').all().map(x=>x.status),['REVIEW','PENDING']);assert.equal(h.sqlite.prepare('SELECT state FROM scoped_hold_incident_recovery').get().state,'COMPLETE');assert.equal(h.sqlite.prepare("SELECT state FROM sync_alert_incidents WHERE kind='WORKBOOK'").get().state,'CLOSED');assert.equal(h.sqlite.prepare("SELECT state FROM sync_alert_incidents WHERE kind='JOB'").get().state,'OPEN');
}finally{h.close()}});
test('lost provider acknowledgment keeps the claim and cannot repeat the notice write',async()=>{for(const mode of ['stamp-lost','status-lost']){const h=fixture();try{
 if(mode==='status-lost')assert.equal(await stepScopedHoldIncident(h.env,'TIME',pin),'IN_PROGRESS');h.setMode(mode);const phase=mode==='stamp-lost'?'TIME':'STATUS';assert.equal(await stepScopedHoldIncident(h.env,phase,pin),'HELD');const before=h.writes();assert.equal(await stepScopedHoldIncident(h.env,phase,pin),'HELD');assert.equal(h.writes(),before);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
}finally{h.close()}}});
test('different identity, broken report, source drift or journal evidence never releases the claim',async()=>{for(const mutation of ["UPDATE expense_events SET status='CONFIRMED'", "INSERT INTO stable_projection_writes VALUES('EXPENSE','expense','VERIFIED')", "UPDATE sync_jobs SET attempt_count=2 WHERE job_id='job'", "UPDATE stable_workbook_claims SET review_reason='OTHER'", "INSERT INTO stable_recovery_epochs VALUES('ARMED')"]){const h=fixture();try{h.sqlite.exec(mutation);assert.equal(await stepScopedHoldIncident(h.env,'PROBE',pin),'HELD');assert.equal(h.writes(),0)}finally{h.close()}}
 const h=fixture();try{assert.equal(await stepScopedHoldIncident(h.env,'PROBE','a'.repeat(64)),'HELD');h.setHealth(false);assert.equal(await stepScopedHoldIncident(h.env,'TIME',pin),'HELD');h.setHealth(true);assert.equal(await stepScopedHoldIncident(h.env,'TIME',pin),'IN_PROGRESS');h.sqlite.exec('UPDATE stable_source_revision SET revision=4');assert.equal(await stepScopedHoldIncident(h.env,'STATUS',pin),'HELD');assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW')}finally{h.close()}
});
