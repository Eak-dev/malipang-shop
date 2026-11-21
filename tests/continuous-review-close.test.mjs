import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';

const require=createRequire(import.meta.url);
const client=require('../dist/sheets/client.js');
const {ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js');
const notice=require('../dist/sheets/stable-edit-notice.js');
const daily=require('../dist/sheets/continuous-daily-positive-recovery.js');
const {closeReviewedContinuousExpense}=require('../dist/sheets/continuous-review-close.js');

function fixture(authority='REVIEW'){
 const h=expenseSqlite(),prepare=h.DB.prepare,batch=h.DB.batch;let mode='ok';
 h.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run,all=s.all;s.run=async function(){const ack=sql.includes("SET state='STATUS_ACKED'");if(ack&&mode==='ack-not-applied')throw Error('synthetic ACK not persisted');const result=await run.call(this);if(ack&&mode==='ack-lost-after')throw Error('synthetic D1 ACK lost after commit');return {...result,success:true};};s.all=async function(){return {...await all.call(this),success:true};};return s;};
 h.DB.batch=async function(stmts){return(await batch.call(this,stmts)).map(x=>({...x,success:true}));};
 Object.assign(h.env,{GOOGLE_SPREADSHEET_ID:'book',SHEET_EXPENSE_DAILY:'รายวัน',APP_ENV:'test',RUNTIME_MODE:'shadow',SHEETS_SYNC_ENABLED:'true',STABLE_PHASE1_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',CONTINUOUS_DAILY_ENABLED:'true',CONTINUOUS_REVIEW_CLOSE_ENABLED:'true',CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED:'true',CONTINUOUS_NOTICE_DISPATCH_ENABLED:'true'});
 h.sqlite.exec("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_test','fixture_msg','fixture_user','synthetic',123,'cash','cash','ingredients','2026-11-15','CONFIRMED','now',1)");
 h.sqlite.exec("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('job','EXPENSE','exp_test',1,'fixture','REVIEW','now')");
 h.sqlite.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,notice_stamp,notice_identity,phase,review_reason,created_at,updated_at) VALUES('book','token-fixture','REVIEW','2026-01-01 00:00:01','notice-id','OPERATION','TEST','now','now')");
 h.sqlite.exec("INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-fixture','book','ARMED','EXPENSE','exp_test',1,'now','now')");
 h.sqlite.exec("INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('token-fixture','epoch-fixture','ADMITTED','now')");
 h.sqlite.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE','exp_test','DAILY',2,'draft',1,?,'token-fixture','VERIFIED','now')").run('a'.repeat(64));
 if(authority==='HANDOFF'){h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',last_error='STABLE_STAGE_CONTINUE' WHERE entity_key='exp_test'; UPDATE stable_workbook_claims SET state='HELD',phase=NULL WHERE operation_token='token-fixture'; INSERT INTO continuous_normal_notice_handoffs(operation_token,spreadsheet_id,epoch_id,expense_id,source_version,projection,journal_entity,operation_kind,created_at) VALUES('token-fixture','book','epoch-fixture','exp_test',1,'DAILY','exp_test','CONFIRM','now'); UPDATE stable_workbook_claims SET phase='END_NOTICE_PENDING' WHERE operation_token='token-fixture'");}
 const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_test',entityVersion:1,traceId:'fixture'};
 const original={write:client.batchUpdateSpreadsheetWithReply,style:notice.stableNoticeStyleFingerprint,verify:daily.verifyReviewedDailyProjection};
 let status='พักแก้ไฟล์',time='2026-01-01 00:00:01',writes=0,proof=true,readyChecks=0,verifyCalls=0,lateStatus=null;
 notice.stableNoticeStyleFingerprint=async(_env,identity,expectedStatus,expectedTime)=>identity==='notice-id'&&status===expectedStatus&&time===expectedTime?'b'.repeat(64):null;
 daily.verifyReviewedDailyProjection=async(_env,_job,_token,kind)=>{verifyCalls++;if(kind==='REVIEW_READY'){readyChecks++;if(mode==='source-race-during-ready')h.sqlite.exec("UPDATE expense_events SET description='changed' WHERE expense_id='exp_test'");}return proof;};
 client.batchUpdateSpreadsheetWithReply=async(_env,requests,before)=>{
  assert.equal(requests.length,1);await before();writes++;
  const f=requests[0].findReplace,isTime=f.range.startColumnIndex===2;
  assert.equal(f.range.startRowIndex,0);assert.equal(f.range.endRowIndex,1);assert.equal(f.matchEntireCell,true);
  if(mode==='status-late'&&!isTime){lateStatus=()=>{if(status===f.find)status=f.replacement;};throw Error('synthetic timeout with late provider write');}
  if(mode===(isTime?'time-not-applied':'status-not-applied'))throw Error('synthetic lost ACK before write');
  if((isTime?time:status)!==f.find)return {replies:[{findReplace:{}}]};
  if(isTime)time=f.replacement;else status=f.replacement;
  if(mode===(isTime?'time-lost-after':'status-lost-after'))throw Error('synthetic lost ACK after write');
  if(mode==='other-review-after-status'&&!isTime)h.sqlite.exec("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('other','EXPENSE','exp_other',1,'x','REVIEW','now')");
  if(mode==='mutate-source-after-status'&&!isTime){h.sqlite.exec("UPDATE expense_events SET description='changed' WHERE expense_id='exp_test'");proof=false;}
  if(mode==='unrelated-source-after-status'&&!isTime)h.sqlite.exec("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_other','fixture_other','fixture_user','synthetic',100,'cash','cash','ingredients','2026-11-15','CONFIRMED','now',1)");
  if(mode==='proof-fails-after-status'&&!isTime)proof=false;
  if(mode==='job-identity-change-after-status'&&!isTime)job.entityKey='exp_other';
  return {replies:[{findReplace:{valuesChanged:1,occurrencesChanged:1}}]};
 };
 return {...h,job,runOnce:()=>closeReviewedContinuousExpense(h.env,job,'token-fixture',new ReviewRequestBudget(40),authority),run:async()=>{for(let i=0;i<5;i++){const outcome=await closeReviewedContinuousExpense(h.env,job,'token-fixture',new ReviewRequestBudget(40),authority);if(outcome!=='IN_PROGRESS')return outcome;}throw Error('UNBOUNDED_TEST');},setMode:v=>{mode=v;},applyLate:()=>lateStatus?.(),setProof:v=>{proof=v;},get:()=>({status,time,writes,readyChecks,verifyCalls}),close(){client.batchUpdateSpreadsheetWithReply=original.write;notice.stableNoticeStyleFingerprint=original.style;daily.verifyReviewedDailyProjection=original.verify;h.close();}};
}

test('review close defaults off and never dispatches',async()=>{const h=fixture();try{delete h.env.CONTINUOUS_REVIEW_CLOSE_ENABLED;assert.equal(await h.run(),'DISABLED');assert.equal(h.get().writes,0);}finally{h.close();}});
test('two notice cells close in separate guarded phases before exact D1 resume',async()=>{const h=fixture();try{
 assert.equal(await h.run(),'RESUMED');assert.equal(h.get().writes,2);assert.ok(h.get().readyChecks>0);assert.equal(h.get().status,'พร้อมแก้ไข • มีรายการรอตรวจ');
 assert.equal(h.sqlite.prepare("SELECT state FROM continuous_review_notice_close").get().state,'COMPLETE');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);
 assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'PENDING');assert.equal(h.sqlite.prepare('SELECT state FROM stable_recovery_operations').get().state,'VERIFIED');assert.equal(h.sqlite.prepare('SELECT state FROM stable_recovery_epochs').get().state,'ARMED');
 assert.equal(await h.run(),'ALREADY_COMPLETED');assert.equal(h.get().writes,2);
 }finally{h.close();}});
test('reviewed daily notice-close statements compile at the D1 expression limit',async()=>{const h=fixture(),sql=[],prepare=h.DB.prepare;try{
 h.DB.prepare=function(statement){sql.push(statement);return prepare.call(this,statement)};
 assert.equal(await h.run(),'RESUMED');assert.ok(sql.some(x=>x.includes('UPDATE stable_recovery_operations')));
 const check=spawnSync('python3',[fileURLToPath(new URL('./helpers/sqlite-expression-limit.py',import.meta.url))],{input:JSON.stringify(sql),encoding:'utf8'});
 assert.equal(check.status,0,check.stderr||check.error?.message);
 }finally{h.close();}});
for(const mode of ['time-not-applied','status-not-applied'])test(`${mode} never replays the uncertain notice write`,async()=>{const h=fixture();try{
 h.setMode(mode);assert.equal(await h.run(),'HELD');const before=h.get().writes;assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');assert.equal(h.get().status,'พักแก้ไฟล์');
 h.setMode('ok');assert.equal(await h.run(),'HELD');assert.equal(h.get().writes,before);assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'REVIEW');
 }finally{h.close();}});
for(const mode of ['time-lost-after'])test(`${mode} resumes only after positive notice readback`,async()=>{const h=fixture();try{
 h.setMode(mode);assert.equal(await h.run(),'RESUMED');assert.equal(h.get().writes,2);assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'PENDING');
 }finally{h.close();}});
test('a changed source after status write retains REVIEW and the explicit review notice',async()=>{const h=fixture();try{
 h.setMode('mutate-source-after-status');assert.equal(await h.run(),'HELD');assert.equal(h.get().status,'พร้อมแก้ไข • มีรายการรอตรวจ');assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'REVIEW');
 assert.equal(await h.run(),'HELD');assert.equal(h.get().writes,2);
 }finally{h.close();}});
test('an unrelated source change after notice does not strand a positively reverified target',async()=>{const h=fixture();try{
 h.setMode('unrelated-source-after-status');assert.equal(await h.run(),'RESUMED');assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'PENDING');assert.equal(h.get().writes,2);
 }finally{h.close();}});
test('source mutation during READY revalidation prevents the D1 close',async()=>{const h=fixture();try{
 h.setMode('source-race-during-ready');assert.equal(await h.run(),'HELD');assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'REVIEW');assert.equal(h.get().status,'พร้อมแก้ไข • มีรายการรอตรวจ');
 }finally{h.close();}});
test('a changed in-memory job identity cannot release the original claim',async()=>{const h=fixture();try{
 h.setMode('job-identity-change-after-status');assert.equal(await h.run(),'HELD');assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'REVIEW');
 }finally{h.close();}});
test('failed post-notice projection revalidation retains REVIEW',async()=>{const h=fixture();try{
 h.setMode('proof-fails-after-status');assert.equal(await h.run(),'HELD');assert.equal(h.get().status,'พร้อมแก้ไข • มีรายการรอตรวจ');assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'REVIEW');
 h.setProof(true);assert.equal(await h.run(),'RESUMED');assert.equal(h.get().writes,2);
 }finally{h.close();}});

test('sync disabled is fail closed even with completed intent',async()=>{const h=fixture();try{h.env.SHEETS_SYNC_ENABLED='false';assert.equal(await h.runOnce(),'HELD');assert.equal(h.get().writes,0);}finally{h.close();}});
test('durable phases limit each invocation to one verification and one mutation',async()=>{const h=fixture();try{
 assert.equal(await h.runOnce(),'IN_PROGRESS');assert.equal(h.get().writes,1);assert.equal(h.get().verifyCalls,1);assert.equal(h.sqlite.prepare('SELECT state FROM continuous_review_notice_close').get().state,'TIME_IN_FLIGHT');
 assert.equal(await h.runOnce(),'IN_PROGRESS');assert.equal(h.get().writes,1);assert.equal(h.get().verifyCalls,1);assert.equal(h.sqlite.prepare('SELECT state FROM continuous_review_notice_close').get().state,'TIME_VERIFIED');
 assert.equal(await h.runOnce(),'IN_PROGRESS');assert.equal(h.get().writes,2);assert.equal(h.get().verifyCalls,2);assert.equal(h.sqlite.prepare('SELECT state FROM continuous_review_notice_close').get().state,'STATUS_ACKED');
 assert.equal(await h.runOnce(),'RESUMED');assert.equal(h.get().writes,2);assert.equal(h.get().verifyCalls,3);
 h.sqlite.exec("UPDATE sync_jobs SET status='REVIEW' WHERE entity_key='exp_test'");
 assert.equal(await h.runOnce(),'ALREADY_COMPLETED');assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'REVIEW');
 }finally{h.close();}});


test('close refuses to run without an explicit request budget',async()=>{const h=fixture();try{assert.equal(await closeReviewedContinuousExpense(h.env,h.job,'token-fixture'),'HELD');assert.equal(h.get().writes,0);}finally{h.close();}});

test('lost status reply holds even if the provider cell changed and never replays',async()=>{const h=fixture();try{h.setMode('status-lost-after');assert.equal(await h.run(),'HELD');assert.equal(h.get().status,'พร้อมแก้ไข • มีรายการรอตรวจ');assert.equal(h.sqlite.prepare('SELECT state FROM continuous_review_notice_close').get().state,'STATUS_IN_FLIGHT');assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'REVIEW');h.setMode('ok');assert.equal(await h.run(),'HELD');assert.equal(h.get().writes,2);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM continuous_notice_status_attempts').get().n,1);assert.throws(()=>h.sqlite.exec('DELETE FROM continuous_notice_status_attempts'),/retained/);}finally{h.close();}});

test('crash before ACK persistence holds despite positive provider response',async()=>{const h=fixture();try{h.setMode('ack-not-applied');assert.equal(await h.run(),'HELD');assert.equal(h.sqlite.prepare('SELECT state FROM continuous_review_notice_close').get().state,'STATUS_IN_FLIGHT');h.setMode('ok');assert.equal(await h.run(),'HELD');assert.equal(h.get().writes,2);assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'REVIEW');}finally{h.close();}});
test('lost D1 ACK response resumes only when the durable ACK is read back',async()=>{const h=fixture();try{h.setMode('ack-lost-after');assert.equal(await h.run(),'RESUMED');assert.equal(h.get().writes,2);assert.equal(h.sqlite.prepare('SELECT state FROM continuous_review_notice_close').get().state,'COMPLETE');}finally{h.close();}});
test('notice timestamp contains a nonsecret random recovery nonce',async()=>{const h=fixture();try{assert.equal(await h.runOnce(),'IN_PROGRESS');assert.match(h.get().time,/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} • [0-9a-f]{32}$/);assert.doesNotMatch(h.get().time,/token-fixture|exp_test/);}finally{h.close();}});

test('late status write after timeout cannot release the claim or cause a replay',async()=>{const h=fixture();try{h.setMode('status-late');assert.equal(await h.run(),'HELD');assert.equal(h.get().status,'พักแก้ไฟล์');h.applyLate();assert.equal(h.get().status,'พร้อมแก้ไข • มีรายการรอตรวจ');h.setMode('ok');assert.equal(await h.run(),'HELD');assert.equal(h.get().writes,2);assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'REVIEW');}finally{h.close();}});

test('normal HANDOFF closes with syncing notice and no false REVIEW',async()=>{const h=fixture('HANDOFF');try{assert.equal(await h.run(),'RESUMED');assert.equal(h.get().status,'พร้อมแก้ไข • กำลังซิงก์');assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'PENDING');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);assert.equal(h.sqlite.prepare('SELECT claim_mode FROM continuous_review_notice_close').get().claim_mode,'HANDOFF');}finally{h.close();}});
test('normal HANDOFF holds unknown status reply without marking REVIEW or replaying',async()=>{const h=fixture('HANDOFF');try{h.setMode('status-lost-after');await assert.rejects(h.run(),/synthetic lost ACK/);assert.equal(h.get().status,'พร้อมแก้ไข • กำลังซิงก์');assert.equal(h.sqlite.prepare('SELECT state FROM continuous_review_notice_close').get().state,'STATUS_IN_FLIGHT');assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'HELD');assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'PENDING');h.setMode('ok');assert.equal(await h.run(),'HELD');assert.equal(h.get().writes,2);}finally{h.close();}});
test('other REVIEW before STATUS refreshes an append-only attempt without rewriting TIME',async()=>{const h=fixture('HANDOFF');try{assert.equal(await h.runOnce(),'IN_PROGRESS');assert.equal(await h.runOnce(),'IN_PROGRESS');const stamp=h.get().time;h.sqlite.exec("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('other','EXPENSE','exp_other',1,'x','REVIEW','now')");assert.equal(await h.runOnce(),'IN_PROGRESS');assert.equal(h.get().writes,2);assert.equal(h.get().time,stamp);assert.equal(h.get().status,'พร้อมแก้ไข • กำลังซิงก์ • มีรายการรอตรวจ');const attempt=h.sqlite.prepare('SELECT initial_ready_status,dispatch_ready_status FROM continuous_notice_status_attempts').get();assert.deepEqual({...attempt},{initial_ready_status:'พร้อมแก้ไข • กำลังซิงก์',dispatch_ready_status:'พร้อมแก้ไข • กำลังซิงก์ • มีรายการรอตรวจ'});assert.equal(await h.runOnce(),'RESUMED');assert.equal(h.get().writes,2);}finally{h.close();}});

test('normal HANDOFF retains claim if another REVIEW appears after READY',async()=>{const h=fixture('HANDOFF');try{h.setMode('other-review-after-status');assert.equal(await h.run(),'HELD');assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'HELD');assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE entity_key='exp_test'").get().status,'PENDING');assert.equal(h.get().writes,2);}finally{h.close();}});

test('HANDOFF lost TIME_VERIFIED transaction ACK resumes from exact durable state without POST replay',async()=>{const h=fixture('HANDOFF');try{assert.equal(await h.runOnce(),'IN_PROGRESS');h.DB.failAfterCommit=true;assert.equal(await h.runOnce(),'IN_PROGRESS');h.DB.failAfterCommit=false;assert.equal(h.sqlite.prepare('SELECT state FROM continuous_review_notice_close').get().state,'TIME_VERIFIED');assert.equal(h.get().writes,1);assert.equal(await h.runOnce(),'IN_PROGRESS');assert.equal(h.get().writes,2);}finally{h.close();}});
test('HANDOFF lost STATUS_ACKED acknowledgement resumes from exact durable state without POST replay',async()=>{const h=fixture('HANDOFF');try{assert.equal(await h.runOnce(),'IN_PROGRESS');assert.equal(await h.runOnce(),'IN_PROGRESS');h.setMode('ack-lost-after');assert.equal(await h.runOnce(),'IN_PROGRESS');assert.equal(h.sqlite.prepare('SELECT state FROM continuous_review_notice_close').get().state,'STATUS_ACKED');assert.equal(h.get().writes,2);h.setMode('ok');assert.equal(await h.runOnce(),'RESUMED');assert.equal(h.get().writes,2);}finally{h.close();}});

test('review close continues unchanged before the revoke-review migration is installed',async()=>{const h=fixture();try{
 const {readFileSync}=await import('node:fs');const original=readFileSync(new URL('../migrations/0040_continuous_review_notice_close.sql',import.meta.url),'utf8'),start=original.indexOf('CREATE TRIGGER IF NOT EXISTS continuous_review_close_insert'),end=original.indexOf('CREATE TRIGGER IF NOT EXISTS continuous_review_close_transition',start);
 h.sqlite.exec('DROP TRIGGER continuous_review_close_insert');h.sqlite.exec(original.slice(start,end));const oldStatus=readFileSync(new URL('../migrations/0044_continuous_notice_status_attempt.sql',import.meta.url),'utf8'),a=oldStatus.indexOf('CREATE TRIGGER IF NOT EXISTS continuous_notice_status_attempt_insert'),b=oldStatus.indexOf('CREATE TRIGGER IF NOT EXISTS continuous_notice_status_attempt_no_update',a);h.sqlite.exec('DROP TRIGGER continuous_notice_status_attempt_insert');h.sqlite.exec(oldStatus.slice(a,b));h.sqlite.exec('DROP TABLE continuous_revoke_review_close_activation');
 assert.equal(await h.run(),'RESUMED');assert.equal(h.get().writes,2);
 }finally{h.close();}});
