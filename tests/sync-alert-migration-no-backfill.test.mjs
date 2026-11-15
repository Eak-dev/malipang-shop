import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {sweepSyncFailureAlerts}=require('../dist/line/sync-failure-alerts.js');
const migration=readFileSync(new URL('../migrations/0025_sync_alert_incidents.sql',import.meta.url),'utf8');

test('migration does not alert historical failures but new failures generate one alert',async()=>{
 const sqlite=new DatabaseSync(':memory:');
 try{
  sqlite.exec(`
   CREATE TABLE sync_jobs(job_id TEXT PRIMARY KEY,entity_type TEXT,entity_key TEXT,entity_version INTEGER,status TEXT,last_error TEXT);
   CREATE TABLE expense_events(expense_id TEXT PRIMARY KEY,description TEXT,amount_satang INTEGER);
   CREATE TABLE stable_workbook_claims(spreadsheet_id TEXT,state TEXT,review_reason TEXT);
   CREATE TABLE failed_jobs(id TEXT PRIMARY KEY,queue_name TEXT,trace_id TEXT,job_key TEXT,payload_json TEXT,error TEXT,status TEXT,attempt_count INTEGER,created_at TEXT,updated_at TEXT,resolved_at TEXT,UNIQUE(queue_name,trace_id,job_key));
   INSERT INTO sync_jobs VALUES('historical-job','ATTENDANCE_EVENT','old-attendance',1,'REVIEW','old failure');
   INSERT INTO stable_workbook_claims VALUES('old-book','REVIEW','old claim');
   INSERT INTO failed_jobs VALUES('historical-dlq','malipang-jobs','old-trace','old-key','{"kind":"SHEETS_SYNC"}','DEAD_LETTER_MAX_RETRIES','OPEN',1,'old','old',NULL);
  `);
  sqlite.exec(migration);sqlite.exec(migration);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM sync_alert_incidents').get().n,0);
  const DB={prepare(sql){const stmt=sqlite.prepare(sql);let args=[];return{bind(...a){args=a;return this},async first(){return stmt.get(...args)??null},async all(){return{success:true,results:stmt.all(...args)}},async run(){return{success:true,meta:{changes:Number(stmt.run(...args).changes)}}}}},async batch(stmts){sqlite.exec('BEGIN');try{const results=[];for(const s of stmts)results.push(await s.run());sqlite.exec('COMMIT');return results}catch(e){sqlite.exec('ROLLBACK');throw e}}};
  const queued=[],env={DB,RUNTIME_MODE:'production',LINE_OWNER_USER_ID:'synthetic-owner',JOB_QUEUE:{async send(job){queued.push(job)}}};
  assert.equal(await sweepSyncFailureAlerts(env),0);assert.equal(queued.length,0);
  sqlite.exec("INSERT INTO sync_jobs VALUES('new-job','ATTENDANCE_EVENT','new-attendance',1,'FAILED','new failure')");
  assert.equal(await sweepSyncFailureAlerts(env),1);assert.equal(await sweepSyncFailureAlerts(env),0);assert.equal(queued.length,1);
  assert.equal(queued[0].kind,'LINE_NOTIFICATION');
  assert.deepEqual(sqlite.prepare('SELECT source_id,state,alerted_at IS NOT NULL AS alerted FROM sync_alert_incidents').all().map(r=>({...r})),[{source_id:'new-job',state:'OPEN',alerted:1}]);
  assert.equal(sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='historical-job'").get().status,'REVIEW');
  assert.equal(sqlite.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='old-book'").get().state,'REVIEW');
  assert.equal(sqlite.prepare("SELECT status FROM failed_jobs WHERE id='historical-dlq'").get().status,'OPEN');
 }finally{sqlite.close();}
});
