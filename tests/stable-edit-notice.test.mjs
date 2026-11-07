import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),auth=require('../dist/sheets/google-auth.js'),notice=require('../dist/sheets/stable-edit-notice.js'),{withStableWorkbookClaim}=require('../dist/sheets/stable-workbook-claim.js');
function fixture(){
 const h=expenseSqlite(),prepare=h.DB.prepare,oldFetch=globalThis.fetch,oldAuth=auth.getGoogleAccessToken,oldWrite=client.batchWriteValues,oldBegin=notice.beginStableNotice;let status='พร้อมแก้ไข',time='old',writes=0,lose=false,waited=0,statusId='s',rebindOnData=false;
 h.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run;s.run=async function(){return{...await run.call(this),success:true};};return s;};Object.assign(h.env,{GOOGLE_SPREADSHEET_ID:'book',SHEET_EXPENSE_DAILY:'daily',STABLE_PHASE1_ENABLED:'true'});auth.getGoogleAccessToken=async()=> 'fixture';
 globalThis.fetch=async input=>{const u=new URL(String(input)),sheet={properties:{sheetId:9,title:'daily',gridProperties:{rowCount:100,columnCount:25,frozenRowCount:3}}};if(u.searchParams.has('ranges')){if(rebindOnData)statusId='rebound';sheet.data=[{startRow:0,startColumn:23,rowData:[{values:[{userEnteredValue:{stringValue:status}}]}]},{startRow:0,startColumn:24,rowData:[{values:[{userEnteredValue:{stringValue:time}}]}]}];}return new Response(JSON.stringify({spreadsheetId:'book',namedRanges:[{namedRangeId:statusId,name:'MLP_DAILY_STATUS',range:{sheetId:9,startRowIndex:0,endRowIndex:1,startColumnIndex:23,endColumnIndex:24}},{namedRangeId:'t',name:'MLP_DAILY_STATUS_TIME',range:{sheetId:9,startRowIndex:0,endRowIndex:1,startColumnIndex:24,endColumnIndex:25}}],sheets:[sheet]}));};
 client.batchWriteValues=async(_env,data,before)=>{await before();writes++;status=data[0].values[0][0];time=data[1].values[0][0];if(lose)throw Error('lost response');};notice.beginStableNotice=(env,token,_wait,onMutationAuthorized)=>oldBegin(env,token,async ms=>{waited=ms;},onMutationAuthorized);
 return{...h,get status(){return status;},get writes(){return writes;},get waited(){return waited;},lose(){lose=true;},rebind(){statusId='rebound';},rebindDuringRead(){rebindOnData=true;},pause(){status='พักแก้ไฟล์';},close(){globalThis.fetch=oldFetch;auth.getGoogleAccessToken=oldAuth;client.batchWriteValues=oldWrite;notice.beginStableNotice=oldBegin;h.close();}};
}
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
