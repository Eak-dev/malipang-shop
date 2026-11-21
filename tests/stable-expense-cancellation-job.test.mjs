import {cutoverReadySql} from './helpers/cutover-ready.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url),route=require('../dist/sheets/continuous-daily-route.js'),claims=require('../dist/sheets/stable-workbook-claim.js'),daily=require('../dist/sheets/atomic-daily-cancellation-candidate.js'),ledger=require('../dist/sheets/atomic-expense-ledger-cancellation.js'),ledgerWriter=require('../dist/sheets/atomic-expense-ledger-writer.js'),final=require('../dist/sheets/stable-cancellation-final-check.js'),{runStableExpenseCancellationJob}=require('../dist/sheets/stable-expense-cancellation-job.js');
function fixture({noProjection=false}={}){
 const h=expenseSqlite(),old={activated:route.assertContinuousDailyActivated,target:route.continuousDailyTarget,withClaim:claims.withStableWorkbookClaim,owns:claims.stableWorkbookClaimOwned,daily:daily.cancelAtomicDailyCandidateUnderClaim,ledger:ledger.cancelCarrierLedgerUnderClaim,resolve:ledgerWriter.resolveCarrierLedgerTarget,final:final.verifyStableCancellationFinal},prepare=h.DB.prepare,batch=h.DB.batch;
 h.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run,all=s.all;s.run=async function(){return{...await run.call(this),success:true}};s.all=async function(){return{...await all.call(this),success:true}};return s};h.DB.batch=async function(s){return(await batch.call(this,s)).map(x=>({...x,success:true}))};
 Object.assign(h.env,{GOOGLE_SPREADSHEET_ID:'book',CONTINUOUS_DAILY_ENABLED:'true',CONTINUOUS_DAILY_SHEET:'newdaily',CONTINUOUS_DAILY_SHEET_ID:'8',CONTINUOUS_RAW_SHEET:'newraw',CONTINUOUS_RAW_SHEET_ID:'9',CONTINUOUS_DETAIL_SHEET:'newdetail',CONTINUOUS_DETAIL_SHEET_ID:'10',SHEET_EXPENSE_DAILY:'olddaily',SHEET_EXPENSE_RAW:'oldraw',SHEET_PURCHASE_DETAILS:'olddetail',APP_ENV:'test',RUNTIME_MODE:'shadow'});
 const sourceDigest='a'.repeat(64),preimageDigest='b'.repeat(64);
 h.sqlite.exec(`UPDATE stable_sync_cutover SET state='ACTIVE',activated_at='now'; INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','claim-token','HELD','now','now'); INSERT INTO continuous_daily_cutovers(spreadsheet_id,legacy_sheet_id,legacy_sheet_name,continuous_sheet_id,continuous_sheet_name,raw_sheet_id,raw_sheet_name,detail_sheet_id,detail_sheet_name,claim_token,source_revision,state,prepared_at) SELECT 'book',7,'olddaily',8,'newdaily',9,'newraw',10,'newdetail','claim-token',revision,'PREPARED','now' FROM stable_source_revision; ${cutoverReadySql('claim-token')} UPDATE continuous_daily_cutovers SET state='ACTIVE',activated_at='now'; INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_test','message','owner','item',10000,'transfer','SHOP_BANK','ingredients','2026-10-09','CONFIRMED','now',1); INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('oldjob','EXPENSE','exp_test',1,'old','COMPLETED','now',NULL,NULL); INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('job','EXPENSE','exp_test',2,'trace','PROCESSING','now','2099-01-01T00:00:00.000Z','lease'); UPDATE expense_events SET status='CANCELLED',version=2,updated_at='2026-11-15T00:00:00.000Z' WHERE expense_id='exp_test';`);
 if(!noProjection) for(const [entity,projection,id,name,width] of [['exp_test','DAILY',8,'newdaily',29],['exp_test','EXPENSE_RAW',9,'newraw',26],['exp_test|item_1','DETAIL',10,'newdetail',26]]){
  h.sqlite.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE',?,?,?,?,1,?,'prior','IN_FLIGHT','now')").run(entity,projection,id,name,sourceDigest);
  h.sqlite.prepare("UPDATE stable_projection_writes SET state='VERIFIED' WHERE entity_id=? AND projection=?").run(entity,projection);
  h.sqlite.prepare("INSERT INTO stable_expense_projection_preimages(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,preimage_width,preimage_digest,created_at) VALUES('book','EXPENSE',?,?,?,?,1,?,?,?,'now')").run(entity,projection,id,name,sourceDigest,width,preimageDigest);
 }
 route.continuousDailyTarget=()=>({sheet:'newdaily',sheetId:8});route.assertContinuousDailyActivated=async()=>({sheet:'newdaily',sheetId:8});claims.withStableWorkbookClaim=async(_env,fn)=>fn('claim-token');claims.stableWorkbookClaimOwned=async()=>true;ledgerWriter.resolveCarrierLedgerTarget=(_env,p)=>p==='EXPENSE_RAW'?{sheet:'newraw',sheetId:9}:{sheet:'newdetail',sheetId:10};
 const stages=[];function complete(entity,projection){stages.push(projection);h.sqlite.prepare("INSERT INTO stable_expense_cancellation_writes(spreadsheet_id,entity_type,entity_id,projection,cancellation_version,previous_version,preimage_digest,operation_token,state,created_at,updated_at) VALUES('book','EXPENSE',?,?,2,1,?,'claim-token','IN_FLIGHT','now','now')").run(entity,projection,preimageDigest);h.sqlite.prepare("UPDATE stable_expense_cancellation_writes SET state='VERIFIED' WHERE entity_id=? AND projection=?").run(entity,projection)}
 daily.cancelAtomicDailyCandidateUnderClaim=async()=>complete('exp_test','DAILY');ledger.cancelCarrierLedgerUnderClaim=async(_env,_job,_lease,_claim,projection,item)=>complete(projection==='DETAIL'?`exp_test|${item}`:'exp_test',projection);final.verifyStableCancellationFinal=async()=>{stages.push('FINAL')};
 const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_test',entityVersion:2,traceId:'trace'},run=()=>runStableExpenseCancellationJob(h.env,job,'lease'),resume=()=>h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");
 return {...h,stages,run,resume,close(){route.continuousDailyTarget=old.target;route.assertContinuousDailyActivated=old.activated;claims.withStableWorkbookClaim=old.withClaim;claims.stableWorkbookClaimOwned=old.owns;daily.cancelAtomicDailyCandidateUnderClaim=old.daily;ledger.cancelCarrierLedgerUnderClaim=old.ledger;ledgerWriter.resolveCarrierLedgerTarget=old.resolve;final.verifyStableCancellationFinal=old.final;h.close()}};
}
test('stages DAILY, RAW, DETAIL and final verification before completing job',async()=>{const h=fixture();try{
 for(const expected of ['DAILY','EXPENSE_RAW','DETAIL']){assert.equal(await h.run(),'CONTINUE');assert.equal(h.stages.at(-1),expected);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'PENDING');h.resume();}
 assert.equal(await h.run(),'COMPLETED');assert.deepEqual(h.stages,['DAILY','EXPENSE_RAW','DETAIL','FINAL']);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'COMPLETED');
}finally{h.close()}});
test('unverified cancellation intent holds before any further projection',async()=>{const h=fixture();try{
 h.sqlite.prepare("INSERT INTO stable_expense_cancellation_writes(spreadsheet_id,entity_type,entity_id,projection,cancellation_version,previous_version,preimage_digest,operation_token,state,created_at,updated_at) VALUES('book','EXPENSE','exp_test','DAILY',2,1,?,'old','IN_FLIGHT','now','now')").run('b'.repeat(64));await assert.rejects(h.run(),/CANCEL_JOB_INTENT_REVIEW/);assert.deepEqual(h.stages,[]);
}finally{h.close()}});
test('version gap and legacy target never run a cancellation',async()=>{const h=fixture();try{
 h.sqlite.exec("UPDATE expense_events SET version=3 WHERE expense_id='exp_test'; UPDATE sync_jobs SET entity_version=3 WHERE job_id='job'");await assert.rejects(runStableExpenseCancellationJob(h.env,{kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_test',entityVersion:3,traceId:'trace'},'lease'),/CANCEL_JOB_PROJECTION_REVIEW/);assert.deepEqual(h.stages,[]);
}finally{h.close()}});

test('Undo before dispatch closes both pending versions without Sheets calls',async()=>{const h=fixture({noProjection:true});try{
 h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE job_id='oldjob'");
 assert.equal(await h.run(),'COMPLETED');assert.deepEqual(h.stages,[]);assert.deepEqual(h.sqlite.prepare('SELECT status FROM sync_jobs ORDER BY entity_version').all().map(x=>x.status),['COMPLETED','COMPLETED']);
}finally{h.close()}});
test('Undo cannot close when the older job is processing',async()=>{const h=fixture({noProjection:true});try{
 h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='old-lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='oldjob'");await assert.rejects(h.run());assert.deepEqual(h.stages,[]);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'PROCESSING');
}finally{h.close()}});

// Seed historical 0030 admission with its immutable triggers restored before
// invocation; separate admission tests cover its initial insert prerequisites.
function emulateAdmittedPrior(h,digest='a'.repeat(64)){
 const names=['continuous_daily_post_no_delete','continuous_daily_snapshot_prepared','continuous_daily_admission_insert'];
 const triggers=names.map(n=>h.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(n).sql);
 for(const n of names)h.sqlite.exec(`DROP TRIGGER ${n}`);
 h.sqlite.exec("DELETE FROM continuous_daily_post_cutover_expenses WHERE expense_id='exp_test'; INSERT INTO continuous_daily_pre_cutover_expenses(spreadsheet_id,expense_id) VALUES('book','exp_test')");
 h.sqlite.prepare("INSERT INTO continuous_daily_source_admissions(spreadsheet_id,expense_id,source_version,source_digest,provider_digest,source_revision,claim_token,admitted_at) VALUES('book','exp_test',1,?,?,0,'prior','now')").run(digest,'b'.repeat(64));
 for(const t of triggers)h.sqlite.exec(t);
}
test('admitted prior version with matching verified projection can cancel',async()=>{const h=fixture();try{
 emulateAdmittedPrior(h);assert.equal(await h.run(),'CONTINUE');assert.deepEqual(h.stages,['DAILY']);
}finally{h.close()}});
test('admitted prior version with wrong digest cannot cancel',async()=>{const h=fixture();try{
 emulateAdmittedPrior(h,'c'.repeat(64));await assert.rejects(h.run(),/CANCEL_JOB_SOURCE/);assert.deepEqual(h.stages,[]);
}finally{h.close()}});

test('Undo holds when an unleased pending older job has a previous attempt',async()=>{const h=fixture({noProjection:true});try{
 h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',attempt_count=1,lease_token=NULL,lease_until=NULL WHERE job_id='oldjob'");
 await assert.rejects(h.run());assert.deepEqual(h.stages,[]);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'PROCESSING');
}finally{h.close()}});
