import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url),{chooseContinuousDailyCutover,continuousDailyCutoverStatements}=require('../dist/sheets/continuous-daily-cutover.js');
const {assertContinuousDailyActivated}=require('../dist/sheets/continuous-daily-route.js');
const {claimSheetSyncJob,syncJob,reconcileExpenseItemRows}=require('../dist/sheets/sync.js');
const worker=require('../dist/index.js').default;

function fixture(withReports=true){
 const h=expenseSqlite();h.env.GOOGLE_SPREADSHEET_ID='book';
 h.sqlite.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','claim','HELD','now','now')");
 if(withReports)for(const stage of ['VIEWS','DAILY_J','REPORTS']){h.sqlite.prepare("INSERT INTO continuous_report_cutover_attempts(spreadsheet_id,stage,operation_token,manifest_digest,manifest_json,cell_count,state,created_at,updated_at) VALUES('book',?,'claim',?,'[{}]',1,'IN_FLIGHT','now','now')").run(stage,'a'.repeat(64));h.sqlite.prepare("UPDATE continuous_report_cutover_attempts SET state='VERIFIED' WHERE stage=?").run(stage);}
 const expense=id=>h.sqlite.prepare("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES(?,?, 'owner','test',100,'transfer','SHOP_BANK','ingredients','2026-10-09','CONFIRMED','now',1)").run(id,`message-${id}`);
 const prepare=()=>h.sqlite.exec("INSERT INTO continuous_daily_cutovers(spreadsheet_id,legacy_sheet_id,legacy_sheet_name,continuous_sheet_id,continuous_sheet_name,raw_sheet_id,raw_sheet_name,detail_sheet_id,detail_sheet_name,claim_token,source_revision,state,prepared_at) SELECT 'book',1,'old',2,'new',3,'raw_new',4,'detail_new','claim',revision,'PREPARED','now' FROM stable_source_revision WHERE singleton=1");
 const snapshot=()=>h.sqlite.exec("INSERT INTO continuous_daily_pre_cutover_expenses(spreadsheet_id,expense_id) SELECT 'book',expense_id FROM expense_events WHERE status<>'CANCELLED'");
 const activate=()=>h.sqlite.exec("UPDATE continuous_daily_cutovers SET state='ACTIVE',activated_at='now' WHERE spreadsheet_id='book'");
 const job=entityKey=>({kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey,entityVersion:1,traceId:'fixture'});
 const journal=(id,sheetId,sheet,state='VERIFIED')=>h.sqlite.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE',?,'DAILY',?,?,1,?,'token',?,'now')").run(id,sheetId,sheet,'a'.repeat(64),state);
 return {...h,expense,prepare,snapshot,activate,job,journal};
}

test('activation requires an unchanged source revision, held claim, complete snapshot and no unresolved intents',()=>{
 for(const bad of ['missing','changed','claim','intent']){const h=fixture();try{
  h.expense('exp_before');h.prepare();if(bad!=='missing')h.snapshot();
  if(bad==='changed')h.expense('exp_during');
  if(bad==='claim')h.sqlite.exec("UPDATE stable_workbook_claims SET state='REVIEW' WHERE spreadsheet_id='book'");
  if(bad==='intent')h.journal('exp_before',1,'old','IN_FLIGHT');
  assert.throws(()=>h.activate(),/continuous daily cutover activation rejected/,bad);
 }finally{h.close();}}
});

test('cutover cannot activate without both verified report stages',()=>{const h=fixture(false);try{
 h.expense('exp_before');h.prepare();h.snapshot();assert.throws(()=>h.activate(),/continuous daily cutover activation rejected/);
 }finally{h.close();}});
test('config alone cannot activate route; exact bound workbook, targets, stages and triggers are required',async()=>{const h=fixture();try{
 Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',STABLE_CANCELLATION_PREIMAGE_ENABLED:'true',CONTINUOUS_DAILY_ENABLED:'true',SHEET_EXPENSE_DAILY:'old',SHEET_EXPENSE_RAW:'raw_old',SHEET_PURCHASE_DETAILS:'detail_old',CONTINUOUS_DAILY_SHEET:'new',CONTINUOUS_DAILY_SHEET_ID:'2',CONTINUOUS_RAW_SHEET:'raw_new',CONTINUOUS_RAW_SHEET_ID:'3',CONTINUOUS_DETAIL_SHEET:'detail_new',CONTINUOUS_DETAIL_SHEET_ID:'4'});
 await assert.rejects(assertContinuousDailyActivated(h.env),/CONTINUOUS_DAILY_NOT_READY/);h.prepare();h.snapshot();h.activate();
 assert.deepEqual(await assertContinuousDailyActivated(h.env),{sheet:'new',sheetId:2});
 h.env.CONTINUOUS_RAW_SHEET_ID='33';await assert.rejects(assertContinuousDailyActivated(h.env),/CONTINUOUS_DAILY_NOT_READY/);h.env.CONTINUOUS_RAW_SHEET_ID='3';
 h.sqlite.exec('DROP TRIGGER continuous_report_attempt_no_delete');await assert.rejects(assertContinuousDailyActivated(h.env),/CONTINUOUS_DAILY_NOT_READY/);
 }finally{h.close();}});

test('snapshot creates a durable identity boundary and rejects later tampering',()=>{const h=fixture();try{
 h.expense('exp_before');h.prepare();h.snapshot();h.activate();h.expense('exp_after');
 assert.throws(()=>h.sqlite.exec("INSERT INTO continuous_daily_pre_cutover_expenses VALUES('book','exp_after')"),/snapshot insert rejected/);
 assert.throws(()=>h.sqlite.exec("DELETE FROM continuous_daily_pre_cutover_expenses"),/snapshot retained/);
 assert.throws(()=>h.sqlite.exec("UPDATE continuous_daily_cutovers SET state='PREPARED',activated_at=NULL"),/cutover activation rejected/);
 }finally{h.close();}});

test('pre-cutover without journal is held, old verified stays old, and new source chooses new',async()=>{const h=fixture();try{
 h.expense('exp_hold');h.expense('exp_old');h.prepare();h.snapshot();h.journal('exp_old',1,'old');h.activate();h.expense('exp_new');
 assert.deepEqual(await chooseContinuousDailyCutover(h.env,h.job('exp_hold')),{status:'HOLD',reason:'PRE_CUTOVER_UNJOURNALED'});
 assert.deepEqual(await chooseContinuousDailyCutover(h.env,h.job('exp_old')),{status:'LEGACY',sheet:'old',sheetId:1});
 assert.deepEqual(await chooseContinuousDailyCutover(h.env,h.job('exp_new')),{status:'CONTINUOUS',sheet:'new',sheetId:2});
 h.journal('exp_new',2,'new','IN_FLIGHT');assert.deepEqual(await chooseContinuousDailyCutover(h.env,h.job('exp_new')),{status:'HOLD',reason:'PREVIOUS_INTENT_UNRESOLVED'});
 }finally{h.close();}});
test('active cutover fences new legacy expense reservations while retaining earlier verified history',()=>{const h=fixture();try{
 h.expense('exp_prior');h.journal('exp_prior',1,'old');h.prepare();h.snapshot();h.activate();
 h.expense('exp_next');assert.throws(()=>h.journal('exp_next',1,'old','IN_FLIGHT'),/continuous expense projection target rejected/);
 h.journal('exp_next',2,'new','IN_FLIGHT');
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE entity_id='exp_prior'").get().state,'VERIFIED');
 const insert=h.sqlite.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES(?,?,?,?,?,?,1,?,'token','IN_FLIGHT','now')");
 assert.throws(()=>insert.run('book','EXPENSE','exp_raw','EXPENSE_RAW',10,'old_raw','a'.repeat(64)),/continuous expense projection target rejected/);
 assert.throws(()=>insert.run('book','EXPENSE','exp_detail','DETAIL',11,'old_detail','a'.repeat(64)),/continuous expense projection target rejected/);
 insert.run('book','EXPENSE','exp_raw','EXPENSE_RAW',3,'raw_new','a'.repeat(64));
 insert.run('book','EXPENSE','exp_detail','DETAIL',4,'detail_new','a'.repeat(64));
 insert.run('book','PERSONAL_USE','personal','PERSONAL_RAW',10,'personal_sheet','a'.repeat(64));
 insert.run('other-book','EXPENSE','exp_other','DAILY',1,'old','a'.repeat(64));
 }finally{h.close();}});
test('legacy reservation and activation serialize safely in either order',()=>{for(const legacyFirst of [true,false]){const h=fixture();try{
 h.expense('exp_race');h.prepare();h.snapshot();
 if(legacyFirst){h.journal('exp_race',1,'old','IN_FLIGHT');assert.throws(()=>h.activate(),/cutover activation rejected/);assert.equal(h.sqlite.prepare('SELECT state FROM continuous_daily_cutovers').get().state,'PREPARED');}
 else{h.activate();assert.throws(()=>h.journal('exp_race',1,'old','IN_FLIGHT'),/projection target rejected/);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_projection_writes WHERE entity_id=\'exp_race\'').get().n,0);}
 }finally{h.close();}}});

test('legacy direct expense lease and activation are mutually fenced in D1',async()=>{const h=fixture();try{
 h.expense('exp_race');const job=h.job('exp_race');
 // A schema created after a pre-migration inspection blocks the stale CAS.
 assert.equal(await claimSheetSyncJob(h.env,job,Date.now(),false),null);
 assert.ok(await claimSheetSyncJob(h.env,job,Date.now(),true));
 h.prepare();h.snapshot();assert.throws(()=>h.activate(),/continuous expense cutover processing/);
 h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_until=NULL,lease_token=NULL WHERE entity_key='exp_race'");h.activate();
 assert.equal(await claimSheetSyncJob(h.env,job,Date.now(),true),null);
 await assert.rejects(syncJob(h.env,job),/CONTINUOUS_DAILY_LEGACY_WRITE_BLOCKED/);
 await assert.rejects(reconcileExpenseItemRows(h.env,'exp_race'),/CONTINUOUS_DAILY_LEGACY_WRITE_BLOCKED/);
 }finally{h.close();}});

test('a prepared or active cutover blocks accidentally disabled continuous configuration',async()=>{const h=fixture();try{
 h.env.CONTINUOUS_DAILY_ENABLED='false';h.expense('exp_before');h.prepare();
 await assert.rejects(assertContinuousDailyActivated(h.env),/CONTINUOUS_DAILY_LEGACY_WRITE_BLOCKED/);
 h.snapshot();h.activate();await assert.rejects(assertContinuousDailyActivated(h.env),/CONTINUOUS_DAILY_LEGACY_WRITE_BLOCKED/);
 }finally{h.close();}});

test('disabled cutover config parks expense queue work without attempting legacy writes',async()=>{for(const stable of ['true','false']){const h=fixture();try{
 h.prepare();h.snapshot();h.activate();h.expense('exp_queued');
 Object.assign(h.env,{STABLE_PHASE1_ENABLED:stable,CONTINUOUS_DAILY_ENABLED:'false',SHEETS_SYNC_ENABLED:'true',SHEET_EXPENSE_DAILY:'old'});
 let acked=0,retried=0;
 await worker.queue({queue:'malipang-jobs',messages:[{body:h.job('exp_queued'),ack(){acked++},retry(){retried++}}]},h.env,{});
 assert.equal(acked,1);assert.equal(retried,0);
 assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE entity_key='exp_queued'").get().status,'PENDING');
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM failed_jobs').get().n,0);
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_projection_writes').get().n,0);
 }finally{h.close();}}});

test('pre-cutover cancelled records leave no boundary reference and cannot be mistaken for new',async()=>{const h=fixture();try{
 h.expense('exp_cancelled');h.sqlite.exec("UPDATE expense_events SET status='CANCELLED' WHERE expense_id='exp_cancelled'");h.prepare();h.snapshot();h.activate();
 assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM continuous_daily_pre_cutover_expenses WHERE expense_id='exp_cancelled'").get().n,0);
 assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM continuous_daily_post_cutover_expenses WHERE expense_id='exp_cancelled'").get().n,0);
 h.sqlite.exec("UPDATE expense_events SET status='CONFIRMED' WHERE expense_id='exp_cancelled'");
 assert.deepEqual(await chooseContinuousDailyCutover(h.env,h.job('exp_cancelled')),{status:'HOLD',reason:'SOURCE_ORIGIN_UNPROVEN'});
 }finally{h.close();}});

test('cutover batch captures only noncancelled prior sources and rolls back if source changes',async()=>{for(const changed of [false,true]){const h=fixture();try{
 h.expense('exp_cancelled');h.sqlite.exec("UPDATE expense_events SET status='CANCELLED' WHERE expense_id='exp_cancelled'");h.expense('exp_waiting');
 const revision=h.sqlite.prepare('SELECT revision FROM stable_source_revision WHERE singleton=1').get().revision;
 const statements=continuousDailyCutoverStatements(h.env,{book:'book',legacySheetId:1,legacySheetName:'old',continuousSheetId:2,continuousSheetName:'new',rawSheetId:3,rawSheetName:'raw_new',detailSheetId:4,detailSheetName:'detail_new',claim:'claim',revision,mustBeCancelledOrAbsentExpenseIds:['exp_cancelled','exp_missing']});
 if(changed)h.expense('exp_changed');
 if(changed){await assert.rejects(h.DB.batch(statements));assert.equal(h.sqlite.prepare('SELECT count(*) n FROM continuous_daily_cutovers').get().n,0);}
 else{
  await h.DB.batch(statements);assert.equal(h.sqlite.prepare("SELECT state FROM continuous_daily_cutovers WHERE spreadsheet_id='book'").get().state,'ACTIVE');
  assert.equal(h.sqlite.prepare("SELECT count(*) n FROM continuous_daily_pre_cutover_expenses WHERE expense_id='exp_cancelled'").get().n,0);
  assert.equal(h.sqlite.prepare("SELECT count(*) n FROM continuous_daily_pre_cutover_expenses WHERE expense_id='exp_waiting'").get().n,1);
 }
 }finally{h.close();}}});

test('cancelled v2 is excluded without requiring or performing deletion',async()=>{const h=fixture();try{
 h.expense('exp_target');h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=2 WHERE expense_id='exp_target'");const revision=h.sqlite.prepare('SELECT revision FROM stable_source_revision WHERE singleton=1').get().revision;
 const statements=continuousDailyCutoverStatements(h.env,{book:'book',legacySheetId:1,legacySheetName:'old',continuousSheetId:2,continuousSheetName:'new',rawSheetId:3,rawSheetName:'raw_new',detailSheetId:4,detailSheetName:'detail_new',claim:'claim',revision,mustBeCancelledOrAbsentExpenseIds:['exp_target','exp_missing']});
 await h.DB.batch(statements);assert.equal(h.sqlite.prepare("SELECT status FROM expense_events WHERE expense_id='exp_target'").get().status,'CANCELLED');
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM continuous_daily_pre_cutover_expenses WHERE expense_id='exp_target'").get().n,0);
 }finally{h.close();}});
test('a target still confirmed blocks atomic activation with no persisted receipt IDs',async()=>{const h=fixture();try{
 h.expense('exp_target');const revision=h.sqlite.prepare('SELECT revision FROM stable_source_revision WHERE singleton=1').get().revision;
 const statements=continuousDailyCutoverStatements(h.env,{book:'book',legacySheetId:1,legacySheetName:'old',continuousSheetId:2,continuousSheetName:'new',rawSheetId:3,rawSheetName:'raw_new',detailSheetId:4,detailSheetName:'detail_new',claim:'claim',revision,mustBeCancelledOrAbsentExpenseIds:['exp_target','exp_missing']});
 await assert.rejects(h.DB.batch(statements));assert.equal(h.sqlite.prepare('SELECT count(*) n FROM continuous_daily_cutovers').get().n,0);
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM continuous_daily_pre_cutover_expenses').get().n,0);
 }finally{h.close();}});
test('only exact reconciled first-attempt source digest admits an old unjournaled ID',async()=>{const h=fixture();try{
 h.sqlite.exec("UPDATE stable_sync_cutover SET state='ACTIVE',activated_at='now'");h.expense('exp_before');h.prepare();h.snapshot();h.activate();
 h.sqlite.exec("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,lease_until,lease_token) VALUES('old','EXPENSE','exp_before',1,'trace','PROCESSING',1,'now','2099-01-01T00:00:00.000Z','lease')");
 const rev=h.sqlite.prepare('SELECT revision FROM stable_source_revision WHERE singleton=1').get().revision,digest='a'.repeat(64);
 h.sqlite.prepare("INSERT INTO continuous_daily_source_admissions(spreadsheet_id,expense_id,source_version,source_digest,provider_digest,source_revision,claim_token,admitted_at) VALUES('book','exp_before',1,?,?,?,'claim','now')").run(digest,'b'.repeat(64),rev);
 assert.deepEqual(await chooseContinuousDailyCutover(h.env,h.job('exp_before'),digest),{status:'CONTINUOUS',sheet:'new',sheetId:2});
 assert.deepEqual(await chooseContinuousDailyCutover(h.env,h.job('exp_before'),'c'.repeat(64)),{status:'HOLD',reason:'PRE_CUTOVER_UNJOURNALED'});
 }finally{h.close();}});
