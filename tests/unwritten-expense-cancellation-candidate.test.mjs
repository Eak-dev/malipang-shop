import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
import {cutoverReadySql} from './helpers/cutover-ready.mjs';
const require=createRequire(import.meta.url),{buildUnwrittenExpenseCancellationCandidate,executeUnwrittenExpenseCancellation}=require('../dist/sheets/unwritten-expense-cancellation-candidate.js'),{recoverDeferredAutoCancelAlerts}=require('../dist/line/sync-failure-alerts.js');
function fixture(){
 const h=expenseSqlite(),batch=h.DB.batch;h.DB.batch=async function(s){return(await batch.call(this,s)).map(x=>({...x,success:true}))};const notifications=[];h.env.JOB_QUEUE.send=async job=>notifications.push(job);Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',STABLE_CANCELLATION_PREIMAGE_ENABLED:'true',CONTINUOUS_DAILY_ENABLED:'true',CONTINUOUS_DAILY_SHEET:'newdaily',CONTINUOUS_DAILY_SHEET_ID:'8',CONTINUOUS_RAW_SHEET:'newraw',CONTINUOUS_RAW_SHEET_ID:'9',CONTINUOUS_DETAIL_SHEET:'newdetail',CONTINUOUS_DETAIL_SHEET_ID:'10',SHEET_EXPENSE_DAILY:'olddaily',SHEET_EXPENSE_RAW:'oldraw',SHEET_PURCHASE_DETAILS:'olddetail',SHADOW_LINE_OUTPUT:'true',GOOGLE_SPREADSHEET_ID:'book',LINE_OWNER_USER_ID:'owner'});
 h.sqlite.exec(`UPDATE stable_sync_cutover SET state='ACTIVE',activated_at='now'; INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','claim','HELD','now','now'); INSERT INTO continuous_daily_cutovers(spreadsheet_id,legacy_sheet_id,legacy_sheet_name,continuous_sheet_id,continuous_sheet_name,raw_sheet_id,raw_sheet_name,detail_sheet_id,detail_sheet_name,claim_token,source_revision,state,prepared_at) SELECT 'book',7,'olddaily',8,'newdaily',9,'newraw',10,'newdetail','claim',revision,'PREPARED','now' FROM stable_source_revision; ${cutoverReadySql('claim')} UPDATE continuous_daily_cutovers SET state='ACTIVE',activated_at='now';
 INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_new','message','owner','example',10000,'transfer','SHOP_BANK','ingredients','2026-10-09','CONFIRMED','now',1);
 INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,lease_until,lease_token) VALUES('job','EXPENSE','exp_new',1,'trace','PROCESSING',1,'now','2099-01-01T00:00:00.000Z','lease');
 `);
 const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_new',entityVersion:1,traceId:'trace'};
 const input=()=>({job,lease:'lease',claim:'claim',sourceDigest:'a'.repeat(64),sourceRevision:h.sqlite.prepare('SELECT revision FROM stable_source_revision WHERE singleton=1').get().revision,description:'example',amountSatang:10000,reason:'CAPACITY'});
 return {...h,job,input,notifications};
}
test('candidate atomically cancels only a first attempt and creates owner outbox',async()=>{const h=fixture();try{
 const candidate=await buildUnwrittenExpenseCancellationCandidate(h.env,h.input());assert.equal(candidate.statements.length,6);await h.DB.batch(candidate.statements);
 assert.deepEqual({...h.sqlite.prepare('SELECT status,version FROM expense_events').get()},{status:'CANCELLED',version:2});
 assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'COMPLETED');
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM expense_audit_log WHERE action='CANCEL'").get().n,1);
 const alert=h.sqlite.prepare('SELECT error,payload_json FROM failed_jobs').get();assert.equal(alert.error,'PENDING_LINE_NOTIFICATION_DELIVERY');assert.equal(JSON.parse(alert.payload_json).to,'owner');
}finally{h.close();}});
for(const [label,change] of [
 ['prior attempt',h=>h.sqlite.exec("UPDATE sync_jobs SET attempt_count=2")],
 ['wrong lease',h=>h.sqlite.exec("UPDATE sync_jobs SET lease_token='other'")],
 ['another job version',h=>h.sqlite.exec("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('other','EXPENSE','exp_new',2,'other','PENDING','now')")],
 ['legacy row mapping',h=>h.sqlite.exec("INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES('legacy','exp_new',4)")],
 ['linked unconfirmed document',h=>h.sqlite.exec("INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,created_at,expense_id) VALUES('doc','doc-message','owner','RECEIPT','WAITING_CONFIRM','now','exp_new'); INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,created_at) VALUES('link','exp_new','doc','PRIMARY_PURCHASE_DOCUMENT','MANUAL','now')")],
 ['existing provider intent',h=>h.sqlite.exec("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE','exp_new','DAILY',8,'newdaily',1,'"+'a'.repeat(64)+"','claim','IN_FLIGHT','now')")],
])test(`candidate transaction fails closed for ${label}`,async()=>{const h=fixture();try{
 change(h);const candidate=await buildUnwrittenExpenseCancellationCandidate(h.env,h.input());await assert.rejects(h.DB.batch(candidate.statements));
 assert.deepEqual({...h.sqlite.prepare('SELECT status,version FROM expense_events').get()},{status:'CONFIRMED',version:1});assert.equal(h.sqlite.prepare('SELECT count(*) n FROM expense_audit_log').get().n,0);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM failed_jobs').get().n,0);
}finally{h.close();}});
test('outbox insertion failure rolls back the source and audit',async()=>{const h=fixture();try{
 const candidate=await buildUnwrittenExpenseCancellationCandidate(h.env,h.input());h.DB.failAt=4;await assert.rejects(h.DB.batch(candidate.statements));
 assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CONFIRMED');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM expense_audit_log').get().n,0);
}finally{h.close();}});
test('successful execution immediately queues owner notification from durable outbox',async()=>{const h=fixture();try{
 assert.equal(await executeUnwrittenExpenseCancellation(h.env,h.input()),true);assert.equal(h.notifications.length,1);assert.match(h.notifications[0].messages[0].text,/example 100\.00/);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM failed_jobs').get().n,1);
}finally{h.close();}});
test('report failure is immediately explained with its safe error code when owner is available',async()=>{const h=fixture();try{
 assert.equal(await executeUnwrittenExpenseCancellation(h.env,{...h.input(),reason:'REPORT_UNVERIFIED',errorCode:'REPORT_HEALTH_FORMULA'}),true);assert.equal(h.notifications.length,1);assert.match(h.notifications[0].messages[0].text,/รายงาน Sheets ตรวจสอบไม่ผ่าน/);assert.match(h.notifications[0].messages[0].text,/REPORT_HEALTH_FORMULA/);
}finally{h.close()}});
test('failed enqueue preserves cancellation and durable outbox for scheduled recovery',async()=>{const h=fixture();try{
 h.env.JOB_QUEUE.send=async()=>{throw Error('offline')};assert.equal(await executeUnwrittenExpenseCancellation(h.env,h.input()),true);assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CANCELLED');assert.equal(h.sqlite.prepare("SELECT error FROM failed_jobs").get().error,'PENDING_LINE_NOTIFICATION_DELIVERY');
}finally{h.close();}});
for(const mode of ['missing-owner','line-disabled'])test(`unwritten expense cancels when ${mode}, persists minimal incident and alerts later once`,async()=>{const h=fixture();try{
 if(mode==='missing-owner')h.env.LINE_OWNER_USER_ID='';else h.env.SHADOW_LINE_OUTPUT='false';
 assert.equal(await executeUnwrittenExpenseCancellation(h.env,h.input()),true);assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CANCELLED');assert.equal(h.notifications.length,0);
 const incident=h.sqlite.prepare("SELECT error,payload_json FROM failed_jobs WHERE status='OPEN'").get();assert.equal(incident.error,'SYNC_AUTO_CANCEL_AWAITING_RECIPIENT');assert.doesNotMatch(incident.payload_json,/example|10000|receipt/i);
 h.env.LINE_OWNER_USER_ID='owner';h.env.SHADOW_LINE_OUTPUT='true';assert.equal(await recoverDeferredAutoCancelAlerts(h.env),1);assert.equal(h.notifications.length,1);assert.match(h.notifications[0].messages[0].text,/example 100\.00/);assert.equal(await recoverDeferredAutoCancelAlerts(h.env),0);assert.equal(h.notifications.length,1);
}finally{h.close();}});
test('concurrent deferred incident sweeps produce only one durable notification',async()=>{const h=fixture();try{
 h.env.LINE_OWNER_USER_ID='';assert.equal(await executeUnwrittenExpenseCancellation(h.env,h.input()),true);h.env.LINE_OWNER_USER_ID='owner';const counts=await Promise.all([recoverDeferredAutoCancelAlerts(h.env),recoverDeferredAutoCancelAlerts(h.env)]);assert.equal(counts[0]+counts[1],1);assert.equal(h.notifications.length,1);assert.equal(h.sqlite.prepare("SELECT count(*) n FROM failed_jobs WHERE job_key LIKE 'LINE_NOTIFICATION:%'").get().n,1);
}finally{h.close();}});
test('deferred legacy month failure alerts once when owner becomes available',async()=>{const h=fixture();try{
 h.env.LINE_OWNER_USER_ID='';assert.equal(await executeUnwrittenExpenseCancellation(h.env,{...h.input(),reason:'LEGACY_COVERAGE'}),true);h.env.LINE_OWNER_USER_ID='owner';
 assert.equal(await recoverDeferredAutoCancelAlerts(h.env),1);assert.match(h.notifications[0].messages[0].text,/ข้อมูลเดือนเดิมในชีตตรวจไม่ผ่าน/);assert.equal(await recoverDeferredAutoCancelAlerts(h.env),0);
}finally{h.close();}});
for(const [reason,errorCode,match] of [['REPORT_UNVERIFIED','REPORT_HEALTH_FORMULA',/รายงาน Sheets ตรวจสอบไม่ผ่าน/],['LEGACY_READ','LEGACY_COVERAGE_READ_UNAVAILABLE',/อ่านข้อมูลชีตรายวันเดิมไม่สำเร็จ/],['PENDING_UNDO','INSERT_DAILY_PENDING_CANCELLATION',/มีรายการยกเลิกก่อนหน้ารอซิงก์/]])test(`deferred ${reason} notification includes the bounded error code`,async()=>{const h=fixture();try{
 h.env.LINE_OWNER_USER_ID='';assert.equal(await executeUnwrittenExpenseCancellation(h.env,{...h.input(),reason,errorCode}),true);const incident=JSON.parse(h.sqlite.prepare("SELECT payload_json FROM failed_jobs WHERE status='OPEN'").get().payload_json);assert.equal(incident.errorCode,errorCode);
 h.env.LINE_OWNER_USER_ID='owner';assert.equal(await recoverDeferredAutoCancelAlerts(h.env),1);assert.match(h.notifications[0].messages[0].text,match);assert.ok(h.notifications[0].messages[0].text.includes(errorCode));
}finally{h.close()}});
test('unsafe provider error text cannot enter a cancellation notification',async()=>{const h=fixture();try{assert.equal(await buildUnwrittenExpenseCancellationCandidate(h.env,{...h.input(),reason:'REPORT_UNVERIFIED',errorCode:'private receipt 123'}),null);assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CONFIRMED');}finally{h.close()}});
test('a deferred Sheets read failure reports a safe code exactly once when the owner becomes available',async()=>{const h=fixture();try{
 h.env.LINE_OWNER_USER_ID='';assert.equal(await executeUnwrittenExpenseCancellation(h.env,{...h.input(),reason:'SHEETS_READ',errorCode:'SHEETS_READ_HTTP_403'}),true);
 h.env.LINE_OWNER_USER_ID='owner';assert.equal(await recoverDeferredAutoCancelAlerts(h.env),1);assert.match(h.notifications[0].messages[0].text,/SHEETS_READ_HTTP_403/);assert.match(h.notifications[0].messages[0].text,/อ่านข้อมูล Sheets ไม่สำเร็จ/);assert.equal(await recoverDeferredAutoCancelAlerts(h.env),0);
}finally{h.close()}});
test('deferred alert enqueue failure leaves ordinary retryable LINE outbox',async()=>{const h=fixture();try{
 h.env.LINE_OWNER_USER_ID='';assert.equal(await executeUnwrittenExpenseCancellation(h.env,h.input()),true);h.env.LINE_OWNER_USER_ID='owner';h.env.JOB_QUEUE.send=async()=>{throw Error('offline')};assert.equal(await recoverDeferredAutoCancelAlerts(h.env),1);assert.equal(h.sqlite.prepare("SELECT error FROM failed_jobs WHERE job_key LIKE 'LINE_NOTIFICATION:%'").get().error,'LINE_NOTIFICATION_ENQUEUE_FAILED');
}finally{h.close();}});

test('armed recovery canary auto-cancels only with its admitted claim operation',async()=>{const h=fixture();try{
 Object.assign(h.env,{STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true'});
 h.sqlite.exec("UPDATE stable_workbook_claims SET operation_token='claim-token' WHERE operation_token='claim'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-test','book','ARMED','EXPENSE','exp_new',1,'now','now')");
 const input=()=>({...h.input(),claim:'claim-token'});
 let c=await buildUnwrittenExpenseCancellationCandidate(h.env,input());await assert.rejects(h.DB.batch(c.statements));assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CONFIRMED');
 h.sqlite.exec("INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token','epoch-test','ADMITTED','now')");
 assert.equal(await executeUnwrittenExpenseCancellation(h.env,input()),true);assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CANCELLED');
}finally{h.close()}});

function admitPreCutoverForTest(h,digest='a'.repeat(64)){
 const names=['continuous_daily_post_no_delete','continuous_daily_snapshot_prepared','continuous_daily_admission_insert'];
 const definitions=names.map(n=>h.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(n).sql);
 for(const n of names)h.sqlite.exec(`DROP TRIGGER ${n}`);
 h.sqlite.exec("DELETE FROM continuous_daily_post_cutover_expenses WHERE expense_id='exp_new'; INSERT INTO continuous_daily_pre_cutover_expenses(spreadsheet_id,expense_id) VALUES('book','exp_new')");
 h.sqlite.prepare("INSERT INTO continuous_daily_source_admissions(spreadsheet_id,expense_id,source_version,source_digest,provider_digest,source_revision,claim_token,admitted_at) VALUES('book','exp_new',1,?,?,0,'claim','now')").run(digest,'b'.repeat(64));
 for(const definition of definitions)h.sqlite.exec(definition);
}
test('admitted pre-cutover first attempt can cancel only for exact digest',async()=>{for(const digest of ['a'.repeat(64),'c'.repeat(64)]){const h=fixture();try{
 admitPreCutoverForTest(h,digest);const c=await buildUnwrittenExpenseCancellationCandidate(h.env,h.input());if(digest[0]==='a'){await h.DB.batch(c.statements);assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CANCELLED')}else{await assert.rejects(h.DB.batch(c.statements));assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CONFIRMED')}
}finally{h.close()}}});
