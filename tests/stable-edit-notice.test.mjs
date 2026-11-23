import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),auth=require('../dist/sheets/google-auth.js'),notice=require('../dist/sheets/stable-edit-notice.js'),{withStableWorkbookClaim}=require('../dist/sheets/stable-workbook-claim.js');
function fixture(pilot=false){
 const sheetId=pilot?1815870717:9,first=pilot?1:23;let format;
 const h=expenseSqlite(),prepare=h.DB.prepare,oldFetch=globalThis.fetch,oldAuth=auth.getGoogleAccessToken,oldWrite=client.batchWriteValues,oldBegin=notice.beginStableNotice;let status='พร้อมแก้ไข',time='old',writes=0,lose=false,waited=0,statusId='s',rebindOnData=false;
 h.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run;s.run=async function(){return{...await run.call(this),success:true};};return s;};Object.assign(h.env,{GOOGLE_SPREADSHEET_ID:'book',SHEET_EXPENSE_DAILY:'daily',STABLE_PHASE1_ENABLED:'true'});auth.getGoogleAccessToken=async()=> 'fixture';
 globalThis.fetch=async input=>{const u=new URL(String(input)),sheet={properties:{sheetId,title:'daily',gridProperties:{rowCount:100,columnCount:25,frozenRowCount:3}}};if(u.searchParams.has('ranges')){if(rebindOnData)statusId='rebound';sheet.data=[{startRow:0,startColumn:first,rowData:[{values:[{userEnteredValue:{stringValue:status},userEnteredFormat:format}]}]},{startRow:0,startColumn:first+1,rowData:[{values:[{userEnteredValue:{stringValue:time}}]}]}];}return new Response(JSON.stringify({spreadsheetId:'book',namedRanges:[{namedRangeId:statusId,name:'MLP_DAILY_STATUS',range:{sheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:first,endColumnIndex:first+1}},{namedRangeId:'t',name:'MLP_DAILY_STATUS_TIME',range:{sheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:first+1,endColumnIndex:first+2}}],sheets:[sheet]}));};
 client.batchWriteValues=async(_env,data,before)=>{await before();writes++;status=data[0].values[0][0];time=data[1].values[0][0];if(lose)throw Error('lost response');};notice.beginStableNotice=(env,token,_wait,onMutationAuthorized)=>oldBegin(env,token,async ms=>{waited=ms;},onMutationAuthorized);
 return{...h,restyle(){format={textFormat:{bold:true}};},get status(){return status;},get writes(){return writes;},get waited(){return waited;},lose(){lose=true;},rebind(){statusId='rebound';},rebindDuringRead(){rebindOnData=true;},pause(){status='พักแก้ไฟล์';},setStatus(v){status=v;},close(){globalThis.fetch=oldFetch;auth.getGoogleAccessToken=oldAuth;client.batchWriteValues=oldWrite;notice.beginStableNotice=oldBegin;h.close();}};
}
test('reserved and taken pilots cannot authorize a provider write; adopted legacy pilot can',async()=>{
 const h=fixture(),{stableWorkbookClaimOwned}=require('../dist/sheets/stable-workbook-claim.js');try{
  await withStableWorkbookClaim(h.env,async token=>{
   assert.equal(await stableWorkbookClaimOwned(h.env,token),true,'ordinary claim');
   for(const phase of ['PILOT_RESERVED','PILOT_TAKEN']){
    h.sqlite.prepare('UPDATE stable_workbook_claims SET phase=? WHERE operation_token=?').run(phase,token);
    assert.equal(await stableWorkbookClaimOwned(h.env,token),false,phase);
   }
   h.sqlite.prepare("UPDATE stable_workbook_claims SET phase='PILOT_ADOPTED' WHERE operation_token=?").run(token);
   assert.equal(await stableWorkbookClaimOwned(h.env,token),true,'legacy adopted claim');
  });
 }finally{h.close();}
});
test('review records the cause without clearing a durable serial phase',async()=>{
 const h=fixture();try{
  h.sqlite.exec("CREATE TRIGGER protect_serial_phase BEFORE UPDATE ON stable_workbook_claims WHEN OLD.phase='SERIAL_CONTINUATION' AND NEW.phase IS NOT OLD.phase BEGIN SELECT RAISE(ABORT,'phase retained'); END");
  await assert.rejects(()=>withStableWorkbookClaim(h.env,async token=>{
   h.sqlite.prepare("UPDATE stable_workbook_claims SET phase='SERIAL_CONTINUATION' WHERE operation_token=?").run(token);
   throw Error('SERIAL_FINAL_COMPLETION_NOT_READY');
  }),/SERIAL_FINAL_COMPLETION_NOT_READY/);
  assert.deepEqual(claimRow(h),{state:'REVIEW',phase:'SERIAL_CONTINUATION',review_reason:'SERIAL_FINAL_COMPLETION_NOT_READY'});
 }finally{h.close();}
});
test('mock serial and normal notice handoff are rejected before dispatch',async()=>{
 const h=fixture();try{
  Object.assign(h.env,{APP_ENV:'test',SERIAL_ATTESTED_HANDOFF_ENABLED:'true',SERIAL_MOCK_CONTINUATION_ENABLED:'true',CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED:'true'});
  await assert.rejects(()=>withStableWorkbookClaim(h.env,async()=>assert.fail('operation must not run')),/SERIAL_MOCK_HANDOFF_INCOMPATIBLE/);
  assert.equal(h.writes,0);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);
 }finally{h.close();}
});
function insertSyntheticHandoff(h,token){
 h.sqlite.exec('DROP TRIGGER IF EXISTS serial_pilot_attested_handoff_not_ready');
 h.sqlite.prepare(`INSERT INTO serial_pilot_attested_handoffs(nonce,round_id,predecessor_job_id,successor_job_id,spreadsheet_id,predecessor_epoch_id,successor_epoch_id,claim_token,worker_version,source_revision,fence_digest,fence_generation,issued_at,expires_at,payload_digest,signer_digest,signature_digest,created_at) VALUES('n','r','b','c','book','eb','ec',?,'w',1,'f',1,'i','e','p','s','g','now')`).run(token);
}
test('an inconsistent handoff with a legacy phase never grants ownership',async()=>{
 const h=fixture(),{stableWorkbookClaimOwned}=require('../dist/sheets/stable-workbook-claim.js');try{
  await assert.rejects(()=>withStableWorkbookClaim(h.env,async token=>{
   assert.equal(await stableWorkbookClaimOwned(h.env,token),true);
   insertSyntheticHandoff(h,token);
   assert.equal(await stableWorkbookClaimOwned(h.env,token),false);
   throw Error('TEST_STOP');
  }),/TEST_STOP/);
 }finally{h.close();}
});
test('handoff appearing during notice read fails the final ownership recheck',async()=>{
 const h=fixture(),{stableWorkbookClaimOwned}=require('../dist/sheets/stable-workbook-claim.js'),oldPaused=notice.readStablePausedNotice;try{
  await assert.rejects(()=>withStableWorkbookClaim(h.env,async token=>{
   notice.readStablePausedNotice=async(...args)=>{const paused=await oldPaused(...args);insertSyntheticHandoff(h,token);return paused;};
   assert.equal(await stableWorkbookClaimOwned(h.env,token),false);
   throw Error('TEST_STOP');
  }),/TEST_STOP/);
 }finally{notice.readStablePausedNotice=oldPaused;h.close();}
});
test('serial schema changing during notice read fails the ownership recheck',async()=>{
 const h=fixture(),{stableWorkbookClaimOwned}=require('../dist/sheets/stable-workbook-claim.js'),oldPaused=notice.readStablePausedNotice;try{
  await assert.rejects(()=>withStableWorkbookClaim(h.env,async token=>{
   notice.readStablePausedNotice=async(...args)=>{const paused=await oldPaused(...args);h.sqlite.exec('DROP TABLE serial_pilot_attested_handoffs');return paused;};
   assert.equal(await stableWorkbookClaimOwned(h.env,token),false);throw Error('TEST_STOP');
  }),/TEST_STOP/);
 }finally{notice.readStablePausedNotice=oldPaused;h.close();}
});
test('claim changes during provider read deny ownership before any further write',async()=>{
 for(const change of ["state='REVIEW'","notice_stamp='changed'","notice_identity='changed'","phase='PILOT_TAKEN'","operation_token='changed'"]){
  const h=fixture(),{stableWorkbookClaimOwned}=require('../dist/sheets/stable-workbook-claim.js'),original=notice.readStablePausedNotice;try{
   await assert.rejects(()=>withStableWorkbookClaim(h.env,async token=>{
    const writes=h.writes;
    notice.readStablePausedNotice=async(...args)=>{const snapshot=await original(...args);h.sqlite.prepare(`UPDATE stable_workbook_claims SET ${change} WHERE operation_token=?`).run(token);return snapshot;};
    assert.equal(await stableWorkbookClaimOwned(h.env,token),false,change);assert.equal(h.writes,writes);throw Error('TEST_STOP');
   }),/TEST_STOP/);
  }finally{notice.readStablePausedNotice=original;h.close();}
 }
});
test('legacy and partial serial table shapes fail closed where required',async()=>{
 for(const [handoffs,oracle,sessions,expected] of [[0,0,0,true],[1,1,0,true],[1,1,1,true],[1,0,0,false],[0,1,0,false],[0,0,1,false],[1,0,1,false],[0,1,1,false]]){
  const h=fixture(),{stableWorkbookClaimOwned}=require('../dist/sheets/stable-workbook-claim.js');try{
   await assert.rejects(()=>withStableWorkbookClaim(h.env,async token=>{
    if(!handoffs)h.sqlite.exec('DROP TABLE serial_pilot_attested_handoffs');
    if(!oracle)h.sqlite.exec('DROP TABLE serial_pilot_oracle_fence');
    if(!sessions)h.sqlite.exec('DROP TABLE serial_pilot_continuation_sessions');
    assert.equal(await stableWorkbookClaimOwned(h.env,token),expected,`${handoffs}${oracle}${sessions}`);
    throw Error('TEST_STOP');
   }),/TEST_STOP/);
  }finally{h.close();}
 }
});
test('legacy ownership reports its additional D1 read budget',async()=>{
 const h=fixture(),{stableWorkbookClaimOwned}=require('../dist/sheets/stable-workbook-claim.js'),prepare=h.DB.prepare;let reads=0;try{
  h.DB.prepare=function(sql){if(sql.startsWith('SELECT'))reads++;return prepare.call(this,sql);};
  await withStableWorkbookClaim(h.env,async token=>{reads=0;assert.equal(await stableWorkbookClaimOwned(h.env,token),true);assert.equal(reads,1,'one claim read after the paused provider snapshot');});
 }finally{h.close();}
});
test('notice shows a pause before the operation and verifies ready before unlock',async()=>{const h=fixture();try{await withStableWorkbookClaim(h.env,async()=>{assert.equal(h.status,'พักแก้ไฟล์');assert.equal(h.waited,15000);});assert.equal(h.status,'พร้อมแก้ไข');assert.equal(h.writes,2);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);}finally{h.close();}});
test('uncertain notice write retains the workbook and never starts the operation',async()=>{const h=fixture();try{h.lose();let entered=false;await assert.rejects(withStableWorkbookClaim(h.env,async()=>{entered=true;}));assert.equal(entered,false);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');}finally{h.close();}});

test('rebinding the named status range holds the claim even if values match',async()=>{const h=fixture();try{await assert.rejects(withStableWorkbookClaim(h.env,async()=>{h.rebind();}));assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');}finally{h.close();}});

test('read-only readiness requires a valid ready notice',async()=>{const h=fixture();try{assert.equal(await notice.stableNoticeReady(h.env),true);h.pause();assert.equal(await notice.stableNoticeReady(h.env),false);}finally{h.close();}});
test('a named range changed between metadata and cell reads fails closed',async()=>{const h=fixture();try{h.rebindDuringRead();assert.equal(await notice.stableNoticeReady(h.env),false);assert.equal(h.writes,0);}finally{h.close();}});
function reads(plan){const inner=globalThis.fetch,waits=[],wait=client.sheetsReadRetryTiming.wait;let gets=0;globalThis.fetch=async(input,init)=>{gets++;const r=plan(gets);return r?new Response('{}',{status:r.status,headers:r.headers||{}}):inner(input,init);};client.sheetsReadRetryTiming.wait=async ms=>{waits.push(ms);};return{waits,get gets(){return gets;},reset(){gets=0;},restore(){client.sheetsReadRetryTiming.wait=wait;}};}
const claimRow=h=>({...h.sqlite.prepare('SELECT state,phase,review_reason FROM stable_workbook_claims').get()});
test('notice pause and ready use six and four provider reads',async()=>{const h=fixture(),r=reads(()=>null);try{let begin=0;await withStableWorkbookClaim(h.env,async()=>{begin=r.gets;r.reset();});assert.equal(begin,6);assert.equal(r.gets,4);assert.equal(h.writes,2);}finally{r.restore();h.close();}});
test('a persistent rate limit before the pause write records the phase and cause and writes nothing',async()=>{const h=fixture(),r=reads(n=>n<=2?{status:429}:null);try{let entered=false;await assert.rejects(withStableWorkbookClaim(h.env,async()=>{entered=true;}),/STABLE_NOTICE_READ/);
 assert.equal(entered,false);assert.equal(h.writes,0);assert.equal(h.status,'พร้อมแก้ไข');assert.deepEqual(r.waits,[20000]);assert.deepEqual(claimRow(h),{state:'REVIEW',phase:'BEGIN_NOTICE',review_reason:'STABLE_NOTICE_READ:HTTP_429'});}finally{r.restore();h.close();}});
test('one rate-limited notice read is retried after Retry-After and the operation completes',async()=>{const h=fixture(),r=reads(n=>n===1?{status:429,headers:{'Retry-After':'3'}}:null);try{let entered=false;await withStableWorkbookClaim(h.env,async()=>{entered=true;});
 assert.equal(entered,true);assert.deepEqual(r.waits,[3000]);assert.equal(h.status,'พร้อมแก้ไข');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);}finally{r.restore();h.close();}});
test('a persistent rate limit on the ready notice keeps the pause visible and records the end phase',async()=>{const h=fixture();let r;try{await assert.rejects(withStableWorkbookClaim(h.env,async()=>{r=reads(()=>({status:503}));}),/STABLE_NOTICE_READ/);
 assert.equal(h.status,'พักแก้ไฟล์');assert.equal(h.writes,1);assert.deepEqual(r.waits,[2000]);assert.deepEqual(claimRow(h),{state:'REVIEW',phase:'END_NOTICE',review_reason:'STABLE_NOTICE_READ:HTTP_503'});}finally{r?.restore();h.close();}});

test('paced notice GET 429 before any pause write fails without inline retry',async()=>{
 const h=fixture(),r=reads(n=>n===1?{status:429}:null);
 try{
  h.env.STABLE_SHEETS_PACING_ENABLED='true';
  h.env.STABLE_SHEETS_READ_BUDGET_PER_MINUTE='55';
  await assert.rejects(withStableWorkbookClaim(h.env,async()=>assert.fail('must not reach projection'),{entityType:'EXPENSE',entityKey:'synthetic',entityVersion:1}),/STABLE_NOTICE_READ_DEFERRED/);
  assert.equal(h.writes,0);assert.equal(r.gets,1);assert.deepEqual(r.waits,[]);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM stable_workbook_claims').get().n,0);
 }finally{r.restore();h.close();}
});

test('paced notice GET 429 after a verified business callback retains REVIEW without inline wait',async()=>{
 const h=fixture();let r;
 try{
  h.env.STABLE_SHEETS_PACING_ENABLED='true';
  h.env.STABLE_SHEETS_READ_BUDGET_PER_MINUTE='55';
  let operations=0;
  await assert.rejects(withStableWorkbookClaim(h.env,async()=>{operations++;r=reads(()=>({status:429}));},{entityType:'EXPENSE',entityKey:'synthetic',entityVersion:1}),/STABLE_NOTICE_READ/);
  assert.equal(operations,1);assert.equal(h.writes,1);assert.equal(h.status,'พักแก้ไฟล์');
  assert.deepEqual(r.waits,[]);
  assert.deepEqual(claimRow(h),{state:'REVIEW',phase:'END_NOTICE',review_reason:'STABLE_NOTICE_READ:HTTP_429'});
 }finally{r?.restore();h.close();}
});

test('paced notice rejects a quota error after sending PAUSED as REVIEW, never a safe pre-write defer',async()=>{
 const h=fixture(),r=reads(n=>n===5?{status:429}:null);
 try{
  h.env.STABLE_SHEETS_PACING_ENABLED='true';
  h.env.STABLE_SHEETS_READ_BUDGET_PER_MINUTE='55';
  await assert.rejects(withStableWorkbookClaim(h.env,async()=>assert.fail('projection must not run'),{entityType:'EXPENSE',entityKey:'synthetic',entityVersion:1}),/STABLE_NOTICE_UNVERIFIED/);
  assert.equal(h.writes,1);assert.equal(h.status,'พักแก้ไฟล์');
  assert.deepEqual(r.waits,[]);
  assert.deepEqual(claimRow(h),{state:'REVIEW',phase:'BEGIN_NOTICE',review_reason:'STABLE_NOTICE_UNVERIFIED'});
 }finally{r.restore();h.close();}
});

for(const code of [429,503])for(const failAt of [3,4]){
 test(`paced begin notice GET #${failAt} HTTP ${code} after PAUSED must retain REVIEW and never defer`,async()=>{
  const h=fixture(),r=reads(n=>n===failAt?{status:code}:null);
  try{
   h.env.STABLE_SHEETS_PACING_ENABLED='true';h.env.STABLE_SHEETS_READ_BUDGET_PER_MINUTE='55';
   await assert.rejects(withStableWorkbookClaim(h.env,async()=>assert.fail('business projection must not run'),{entityType:'EXPENSE',entityKey:'synthetic',entityVersion:1}),/STABLE_NOTICE_READ/);
   assert.equal(h.writes,1);assert.equal(h.status,'พักแก้ไฟล์');
   assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_workbook_claims WHERE state='REVIEW'").get().n,1);
   assert.deepEqual(claimRow(h),{state:'REVIEW',phase:'BEGIN_NOTICE',review_reason:`STABLE_NOTICE_READ:HTTP_${code}`});
   assert.deepEqual(r.waits,[]);
  }finally{r.restore();h.close();}
 });
}
function armNoticeCanary(h){
 h.env.STABLE_RECOVERY_GATE_ENABLED='true';
 h.env.STABLE_SHEETS_PACING_ENABLED='true';
 h.env.STABLE_SHEETS_READ_BUDGET_PER_MINUTE='55';
 h.sqlite.prepare("INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('canary-epoch-test-1','book','ARMED','EXPENSE','exp_fixture',1,'now','now')").run();
}
test('gate and pacing pre-POST GET 429 defer with NO admitted operation; same target may retry',async()=>{
 const h=fixture(),r=reads(n=>n===1?{status:429}:null),job={entityType:'EXPENSE',entityKey:'exp_fixture',entityVersion:1};
 try{
  armNoticeCanary(h);
  await assert.rejects(withStableWorkbookClaim(h.env,async()=>assert.fail('first attempt must not project'),job),/STABLE_NOTICE_READ_DEFERRED/);
  assert.equal(h.writes,0);
  assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_recovery_operations').get().n,0);
  assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);
  // Pacing still enforces the interval after a failed read. Simulate the
  // elapsed cooldown in this local-only fixture, NOT an operator refund.
  await assert.rejects(withStableWorkbookClaim(h.env,async()=>assert.fail('cooldown must hold'),job),/STABLE_SHEETS_PACING_BLOCKED/);
  h.sqlite.prepare("UPDATE stable_sheet_pacing SET last_admission_ms=0,reserved_units=0,window_minute=0 WHERE spreadsheet_id='book'").run();
  let executions=0;
  const outcome=await withStableWorkbookClaim(h.env,async()=>{executions++;return 'CONTINUE';},job);
  assert.equal(outcome,'CONTINUE');assert.equal(executions,1);
  assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_recovery_operations WHERE state='VERIFIED'").get().n,1);
 }finally{r.restore();h.close();}
});
test('gate and pacing post-PAUSED GET 503 holds ADMITTED and REVIEW; it cannot silently retry',async()=>{
 const h=fixture(),r=reads(n=>n===3?{status:503}:null),job={entityType:'EXPENSE',entityKey:'exp_fixture',entityVersion:1};
 try{
  armNoticeCanary(h);
  await assert.rejects(withStableWorkbookClaim(h.env,async()=>assert.fail('must not project'),job),/STABLE_NOTICE_READ/);
  assert.equal(h.writes,1);
  assert.deepEqual(claimRow(h),{state:'REVIEW',phase:'BEGIN_NOTICE',review_reason:'STABLE_NOTICE_READ:HTTP_503'});
  assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_recovery_operations WHERE state='ADMITTED'").get().n,1);
  await assert.rejects(withStableWorkbookClaim(h.env,async()=>assert.fail('must not reenter'),job),/STABLE_RECOVERY_GATE_BLOCKED|STABLE_WORKBOOK_REVIEW/);
 }finally{r.restore();h.close();}
});

for(const initial of ['พร้อมแก้ไข • กำลังซิงก์','พร้อมแก้ไข • กำลังซิงก์ • มีรายการรอตรวจ'])test(`normal notice can begin from ${initial}`,async()=>{const h=fixture();try{h.setStatus(initial);assert.equal(await notice.stableNoticeReady(h.env),true);await withStableWorkbookClaim(h.env,async()=>{assert.equal(h.status,'พักแก้ไฟล์');});assert.equal(h.status,'พร้อมแก้ไข');assert.equal(h.writes,2);}finally{h.close();}});
for(const initial of [`พร้อมแก้ไข • กำลังซิงก์ • รหัส ${'a'.repeat(32)}`,`พร้อมแก้ไข • กำลังซิงก์ • มีรายการรอตรวจ • รหัส ${'b'.repeat(32)}`])test('normal notice can begin from a nonce-bound syncing status',async()=>{const h=fixture();try{h.setStatus(initial);assert.equal(await notice.stableNoticeReady(h.env),true);await withStableWorkbookClaim(h.env,async()=>{assert.equal(h.status,'พักแก้ไฟล์');});assert.equal(h.status,'พร้อมแก้ไข');}finally{h.close();}});
test('expired-revoke strict notice read exposes transient status while default callers fail closed',async()=>{const h=fixture(),r=reads(()=>({status:503}));try{h.env.STABLE_SHEETS_PACING_ENABLED='true';assert.equal(await notice.stableNoticePaused(h.env,'stamp','identity'),false);await assert.rejects(notice.stableNoticePaused(h.env,'stamp','identity',undefined,undefined,true),e=>e instanceof client.SheetsHttpError&&e.status===503);assert.equal(h.writes,0);}finally{r.restore();h.close();}});

test('a changed paused pilot notice style prevents the ready request',async()=>{
 const h=fixture(true);
 try{
  h.pause();const identity=JSON.stringify([1815870717,'s','t']);
  h.sqlite.prepare("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,notice_stamp,notice_identity,created_at,updated_at) VALUES('book','pilot-token','HELD','old',?,'now','now')").run(identity);
  const style=await notice.stableNoticeStyleFingerprint(h.env,identity,'พักแก้ไฟล์','old');
  assert.match(style,/^[a-f0-9]{64}$/);h.restyle();
  await assert.rejects(notice.endStableNotice(h.env,'pilot-token',false,async()=>{},style),/PILOT_NOTICE_STYLE_CHANGED/);
  assert.equal(h.writes,0);assert.equal(h.status,'พักแก้ไฟล์');
 }finally{h.close();}
});

test('notice postimage digest is returned only after validated ready readback',async()=>{
 const h=fixture(true);
 try{
  h.pause();const identity=JSON.stringify([1815870717,'s','t']);
  h.sqlite.prepare("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,notice_stamp,notice_identity,created_at,updated_at) VALUES('book','pilot-token','HELD','old',?,'now','now')").run(identity);
  const style=await notice.stableNoticeStyleFingerprint(h.env,identity,'พักแก้ไฟล์','old');
  const result=await notice.endStableNotice(h.env,'pilot-token',false,async()=>{},style,true);
  assert.match(result.postimageDigest,/^[a-f0-9]{64}$/);assert.equal(h.writes,1);
 }finally{h.close();}
});

test('lost ready notice acknowledgement retains claim and does not repeat the write',async()=>{
 const h=fixture();try{
  await assert.rejects(withStableWorkbookClaim(h.env,async()=>{h.lose();}),/lost response/);
  assert.equal(h.writes,2);assert.equal(h.status,'พร้อมแก้ไข');
  assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 }finally{h.close();}
});
