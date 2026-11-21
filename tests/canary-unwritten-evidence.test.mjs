import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
import {cutoverReadySql} from './helpers/cutover-ready.mjs';
const require=createRequire(import.meta.url);
const route=require('../dist/sheets/continuous-daily-route.js');
const {operateContinuousCanary}=require('../dist/admin/continuous-canary-operator.js');
const {readCanaryUnwrittenEvidence}=require('../dist/admin/canary-unwritten-evidence.js');
const {canaryAbsentFromSnapshots,inspectCanaryUnwrittenProvider}=require('../dist/admin/canary-unwritten-provider-proof.js');
const {finalizeCanaryUnwrittenRecovery}=require('../dist/admin/canary-unwritten-finalize.js');
const {stepCanaryUnwrittenRecovery}=require('../dist/admin/canary-unwritten-dispatch.js');
const client=require('../dist/sheets/client.js');
const notice=require('../dist/sheets/stable-edit-notice.js');
const health=require('../dist/sheets/continuous-report-health.js');
const {ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js');

async function fixture(){
 const h=expenseSqlite(),old=route.assertContinuousDailyActivated,prepare=h.DB.prepare,batch=h.DB.batch;
 h.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run,all=s.all;s.run=async function(){return {...await run.call(this),success:true}};s.all=async function(){return {...await all.call(this),success:true}};return s};
 h.DB.batch=async function(s){return (await batch.call(this,s)).map(x=>({...x,success:true}))};
 Object.assign(h.env,{GOOGLE_SPREADSHEET_ID:'book',STABLE_PHASE1_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',CONTINUOUS_DAILY_ENABLED:'true',CONTINUOUS_CANARY_OPERATOR_ENABLED:'true'});
 h.sqlite.exec(`UPDATE stable_sync_cutover SET state='ACTIVE',activated_at='now';
 INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','cutover-token','HELD','now','now');
 INSERT INTO continuous_cutover_operator(spreadsheet_id,operation_token,origin,state,created_at,updated_at) VALUES('book','cutover-token','NEW','STARTING','now','now');
 UPDATE continuous_cutover_operator SET state='HELD';
 INSERT INTO continuous_daily_cutovers(spreadsheet_id,legacy_sheet_id,legacy_sheet_name,continuous_sheet_id,continuous_sheet_name,raw_sheet_id,raw_sheet_name,detail_sheet_id,detail_sheet_name,claim_token,source_revision,state,prepared_at) SELECT 'book',7,'old',8,'new',9,'raw_new',10,'detail_new','cutover-token',revision,'PREPARED','now' FROM stable_source_revision;
 ${cutoverReadySql('cutover-token')}
 UPDATE continuous_daily_cutovers SET state='ACTIVE',activated_at='now';
 UPDATE continuous_cutover_operator SET state='RELEASING'; UPDATE continuous_cutover_operator SET state='COMPLETE';
 DELETE FROM stable_workbook_claims WHERE spreadsheet_id='book';`);
 route.assertContinuousDailyActivated=async()=>({sheet:'new',sheetId:8});
 await operateContinuousCanary(h.env,'PREPARE');await operateContinuousCanary(h.env,'CONFIRM');await operateContinuousCanary(h.env,'ARM_CONFIRM');
 const c=h.sqlite.prepare('SELECT * FROM continuous_canary_operator').get();
 h.sqlite.exec(`INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,phase,review_reason,notice_stamp,notice_identity,created_at,updated_at) VALUES('book','canary-claim-token','REVIEW','OPERATION','INSERT_DAILY_PREFLIGHT_REPORT_HEALTH_FORMULA','paused-stamp','identity','now','now');
 INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) SELECT 'canary-claim-token',epoch_id,'ADMITTED','now' FROM stable_recovery_epochs WHERE state='ARMED';
 UPDATE sync_jobs SET status='REVIEW',last_error='STABLE_SYNC_REVIEW',lease_token=NULL,lease_until=NULL WHERE entity_type='EXPENSE' AND entity_version=1;`);
 return {...h,c,close(){route.assertContinuousDailyActivated=old;h.close()}};
}

test('exact incident can be read without changing the database or exposing it as authorization',async()=>{
 const h=await fixture();try{
  const before=h.sqlite.prepare('SELECT total_changes() n').get().n,e=await readCanaryUnwrittenEvidence(h.env);
  assert.ok(e);assert.equal(e.expense_id,h.c.expense_id);assert.equal(e.claim_token,'canary-claim-token');
  assert.equal(h.sqlite.prepare('SELECT total_changes() n').get().n,before);
  assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 }finally{h.close();}
});

for(const [label,mutate] of [
 ['gate disabled',h=>{h.env.STABLE_RECOVERY_GATE_ENABLED='false'}],
 ['notice disabled',h=>{h.env.STABLE_PHASE1_ENABLED='false'}],
 ['pacing disabled',h=>{h.env.STABLE_SHEETS_PACING_ENABLED='false'}],
 ['publication mode enabled',h=>{h.env.CONTINUOUS_PUBLICATION_ENABLED='true'}],
 ['notice handoff mode enabled',h=>{h.env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED='true'}],
 ['Canary operator disabled',h=>{h.env.CONTINUOUS_CANARY_OPERATOR_ENABLED='false'}],
 ['changed source amount',h=>h.sqlite.exec('UPDATE expense_events SET amount_satang=200')],
 ['job no longer review',h=>h.sqlite.exec("UPDATE sync_jobs SET status='PENDING'")],
 ['claim reason changed',h=>h.sqlite.exec("UPDATE stable_workbook_claims SET review_reason='OTHER'")],
 ['foreign claim',h=>h.sqlite.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('other','foreign-token','HELD','now','now')")],
 ['missing projection fence',h=>h.sqlite.exec('DROP TRIGGER continuous_expense_projection_target_fence')],
 ['row index exists',h=>h.sqlite.prepare("INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES('new',?,5)").run(h.c.expense_id)],
 ['terminal failure',h=>h.sqlite.prepare("INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,created_at,updated_at) VALUES('terminal','malipang-jobs','different',?,'{}','DEAD_LETTER_MAX_RETRIES','OPEN','now','now')").run('EXPENSE:'+h.c.expense_id+':1')],
])test(`unwritten evidence rejects ${label}`,async()=>{const h=await fixture();try{mutate(h);assert.equal(await readCanaryUnwrittenEvidence(h.env),null)}finally{h.close()}});

const ids=['exp_canary_','item_canary_','doc_canary_'].map(x=>x+'a'.repeat(32));
const snapshot=()=>({grids:[{sheetId:8,rowCount:5,columnCount:29},{sheetId:9,rowCount:3,columnCount:26},{sheetId:10,rowCount:3,columnCount:26}],formula:[[],[],[]],effective:[[],[],[]]});
function put(s,kind,grid,row,col,value){while(s[kind][grid].length<row)s[kind][grid].push([]);s[kind][grid][row-1][col-1]=value;}

test('provider absence proof checks all cells and accepts only consistent bounded carriers',()=>{
 const s=snapshot(),marker='b'.repeat(32);
 put(s,'formula',0,4,25,'MPD1_EMPTY_4_'+marker);put(s,'effective',0,4,25,'MPD1_EMPTY_4_'+marker);
 put(s,'formula',1,2,26,'MPL1_EMPTY_2_'+marker);put(s,'effective',1,2,26,'MPL1_EMPTY_2_'+marker);
 assert.equal(canaryAbsentFromSnapshots(s,...ids),true);
 for(const mutate of [
  x=>put(x,'effective',2,3,12,ids[0]),
  x=>put(x,'formula',0,5,25,'MPD1␟malformed'),
  x=>{put(x,'formula',1,3,26,'unexpected');put(x,'effective',1,3,26,'unexpected')},
  x=>put(x,'effective',1,2,26,'different'),
  x=>{put(x,'formula',1,2,26,'MPL1_EMPTY_3_'+marker);put(x,'effective',1,2,26,'MPL1_EMPTY_3_'+marker)},
  x=>put(x,'formula',1,2,1,{unexpected:'provider value'}),
  x=>{x.formula[0].push(...Array.from({length:6},()=>[]))},
  x=>{x.grids[2].rowCount=5001},
 ]){const changed=structuredClone(s);mutate(changed);assert.equal(canaryAbsentFromSnapshots(changed,...ids),false);}
});

async function mockProvider(h){
 Object.assign(h.env,{CONTINUOUS_DAILY_SHEET:'new',CONTINUOUS_DAILY_SHEET_ID:'8',CONTINUOUS_RAW_SHEET:'raw_new',CONTINUOUS_RAW_SHEET_ID:'9',CONTINUOUS_DETAIL_SHEET:'detail_new',CONTINUOUS_DETAIL_SHEET_ID:'10'});
 const original={properties:client.getSpreadsheetSheetProperties,formula:client.batchGetSheetFormulaValues,effective:client.batchGetSheetEffectiveSerialValues,style:notice.stableNoticeStyleFingerprint,health:health.readContinuousReportHealth};
 const s=snapshot(),state={s,styleCalls:0,healthCalls:0,gridCalls:0,formulaCalls:0,effectiveCalls:0};
 client.getSpreadsheetSheetProperties=async(_env,policy)=>{policy?.budget?.consumeRead();state.gridCalls++;return s.grids.map((g,i)=>({...structuredClone(g),title:['new','raw_new','detail_new'][i]}))};
 client.batchGetSheetFormulaValues=async(_env,_ranges,policy)=>{policy?.budget?.consumeRead();state.formulaCalls++;return structuredClone(s.formula)};
 client.batchGetSheetEffectiveSerialValues=async(_env,_ranges,policy)=>{policy?.budget?.consumeRead();state.effectiveCalls++;return structuredClone(s.effective)};
 notice.stableNoticeStyleFingerprint=async(_env,_identity,_status,_stamp,budget)=>{budget?.consumeRead();budget?.consumeRead();state.styleCalls++;return 'f'.repeat(64)};
 health.readContinuousReportHealth=async(_env,_expected,_publication,policy)=>{for(let i=0;i<5;i++)policy?.budget?.consumeRead();state.healthCalls++;return 'OK'};
 return {state,restore(){client.getSpreadsheetSheetProperties=original.properties;client.batchGetSheetFormulaValues=original.formula;client.batchGetSheetEffectiveSerialValues=original.effective;notice.stableNoticeStyleFingerprint=original.style;health.readContinuousReportHealth=original.health}};
}

test('provider preflight is read only, bounded and returns a fingerprint rather than private evidence',async()=>{
 const h=await fixture(),m=await mockProvider(h);try{
  const before=h.sqlite.prepare('SELECT total_changes() n').get().n,result=await inspectCanaryUnwrittenProvider(h.env);
  assert.deepEqual(Object.keys(result??{}),['fingerprint','styleDigest']);assert.match(result.fingerprint,/^[a-f0-9]{64}$/);assert.match(result.styleDigest,/^[a-f0-9]{64}$/);
  assert.equal(h.sqlite.prepare('SELECT total_changes() n').get().n,before);assert.equal(m.state.formulaCalls,2);assert.equal(m.state.effectiveCalls,2);assert.equal(m.state.styleCalls,2);assert.equal(m.state.healthCalls,1);
  assert.equal(m.state.gridCalls,4);
 }finally{m.restore();h.close()}
});
test('provider preflight respects a bounded request budget',async()=>{
 const h=await fixture(),m=await mockProvider(h);try{
  const enough=new ReviewRequestBudget(17);assert.ok(await inspectCanaryUnwrittenProvider(h.env,undefined,enough));assert.equal(enough.used,17);
  const short=new ReviewRequestBudget(16);assert.equal(await inspectCanaryUnwrittenProvider(h.env,undefined,short),null);
 }finally{m.restore();h.close()}
});
test('probe exposes only a safe stage and classified report error',async()=>{
 const h=await fixture(),m=await mockProvider(h);try{
  const diagnostic={stage:'START',reason:'UNKNOWN'};
  health.readContinuousReportHealth=async()=>{throw Error('REPORT_HEALTH_FORMULA')};
  assert.equal(await inspectCanaryUnwrittenProvider(h.env,undefined,undefined,diagnostic),null);
  assert.deepEqual(diagnostic,{stage:'REPORT_HEALTH',reason:'REPORT_HEALTH_FORMULA'});
  health.readContinuousReportHealth=async()=>{throw Error('private provider data')};
  assert.equal(await inspectCanaryUnwrittenProvider(h.env,undefined,undefined,diagnostic),null);
  assert.deepEqual(diagnostic,{stage:'REPORT_HEALTH',reason:'UNVERIFIED'});
  health.readContinuousReportHealth=async()=>{throw new client.SheetsHttpError(403,'private provider data')};
  assert.equal(await inspectCanaryUnwrittenProvider(h.env,undefined,undefined,diagnostic),null);
  assert.deepEqual(diagnostic,{stage:'REPORT_HEALTH',reason:'SHEETS_HTTP_403'});
 }finally{m.restore();h.close()}
});

for(const [label,mutate] of [
 ['target present',(h,m)=>put(m.state.s,'effective',1,2,1,h.c.expense_id)],
 ['notice identity changes',()=>{let n=0;notice.stableNoticeStyleFingerprint=async()=>++n===1?'a':'b'}],
 ['report health fails',()=>{health.readContinuousReportHealth=async()=>{throw Error('unverified')}}],
 ['source changes during provider read',(h)=>{health.readContinuousReportHealth=async()=>{h.sqlite.exec('UPDATE expense_events SET amount_satang=200');return 'OK'}}],
 ['grid changes between reads',(_h,m)=>{let n=0;client.getSpreadsheetSheetProperties=async()=>m.state.s.grids.map((x,i)=>({...structuredClone(x),rowCount:x.rowCount+(++n>3?1:0),title:['new','raw_new','detail_new'][i]}))}],
 ['snapshot changes',(_h,m)=>{let n=0;client.batchGetSheetFormulaValues=async()=>{const v=structuredClone(m.state.s.formula);if(++n===2)v[0]=[['changed']];return v}}],
 ['environment changes',h=>{health.readContinuousReportHealth=async()=>{h.env.CONTINUOUS_CANARY_OPERATOR_ENABLED='false';return 'OK'}}],
 ['report scope changes',h=>{health.readContinuousReportHealth=async()=>{h.env.SHEET_EXPENSE_RAW='other';return 'OK'}}],
 ['activated sheet differs',()=>{route.assertContinuousDailyActivated=async()=>({sheet:'different',sheetId:8})}],
])test(`provider preflight fails closed when ${label}`,async()=>{
 const h=await fixture(),m=await mockProvider(h);try{mutate(h,m);assert.equal(await inspectCanaryUnwrittenProvider(h.env),null)}finally{m.restore();h.close()}
});

function insertRecoveryIntent(h,overrides={}){
 const e=h.sqlite.prepare('SELECT revision FROM stable_source_revision').get(),epoch=h.sqlite.prepare("SELECT epoch_id FROM stable_recovery_epochs WHERE state='ARMED'").get();
 const values={book:'book',token:'canary-claim-token',epoch:epoch.epoch_id,expense:h.c.expense_id,revision:e.revision,paused:'paused-stamp',identity:'identity',next:'next-stamp-'+('b'.repeat(32)),ready:'พร้อมแก้ไข • มีรายการรอตรวจ',provider:'c'.repeat(64),style:'d'.repeat(64),state:'TIME_IN_FLIGHT',...overrides};
 return h.sqlite.prepare(`INSERT INTO canary_unwritten_recovery(spreadsheet_id,operation_token,epoch_id,expense_id,source_version,source_revision,paused_stamp,notice_identity,next_stamp,ready_status,provider_digest,style_digest,state,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?,?,?,?,?,?,'now','now')`)
  .run(values.book,values.token,values.epoch,values.expense,values.revision,values.paused,values.identity,values.next,values.ready,values.provider,values.style,values.state);
}

test('recovery intent is a one-shot immutable ordered audit record',async()=>{
 const h=await fixture();try{
  insertRecoveryIntent(h);
  assert.throws(()=>insertRecoveryIntent(h));
  assert.throws(()=>h.sqlite.exec('INSERT OR REPLACE INTO canary_unwritten_recovery SELECT * FROM canary_unwritten_recovery'));
  assert.throws(()=>h.sqlite.exec("UPDATE canary_unwritten_recovery SET state='STATUS_ACKED'"));
  assert.throws(()=>h.sqlite.exec("UPDATE canary_unwritten_recovery SET state='TIME_ACKED',expense_id='different'"));
  for(const state of ['TIME_ACKED','STATUS_IN_FLIGHT','STATUS_ACKED','COMPLETE'])h.sqlite.prepare('UPDATE canary_unwritten_recovery SET state=?').run(state);
  assert.throws(()=>h.sqlite.exec("UPDATE canary_unwritten_recovery SET state='TIME_IN_FLIGHT'"));
  assert.throws(()=>h.sqlite.exec('DELETE FROM canary_unwritten_recovery'));
  assert.equal(h.sqlite.prepare('SELECT state FROM canary_unwritten_recovery').get().state,'COMPLETE');
 }finally{h.close()}
});

for(const [label,mutate,overrides] of [
 ['wrong initial phase',()=>{}, {state:'STATUS_ACKED'}],
 ['wrong notice stamp',()=>{}, {paused:'wrong'}],
 ['changed source',h=>h.sqlite.exec('UPDATE expense_events SET amount_satang=200'),{}],
 ['foreign claim',h=>h.sqlite.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('other','foreign-token','HELD','now','now')"),{}],
 ['terminal failure',h=>h.sqlite.prepare("INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,created_at,updated_at) VALUES('terminal','malipang-jobs','different',?,'{}','DEAD_LETTER_MAX_RETRIES','OPEN','now','now')").run('EXPENSE:'+h.c.expense_id+':1'),{}],
])test(`recovery intent rejects ${label}`,async()=>{const h=await fixture();try{mutate(h);assert.throws(()=>insertRecoveryIntent(h,overrides));assert.equal(h.sqlite.prepare('SELECT count(*) n FROM canary_unwritten_recovery').get().n,0)}finally{h.close()}});

async function acknowledgedFixture({otherReview=false}={}){
 const h=await fixture(),m=await mockProvider(h);h.env.CANARY_UNWRITTEN_RECOVERY_ENABLED='true';
 if(otherReview)addOtherReview(h);
 const proof=await inspectCanaryUnwrittenProvider(h.env);assert.ok(proof);
 insertRecoveryIntent(h,{ready:otherReview?'พร้อมแก้ไข • มีรายการรอตรวจ':'พร้อมแก้ไข',provider:proof.fingerprint,style:proof.styleDigest});
 for(const state of ['TIME_ACKED','STATUS_IN_FLIGHT','STATUS_ACKED'])h.sqlite.prepare('UPDATE canary_unwritten_recovery SET state=?').run(state);
 return {h,m,close(){m.restore();h.close()}};
}
function addOtherReview(h){h.sqlite.exec("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('other-job','ATTENDANCE_EVENT','other',1,'other-trace','REVIEW','now')")}
function recoveryState(h){return{
 recovery:h.sqlite.prepare('SELECT state FROM canary_unwritten_recovery').get().state,
 claim:h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get()?.state??null,
 job:h.sqlite.prepare("SELECT status FROM sync_jobs WHERE entity_type='EXPENSE'").get().status,
 admission:h.sqlite.prepare('SELECT state FROM stable_recovery_operations').get().state,
 epoch:h.sqlite.prepare('SELECT state FROM stable_recovery_epochs').get().state,
 }}
const fenced={recovery:'STATUS_ACKED',claim:'REVIEW',job:'REVIEW',admission:'ADMITTED',epoch:'ARMED'};

test('finalization atomically resumes only the exact synthetic target and preserves epoch history',async()=>{
 const x=await acknowledgedFixture();try{
  assert.equal(await finalizeCanaryUnwrittenRecovery(x.h.env),'RESUMED');
  assert.deepEqual(recoveryState(x.h),{recovery:'COMPLETE',claim:null,job:'PENDING',admission:'VERIFIED',epoch:'ARMED'});
  assert.equal(await finalizeCanaryUnwrittenRecovery(x.h.env),'ALREADY_COMMITTED');
 }finally{x.close()}
});
test('finalization preserves other review jobs and the matching notice',async()=>{
 const x=await acknowledgedFixture({otherReview:true});try{
  assert.equal(await finalizeCanaryUnwrittenRecovery(x.h.env),'RESUMED');
  assert.equal(x.h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='other-job'").get().status,'REVIEW');
 }finally{x.close()}
});
test('concurrent finalizers cannot commit the target twice',async()=>{
 const x=await acknowledgedFixture();try{
  const results=await Promise.all([finalizeCanaryUnwrittenRecovery(x.h.env),finalizeCanaryUnwrittenRecovery(x.h.env)]);
  assert.equal(results.filter(r=>r==='RESUMED').length,1);assert.ok(results.every(r=>['RESUMED','HELD','ALREADY_COMMITTED'].includes(r)));
  assert.deepEqual(recoveryState(x.h),{recovery:'COMPLETE',claim:null,job:'PENDING',admission:'VERIFIED',epoch:'ARMED'});
 }finally{x.close()}
});
test('finalization rechecks source inside the database transaction',async()=>{
 const x=await acknowledgedFixture();try{
  const oldBatch=x.h.DB.batch;x.h.DB.batch=async function(statements){x.h.sqlite.exec('UPDATE expense_events SET amount_satang=200');return oldBatch.call(this,statements)};
  assert.equal(await finalizeCanaryUnwrittenRecovery(x.h.env),'HELD');assert.deepEqual(recoveryState(x.h),fenced);
 }finally{x.close()}
});

for(let index=0;index<5;index++)test(`finalization rolls back all changes on database failure at statement ${index}`,async()=>{
 const x=await acknowledgedFixture();try{x.h.DB.failAt=index;assert.equal(await finalizeCanaryUnwrittenRecovery(x.h.env),'HELD');assert.deepEqual(recoveryState(x.h),fenced)}finally{x.close()}
});
test('lost database commit acknowledgement is reconciled without repeating provider mutations',async()=>{
 const x=await acknowledgedFixture();try{
  x.h.DB.failAfterCommit=true;assert.equal(await finalizeCanaryUnwrittenRecovery(x.h.env),'HELD');
  x.h.DB.failAfterCommit=false;assert.equal(await finalizeCanaryUnwrittenRecovery(x.h.env),'ALREADY_COMMITTED');
  assert.deepEqual(recoveryState(x.h),{recovery:'COMPLETE',claim:null,job:'PENDING',admission:'VERIFIED',epoch:'ARMED'});
 }finally{x.close()}
});
for(const [label,mutate] of [
 ['disabled flag',x=>{x.h.env.CANARY_UNWRITTEN_RECOVERY_ENABLED='false'}],
 ['changed source',x=>x.h.sqlite.exec('UPDATE expense_events SET amount_satang=200')],
 ['changed notice',()=>{notice.stableNoticeStyleFingerprint=async()=>null}],
 ['changed report',()=>{health.readContinuousReportHealth=async()=>{throw Error('unverified')}}],
 ['another job newly needs review',x=>addOtherReview(x.h)],
 ['missing audit trigger',x=>x.h.sqlite.exec('DROP TRIGGER canary_unwritten_recovery_no_delete')],
])test(`finalization retains the fence for ${label}`,async()=>{
 const x=await acknowledgedFixture();try{mutate(x);const result=await finalizeCanaryUnwrittenRecovery(x.h.env);assert.ok(result==='HELD'||result==='DISABLED');assert.deepEqual(recoveryState(x.h),fenced)}finally{x.close()}
});

async function dispatchFixture(){
 const h=await fixture(),m=await mockProvider(h);h.env.CANARY_UNWRITTEN_RECOVERY_ENABLED='true';
 const originalWrite=client.batchUpdateSpreadsheetWithReply,originalStyle=notice.stableNoticeStyleFingerprint;
 const provider={status:'พักแก้ไฟล์',stamp:'paused-stamp',writes:0,failAfter:null,failBeforeSend:false,malformedAt:null};
 notice.stableNoticeStyleFingerprint=async(_env,identity,status,stamp,budget)=>{budget?.consumeRead();budget?.consumeRead();return identity==='identity'&&status===provider.status&&stamp===provider.stamp?'f'.repeat(64):null};
 client.batchUpdateSpreadsheetWithReply=async(_env,requests,before,budget)=>{
  assert.equal(requests.length,1);const ticket=budget?.claimMutation();try{await before();if(provider.failBeforeSend)throw Error('crash before dispatch');ticket?.consume();provider.writes++;
  const q=requests[0].findReplace,key=q.range.startColumnIndex===2?'stamp':'status';
  const changed=provider[key]===q.find?1:0;if(changed)provider[key]=q.replacement;
  if(provider.failAfter===provider.writes)throw Error('provider response lost');
  if(provider.malformedAt===provider.writes)return {replies:[]};
  return {replies:[{findReplace:{valuesChanged:changed,occurrencesChanged:changed,formulasChanged:0}}]};}finally{ticket?.release()}
 };
 return {h,m,provider,close(){client.batchUpdateSpreadsheetWithReply=originalWrite;notice.stableNoticeStyleFingerprint=originalStyle;m.restore();h.close()}};
}
test('one-shot dispatcher verifies two acknowledgements before committing',async()=>{
 const x=await dispatchFixture();try{
  assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,'TIME'),'IN_PROGRESS');
  assert.equal(x.h.sqlite.prepare('SELECT state FROM canary_unwritten_recovery').get().state,'TIME_ACKED');
  assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,'STATUS'),'IN_PROGRESS');
  assert.equal(x.h.sqlite.prepare('SELECT state FROM canary_unwritten_recovery').get().state,'STATUS_ACKED');
  assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,'COMMIT'),'RESUMED');
  assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,'COMMIT'),'ALREADY_COMMITTED');
  assert.equal(x.provider.status,'พร้อมแก้ไข');assert.equal(x.provider.writes,2);
  assert.deepEqual(recoveryState(x.h),{recovery:'COMPLETE',claim:null,job:'PENDING',admission:'VERIFIED',epoch:'ARMED'});
 }finally{x.close()}
});
test('PROBE reads evidence without a database or provider mutation',async()=>{
 const x=await dispatchFixture();try{
  const before=x.h.sqlite.prepare('SELECT total_changes() n').get().n;
  assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,'PROBE'),'READY');
  assert.equal(x.provider.writes,0);assert.equal(x.h.sqlite.prepare('SELECT total_changes() n').get().n,before);
  assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,'TIME'),'IN_PROGRESS');
  assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,'PROBE'),'HELD');assert.equal(x.provider.writes,1);
 }finally{x.close()}
});
test('each dispatcher call is pinned to its explicitly selected phase',async()=>{
 const x=await dispatchFixture();try{
  assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,'STATUS'),'HELD');
  assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,'COMMIT'),'HELD');assert.equal(x.provider.writes,0);
  assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,'TIME'),'IN_PROGRESS');
  assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,'TIME'),'HELD');
  assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,'COMMIT'),'HELD');assert.equal(x.provider.writes,1);
 }finally{x.close()}
});
for(const point of [1,2])test(`lost provider acknowledgement at mutation ${point} remains fenced and is never resent`,async()=>{
 const x=await dispatchFixture();try{
  x.provider.failAfter=point;
  if(point===2)assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,'TIME'),'IN_PROGRESS');
  assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,point===1?'TIME':'STATUS'),'HELD');
  assert.equal(x.h.sqlite.prepare('SELECT state FROM canary_unwritten_recovery').get().state,point===1?'TIME_IN_FLIGHT':'STATUS_IN_FLIGHT');
  assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,point===1?'TIME':'STATUS'),'HELD');assert.equal(x.provider.writes,point);
  assert.equal(x.h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
  assert.equal(x.h.sqlite.prepare("SELECT status FROM sync_jobs WHERE entity_type='EXPENSE'").get().status,'REVIEW');
 }finally{x.close()}
});
test('malformed provider acknowledgement stays in flight without retry',async()=>{
 const x=await dispatchFixture();try{
  x.provider.malformedAt=1;assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,'TIME'),'HELD');
  assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,'TIME'),'HELD');assert.equal(x.provider.writes,1);
  assert.equal(x.h.sqlite.prepare('SELECT state FROM canary_unwritten_recovery').get().state,'TIME_IN_FLIGHT');
 }finally{x.close()}
});
test('crash after durable intent but before sending never dispatches on a later call',async()=>{
 const x=await dispatchFixture();try{
  x.provider.failBeforeSend=true;assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,'TIME'),'HELD');
  x.provider.failBeforeSend=false;assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,'TIME'),'HELD');assert.equal(x.provider.writes,0);
  assert.equal(x.h.sqlite.prepare('SELECT state FROM canary_unwritten_recovery').get().state,'TIME_IN_FLIGHT');
 }finally{x.close()}
});
test('a newly reviewed job prevents dispatching a stale ready notice',async()=>{
 const x=await dispatchFixture();try{
  assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,'TIME'),'IN_PROGRESS');addOtherReview(x.h);
  assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,'STATUS'),'HELD');assert.equal(x.provider.writes,1);
  assert.equal(x.h.sqlite.prepare('SELECT state FROM canary_unwritten_recovery').get().state,'TIME_ACKED');
 }finally{x.close()}
});
test('concurrent dispatch cannot send the first provider mutation twice',async()=>{
 const x=await dispatchFixture();try{
  const result=await Promise.all([stepCanaryUnwrittenRecovery(x.h.env,'TIME'),stepCanaryUnwrittenRecovery(x.h.env,'TIME')]);
  assert.equal(result.filter(r=>r==='IN_PROGRESS').length,1);assert.equal(x.provider.writes,1);
  assert.equal(x.h.sqlite.prepare('SELECT state FROM canary_unwritten_recovery').get().state,'TIME_ACKED');
 }finally{x.close()}
});
test('concurrent dispatch cannot send the second provider mutation twice',async()=>{
 const x=await dispatchFixture();try{
  assert.equal(await stepCanaryUnwrittenRecovery(x.h.env,'TIME'),'IN_PROGRESS');
  const result=await Promise.all([stepCanaryUnwrittenRecovery(x.h.env,'STATUS'),stepCanaryUnwrittenRecovery(x.h.env,'STATUS')]);
  assert.equal(result.filter(r=>r==='IN_PROGRESS').length,1);assert.equal(x.provider.writes,2);
  assert.equal(x.h.sqlite.prepare('SELECT state FROM canary_unwritten_recovery').get().state,'STATUS_ACKED');
 }finally{x.close()}
});
