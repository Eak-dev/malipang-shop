import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {expenseSqlite} from './helpers/expense-sqlite.mjs';import {cutoverReadySql} from './helpers/cutover-ready.mjs';
const require=createRequire(import.meta.url),route=require('../dist/sheets/continuous-daily-route.js'),{armNextContinuousExpense,holdContinuousHistoricalExpenses,holdContinuousUndoVersionGaps,holdContinuousConfirmationVersionGaps,holdContinuousExpenseHistory,holdContinuousExpiredLease}=require('../dist/sheets/continuous-normal-recovery.js'),{sweepSyncFailureAlerts}=require('../dist/line/sync-failure-alerts.js');
function fixture(){
 const h=expenseSqlite(),original=route.assertContinuousDailyActivated,prepare=h.DB.prepare,batch=h.DB.batch;
 h.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run;s.run=async function(){return {...await run.call(this),success:true}};return s};h.DB.batch=async function(s){return(await batch.call(this,s)).map(x=>({...x,success:true}))};
 Object.assign(h.env,{GOOGLE_SPREADSHEET_ID:'book',STABLE_PHASE1_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true',CONTINUOUS_DAILY_ENABLED:'true',CONTINUOUS_DAILY_SHEET:'draft',CONTINUOUS_DAILY_SHEET_ID:'2',CONTINUOUS_RAW_SHEET:'raw_new',CONTINUOUS_RAW_SHEET_ID:'3',CONTINUOUS_DETAIL_SHEET:'detail_new',CONTINUOUS_DETAIL_SHEET_ID:'4',CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED:'true'});
 h.sqlite.exec(`UPDATE stable_sync_cutover SET state='ACTIVE',activated_at='now';
 INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_old','oldmsg','owner','old',100,'transfer','SHOP_BANK','ingredients','2026-11-15','CONFIRMED','now',1);
 INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('oldjob','EXPENSE','exp_old',1,'oldtrace','PENDING','2020');
 INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','claim','HELD','now','now');
 INSERT INTO continuous_cutover_operator(spreadsheet_id,operation_token,origin,state,created_at,updated_at) VALUES('book','claim','NEW','STARTING','now','now');
 UPDATE continuous_cutover_operator SET state='HELD';UPDATE continuous_cutover_operator SET state='RELEASING';UPDATE continuous_cutover_operator SET state='COMPLETE';
 INSERT INTO continuous_daily_cutovers(spreadsheet_id,legacy_sheet_id,legacy_sheet_name,continuous_sheet_id,continuous_sheet_name,raw_sheet_id,raw_sheet_name,detail_sheet_id,detail_sheet_name,claim_token,source_revision,state,prepared_at) SELECT 'book',1,'old',2,'draft',3,'raw_new',4,'detail_new','claim',revision,'PREPARED','now' FROM stable_source_revision;
 INSERT INTO continuous_daily_pre_cutover_expenses VALUES('book','exp_old');${cutoverReadySql('claim')}
 UPDATE continuous_daily_cutovers SET state='ACTIVE',activated_at='now';DELETE FROM stable_workbook_claims;
 INSERT INTO continuous_canary_operator(spreadsheet_id,expense_id,document_id,item_id,line_user_id,transaction_date,trace_id,state,created_at,updated_at) VALUES('book','exp_canary_test','doc_canary_test','item_canary_test','CANARY_NO_LINE_test','2026-11-15','trace_canary_test','DRAFT','now','now');
 UPDATE continuous_canary_operator SET state='CONFIRMING';UPDATE continuous_canary_operator SET state='CONFIRMED';UPDATE continuous_canary_operator SET state='ARMED_CONFIRM';
 UPDATE continuous_canary_operator SET state='DUPLICATE_ARMED',duplicate_epoch_id='duplicate_epoch';UPDATE continuous_canary_operator SET state='DUPLICATE_SEEN';UPDATE continuous_canary_operator SET state='DUPLICATE_VERIFIED';UPDATE continuous_canary_operator SET state='UNDOING';UPDATE continuous_canary_operator SET state='UNDONE';UPDATE continuous_canary_operator SET state='ARMED_UNDO';UPDATE continuous_canary_operator SET state='VERIFIED';`);
 route.assertContinuousDailyActivated=async()=>({sheet:'draft',sheetId:2});
 const make=(id,version=1)=>{h.sqlite.prepare("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES(?,?, 'owner','new',100,'transfer','SHOP_BANK','ingredients','2026-11-15',?,'now',?)").run(id,`${id}_message`,version===1?'CONFIRMED':'CANCELLED',version);h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES(?,'EXPENSE',?,?,?,'PENDING','2021')").run(`${id}_1`,id,1,`${id}_trace`);if(version===2)h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES(?,'EXPENSE',?,2,?,'PENDING','2022')").run(`${id}_2`,id,`${id}_trace`);};
 return {...h,make,close(){route.assertContinuousDailyActivated=original;h.close()}};
}
test('automatically arms only one new confirmed expense, never an older source',async()=>{const h=fixture();try{
 h.make('exp_new');assert.equal(await armNextContinuousExpense(h.env),true);
 const row=h.sqlite.prepare("SELECT target_key,target_version,state FROM stable_recovery_epochs").get();assert.deepEqual({...row},{target_key:'exp_new',target_version:1,state:'ARMED'});
 assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM continuous_normal_recovery_admissions').get().n,1);assert.equal(await armNextContinuousExpense(h.env),false);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='oldjob'").get().status,'PENDING');
 }finally{h.close()}});
test('canary verification and opt-in gate are required',async()=>{const h=fixture();try{h.make('exp_new');h.env.CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED='false';assert.equal(await armNextContinuousExpense(h.env),false);h.env.CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED='true';h.sqlite.exec('DROP TRIGGER continuous_canary_transition; UPDATE continuous_canary_operator SET state=\'ABORTED\'');assert.equal(await armNextContinuousExpense(h.env),false);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_recovery_epochs').get().n,0);}finally{h.close()}});
test('unwritten Undo version is selected while original untouched pending job stays parked',async()=>{const h=fixture();try{h.make('exp_new',2);assert.equal(await armNextContinuousExpense(h.env),true);const row=h.sqlite.prepare('SELECT target_key,target_version FROM stable_recovery_epochs').get();assert.deepEqual({...row},{target_key:'exp_new',target_version:2});assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='exp_new_1'").get().status,'PENDING');}finally{h.close()}});
test('a prior failed delivery or active workbook claim blocks automatic admission',async()=>{for(const mode of ['failure','claim']){const h=fixture();try{h.make('exp_new');if(mode==='failure')h.sqlite.exec("INSERT INTO failed_jobs(id,queue_name,job_key,trace_id,payload_json,error,status,created_at,updated_at) VALUES('failure','malipang-jobs','EXPENSE:exp_new:1','trace','{}','ERROR','OPEN','now','now')");else h.sqlite.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','other','HELD','now','now')");assert.equal(await armNextContinuousExpense(h.env),false);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_recovery_epochs').get().n,0);}finally{h.close()}}});
test('uncertain provider intent or altered fencing trigger blocks all automatic admissions',async()=>{for(const mode of ['intent','trigger']){const h=fixture();try{
 h.make('exp_new');if(mode==='intent')h.sqlite.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE','exp_other','DAILY',2,'draft',1,?,'other-token','IN_FLIGHT','now')").run('a'.repeat(64));else h.sqlite.exec('DROP TRIGGER continuous_expense_projection_target_fence');
 assert.equal(await armNextContinuousExpense(h.env),false);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_recovery_epochs').get().n,0);
 }finally{h.close()}}});
test('a previously closed target is never automatically rearmed even if its job remains pending',async()=>{const h=fixture();try{h.make('exp_new');assert.equal(await armNextContinuousExpense(h.env),true);h.sqlite.exec("UPDATE stable_recovery_epochs SET state='COMPLETE'");assert.equal(await armNextContinuousExpense(h.env),false);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_recovery_epochs').get().n,1);}finally{h.close()}});
test('a new Undo with a version gap is held without writing and reports the exact reason to the owner',async()=>{const h=fixture();try{
 h.make('exp_new',2);h.sqlite.exec("UPDATE expense_events SET version=3 WHERE expense_id='exp_new'; INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('exp_new_3','EXPENSE','exp_new',3,'gaptrace','PENDING',0,'2023')");
 assert.equal(await holdContinuousUndoVersionGaps(h.env),1);const j=h.sqlite.prepare("SELECT status,last_error FROM sync_jobs WHERE job_id='exp_new_3'").get();assert.deepEqual({...j},{status:'REVIEW',last_error:'CONTINUOUS_UNDO_VERSION_GAP'});assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='oldjob'").get().status,'PENDING');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_recovery_epochs').get().n,0);
 const notifications=[];Object.assign(h.env,{LINE_OWNER_USER_ID:'owner',SHADOW_LINE_OUTPUT:'true'});h.env.JOB_QUEUE.send=async job=>notifications.push(job);assert.equal(await sweepSyncFailureAlerts(h.env),1);assert.match(notifications[0].messages[0].text,/รุ่นของรายการยกเลิกไม่ต่อเนื่อง/);assert.match(notifications[0].messages[0].text,/CONTINUOUS_UNDO_VERSION_GAP/);
 }finally{h.close()}});
test('attempted post-cutover version-gap is held while pre-cutover gap is untouched',async()=>{const h=fixture();try{
 h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=3 WHERE expense_id='exp_old'; INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('oldgap','EXPENSE','exp_old',3,'oldgap','PENDING',0,'now')");h.make('exp_new',2);h.sqlite.exec("UPDATE expense_events SET version=3 WHERE expense_id='exp_new'; INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('newgap','EXPENSE','exp_new',3,'newgap','PENDING',1,'now')");
 assert.equal(await holdContinuousUndoVersionGaps(h.env),1);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='oldgap'").get().status,'PENDING');assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='newgap'").get().status,'REVIEW');
 }finally{h.close()}});
test('version-gap Undo is not held while another version of that expense is active',async()=>{for(const mode of ['epoch','processing']){const h=fixture();try{
 h.make('exp_new',2);h.sqlite.exec("UPDATE expense_events SET version=3 WHERE expense_id='exp_new'; INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('newgap','EXPENSE','exp_new',3,'trace3','PENDING',0,'now')");
 if(mode==='epoch')h.sqlite.exec("INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-active','book','ARMED','EXPENSE','exp_new',1,'now','now')");
 else h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='worker',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='exp_new_1'");
 assert.equal(await holdContinuousUndoVersionGaps(h.env),0);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='newgap'").get().status,'PENDING');
 }finally{h.close()}}});
test('confirmed version above v1 is held with a specific alert after no matching work remains active',async()=>{const h=fixture();try{
 h.make('exp_new');h.sqlite.exec("UPDATE expense_events SET version=2 WHERE expense_id='exp_new'; INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('confirmgap','EXPENSE','exp_new',2,'trace2','PENDING',1,'now')");
 assert.equal(await holdContinuousConfirmationVersionGaps(h.env),1);assert.deepEqual({...h.sqlite.prepare("SELECT status,last_error FROM sync_jobs WHERE job_id='confirmgap'").get()},{status:'REVIEW',last_error:'CONTINUOUS_CONFIRM_VERSION_GAP'});
 const sent=[];Object.assign(h.env,{LINE_OWNER_USER_ID:'owner',SHADOW_LINE_OUTPUT:'true'});h.env.JOB_QUEUE.send=async job=>sent.push(job);assert.equal(await sweepSyncFailureAlerts(h.env),1);assert.match(sent[0].messages[0].text,/CONTINUOUS_CONFIRM_VERSION_GAP/);
 }finally{h.close()}});
test('confirmed version gap does not interrupt the same expense active epoch or processing job',async()=>{for(const mode of ['epoch','processing']){const h=fixture();try{
 h.make('exp_new');h.sqlite.exec("UPDATE expense_events SET version=2 WHERE expense_id='exp_new'; INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('confirmgap','EXPENSE','exp_new',2,'trace2','PENDING','now')");
 if(mode==='epoch')h.sqlite.exec("INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-active','book','ARMED','EXPENSE','exp_new',1,'now','now')");
 else h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='worker',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='exp_new_1'");
 assert.equal(await holdContinuousConfirmationVersionGaps(h.env),0);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='confirmgap'").get().status,'PENDING');
 }finally{h.close()}}});
test('a confirmed pre-cutover expense is held once and owner receives its specific reason',async()=>{const h=fixture();try{
 h.make('exp_new');assert.equal(await holdContinuousHistoricalExpenses(h.env),1);assert.equal(await holdContinuousHistoricalExpenses(h.env),0);
 assert.deepEqual({...h.sqlite.prepare("SELECT status,last_error FROM sync_jobs WHERE job_id='oldjob'").get()},{status:'REVIEW',last_error:'CONTINUOUS_PRE_CUTOVER_UNRECONCILED'});
 assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='exp_new_1'").get().status,'PENDING');
 const sent=[];Object.assign(h.env,{LINE_OWNER_USER_ID:'owner',SHADOW_LINE_OUTPUT:'true'});h.env.JOB_QUEUE.send=async job=>sent.push(job);
 assert.equal(await sweepSyncFailureAlerts(h.env),1);assert.match(sent[0].messages[0].text,/CONTINUOUS_PRE_CUTOVER_UNRECONCILED/);assert.equal(await sweepSyncFailureAlerts(h.env),0);
 }finally{h.close()}});
test('historical hold leaves cancelled sources, leased jobs, other entities and busy claims untouched',async()=>{for(const mode of ['cancelled','leased','claim','gate']){const h=fixture();try{
 if(mode==='cancelled')h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=2 WHERE expense_id='exp_old'");
 else if(mode==='leased')h.sqlite.exec("UPDATE sync_jobs SET lease_token='worker',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='oldjob'");
 else if(mode==='claim')h.sqlite.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','other','HELD','now','now')");
 else h.env.CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED='false';
 h.sqlite.exec("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('attendance','ATTENDANCE_EVENT','old',1,'trace','PENDING','now')");
 assert.equal(await holdContinuousHistoricalExpenses(h.env),0);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='oldjob'").get().status,'PENDING');assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='attendance'").get().status,'PENDING');
 }finally{h.close()}}});
for(const status of ['OPEN','RESOLVED'])test(`new pending expense with ${status.toLowerCase()} failure history is held and alerts owner once`,async()=>{const h=fixture();try{
 h.make('exp_new');h.sqlite.prepare("INSERT INTO failed_jobs(id,queue_name,job_key,trace_id,payload_json,error,status,created_at,updated_at) VALUES('failure','malipang-jobs','EXPENSE:exp_new:1','failure-trace','{}','TRANSIENT',?,'now','now')").run(status);
 assert.equal(await holdContinuousExpenseHistory(h.env),1);assert.equal(await holdContinuousExpenseHistory(h.env),0);
 assert.deepEqual({...h.sqlite.prepare("SELECT status,last_error FROM sync_jobs WHERE job_id='exp_new_1'").get()},{status:'REVIEW',last_error:'CONTINUOUS_SYNC_HISTORY_UNRECONCILED'});
 assert.equal(h.sqlite.prepare("SELECT status FROM failed_jobs WHERE id='failure'").get().status,status);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_projection_writes').get().n,0);
 const sent=[];Object.assign(h.env,{LINE_OWNER_USER_ID:'owner',SHADOW_LINE_OUTPUT:'true'});h.env.JOB_QUEUE.send=async job=>sent.push(job);
 assert.equal(await sweepSyncFailureAlerts(h.env),1);assert.match(sent[0].messages[0].text,/CONTINUOUS_SYNC_HISTORY_UNRECONCILED/);assert.equal(await sweepSyncFailureAlerts(h.env),0);
 }finally{h.close()}});
test('history hold does not interrupt an active matching epoch or a leased job',async()=>{for(const mode of ['epoch','lease','processing']){const h=fixture();try{
 h.make('exp_new');h.sqlite.exec("INSERT INTO failed_jobs(id,queue_name,job_key,trace_id,payload_json,error,status,created_at,updated_at) VALUES('failure','malipang-jobs','EXPENSE:exp_new:1','trace','{}','ERROR','OPEN','now','now')");
 if(mode==='epoch')h.sqlite.exec("INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-active','book','ARMED','EXPENSE','exp_new',1,'now','now')");
 if(mode==='lease')h.sqlite.exec("UPDATE sync_jobs SET lease_token='worker',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='exp_new_1'");
 if(mode==='processing')h.sqlite.exec("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_token,lease_until) VALUES('other','EXPENSE','exp_new',2,'trace2','PROCESSING','now','worker','2099-01-01T00:00:00.000Z')");
 assert.equal(await holdContinuousExpenseHistory(h.env),0);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='exp_new_1'").get().status,'PENDING');
 }finally{h.close()}}});
test('an attempted, previously epoch-targeted, or version-conflicted pending job is held while a fresh job remains eligible',async()=>{for(const mode of ['attempt','prior-epoch','extra-version']){const h=fixture();try{
 h.make('exp_new');h.make('exp_fresh');
 if(mode==='attempt')h.sqlite.exec("UPDATE sync_jobs SET attempt_count=1 WHERE job_id='exp_new_1'");
 if(mode==='prior-epoch')h.sqlite.exec("INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-old','book','COMPLETE','EXPENSE','exp_new',1,'now','now')");
 if(mode==='extra-version')h.sqlite.exec("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('other','EXPENSE','exp_new',3,'trace2','COMPLETED','now')");
 assert.equal(await holdContinuousExpenseHistory(h.env),1);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='exp_new_1'").get().status,'REVIEW');assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='exp_fresh_1'").get().status,'PENDING');assert.equal(await armNextContinuousExpense(h.env),true);assert.equal(h.sqlite.prepare("SELECT target_key FROM stable_recovery_epochs WHERE state='ARMED'").get().target_key,'exp_fresh');
 }finally{h.close()}}});
test('history hold preserves a superseded v1 while a safe no-write v2 Undo is eligible',async()=>{for(const mode of ['old-pending','old-completed']){const h=fixture();try{
 h.make('exp_new',2);
 if(mode==='old-completed')h.sqlite.exec("UPDATE sync_jobs SET status='COMPLETED',last_error='SUPERSEDED_BEFORE_DISPATCH' WHERE job_id='exp_new_1'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-old','book','COMPLETE','EXPENSE','exp_new',1,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at,verified_at) VALUES('old-operation','epoch-old','VERIFIED','now','now')");
 assert.equal(await holdContinuousExpenseHistory(h.env),0);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='exp_new_1'").get().status,mode==='old-pending'?'PENDING':'COMPLETED');assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='exp_new_2'").get().status,'PENDING');
 assert.equal(await armNextContinuousExpense(h.env),true);assert.equal(h.sqlite.prepare("SELECT target_version FROM stable_recovery_epochs WHERE state='ARMED'").get().target_version,2);
 }finally{h.close()}}});
test('unreconciled post-cutover v2 predecessor is held without changing the older job or provider intent',async()=>{for(const mode of ['missing','review','mapping','unproven-written','prior-cancel']){const h=fixture();try{
 h.make('exp_new',2);
 if(mode==='missing')h.sqlite.exec("DELETE FROM sync_jobs WHERE job_id='exp_new_1'");
 if(mode==='review')h.sqlite.exec("UPDATE sync_jobs SET status='REVIEW',last_error='OTHER' WHERE job_id='exp_new_1'");
 if(mode==='mapping')h.sqlite.exec("INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES('old','exp_new',4)");
 if(mode==='unproven-written'){h.sqlite.exec("UPDATE sync_jobs SET status='COMPLETED' WHERE job_id='exp_new_1'");h.sqlite.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE','exp_new','DAILY',2,'draft',1,?,'old-op','IN_FLIGHT','now')").run('a'.repeat(64));h.sqlite.exec("UPDATE stable_projection_writes SET state='VERIFIED' WHERE entity_id='exp_new'");}
 if(mode==='prior-cancel'){
  // A prior cancellation intent is enough to require reconciliation even if
  // the source version still looks like an untouched Undo.
  const hash='a'.repeat(64);h.sqlite.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE','exp_new','DAILY',2,'draft',1,?,'old-op','IN_FLIGHT','now')").run(hash);h.sqlite.exec("UPDATE stable_projection_writes SET state='VERIFIED' WHERE entity_id='exp_new'");
  h.sqlite.prepare("INSERT INTO stable_expense_projection_preimages(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,preimage_width,preimage_digest,created_at) VALUES('book','EXPENSE','exp_new','DAILY',2,'draft',1,?,29,?,'now')").run(hash,hash);
  h.sqlite.prepare("INSERT INTO stable_expense_cancellation_writes(spreadsheet_id,entity_type,entity_id,projection,cancellation_version,previous_version,preimage_digest,operation_token,state,created_at,updated_at) VALUES('book','EXPENSE','exp_new','DAILY',2,1,?,'cancel-op','IN_FLIGHT','now','now')").run(hash);
 }
 const old=h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='exp_new_1'").get();assert.equal(await holdContinuousExpenseHistory(h.env),1);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='exp_new_2'").get().status,'REVIEW');assert.deepEqual(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='exp_new_1'").get(),old);
 }finally{h.close()}}});
test('post-cutover confirmed v1 with an orphan projection or row mapping is held rather than silently skipped',async()=>{for(const mode of ['projection','mapping']){const h=fixture();try{
 h.make('exp_new');if(mode==='mapping')h.sqlite.exec("INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES('old','exp_new',4)");else h.sqlite.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE','exp_new','DAILY',2,'draft',1,?,'orphan-op','IN_FLIGHT','now')").run('a'.repeat(64));
 assert.equal(await holdContinuousExpenseHistory(h.env),1);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='exp_new_1'").get().status,'REVIEW');
 }finally{h.close()}}});
test('history hold preserves a v2 Undo with a verified and authenticated v1 projection',async()=>{const h=fixture();try{
 h.make('exp_new',2);const hash='a'.repeat(64);h.sqlite.exec("UPDATE sync_jobs SET status='COMPLETED' WHERE job_id='exp_new_1'");
 h.sqlite.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE','exp_new','DAILY',2,'draft',1,?,'old-operation','IN_FLIGHT','now')").run(hash);h.sqlite.exec("UPDATE stable_projection_writes SET state='VERIFIED' WHERE entity_id='exp_new'");
 h.sqlite.prepare("INSERT INTO stable_expense_projection_preimages(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,preimage_width,preimage_digest,created_at) VALUES('book','EXPENSE','exp_new','DAILY',2,'draft',1,?,29,?,'now')").run(hash,hash);
 h.sqlite.exec("INSERT INTO atomic_daily_marker_reservations(spreadsheet_id,sheet_id,marker,entity_id,source_version,operation_token,created_at) VALUES('book',2,'old-marker','exp_new',1,'old-operation','now')");
 assert.equal(await holdContinuousExpenseHistory(h.env),0);assert.equal(await armNextContinuousExpense(h.env),true);assert.equal(h.sqlite.prepare("SELECT target_version FROM stable_recovery_epochs WHERE state='ARMED'").get().target_version,2);
 }finally{h.close()}});
test('expired exact normal epoch holds an uncertain provider intent and alerts without permitting late job completion',async()=>{const h=fixture();try{
 h.make('exp_new');assert.equal(await armNextContinuousExpense(h.env),true);const epoch=h.sqlite.prepare("SELECT epoch_id FROM stable_recovery_epochs WHERE state='ARMED'").get().epoch_id;
 h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease-token',lease_until='2001-01-01T00:00:00.000Z' WHERE job_id='exp_new_1'; INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','claim-operation','HELD','now','now')");
 h.sqlite.prepare("INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-operation',?,'ADMITTED','now')").run(epoch);
 h.sqlite.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE','exp_new','DAILY',2,'draft',1,?,'claim-operation','IN_FLIGHT','now')").run('a'.repeat(64));
 assert.equal(await holdContinuousExpiredLease(h.env),1);assert.equal(await holdContinuousExpiredLease(h.env),0);
 assert.deepEqual({...h.sqlite.prepare("SELECT status,last_error,lease_token FROM sync_jobs WHERE job_id='exp_new_1'").get()},{status:'REVIEW',last_error:'CONTINUOUS_SYNC_LEASE_EXPIRED_UNCERTAIN',lease_token:'lease-token'});
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_workbook_claims").get().state,'REVIEW');assert.equal(h.sqlite.prepare("SELECT state FROM stable_recovery_epochs WHERE epoch_id=?").get(epoch).state,'REVIEW');assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes").get().state,'IN_FLIGHT');
 assert.equal(h.sqlite.prepare("UPDATE sync_jobs SET status='COMPLETED' WHERE job_id='exp_new_1' AND status='PROCESSING' AND lease_token='lease-token'").run().changes,0);
 const sent=[];Object.assign(h.env,{LINE_OWNER_USER_ID:'owner',SHADOW_LINE_OUTPUT:'true'});h.env.JOB_QUEUE.send=async job=>sent.push(job);assert.equal(await sweepSyncFailureAlerts(h.env),2);assert.ok(sent.every(x=>x.messages[0].text.includes('CONTINUOUS_SYNC_LEASE_EXPIRED_UNCERTAIN')));
 }finally{h.close()}});
test('expired target fences epoch while preserving an unlinked foreign claim or no claim',async()=>{for(const mode of ['foreign','none']){const h=fixture();try{
 h.make('exp_new');assert.equal(await armNextContinuousExpense(h.env),true);const epoch=h.sqlite.prepare("SELECT epoch_id FROM stable_recovery_epochs WHERE state='ARMED'").get().epoch_id;
 h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease-token',lease_until='2001-01-01T00:00:00.000Z' WHERE job_id='exp_new_1'");if(mode==='foreign')h.sqlite.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','foreign-claim','HELD','before','before')");
 assert.equal(await holdContinuousExpiredLease(h.env),1);assert.equal(h.sqlite.prepare("SELECT state FROM stable_recovery_epochs WHERE epoch_id=?").get(epoch).state,'REVIEW');
 const claim=h.sqlite.prepare("SELECT state,operation_token,updated_at FROM stable_workbook_claims").get();if(mode==='foreign')assert.deepEqual({...claim},{state:'HELD',operation_token:'foreign-claim',updated_at:'before'});else assert.equal(claim,undefined);
 }finally{h.close()}}});
test('unexpired lease is not held and expiry of an unrelated historical epoch is untouched',async()=>{const h=fixture();try{
 h.make('exp_new');assert.equal(await armNextContinuousExpense(h.env),true);h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease-token',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='exp_new_1'");
 assert.equal(await holdContinuousExpiredLease(h.env),0);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='exp_new_1'").get().status,'PROCESSING');
 }finally{h.close()}});
