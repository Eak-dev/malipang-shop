import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {DatabaseSync} from 'node:sqlite';import {readFileSync,readdirSync} from 'node:fs';import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),auth=require('../dist/sheets/google-auth.js'),{stableFaultReason}=require('../dist/sheets/stable-fault.js'),{OperationTimeoutError}=require('../dist/shared/async.js'),{withStableWorkbookClaim}=require('../dist/sheets/stable-workbook-claim.js');
function provider(responses){const oldFetch=globalThis.fetch,oldAuth=auth.getGoogleAccessToken,oldWait=client.sheetsReadRetryTiming.wait,calls=[];auth.getGoogleAccessToken=async()=>'fixture';client.sheetsReadRetryTiming.wait=async()=>{};
 globalThis.fetch=async(input,init)=>{calls.push(init?.method||'GET');const next=responses.shift()??{status:200,body:{}};return new Response(JSON.stringify(next.body??{}),{status:next.status});};
 return{calls,restore(){globalThis.fetch=oldFetch;auth.getGoogleAccessToken=oldAuth;client.sheetsReadRetryTiming.wait=oldWait;}};}

test('fault reasons are short codes and never copy provider bodies or free-form messages',()=>{
 assert.equal(stableFaultReason(new client.SheetsHttpError(400,'Sheets HTTP 400: {"error":"private row text"}')),'SHEETS_HTTP:HTTP_400');
 assert.equal(stableFaultReason(new client.SheetsHttpError(429,'STABLE_NOTICE_READ')),'STABLE_NOTICE_READ:HTTP_429');
 assert.equal(stableFaultReason(new client.SheetsMutationOutcomeUnknownError(new client.SheetsHttpError(503,'Sheets HTTP 503: body'))),'SHEETS_MUTATION_OUTCOME_UNKNOWN:HTTP_503');
 assert.equal(stableFaultReason(new client.SheetsMutationOutcomeUnknownError(new OperationTimeoutError('Google Sheets POST',15000))),'SHEETS_MUTATION_OUTCOME_UNKNOWN:TIMEOUT');
 assert.equal(stableFaultReason(new OperationTimeoutError('Stable notice read',15000)),'TIMEOUT');
 assert.equal(stableFaultReason(Error('Too many subrequests.')),'WORKER_SUBREQUEST_LIMIT');
 assert.equal(stableFaultReason(Error('D1_ERROR: Too many API requests by single Worker invocation')),'D1_QUERY_LIMIT');
 assert.equal(stableFaultReason(Error('STABLE_EXPENSE_CONTINUE_UNCERTAIN')),'STABLE_EXPENSE_CONTINUE_UNCERTAIN');
 assert.equal(stableFaultReason(Error('Expense not found: exp_private')),'UNCLASSIFIED_ERROR');
 assert.equal(stableFaultReason(new TypeError('fetch failed for private host')),'UNCLASSIFIED_TYPEERROR');
 assert.equal(stableFaultReason('plain'),'UNCLASSIFIED_ERROR');
});

test('a transient read is retried once while mutations and non-GET requests are never retried',async()=>{
 let p=provider([{status:503},{status:200,body:{values:[['ok']]}}]);try{assert.deepEqual(await client.getSheetValues({GOOGLE_SPREADSHEET_ID:'book'},'A1'),[['ok']]);assert.deepEqual(p.calls,['GET','GET']);}finally{p.restore();}
 p=provider([{status:429},{status:429}]);try{await assert.rejects(client.getSheetValues({GOOGLE_SPREADSHEET_ID:'book'},'A1'),e=>e instanceof client.SheetsHttpError&&e.status===429);assert.equal(p.calls.length,2);}finally{p.restore();}
 p=provider([{status:503}]);try{await assert.rejects(client.batchWriteValues({GOOGLE_SPREADSHEET_ID:'book'},[{range:'A1',values:[[1]]}]),client.SheetsMutationOutcomeUnknownError);assert.deepEqual(p.calls,['POST']);}finally{p.restore();}
 p=provider([{status:200,body:{sheets:[]}},{status:503}]);try{await assert.rejects(client.bootstrapSheets({GOOGLE_SPREADSHEET_ID:'book'}),e=>e instanceof client.SheetsHttpError&&e.status===503);assert.deepEqual(p.calls,['GET','POST']);}finally{p.restore();}
});

test('migration 0022 keeps an existing production-shaped review claim and adds empty diagnostics',()=>{
 const sqlite=new DatabaseSync(':memory:'),directory=new URL('../migrations/',import.meta.url),names=readdirSync(directory).filter(n=>n.endsWith('.sql')).sort();
 try{for(const name of names.filter(n=>n<'0022'))sqlite.exec(readFileSync(new URL(name,directory),'utf8'));
  sqlite.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,notice_stamp,notice_identity,created_at,updated_at) VALUES('book','token','REVIEW','2026-11-05 21:26:00','identity','2026-11-05T14:25:59.377Z','2026-11-05T14:26:29.705Z')");
  for(const name of names.filter(n=>n>='0022'))sqlite.exec(readFileSync(new URL(name,directory),'utf8'));
  assert.deepEqual({...sqlite.prepare('SELECT state,notice_stamp,notice_identity,updated_at,phase,review_reason FROM stable_workbook_claims').get()},{state:'REVIEW',notice_stamp:'2026-11-05 21:26:00',notice_identity:'identity',updated_at:'2026-11-05T14:26:29.705Z',phase:null,review_reason:null});
  assert.equal(sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(sqlite.prepare('SELECT count(*) n FROM pragma_foreign_key_check').get().n,0);
 }finally{sqlite.close();}
});

test('before migration 0022 is applied a failed operation still retains the claim for review',async()=>{const h=expenseSqlite(),error=console.error;try{
 console.error=()=>{};Object.assign(h.env,{GOOGLE_SPREADSHEET_ID:'book',STABLE_PHASE1_ENABLED:'false'});const prepare=h.DB.prepare;
 h.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run;s.run=async function(){if(sql.includes('review_reason=?'))throw Error('no such column: phase');return{...await run.call(this),success:true};};return s;};
 await assert.rejects(withStableWorkbookClaim(h.env,async()=>{throw Error('unknown provider response');}));
 assert.deepEqual({...h.sqlite.prepare('SELECT state,phase,review_reason FROM stable_workbook_claims').get()},{state:'REVIEW',phase:null,review_reason:null});
}finally{console.error=error;h.close();}});
