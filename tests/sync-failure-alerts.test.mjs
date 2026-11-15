import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url);
const {sweepSyncFailureAlerts,wakeSyncFailureAlerts}=require('../dist/line/sync-failure-alerts.js');
const {recoverPendingLineNotifications,processLineNotificationMessage}=require('../dist/line/attendance-notification.js');
const worker=require('../dist/index.js').default;

function fixture(){
 const h=expenseSqlite(),sent=[];
 Object.assign(h.env,{RUNTIME_MODE:'production',LINE_OWNER_USER_ID:'fixture-owner',GOOGLE_SPREADSHEET_ID:'book',JOB_QUEUE:{async send(job){sent.push(job);}}});
 const addReview=(id,reason='STABLE_DAILY_MONTH_OPENING_UNVERIFIED',status='REVIEW')=>{
  h.sqlite.prepare("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES(?,?,?,'Synthetic store',159725,'transfer','SHOP_BANK','ingredients','2026-11-04','CONFIRMED','now',1)").run('exp_'+id,'msg_'+id,'user');
  h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,last_error) VALUES(?,'EXPENSE',?,1,'fixture',?,'2026-11-15T00:00:00.000Z',?)").run(id,'exp_'+id,status,reason);
 };
 return{...h,sent,addReview};
}

test('durable review alert is sent once and never changes source jobs or business records',async()=>{const h=fixture();try{
 h.addReview('job1');assert.equal(await sweepSyncFailureAlerts(h.env),1);assert.equal(await sweepSyncFailureAlerts(h.env),0);assert.equal(h.sent.length,1);
 assert.equal(h.sent[0].kind,'LINE_NOTIFICATION');assert.equal(h.sent[0].purpose,'SYNC_FAILURE');assert.match(h.sent[0].messages[0].text,/ยอดตั้งต้น/);assert.match(h.sent[0].messages[0].text,/1,?597\.25/);
 assert.equal(h.sqlite.prepare("SELECT status FROM expense_events WHERE expense_id='exp_job1'").get().status,'CONFIRMED');
 assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job1'").get().status,'REVIEW');
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM failed_jobs WHERE job_key LIKE 'LINE_NOTIFICATION:%' AND status='OPEN'").get().n,1);
 }finally{h.close();}});

test('unknown provider error is not exposed and is described as uncertain',async()=>{const h=fixture();try{
 h.addReview('job2','private provider secret');await sweepSyncFailureAlerts(h.env);const text=h.sent[0].messages[0].text;
 assert.match(text,/ยังไม่ชัดเจน/);assert.doesNotMatch(text,/private provider secret|exp_job2/);
 }finally{h.close();}});

test('concurrent scans produce only one outbox and one queued notification',async()=>{const h=fixture();try{
 h.addReview('job3');const result=await Promise.all([sweepSyncFailureAlerts(h.env),sweepSyncFailureAlerts(h.env)]);assert.equal(result[0]+result[1],1);assert.equal(h.sent.length,1);
 }finally{h.close();}});

test('enqueue failure leaves a durable notification for existing cron recovery without retrying the source',async()=>{const h=fixture();try{
 h.addReview('job4');h.env.JOB_QUEUE.send=async()=>{throw Error('synthetic queue failure');};await sweepSyncFailureAlerts(h.env);
 assert.equal(h.sqlite.prepare("SELECT error FROM failed_jobs WHERE job_key LIKE 'LINE_NOTIFICATION:%'").get().error,'LINE_NOTIFICATION_ENQUEUE_FAILED');
 h.sqlite.exec("UPDATE failed_jobs SET updated_at='2001-01-01T00:00:00.000Z' WHERE job_key LIKE 'LINE_NOTIFICATION:%'");h.env.JOB_QUEUE.send=async job=>h.sent.push(job);
 assert.equal(await recoverPendingLineNotifications(h.env),1);assert.equal(h.sent.length,1);assert.equal(h.sent[0].kind,'LINE_NOTIFICATION');
 assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job4'").get().status,'REVIEW');
 }finally{h.close();}});

test('a failure resolved before the scan remains durable and is reported once',async()=>{const h=fixture();try{
 h.addReview('job5');h.sqlite.exec("UPDATE sync_jobs SET status='COMPLETED' WHERE job_id='job5'");
 assert.equal(await sweepSyncFailureAlerts(h.env),1);assert.equal(await sweepSyncFailureAlerts(h.env),0);assert.equal(h.sent.length,1);
 assert.equal(h.sqlite.prepare("SELECT state FROM sync_alert_incidents WHERE kind='JOB' AND source_id='job5'").get().state,'CLOSED');
 }finally{h.close();}});

test('retained workbook review and terminal sheet failure emit durable distinct alerts',async()=>{const h=fixture();try{
 h.sqlite.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','private-token','REVIEW','now','2026-11-15T00:00:00.000Z'); INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES('dead','malipang-jobs','old','EXPENSE:private:1','{\"kind\":\"SHEETS_SYNC\"}','DEAD_LETTER_MAX_RETRIES','OPEN',1,'now','now')");
 assert.equal(await sweepSyncFailureAlerts(h.env),2);assert.equal(await sweepSyncFailureAlerts(h.env),0);assert.equal(h.sent.length,2);assert.ok(h.sent.every(x=>x.purpose==='SYNC_FAILURE'));assert.doesNotMatch(JSON.stringify(h.sent),/private-token|EXPENSE:private/);
 }finally{h.close();}});

test('workbook alerts explain recognized causes and do not expose unknown error contents',async()=>{
 for(const [reason,expected] of [['SHEETS_MUTATION_OUTCOME_UNKNOWN:TIMEOUT',/ยังยืนยันผลไม่ได้/],['SHEETS_READ:HTTP_403',/สิทธิ์เข้าถึง Sheets ไม่ผ่าน/],['SHEETS_READ:HTTP_429',/จำกัดจำนวนคำขอ/],['CONTINUOUS_NOTICE_FAILURE:STOPPED:GOOGLE_OAUTH_CREDENTIAL_INVALID',/GOOGLE_OAUTH_CREDENTIAL_INVALID/],['CONTINUOUS_NOTICE_FAILURE:UNKNOWN:SHEETS_MUTATION_OUTCOME_UNKNOWN',/ผลคำสั่ง Sheets ยังไม่ชัดเจน/],['CONTINUOUS_NOTICE_OUTCOME_UNKNOWN',/ส่งคำสั่งสถานะไป Sheets แล้ว/],['CONTINUOUS_NOTICE_PROOF_UNVERIFIED',/ตรวจผลการซิงก์ใน Sheets ไม่ผ่าน/],['CONTINUOUS_NOTICE_RUNNER_STALLED',/งานตรวจสถานะซิงก์ค้าง/],['private provider token',/ยังระบุสาเหตุที่แน่ชัดไม่ได้/]]){
  const h=fixture();try{
   h.sqlite.prepare("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at,review_reason) VALUES('book','token','REVIEW','now','now',?)").run(reason);
   assert.equal(await sweepSyncFailureAlerts(h.env),1);assert.match(h.sent[0].messages[0].text,expected);
   assert.doesNotMatch(h.sent[0].messages[0].text,/private provider token/);
  }finally{h.close();}
 }
});

test('existing terminal backlog is grouped and repeated terminal updates do not spam',async()=>{const h=fixture();try{
 const insert=h.sqlite.prepare("INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES(?,'malipang-jobs',?,?,'{\"kind\":\"SHEETS_SYNC\"}','DEAD_LETTER_MAX_RETRIES','OPEN',1,'now','now')");
 for(let i=0;i<6;i++)insert.run('dead'+i,'trace'+i,'EXPENSE:fixture'+i+':1');
 assert.equal(await sweepSyncFailureAlerts(h.env),4);assert.equal(h.sent.length,1);assert.match(h.sent[0].messages[0].text,/4 งาน/);
 h.sqlite.exec("UPDATE failed_jobs SET updated_at='later' WHERE id='dead0'");
 assert.equal(await sweepSyncFailureAlerts(h.env),2);assert.equal(h.sent.length,2);assert.match(h.sent[1].messages[0].text,/2 งาน/);
 assert.equal(await sweepSyncFailureAlerts(h.env),0);assert.equal(h.sent.length,2);
 }finally{h.close();}});

test('concurrent terminal sweeps persist one grouped notification',async()=>{const h=fixture();try{
 h.sqlite.exec("INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES('dead','malipang-jobs','old','EXPENSE:private:1','{\"kind\":\"SHEETS_SYNC\"}','DEAD_LETTER_MAX_RETRIES','OPEN',1,'now','now')");
 const counts=await Promise.all([sweepSyncFailureAlerts(h.env),sweepSyncFailureAlerts(h.env)]);assert.equal(counts[0]+counts[1],1);assert.equal(h.sent.length,1);
 }finally{h.close();}});

test('LINE delivery failure retries notification only, never the source expense',async()=>{const h=fixture(),original=globalThis.fetch;try{
 h.addReview('job8');await sweepSyncFailureAlerts(h.env);const job=h.sent[0];let ack=0,retry=0;h.env.LINE_CHANNEL_ACCESS_TOKEN='synthetic';globalThis.fetch=async()=>new Response('unavailable',{status:503});
 await processLineNotificationMessage(h.env,'malipang-jobs',{body:job,ack(){ack++;},retry(){retry++;}},1);
 assert.equal(ack,0);assert.equal(retry,1);assert.equal(h.sqlite.prepare("SELECT status FROM expense_events WHERE expense_id='exp_job8'").get().status,'CONFIRMED');assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job8'").get().status,'REVIEW');
 }finally{globalThis.fetch=original;h.close();}});

test('old or already resolved sync alerts never send beyond the retry-key window',async()=>{for(const resolved of [false,true]){const h=fixture(),original=globalThis.fetch;try{
 h.addReview('window');await sweepSyncFailureAlerts(h.env);const job=h.sent[0];let ack=0,retry=0,calls=0;
 h.env.LINE_CHANNEL_ACCESS_TOKEN='synthetic';globalThis.fetch=async()=>{calls++;return new Response('{}',{status:200});};
 if(resolved)h.sqlite.exec("UPDATE failed_jobs SET status='RESOLVED' WHERE job_key LIKE 'LINE_NOTIFICATION:%'");
 else h.sqlite.exec("UPDATE failed_jobs SET created_at='2001-01-01T00:00:00.000Z' WHERE job_key LIKE 'LINE_NOTIFICATION:%'");
 await processLineNotificationMessage(h.env,'malipang-jobs',{body:job,ack(){ack++;},retry(){retry++;}},1);
 assert.equal(calls,0);assert.equal(ack,1);assert.equal(retry,0);
 if(!resolved)assert.equal(h.sqlite.prepare("SELECT error FROM failed_jobs WHERE job_key LIKE 'LINE_NOTIFICATION:%'").get().error,'LINE_NOTIFICATION_DELIVERY_UNCERTAIN');
 }finally{globalThis.fetch=original;h.close();}}});

test('disabled LINE output leaves a queued sync alert open for later recovery',async()=>{const h=fixture(),original=globalThis.fetch;try{
 h.addReview('disabled');await sweepSyncFailureAlerts(h.env);const job=h.sent[0];let ack=0,retry=0,calls=0;
 h.sqlite.exec("UPDATE failed_jobs SET error='LINE /v2/bot/message/push HTTP 503' WHERE job_key LIKE 'LINE_NOTIFICATION:%'");
 h.env.LINE_CHANNEL_ACCESS_TOKEN='synthetic';h.env.RUNTIME_MODE='shadow';h.env.SHADOW_LINE_OUTPUT='false';
 globalThis.fetch=async()=>{calls++;return new Response('{}',{status:200});};
 await processLineNotificationMessage(h.env,'malipang-jobs',{body:job,ack(){ack++;},retry(){retry++;}},1);
 assert.equal(calls,0);assert.equal(ack,1);assert.equal(retry,0);
 assert.deepEqual({...h.sqlite.prepare("SELECT status,error FROM failed_jobs WHERE job_key LIKE 'LINE_NOTIFICATION:%'").get()},{status:'OPEN',error:'PENDING_LINE_NOTIFICATION_DELIVERY'});
 h.env.RUNTIME_MODE='production';
 await processLineNotificationMessage(h.env,'malipang-jobs',{body:job,ack(){ack++;},retry(){retry++;}},1);
 assert.equal(calls,1);assert.equal(ack,2);assert.equal(retry,0);
 assert.equal(h.sqlite.prepare("SELECT status FROM failed_jobs WHERE job_key LIKE 'LINE_NOTIFICATION:%'").get().status,'RESOLVED');
 }finally{globalThis.fetch=original;h.close();}});

test('sheet and staff-config DLQ keep the legacy owner alert if incident schema is absent or incomplete',async()=>{for(const partial of [false,true])for(const staff of [false,true]){const h=fixture(),original=globalThis.fetch;try{
 if(partial)h.sqlite.exec('DROP TRIGGER sync_alert_job_update');
 else {for(const {name} of h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'sync_alert_%'").all())h.sqlite.exec(`DROP TRIGGER "${name}"`);h.sqlite.exec('DROP TABLE sync_alert_incidents');}
 let ack=0,retry=0;const calls=[];h.env.LINE_CHANNEL_ACCESS_TOKEN='synthetic';
 globalThis.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response('{}',{status:200});};
 const job=staff?{kind:'STAFF_CONFIG_SYNC',employeeId:'synthetic',version:1,traceId:'dlq'}:{kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'synthetic',entityVersion:1,traceId:'dlq'};
 await worker.queue({queue:'malipang-jobs-dlq',messages:[{body:job,attempts:1,ack(){ack++;},retry(){retry++;}}]},h.env,{});
 assert.equal(ack,1);assert.equal(retry,0);assert.equal(calls.length,1);assert.match(calls[0].body.messages[0].text,/MaliPang DLQ/);
 assert.equal(h.sent.length,0);assert.equal(h.sqlite.prepare("SELECT count(*) n FROM failed_jobs WHERE error='DEAD_LETTER_MAX_RETRIES'").get().n,1);
 }finally{globalThis.fetch=original;h.close();}}});

test('sheet DLQ uses the durable alert path when the incident schema is ready',async()=>{const h=fixture(),original=globalThis.fetch;try{
 let ack=0,calls=0;globalThis.fetch=async()=>{calls++;return new Response('{}',{status:200});};
 const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'synthetic',entityVersion:1,traceId:'dlq'};
 await worker.queue({queue:'malipang-jobs-dlq',messages:[{body:job,attempts:1,ack(){ack++;},retry(){assert.fail('should not retry');}}]},h.env,{});
 assert.equal(ack,1);assert.equal(calls,0);assert.equal(h.sent.length,1);assert.equal(h.sent[0].kind,'SYNC_ALERT_SWEEP');
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM sync_alert_incidents WHERE kind='TERMINAL'").get().n,1);
 }finally{globalThis.fetch=original;h.close();}});

test('missing owner does not mark an incident notified; wake-up failure is isolated',async()=>{const h=fixture();try{
 h.addReview('job6');h.env.LINE_OWNER_USER_ID='';await assert.rejects(sweepSyncFailureAlerts(h.env),/OWNER_UNAVAILABLE/);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM failed_jobs').get().n,0);
 h.env.JOB_QUEUE.send=async()=>{throw Error('queue failure')};await assert.doesNotReject(wakeSyncFailureAlerts(h.env));assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job6'").get().status,'REVIEW');
 }finally{h.close();}});

test('Queue wake-up scans durable review state without replaying the sheet job',async()=>{const h=fixture();try{
 h.addReview('job7');let ack=0,retry=0;await worker.queue({queue:'malipang-jobs',messages:[{body:{kind:'SYNC_ALERT_SWEEP',traceId:'wake'},attempts:1,ack(){ack++},retry(){retry++;}}]},h.env,{});
 assert.equal(ack,1);assert.equal(retry,0);assert.equal(h.sent.length,1);assert.equal(h.sent[0].kind,'LINE_NOTIFICATION');assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job7'").get().status,'REVIEW');
 }finally{h.close();}});

test('failed sync is durably alerted with uncertain Sheets outcome',async()=>{const h=fixture();try{
 h.addReview('failed1','provider secret','FAILED');
 assert.equal(await sweepSyncFailureAlerts(h.env),1);assert.equal(await sweepSyncFailureAlerts(h.env),0);
 assert.match(h.sent[0].messages[0].text,/ซิงก์ล้มเหลว/);assert.match(h.sent[0].messages[0].text,/ตรวจสถานะล่าสุด/);assert.doesNotMatch(h.sent[0].messages[0].text,/provider secret/);
 }finally{h.close();}});

test('sync alert exhausted queue retries remains recoverable from durable outbox',async()=>{const h=fixture();try{
 h.addReview('failed2');await sweepSyncFailureAlerts(h.env);const job=h.sent[0];let ack=0,retry=0;
 await worker.queue({queue:'malipang-jobs-dlq',messages:[{body:job,attempts:1,ack(){ack++;},retry(){retry++;}}]},h.env,{});
 assert.equal(ack,1);assert.equal(retry,0);assert.equal(h.sqlite.prepare("SELECT error FROM failed_jobs WHERE job_key LIKE 'LINE_NOTIFICATION:%'").get().error,'LINE_NOTIFICATION_ENQUEUE_FAILED');
 h.sqlite.exec("UPDATE failed_jobs SET updated_at='2001-01-01T00:00:00.000Z' WHERE job_key LIKE 'LINE_NOTIFICATION:%'");assert.equal(await recoverPendingLineNotifications(h.env),1);assert.equal(h.sent.length,2);
 }finally{h.close();}});

test('paced batch parks sheet work while alert sweep runs',async()=>{const h=fixture();try{
 Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true'});h.addReview('paced');
 const sheet={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_paced',entityVersion:1,traceId:'fixture'};let sheetAck=0,alertAck=0,retry=0;
 await worker.queue({queue:'malipang-jobs',messages:[{body:sheet,attempts:1,ack(){sheetAck++;},retry(){retry++;}},{body:{kind:'SYNC_ALERT_SWEEP',traceId:'wake'},attempts:1,ack(){alertAck++;},retry(){retry++;}}]},h.env,{});
 assert.equal(sheetAck,1);assert.equal(alertAck,1);assert.equal(retry,0);assert.equal(h.sent.length,1);assert.equal(h.sent[0].kind,'LINE_NOTIFICATION');assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='paced'").get().status,'REVIEW');
 }finally{h.close();}});

test('a batch of wake hints runs only one sweep and parks a sheet job even without pacing',async()=>{const h=fixture(),alerts=require('../dist/line/sync-failure-alerts.js'),original=alerts.sweepSyncFailureAlerts;try{
 let scans=0,ack=0,retry=0;alerts.sweepSyncFailureAlerts=async()=>{scans++;return 0;};
 const sheet={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_parked',entityVersion:1,traceId:'fixture'};
 const messages=[sheet,...Array.from({length:9},()=>({kind:'SYNC_ALERT_SWEEP',traceId:'wake'}))].map(body=>({body,attempts:1,ack(){ack++;},retry(){retry++;}}));
 await worker.queue({queue:'malipang-jobs',messages},h.env,{});
 assert.equal(scans,1);assert.equal(ack,10);assert.equal(retry,0);
 assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE entity_key='exp_parked'").get().status,'PENDING');
 }finally{alerts.sweepSyncFailureAlerts=original;h.close();}});

test('writer failure wakes independent alert sweep and retries only original writer',async()=>{const h=fixture(),dispatch=require('../dist/sheets/stable-phase1-dispatch.js'),original=dispatch.dispatchStablePhase1;try{
 h.env.STABLE_PHASE1_ENABLED='true';h.addReview('failcatch','synthetic','FAILED');dispatch.dispatchStablePhase1=async()=>{throw Error('synthetic provider failure');};
 let ack=0,retry=0;const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_failcatch',entityVersion:1,traceId:'fixture'};
 await worker.queue({queue:'malipang-jobs',messages:[{body:job,attempts:1,ack(){ack++;},retry(){retry++;}}]},h.env,{});
 assert.equal(ack,0);assert.equal(retry,1);assert.equal(h.sent.length,1);assert.equal(h.sent[0].kind,'SYNC_ALERT_SWEEP');
 await worker.queue({queue:'malipang-jobs',messages:[{body:h.sent[0],attempts:1,ack(){},retry(){assert.fail('sweep should succeed');}}]},h.env,{});
 assert.equal(h.sent[1].kind,'LINE_NOTIFICATION');assert.match(h.sent[1].messages[0].text,/ซิงก์ล้มเหลว/);
 }finally{dispatch.dispatchStablePhase1=original;h.close();}});

test('an existing workbook review does not repeatedly wake alerts and the durable incident remains scannable',async()=>{const h=fixture(),dispatch=require('../dist/sheets/stable-phase1-dispatch.js'),original=dispatch.dispatchStablePhase1;try{
 h.env.STABLE_PHASE1_ENABLED='true';h.sqlite.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','token','REVIEW','now','now')");
 dispatch.dispatchStablePhase1=async()=>{throw Error('STABLE_WORKBOOK_REVIEW');};let ack=0,retry=0;
 const job={kind:'SHEETS_SYNC',entityType:'DAILY_PAYROLL',entityKey:'synthetic',entityVersion:1,traceId:'fixture'};
 await worker.queue({queue:'malipang-jobs',messages:[{body:job,attempts:1,ack(){ack++;},retry(){retry++;}}]},h.env,{});
 assert.equal(ack,1);assert.equal(retry,0);assert.equal(h.sent.length,0);
 assert.equal(await sweepSyncFailureAlerts(h.env),1);
 assert.equal(h.sent[0].kind,'LINE_NOTIFICATION');assert.match(h.sent[0].messages[0].text,/พักซิงก์/);
 }finally{dispatch.dispatchStablePhase1=original;h.close();}});

test('transient failure is retained, deduplicated while open, and a new failure reopens it',async()=>{const h=fixture();try{
 h.addReview('transient','private-provider-detail','FAILED');
 h.sqlite.exec("UPDATE sync_jobs SET status='PENDING' WHERE job_id='transient'; UPDATE sync_jobs SET status='FAILED',updated_at='later' WHERE job_id='transient'; UPDATE sync_jobs SET status='COMPLETED' WHERE job_id='transient'");
 assert.equal(await sweepSyncFailureAlerts(h.env),1);assert.equal(await sweepSyncFailureAlerts(h.env),0);
 h.sqlite.exec("UPDATE sync_jobs SET status='FAILED' WHERE job_id='transient'; UPDATE sync_jobs SET updated_at='later2' WHERE job_id='transient'");
 assert.equal(await sweepSyncFailureAlerts(h.env),1);assert.equal(await sweepSyncFailureAlerts(h.env),0);assert.equal(h.sent.length,2);
 const incidents=h.sqlite.prepare("SELECT * FROM sync_alert_incidents WHERE kind='JOB' AND source_id='transient' ORDER BY incident_id").all();
 assert.equal(incidents.length,2);assert.deepEqual(incidents.map(x=>x.state),['CLOSED','OPEN']);assert.doesNotMatch(JSON.stringify(incidents),/private-provider-detail/);
 }finally{h.close();}});

test('a newly held review creates a distinct owner alert after an earlier failure',async()=>{const h=fixture();try{
 h.addReview('reasonchange','provider-error','FAILED');
 assert.equal(await sweepSyncFailureAlerts(h.env),1);
 h.sqlite.exec("UPDATE sync_jobs SET status='REVIEW',last_error='STABLE_DAILY_ROW_HELPER_FORMULA_UNVERIFIED' WHERE job_id='reasonchange'");
 assert.equal(await sweepSyncFailureAlerts(h.env),1);
 assert.match(h.sent[1].messages[0].text,/สูตรในชีตรายวันตรวจไม่ผ่าน/);
 h.sqlite.exec("UPDATE sync_jobs SET last_error='STABLE_DAILY_ROW_HELPER_FORMULA_UNVERIFIED' WHERE job_id='reasonchange'");
 assert.equal(await sweepSyncFailureAlerts(h.env),0);
 const incidents=h.sqlite.prepare("SELECT category,state FROM sync_alert_incidents WHERE kind='JOB' AND source_id='reasonchange' ORDER BY incident_id").all();
 assert.deepEqual(incidents.map(x=>[x.category,x.state]),[['FAILED','CLOSED'],['ROW_FORMULA','OPEN']]);
 }finally{h.close();}});

test('an unsent failure and later review are both retained during category change',async()=>{const h=fixture();try{
 h.addReview('unsentreason','provider-error','FAILED');
 h.sqlite.exec("UPDATE sync_jobs SET status='REVIEW',last_error='STABLE_DAILY_MONTH_OPENING_UNVERIFIED' WHERE job_id='unsentreason'");
 assert.equal(await sweepSyncFailureAlerts(h.env),2);
 assert.equal(h.sent.length,2);assert.match(h.sent[0].messages[0].text,/เคยพบปัญหา/);assert.match(h.sent[1].messages[0].text,/ยอดตั้งต้น/);
 assert.equal(await sweepSyncFailureAlerts(h.env),0);
 }finally{h.close();}});

test('terminal incident reopening with same id produces a new alert',async()=>{const h=fixture();try{
 h.sqlite.exec(`INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES('again','malipang-jobs','t','key','{"kind":"SHEETS_SYNC"}','DEAD_LETTER_MAX_RETRIES','OPEN',1,'now','now')`);
 assert.equal(await sweepSyncFailureAlerts(h.env),1);
 h.sqlite.exec("UPDATE failed_jobs SET updated_at='later' WHERE id='again'");assert.equal(await sweepSyncFailureAlerts(h.env),0);
 h.sqlite.exec("UPDATE failed_jobs SET status='RESOLVED' WHERE id='again'; UPDATE failed_jobs SET status='OPEN' WHERE id='again'");
 assert.equal(await sweepSyncFailureAlerts(h.env),1);assert.equal(h.sent.length,2);
 }finally{h.close();}});

test('source UPSERTs do not override duplicate incident protection inside triggers',async()=>{const h=fixture();try{
 h.addReview('upsert');
 h.sqlite.exec(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at)
  VALUES('upsert','EXPENSE','exp_upsert',1,'fixture','REVIEW','later')
  ON CONFLICT(job_id) DO UPDATE SET status='REVIEW',last_error='changed';`);
 h.sqlite.exec(`INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','token','REVIEW','now','now');
  INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','token','REVIEW','now','later')
  ON CONFLICT(spreadsheet_id) DO UPDATE SET state='REVIEW';`);
 const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'fixture',entityVersion:1,traceId:'terminal'};
 const {createFailedJob}=require('../dist/db/repositories.js');
 await createFailedJob(h.env,'malipang-jobs',job.traceId,job,'DEAD_LETTER_MAX_RETRIES');
 await createFailedJob(h.env,'malipang-jobs',job.traceId,job,'DEAD_LETTER_MAX_RETRIES');
 const incidents=h.sqlite.prepare("SELECT kind,count(*) n FROM sync_alert_incidents WHERE state='OPEN' GROUP BY kind ORDER BY kind").all();
 assert.deepEqual(incidents.map(r=>[r.kind,r.n]),[['JOB',1],['TERMINAL',1],['WORKBOOK',1]]);
 }finally{h.close();}});

test('missing incident migration reports unavailable and does not block existing notification recovery',async()=>{const h=fixture();try{
 h.addReview('unmigrated');const triggers=h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'sync_alert_%'").all();
 for(const {name} of triggers)h.sqlite.exec(`DROP TRIGGER "${name}"`);h.sqlite.exec('DROP TABLE sync_alert_incidents');
 assert.equal(await sweepSyncFailureAlerts(h.env),null);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='unmigrated'").get().status,'REVIEW');
 const payload={kind:'LINE_NOTIFICATION',to:'fixture-owner',messages:[{type:'text',text:'synthetic'}],purpose:'EXPENSE_RESPONSE',retryKey:'12345678-1234-1234-1234-123456789abc',traceId:'legacy'};
 h.sqlite.prepare("INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES('legacy','malipang-jobs','legacy','LINE_NOTIFICATION:legacy',?,'LINE_NOTIFICATION_ENQUEUE_FAILED','OPEN',0,'2026-11-15T00:00:00.000Z','2001-01-01T00:00:00.000Z')").run(JSON.stringify(payload));
 assert.equal(await recoverPendingLineNotifications(h.env),1);assert.equal(h.sent.length,1);assert.equal(h.sent[0].traceId,'legacy');
 }finally{h.close();}});

test('partial incident migration reports unavailable without marking or queuing alerts',async()=>{const h=fixture();try{
 h.addReview('partial');h.sqlite.exec('DROP TRIGGER sync_alert_job_update');assert.equal(await sweepSyncFailureAlerts(h.env),null);
 assert.equal(h.sent.length,0);assert.equal(h.sqlite.prepare("SELECT count(*) n FROM sync_alert_incidents WHERE alerted_at IS NOT NULL").get().n,0);
 }finally{h.close();}});
