process.env.MALIPANG_TEST_CANDIDATE_FLAGS='1'; // candidate behaviour flags on for this file
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
import {cutoverReadySql} from './helpers/cutover-ready.mjs';

const require=createRequire(import.meta.url);
const notice=require('../dist/sheets/stable-edit-notice.js');
const {SheetsHttpError,SheetsReadNetworkError,SheetsMutationOutcomeUnknownError}=require('../dist/sheets/client.js');
const {GoogleOAuthHttpError,GoogleOAuthPreflightError}=require('../dist/sheets/google-auth.js');
const {OperationTimeoutError}=require('../dist/shared/async.js');
const {runStableExpenseJob}=require('../dist/sheets/stable-expense-job.js');

function fixture(error,{afterAuthorization=false,priorIntent=false,owner=true,realNotice=false}={}){
 const h=expenseSqlite(),prepare=h.DB.prepare,batch=h.DB.batch,oldBegin=notice.beginStableNotice,sent=[];
 h.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run,all=s.all;s.run=async function(){return{...await run.call(this),success:true}};s.all=async function(){return{...await all.call(this),success:true}};return s};
 h.DB.batch=async function(stmts){return(await batch.call(this,stmts)).map(r=>({...r,success:true}))};
 Object.assign(h.env,{APP_ENV:'production',RUNTIME_MODE:'production',SHEETS_SYNC_ENABLED:'true',STABLE_PHASE1_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',STABLE_CANCELLATION_PREIMAGE_ENABLED:'true',CONTINUOUS_DAILY_ENABLED:'true',CONTINUOUS_DAILY_SHEET:'newdaily',CONTINUOUS_DAILY_SHEET_ID:'8',CONTINUOUS_RAW_SHEET:'newraw',CONTINUOUS_RAW_SHEET_ID:'9',CONTINUOUS_DETAIL_SHEET:'newdetail',CONTINUOUS_DETAIL_SHEET_ID:'10',SHEET_EXPENSE_DAILY:'olddaily',SHEET_EXPENSE_RAW:'oldraw',SHEET_PURCHASE_DETAILS:'olddetail',GOOGLE_SPREADSHEET_ID:'book',LINE_OWNER_USER_ID:owner?'owner':'',SHADOW_LINE_OUTPUT:'false',JOB_QUEUE:{async send(job){sent.push(job)}}});
 h.sqlite.exec(`UPDATE stable_sync_cutover SET state='ACTIVE',activated_at='now';
 INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','setup','HELD','now','now');
 INSERT INTO continuous_daily_cutovers(spreadsheet_id,legacy_sheet_id,legacy_sheet_name,continuous_sheet_id,continuous_sheet_name,raw_sheet_id,raw_sheet_name,detail_sheet_id,detail_sheet_name,claim_token,source_revision,state,prepared_at) SELECT 'book',7,'olddaily',8,'newdaily',9,'newraw',10,'newdetail','setup',revision,'PREPARED','now' FROM stable_source_revision;
 ${cutoverReadySql('setup')}
 UPDATE continuous_daily_cutovers SET state='ACTIVE',activated_at='now'; DELETE FROM stable_workbook_claims WHERE operation_token='setup';
 INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_test','msg','user','Synthetic',10000,'transfer','SHOP_BANK','ingredients','2026-11-15','CONFIRMED','now',1);
 INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,lease_until,lease_token) VALUES('job','EXPENSE','exp_test',1,'trace','PROCESSING',1,'now','2099-01-01T00:00:00.000Z','lease');
 INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-test','book','ARMED','EXPENSE','exp_test',1,'now','now');`);
 if(priorIntent)h.sqlite.exec(`INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE','exp_test','DAILY',8,'newdaily',1,'${'a'.repeat(64)}','prior','IN_FLIGHT','now')`);
 if(!realNotice)notice.beginStableNotice=async(_env,_token,_wait,before)=>{if(afterAuthorization)await before();throw error};
 const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_test',entityVersion:1,traceId:'trace'};
 return{...h,sent,run:()=>runStableExpenseJob(h.env,job,'lease'),close(){notice.beginStableNotice=oldBegin;h.close()}};
}

for(const [name,error,code] of [
 ['Sheets permission',new SheetsHttpError(403,'STABLE_NOTICE_READ'),'SHEETS_READ_HTTP_403'],
 ['Sheets rate limit',new SheetsHttpError(429,'STABLE_NOTICE_READ'),'SHEETS_READ_HTTP_429'],
 ['OAuth permission',new GoogleOAuthHttpError(403),'GOOGLE_OAUTH_HTTP_403'],
 ['OAuth invalid credentials',new GoogleOAuthPreflightError('GOOGLE_OAUTH_CREDENTIAL_INVALID'),'GOOGLE_OAUTH_CREDENTIAL_INVALID'],
 ['OAuth network',new GoogleOAuthPreflightError('GOOGLE_OAUTH_NETWORK'),'GOOGLE_OAUTH_NETWORK'],
 ['OAuth invalid response',new GoogleOAuthPreflightError('GOOGLE_OAUTH_RESPONSE_INVALID'),'GOOGLE_OAUTH_RESPONSE_INVALID'],
 ['OAuth timeout',new OperationTimeoutError('Google OAuth',100),'GOOGLE_OAUTH_TIMEOUT'],
 ['notice read timeout',new OperationTimeoutError('Stable notice read',100),'SHEETS_READ_TIMEOUT']
])test(`${name} before notice POST cancels only the unwritten expense and alerts`,async()=>{
 const h=fixture(error);try{
  assert.equal(await h.run(),'COMPLETED');
  assert.deepEqual({...h.sqlite.prepare("SELECT status,version FROM expense_events WHERE expense_id='exp_test'").get()},{status:'CANCELLED',version:2});
  assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'COMPLETED');
  assert.equal(h.sqlite.prepare("SELECT state FROM stable_recovery_epochs WHERE epoch_id='epoch-test'").get().state,'COMPLETE');
  assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);
  assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_projection_writes').get().n,0);
  assert.equal(h.sent.length,1);assert.match(h.sent[0].messages[0].text,new RegExp(code));
 }finally{h.close()}
});

test('unavailable owner retains a minimal deferred alert after safe cancellation',async()=>{
 const h=fixture(new GoogleOAuthHttpError(403),{owner:false});try{
  assert.equal(await h.run(),'COMPLETED');assert.equal(h.sent.length,0);
  const row=h.sqlite.prepare("SELECT error,payload_json FROM failed_jobs WHERE error='SYNC_AUTO_CANCEL_AWAITING_RECIPIENT'").get();
  assert.ok(row);assert.equal(JSON.parse(row.payload_json).errorCode,'GOOGLE_OAUTH_HTTP_403');assert.doesNotMatch(row.payload_json,/Synthetic|10000/);
 }finally{h.close()}
});

test('prior business intent prevents pre-notice cancellation and retains REVIEW',async()=>{
 const h=fixture(new SheetsHttpError(403,'STABLE_NOTICE_READ'),{priorIntent:true});try{
  await assert.rejects(h.run());assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CONFIRMED');
  assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
  assert.equal(h.sqlite.prepare('SELECT state FROM stable_projection_writes').get().state,'IN_FLIGHT');
 }finally{h.close()}
});

test('an uncertain notice POST is never treated as an untouched read failure',async()=>{
 const h=fixture(new SheetsMutationOutcomeUnknownError(new SheetsHttpError(503,'unavailable')),{afterAuthorization:true});try{
  await assert.rejects(h.run());assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CONFIRMED');
  assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
  assert.equal(h.sqlite.prepare('SELECT state FROM stable_recovery_operations').get().state,'ADMITTED');
 }finally{h.close()}
});

test('a typed OAuth failure after notice authorization cannot cancel the expense',async()=>{
 const h=fixture(new GoogleOAuthPreflightError('GOOGLE_OAUTH_NETWORK'),{afterAuthorization:true});try{
  await assert.rejects(h.run());assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CONFIRMED');
  assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
  assert.equal(h.sqlite.prepare('SELECT state FROM stable_recovery_operations').get().state,'ADMITTED');
  assert.equal(h.sent.length,0);
 }finally{h.close()}
});

test('a Sheets GET network failure after notice authorization cannot cancel the expense',async()=>{
 const h=fixture(new SheetsReadNetworkError(),{afterAuthorization:true});try{
  await assert.rejects(h.run());assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CONFIRMED');
  assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
  assert.equal(h.sqlite.prepare('SELECT state FROM stable_recovery_operations').get().state,'ADMITTED');
  assert.equal(h.sent.length,0);
 }finally{h.close()}
});

async function syntheticCredentials(){
 const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:1024,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const der=Buffer.from(await crypto.subtle.exportKey('pkcs8',pair.privateKey)).toString('base64');
 return {GOOGLE_SERVICE_ACCOUNT_EMAIL:'synthetic@example.invalid',GOOGLE_PRIVATE_KEY_BASE64:Buffer.from(`-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----`).toString('base64')};
}

test('real notice and client paths never POST to Sheets on pre-notice OAuth/read failures',{timeout:5000},async()=>{
 const credentials=await syntheticCredentials(),originalFetch=globalThis.fetch;
 for(const [kind,code] of [['key','GOOGLE_OAUTH_CREDENTIAL_INVALID'],['network','GOOGLE_OAUTH_NETWORK'],['response','GOOGLE_OAUTH_RESPONSE_INVALID'],['body-timeout','GOOGLE_OAUTH_TIMEOUT'],['error-cancel-hang','GOOGLE_OAUTH_HTTP_403'],['oversize','GOOGLE_OAUTH_RESPONSE_INVALID'],['token-oversize','GOOGLE_OAUTH_RESPONSE_INVALID'],['sheet-network','SHEETS_READ_NETWORK'],['sheet-stall','SHEETS_READ_TIMEOUT'],['sheet','SHEETS_READ_HTTP_403']]){
  const h=fixture(null,{realNotice:true}),requests=[];Object.assign(h.env,credentials);
  if(kind==='key')h.env.GOOGLE_PRIVATE_KEY_BASE64='not-a-valid-private-key';
  if(kind==='body-timeout'||kind==='sheet-stall')h.env.EXTERNAL_API_TIMEOUT_MS='30';
  globalThis.fetch=async(input,init={})=>{
   const url=new URL(String(input));requests.push({host:url.hostname,method:init.method||'GET'});
   if(url.hostname==='oauth2.googleapis.com'){
    if(kind==='network')throw new TypeError('private upstream network detail');
    if(kind==='response')return new Response('{malformed private payload',{status:200});
    if(kind==='body-timeout')return new Response(new ReadableStream({start(){}}),{status:200});
    if(kind==='error-cancel-hang')return new Response(new ReadableStream({cancel(){return new Promise(()=>{});}}),{status:403});
    if(kind==='oversize')return new Response('x'.repeat(65537),{status:200});
    if(kind==='token-oversize')return Response.json({access_token:'x'.repeat(2049),expires_in:3600});
    return Response.json({access_token:'synthetic-token',expires_in:30});
   }
   if(url.hostname==='sheets.googleapis.com'){if(kind==='sheet-network')throw new TypeError('private sheet network');if(kind==='sheet-stall')return new Response(new ReadableStream({start(){},cancel(){return new Promise(()=>{});}}));return new Response('private sheet error',{status:403});}
   throw Error('unexpected test request');
  };
  try{
   assert.equal(await h.run(),'COMPLETED');
   assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CANCELLED');
   assert.equal(h.sqlite.prepare('SELECT state FROM stable_recovery_epochs').get().state,'COMPLETE');
   assert.equal(requests.filter(r=>r.host==='sheets.googleapis.com'&&r.method==='POST').length,0);
   assert.ok(kind==='key'?requests.filter(r=>r.host==='oauth2.googleapis.com').length===0:requests.some(r=>r.host==='oauth2.googleapis.com'));
   assert.equal(h.sent.length,1);assert.match(h.sent[0].messages[0].text,new RegExp(code));
   assert.doesNotMatch(h.sent[0].messages[0].text,/private upstream|private payload|private sheet error/);
  }finally{globalThis.fetch=originalFetch;h.close()}
 }
});

test('Sheets response bodies have a deadline and mutations with lost replies remain unknown',{timeout:5000},async()=>{
 const credentials=await syntheticCredentials(),oldFetch=globalThis.fetch,client=require('../dist/sheets/client.js');
 const env={...credentials,GOOGLE_SPREADSHEET_ID:'book',EXTERNAL_API_TIMEOUT_MS:'30',STABLE_SHEETS_PACING_ENABLED:'true'};let mode='';const calls=[];
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(String(input));if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'synthetic-token',expires_in:30});
  calls.push(init.method||'GET');
  if(mode==='large')return Response.json({values:[['x'.repeat(17*1024*1024)]]});
  return new Response(new ReadableStream({start(){},cancel(){return new Promise(()=>{});}}),{status:mode==='error'?403:200});
 };
 try{
  mode='large';assert.equal((await client.getSheetValues(env,'A1'))[0][0].length,17*1024*1024);
  mode='error';await assert.rejects(client.batchUpdateSpreadsheetWithReply(env,[{}]),e=>e instanceof SheetsMutationOutcomeUnknownError);
  mode='stall';await assert.rejects(client.batchUpdateSpreadsheetWithReply(env,[{}]),e=>e instanceof SheetsMutationOutcomeUnknownError);
  assert.deepEqual(calls,['GET','POST','POST']);
 }finally{globalThis.fetch=oldFetch}
});

// QA (#298): the untouched-notice handler (stable-expense-job.ts:284) with the
// auto-cancel flag unset or not exactly 'true' returns before any recovery
// admission, so nothing is admitted, cancelled or alerted.
for(const value of [undefined,'false','TRUE','1'])for(const [name,error] of [
 ['Sheets permission',new SheetsHttpError(403,'STABLE_NOTICE_READ')],
 ['OAuth network',new GoogleOAuthPreflightError('GOOGLE_OAUTH_NETWORK')],
 ['notice read timeout',new OperationTimeoutError('Stable notice read',100)]
])test(`auto-cancel flag ${value===undefined?'unset':`'${value}'`}: ${name} before notice POST admits and cancels nothing`,async()=>{
 const h=fixture(error);try{
  if(value===undefined)delete h.env.UNWRITTEN_EXPENSE_AUTO_CANCEL_ENABLED;else h.env.UNWRITTEN_EXPENSE_AUTO_CANCEL_ENABLED=value;
  const before=h.sqlite.prepare('SELECT count(*) n FROM failed_jobs').get().n;
  await assert.rejects(h.run());
  assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_recovery_operations').get().n,0,'no recovery admission');
  assert.equal(h.sqlite.prepare("SELECT state FROM stable_recovery_epochs WHERE epoch_id='epoch-test'").get().state,'ARMED');
  assert.deepEqual({...h.sqlite.prepare("SELECT status,version FROM expense_events WHERE expense_id='exp_test'").get()},{status:'CONFIRMED',version:1});
  assert.equal(h.sqlite.prepare('SELECT count(*) n FROM expense_events').get().n,1);
  assert.notEqual(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'COMPLETED');
  assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_projection_writes').get().n,0);
  assert.equal(h.sent.length,0,'no LINE alert');
  assert.equal(h.sqlite.prepare('SELECT count(*) n FROM failed_jobs').get().n,before,'no deferred alert');
  // The original fence: the claim is retained for review at BEGIN_NOTICE.
  const claims=h.sqlite.prepare('SELECT state,phase FROM stable_workbook_claims').all().map(r=>({...r}));
  assert.deepEqual(claims,[{state:'REVIEW',phase:'BEGIN_NOTICE'}]);
 }finally{h.close()}
});
