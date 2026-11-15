import test from 'node:test';import assert from 'node:assert/strict';import {generateKeyPairSync} from 'node:crypto';import {createRequire} from 'node:module';import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url),{ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),notice=require('../dist/sheets/stable-edit-notice.js');
test('invocation notice reserves all postreads before dispatch and counts OAuth plus HTTP',async()=>{
 const h=expenseSqlite(),originalFetch=globalThis.fetch,prepare=h.DB.prepare;let status='พร้อมแก้ไข',time='old',posts=0,requests=0;
 try{
  h.DB.prepare=function(sql){const statement=prepare.call(this,sql),run=statement.run;statement.run=async function(){return {...await run.call(this),success:true};};return statement;};
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  Object.assign(h.env,{GOOGLE_SPREADSHEET_ID:'book',GOOGLE_SERVICE_ACCOUNT_EMAIL:'test@example.invalid',GOOGLE_PRIVATE_KEY_BASE64:Buffer.from(privateKey).toString('base64'),SHEET_EXPENSE_DAILY:'daily',STABLE_PHASE1_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true'});
  h.sqlite.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','claim','HELD','now','now')");
  globalThis.fetch=async(input,init={})=>{requests++;const url=String(input);if(url.includes('oauth2.googleapis.com'))return Response.json({access_token:'synthetic',expires_in:3600});if(url.includes('values:batchUpdate')){posts++;const data=JSON.parse(init.body).data;status=data[0].values[0][0];time=data[1].values[0][0];return Response.json({});}const parsed=new URL(url),sheet={properties:{sheetId:9,title:'daily',gridProperties:{rowCount:100,columnCount:25,frozenRowCount:3}}},namedRanges=[{namedRangeId:'s',name:'MLP_DAILY_STATUS',range:{sheetId:9,startRowIndex:0,endRowIndex:1,startColumnIndex:23,endColumnIndex:24}},{namedRangeId:'t',name:'MLP_DAILY_STATUS_TIME',range:{sheetId:9,startRowIndex:0,endRowIndex:1,startColumnIndex:24,endColumnIndex:25}}];if(parsed.searchParams.has('ranges'))sheet.data=[{startRow:0,startColumn:23,rowData:[{values:[{userEnteredValue:{stringValue:status}}]}]},{startRow:0,startColumn:24,rowData:[{values:[{userEnteredValue:{stringValue:time}}]}]}];return Response.json({spreadsheetId:'book',namedRanges,sheets:[sheet]});};
  const tooSmall=new ReviewRequestBudget(8,'invocation');await assert.rejects(notice.beginStableNotice(h.env,'claim',async()=>{},async()=>{},true,tooSmall),/STABLE_NOTICE_BUDGET/);assert.equal(posts,0);assert.equal(requests,0);
  const budget=new ReviewRequestBudget(9,'invocation');await notice.beginStableNotice(h.env,'claim',async()=>{},async()=>{},true,budget);assert.equal(posts,1);assert.equal(requests,8);assert.equal(budget.used,requests);assert.equal(budget.postReserved,0);budget.consumeQueue();budget.consumeQueue();assert.equal(budget.queueUsed,2);assert.throws(()=>budget.consumeQueue(),/REVIEW_REQUEST_BUDGET_EXHAUSTED/);
 }finally{globalThis.fetch=originalFetch;h.close();}
});
test('publication mode fails before any legacy expense sync can write',async()=>{
 const {syncJob}=require('../dist/sheets/sync.js');
 await assert.rejects(syncJob({CONTINUOUS_PUBLICATION_ENABLED:'true'},{kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_x',entityVersion:1}),/PUBLICATION_LEGACY_DISABLED/);
});
test('queue entry passes one publication budget through dispatch and counts continuation enqueue',async()=>{
 const h=expenseSqlite(),worker=require('../dist/index.js').default,dispatch=require('../dist/sheets/stable-phase1-dispatch.js'),old=dispatch.dispatchStablePhase1;let captured,sends=0,acks=0;
 try{
  Object.assign(h.env,{CONTINUOUS_PUBLICATION_ENABLED:'true',STABLE_PHASE1_ENABLED:'true'});h.env.JOB_QUEUE.send=async()=>{sends++;};dispatch.dispatchStablePhase1=async(_env,_job,_attempt,budget)=>{captured=budget;for(let i=0;i<48;i++)budget.consumeRead();return 'CONTINUE';};
  const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_fixture',entityVersion:1,traceId:'synthetic'},message={body:job,attempts:1,ack(){acks++;},retry(){assert.fail('unexpected retry');}};
  await worker.queue({queue:'malipang-jobs',messages:[message]},h.env,{});assert.equal(captured.used,48);assert.equal(captured.queueUsed,1);assert.equal(sends,1);assert.equal(acks,1);
 }finally{dispatch.dispatchStablePhase1=old;h.close();}
});
