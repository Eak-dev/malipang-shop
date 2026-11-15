import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
import {cutoverReadySql} from './helpers/cutover-ready.mjs';
const require=createRequire(import.meta.url),route=require('../dist/sheets/continuous-daily-route.js'),client=require('../dist/sheets/client.js'),health=require('../dist/sheets/continuous-report-health.js'),confirmation=require('../dist/expense/confirm.js'),worker=require('../dist/index.js').default,{encodeAtomicDailyPayload}=require('../dist/sheets/atomic-daily-template.js'),{encodeLedgerCarrier}=require('../dist/sheets/atomic-expense-ledger-template.js');
const {operateContinuousCanary}=require('../dist/admin/continuous-canary-operator.js');
function fixture(){
 const h=expenseSqlite(),old=route.assertContinuousDailyActivated,prepare=h.DB.prepare,batch=h.DB.batch;
 h.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run,all=s.all;s.run=async function(){return {...await run.call(this),success:true}};s.all=async function(){return {...await all.call(this),success:true}};return s};
 h.DB.batch=async function(s){return (await batch.call(this,s)).map(x=>({...x,success:true}))};
 Object.assign(h.env,{GOOGLE_SPREADSHEET_ID:'book',STABLE_PHASE1_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',CONTINUOUS_CANARY_OPERATOR_ENABLED:'true'});
 h.env.JOB_QUEUE.send=async message=>h.queue.push(message);
 h.sqlite.exec(`UPDATE stable_sync_cutover SET state='ACTIVE',activated_at='now'; INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','claim-token-123','HELD','now','now'); INSERT INTO continuous_daily_cutovers(spreadsheet_id,legacy_sheet_id,legacy_sheet_name,continuous_sheet_id,continuous_sheet_name,raw_sheet_id,raw_sheet_name,detail_sheet_id,detail_sheet_name,claim_token,source_revision,state,prepared_at) SELECT 'book',7,'old',8,'new',9,'raw_new',10,'detail_new','claim-token-123',revision,'PREPARED','now' FROM stable_source_revision; ${cutoverReadySql('claim-token-123')} UPDATE continuous_daily_cutovers SET state='ACTIVE',activated_at='now'; DELETE FROM stable_workbook_claims WHERE spreadsheet_id='book';`);
 route.assertContinuousDailyActivated=async()=>({sheet:'new',sheetId:8});
 return {...h,run:a=>operateContinuousCanary(h.env,a),close(){route.assertContinuousDailyActivated=old;h.close()}};
}
test('a flagged synthetic item follows the real confirmation transaction and arms only its exact job',async()=>{const h=fixture();try{
 assert.deepEqual(await h.run('PREPARE'),{ok:true,action:'PREPARE'});
 const c=h.sqlite.prepare('SELECT * FROM continuous_canary_operator').get(),draft=h.sqlite.prepare('SELECT * FROM expense_events WHERE expense_id=?').get(c.expense_id);
 assert.match(draft.description,/\[SYSTEM TEST\]/);assert.equal(draft.status,'WAITING_CONFIRM');assert.equal(draft.amount_satang,100);
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM expense_document_items WHERE expense_id=?').get(c.expense_id).n,1);
 await assert.rejects(h.run('PREPARE'));await h.run('CONFIRM');
 assert.equal(h.sqlite.prepare('SELECT status FROM expense_events WHERE expense_id=?').get(c.expense_id).status,'CONFIRMED');
 assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs WHERE entity_key=? AND entity_version=1').get(c.expense_id).status,'PENDING');
 await h.run('ARM_CONFIRM');const e=h.sqlite.prepare("SELECT * FROM stable_recovery_epochs WHERE state='ARMED'").get();assert.equal(e.target_key,c.expense_id);assert.equal(e.target_version,1);
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM continuous_canary_operator').get().n,1);await assert.rejects(h.run('ARM_CONFIRM'));
 }finally{h.close()}});
test('disabled flag, existing claim and a changed draft prevent an unsafe start or confirmation',async()=>{const h=fixture();try{
 h.env.CONTINUOUS_CANARY_OPERATOR_ENABLED='false';await assert.rejects(h.run('PREPARE'),/DISABLED/);h.env.CONTINUOUS_CANARY_OPERATOR_ENABLED='true';
 h.sqlite.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','blocking','REVIEW','now','now')");await assert.rejects(h.run('PREPARE'),/QUIESCENT/);h.sqlite.exec("DELETE FROM stable_workbook_claims WHERE spreadsheet_id='book'");
 await h.run('PREPARE');h.sqlite.exec("UPDATE expense_events SET amount_satang=200 WHERE status='WAITING_CONFIRM'");await assert.rejects(h.run('CONFIRM'),/CONFIRM_UNCERTAIN/);
 assert.equal(h.sqlite.prepare('SELECT state FROM continuous_canary_operator').get().state,'CONFIRMING');await assert.rejects(h.run('CONFIRM'));
 }finally{h.close()}});
test('recovery invalidates the exact old snapshot; a late confirmation cannot commit even if recovery ACK is lost',async()=>{const h=fixture(),original=confirmation.confirmExpenseAtomically;let release,signal;const pause=new Promise(r=>release=r),reached=new Promise(r=>signal=r);try{
 await h.run('PREPARE');const c=h.sqlite.prepare('SELECT * FROM continuous_canary_operator').get();let oldSnapshot;
 confirmation.confirmExpenseAtomically=async(env,input)=>{oldSnapshot=input.documentSnapshot.updatedAt;signal();await pause;return original(env,input)};
 const running=h.run('CONFIRM').then(()=>null,error=>error);await reached;
 h.DB.failAfterCommit=true;await assert.rejects(h.run('RECONCILE_CONFIRM'),/fixture crash after commit/);h.DB.failAfterCommit=false;
 const fresh=h.sqlite.prepare('SELECT updated_at FROM expense_documents WHERE document_id=?').get(c.document_id).updated_at;
 assert.notEqual(fresh,oldSnapshot);assert.ok(Number.isFinite(Date.parse(fresh)));assert.equal(h.sqlite.prepare('SELECT state FROM continuous_canary_operator').get().state,'DRAFT');
 release();assert.match((await running).message,/CANARY_CONFIRM_UNCERTAIN/);
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM sync_jobs WHERE entity_key=?').get(c.expense_id).n,0);
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM expense_audit_log WHERE expense_id=? AND action='CONFIRM'").get(c.expense_id).n,0);
 confirmation.confirmExpenseAtomically=original;await h.run('CONFIRM');
 assert.deepEqual(h.sqlite.prepare('SELECT state FROM continuous_canary_confirm_attempts ORDER BY rowid').all().map(x=>x.state),['INVALIDATED','CONFIRMED']);
 }finally{release?.();confirmation.confirmExpenseAtomically=original;h.close()}});
test('recovery recognizes a committed confirmation while the original caller is still finishing',async()=>{const h=fixture(),original=confirmation.confirmExpenseAtomically;let release,signal;const pause=new Promise(r=>release=r),reached=new Promise(r=>signal=r);try{
 await h.run('PREPARE');confirmation.confirmExpenseAtomically=async(env,input)=>{const v=await original(env,input);signal();await pause;return v};
 const running=h.run('CONFIRM').then(()=>null,error=>error);await reached;
 await h.run('RECONCILE_CONFIRM');
 assert.equal(h.sqlite.prepare('SELECT state FROM continuous_canary_operator').get().state,'CONFIRMED');assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CONFIRMED');
 release();assert.equal(await running,null);assert.equal(h.sqlite.prepare('SELECT state FROM continuous_canary_operator').get().state,'CONFIRMED');
 }finally{release?.();confirmation.confirmExpenseAtomically=original;h.close()}});
test('lost acknowledgement of a committed confirmation is recognized only from exact audit and pending outbox',async()=>{const h=fixture(),original=confirmation.confirmExpenseAtomically;try{
 await h.run('PREPARE');confirmation.confirmExpenseAtomically=async(env,input)=>{h.DB.failAfterCommit=true;try{return await original(env,input)}finally{h.DB.failAfterCommit=false}};
 await assert.rejects(h.run('CONFIRM'),/fixture crash after commit/);confirmation.confirmExpenseAtomically=original;
 assert.equal(h.sqlite.prepare('SELECT state FROM continuous_canary_operator').get().state,'CONFIRMING');assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CONFIRMED');
 h.sqlite.exec("UPDATE sync_jobs SET attempt_count=1 WHERE entity_version=1");await assert.rejects(h.run('RECONCILE_CONFIRM'));assert.equal(h.sqlite.prepare('SELECT state FROM continuous_canary_operator').get().state,'CONFIRMING');
 h.sqlite.exec("UPDATE sync_jobs SET attempt_count=0 WHERE entity_version=1");await h.run('RECONCILE_CONFIRM');await h.run('RECONCILE_CONFIRM');
 assert.equal(h.sqlite.prepare('SELECT state FROM continuous_canary_operator').get().state,'CONFIRMED');assert.equal(h.sqlite.prepare("SELECT count(*) n FROM expense_audit_log WHERE action='CONFIRM'").get().n,1);assert.equal(h.queue.length,0);
 }finally{confirmation.confirmExpenseAtomically=original;h.close()}});
test('repeated recovery never restores any earlier pending confirmation snapshot',async()=>{const h=fixture(),original=confirmation.confirmExpenseAtomically,oldNow=Date.now;const snapshots=[],releases=[],signals=[];try{
 await h.run('PREPARE');confirmation.confirmExpenseAtomically=async(env,input)=>{const i=snapshots.push(input.documentSnapshot.updatedAt)-1;let release;const blocked=new Promise(r=>release=r);releases[i]=release;signals[i]?.();await blocked;return original(env,input)};
 let firstSignal;const firstSeen=new Promise(r=>firstSignal=r);signals[0]=firstSignal;const first=h.run('CONFIRM').then(()=>null,e=>e);await firstSeen;
 await h.run('RECONCILE_CONFIRM');let secondSignal;const secondSeen=new Promise(r=>secondSignal=r);signals[1]=secondSignal;const second=h.run('CONFIRM').then(()=>null,e=>e);await secondSeen;
 assert.throws(()=>h.sqlite.exec("UPDATE continuous_canary_operator SET state='DRAFT' WHERE state='CONFIRMING'"),/not invalidated/);
 Date.now=()=>Date.parse(snapshots[0])-1000;await h.run('RECONCILE_CONFIRM');Date.now=oldNow;
 const current=h.sqlite.prepare('SELECT updated_at FROM expense_documents').get().updated_at;assert.ok(!snapshots.includes(current));
 releases.forEach(release=>release());assert.match((await first).message,/CANARY_CONFIRM_UNCERTAIN/);assert.match((await second).message,/CANARY_CONFIRM_UNCERTAIN/);
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM sync_jobs').get().n,0);assert.equal(h.sqlite.prepare("SELECT count(*) n FROM expense_audit_log WHERE action='CONFIRM'").get().n,0);
 }finally{Date.now=oldNow;releases.forEach(release=>release());confirmation.confirmExpenseAtomically=original;h.close()}});
test('only a completed exact canary with verified provider output can invoke real Undo and arm version two',async()=>{const h=fixture();
 const old={grid:client.getSheetGridInfo,formula:client.batchGetSheetFormulaValues,effective:client.batchGetSheetEffectiveSerialValues,health:health.readContinuousReportHealth};
 try{
 Object.assign(h.env,{CONTINUOUS_DAILY_SHEET:'new',CONTINUOUS_DAILY_SHEET_ID:'8',CONTINUOUS_RAW_SHEET:'raw_new',CONTINUOUS_RAW_SHEET_ID:'9',CONTINUOUS_DETAIL_SHEET:'detail_new',CONTINUOUS_DETAIL_SHEET_ID:'10'});
 await h.run('PREPARE');await h.run('CONFIRM');await h.run('ARM_CONFIRM');const c=h.sqlite.prepare('SELECT * FROM continuous_canary_operator').get();
 await assert.rejects(h.run('UNDO'),/STATE_UNVERIFIED/);
 h.sqlite.prepare("UPDATE sync_jobs SET status='COMPLETED' WHERE entity_key=? AND entity_version=1").run(c.expense_id);
 for(const [id,p,sheetId,sheet] of [[c.expense_id,'DAILY',8,'new'],[c.expense_id,'EXPENSE_RAW',9,'raw_new'],[`${c.expense_id}|${c.item_id}`,'DETAIL',10,'detail_new']]){
  h.sqlite.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE',?,?,?,?,1,?,?,'IN_FLIGHT','now')").run(id,p,sheetId,sheet,'a'.repeat(64),`token-${p}`);
  h.sqlite.prepare("UPDATE stable_projection_writes SET state='VERIFIED' WHERE entity_id=? AND projection=?").run(id,p);
 }
 h.sqlite.exec("UPDATE stable_recovery_epochs SET state='COMPLETE' WHERE state='ARMED'");
 const [y,m,d]=c.transaction_date.split('-').map(Number),serial=(Date.UTC(y,m-1,d)-Date.UTC(1899,11,30))/86400000;
 const daily=encodeAtomicDailyPayload({expenseId:c.expense_id,postingYear:y,postingMonth:m,postingDay:d,description:'[SYSTEM TEST] Synthetic expense - cancel after verification',amountColumn:'H',amountSatang:100,category:'ingredients',wallet:'บัญชีร้าน'});
 const raw=encodeLedgerCarrier({projection:'EXPENSE_RAW',expenseId:c.expense_id,itemId:'',confirmedVersion:1,status:'CONFIRMED',cancelVersion:null,cancelledAt:'',values:[c.expense_id,c.transaction_date,'[SYSTEM TEST]',1,'transfer','SHOP_BANK','ingredients','CONFIRMED','','','','','','','','','']});
 const detail=encodeLedgerCarrier({projection:'DETAIL',expenseId:c.expense_id,itemId:c.item_id,confirmedVersion:1,status:'CONFIRMED',cancelVersion:null,cancelledAt:'',values:[c.item_id,c.expense_id,c.document_id,c.transaction_date,'[SYSTEM TEST]','','[SYSTEM TEST]',1,'test',1,'',1,'',1,'ingredients','','CONFIRMED','','','']});
 client.getSheetGridInfo=async(_env,name)=>({sheetId:{new:8,raw_new:9,detail_new:10}[name],rowCount:100,columnCount:26});
 client.batchGetSheetFormulaValues=async()=>{const a=[],b=[],z=[];a[24]=daily;b[25]=raw;z[25]=detail;return [[a],[b],[z]]};
 client.batchGetSheetEffectiveSerialValues=async()=>{const a=[];a[8]=1;a[20]=serial;a[21]='ingredients';a[23]=`MALIPANG_EXPENSE:${c.expense_id}`;return [[a],[],[]]};
 health.readContinuousReportHealth=async(_env,expected)=>{assert.equal(expected.expenseId,c.expense_id);assert.deepEqual(expected.itemIds,[c.item_id]);return 'OK'};
 h.env.JOB_QUEUE.send=async message=>{h.queue.push(message);throw Error('lost queue acknowledgement')};
 await assert.rejects(h.run('ARM_DUPLICATE'),/lost queue acknowledgement/);assert.equal(h.queue.length,1);
 await assert.rejects(h.run('VERIFY_DUPLICATE'),/DUPLICATE_NOT_SEEN/);
 await assert.rejects(h.run('ARM_DUPLICATE'),/STATE_UNVERIFIED/);assert.equal(h.queue.length,1);
 let acked=0,retried=0;await worker.queue({queue:'malipang-jobs',messages:[{body:h.queue[0],ack(){acked++},retry(){retried++}}]},h.env,{});
 assert.equal(acked,1);assert.equal(retried,0);assert.equal(h.sqlite.prepare('SELECT state FROM continuous_canary_operator').get().state,'DUPLICATE_SEEN');
 await h.run('VERIFY_DUPLICATE');assert.equal(h.sqlite.prepare('SELECT state FROM continuous_canary_operator').get().state,'DUPLICATE_VERIFIED');
 h.DB.failAfterCommit=true;await assert.rejects(h.run('UNDO'),/fixture crash after commit/);h.DB.failAfterCommit=false;
 assert.equal(h.sqlite.prepare('SELECT state FROM continuous_canary_operator').get().state,'UNDOING');
 assert.equal(h.sqlite.prepare('SELECT status,version FROM expense_events WHERE expense_id=?').get(c.expense_id).status,'CANCELLED');
 assert.equal(h.sqlite.prepare('SELECT version FROM expense_events WHERE expense_id=?').get(c.expense_id).version,2);
 h.sqlite.prepare("UPDATE sync_jobs SET status='PROCESSING' WHERE entity_key=? AND entity_version=2").run(c.expense_id);
 await assert.rejects(h.run('RECONCILE_UNDO'),/RECONCILE_UNVERIFIED/);assert.equal(h.sqlite.prepare('SELECT state FROM continuous_canary_operator').get().state,'UNDOING');
 h.sqlite.prepare("UPDATE sync_jobs SET status='PENDING' WHERE entity_key=? AND entity_version=2").run(c.expense_id);
 await h.run('RECONCILE_UNDO');assert.equal(h.sqlite.prepare('SELECT state FROM continuous_canary_operator').get().state,'UNDONE');
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM expense_audit_log WHERE expense_id=? AND action='UNDO'").get(c.expense_id).n,1);assert.equal(h.queue.length,1);await h.run('ARM_UNDO');
 const e=h.sqlite.prepare("SELECT * FROM stable_recovery_epochs WHERE state='ARMED'").get();assert.equal(e.target_key,c.expense_id);assert.equal(e.target_version,2);
 h.sqlite.prepare("UPDATE sync_jobs SET status='COMPLETED' WHERE entity_key=? AND entity_version=2").run(c.expense_id);h.sqlite.exec("UPDATE stable_recovery_epochs SET state='COMPLETE' WHERE state='ARMED'");
 for(const [id,p,sheetId,sheet] of [[c.expense_id,'DAILY',8,'new'],[c.expense_id,'EXPENSE_RAW',9,'raw_new'],[`${c.expense_id}|${c.item_id}`,'DETAIL',10,'detail_new']]){
  h.sqlite.prepare("INSERT INTO stable_expense_projection_preimages(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,preimage_width,preimage_digest,created_at) VALUES('book','EXPENSE',?,?,?,?,1,?,26,?,'now')").run(id,p,sheetId,sheet,'a'.repeat(64),'b'.repeat(64));
  h.sqlite.prepare("INSERT INTO stable_expense_cancellation_writes(spreadsheet_id,entity_type,entity_id,projection,cancellation_version,previous_version,preimage_digest,operation_token,state,created_at,updated_at) VALUES('book','EXPENSE',?,?,2,1,?,?,'IN_FLIGHT','now','now')").run(id,p,'b'.repeat(64),`cancel-${p}`);
  h.sqlite.prepare("UPDATE stable_expense_cancellation_writes SET state='VERIFIED' WHERE entity_id=? AND projection=?").run(id,p);
 }
 await assert.rejects(h.run('VERIFY'),/CANARY_PROVIDER_IDENTITY/);
 const cancelledRaw=encodeLedgerCarrier({projection:'EXPENSE_RAW',expenseId:c.expense_id,itemId:'',confirmedVersion:1,status:'CANCELLED',cancelVersion:2,cancelledAt:'2026-11-15T00:00:00.000Z',values:[c.expense_id,c.transaction_date,'[SYSTEM TEST]',1,'transfer','SHOP_BANK','ingredients','CONFIRMED','','','','','','','','','']});
 const cancelledDetail=encodeLedgerCarrier({projection:'DETAIL',expenseId:c.expense_id,itemId:c.item_id,confirmedVersion:1,status:'CANCELLED',cancelVersion:2,cancelledAt:'2026-11-15T00:00:00.000Z',values:[c.item_id,c.expense_id,c.document_id,c.transaction_date,'[SYSTEM TEST]','','[SYSTEM TEST]',1,'test',1,'',1,'',1,'ingredients','','CONFIRMED','','','']});
 client.batchGetSheetFormulaValues=async()=>{const b=[],z=[];b[25]=cancelledRaw;z[25]=cancelledDetail;return [[],[b],[z]]};
 health.readContinuousReportHealth=async(_env,expected)=>{assert.deepEqual(expected,{expenseId:c.expense_id,absent:true});return 'OK'};
 await h.run('VERIFY');assert.equal(h.sqlite.prepare('SELECT state FROM continuous_canary_operator').get().state,'VERIFIED');
 }finally{client.getSheetGridInfo=old.grid;client.batchGetSheetFormulaValues=old.formula;client.batchGetSheetEffectiveSerialValues=old.effective;health.readContinuousReportHealth=old.health;h.close()}});
