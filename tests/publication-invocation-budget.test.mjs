process.env.MALIPANG_TEST_CANDIDATE_FLAGS='1'; // candidate behaviour flags on for this file
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
 const {syncJob}=require('../dist/sheets/sync.js'),activation=require('../dist/sheets/continuous-notice-activation.js'),old=activation.assertContinuousNoticeActivation;
 try{activation.assertContinuousNoticeActivation=async()=>{};await assert.rejects(syncJob({CONTINUOUS_PUBLICATION_ENABLED:'true'},{kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_x',entityVersion:1}),/PUBLICATION_LEGACY_DISABLED/);}finally{activation.assertContinuousNoticeActivation=old;}
});
test('queue entry passes one publication budget through dispatch and counts continuation enqueue',async()=>{
 const h=expenseSqlite(),worker=require('../dist/index.js').default,dispatch=require('../dist/sheets/stable-phase1-dispatch.js'),old=dispatch.dispatchStablePhase1;let captured,sends=0,acks=0;
 try{
  Object.assign(h.env,{CONTINUOUS_PUBLICATION_ENABLED:'true',STABLE_PHASE1_ENABLED:'true'});h.env.JOB_QUEUE.send=async()=>{sends++;};dispatch.dispatchStablePhase1=async(_env,_job,_attempt,budget)=>{captured=budget;for(let i=0;i<48;i++)budget.consumeRead();return 'CONTINUE';};
  const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_fixture',entityVersion:1,traceId:'synthetic'},message={body:job,attempts:1,ack(){acks++;},retry(){assert.fail('unexpected retry');}};
  await worker.queue({queue:'malipang-jobs',messages:[message]},h.env,{});assert.equal(captured.used,48);assert.equal(captured.queueUsed,1);assert.equal(sends,1);assert.equal(acks,1);
 }finally{dispatch.dispatchStablePhase1=old;h.close();}
});
test('single expense handler meters D1 and queue calls in the same invocation',async()=>{
 const h=expenseSqlite(),worker=require('../dist/index.js').default,dispatch=require('../dist/sheets/stable-phase1-dispatch.js'),old=dispatch.dispatchStablePhase1;let captured,acks=0;
 try{Object.assign(h.env,{CONTINUOUS_PUBLICATION_ENABLED:'true',STABLE_PHASE1_ENABLED:'true'});h.env.JOB_QUEUE.send=async()=>{};
  dispatch.dispatchStablePhase1=async(env,_job,_attempt,budget)=>{captured=budget;await env.DB.prepare('SELECT 1 AS n').first();await env.DB.batch([env.DB.prepare('SELECT 2'),env.DB.prepare('SELECT 3')]);return 'CONTINUE';};
  const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_fixture',entityVersion:1,traceId:'synthetic'},message={body:job,attempts:1,ack(){acks++;},retry(){assert.fail('unexpected retry');}};
  await worker.queue({queue:'malipang-jobs',messages:[message]},h.env,{});assert.ok(captured.bindingBudget);assert.deepEqual(captured.bindingBudget.snapshot().used,{d1:2,queue:1});assert.equal(acks,1);
 }finally{dispatch.dispatchStablePhase1=old;h.close();}
});
test('mixed batch does not claim single-message budget evidence',async()=>{
 const h=expenseSqlite(),worker=require('../dist/index.js').default,dispatch=require('../dist/sheets/stable-phase1-dispatch.js'),old=dispatch.dispatchStablePhase1,captured=[];
 try{Object.assign(h.env,{CONTINUOUS_PUBLICATION_ENABLED:'true',STABLE_PHASE1_ENABLED:'true'});dispatch.dispatchStablePhase1=async(_env,_job,_attempt,budget)=>{captured.push(budget);return 'BLOCKED';};
  const mk=(id)=>({body:{kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:id,entityVersion:1,traceId:'synthetic'},attempts:1,ack(){},retry(){assert.fail('unexpected retry');}});
  await worker.queue({queue:'malipang-jobs',messages:[mk('exp_a'),mk('exp_b')]},h.env,{});assert.equal(captured.length,2);assert.ok(captured.every(x=>x.bindingBudget===undefined));
 }finally{dispatch.dispatchStablePhase1=old;h.close();}
});
test('paced ten-expense batch meters the one selected writer and accounts for park overhead',async()=>{
 const h=expenseSqlite(),worker=require('../dist/index.js').default,dispatch=require('../dist/sheets/stable-phase1-dispatch.js'),old=dispatch.dispatchStablePhase1;let captured,acks=0;
 try{Object.assign(h.env,{CONTINUOUS_PUBLICATION_ENABLED:'true',STABLE_PHASE1_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book',NOTICE_QUEUE:{async send(){}}});h.env.JOB_QUEUE.send=async()=>{};
  dispatch.dispatchStablePhase1=async(env,_job,_attempt,budget)=>{captured=budget;assert.ok(budget.bindingBudget.attests(env.DB,env.JOB_QUEUE,env.NOTICE_QUEUE));assert.equal(budget.bindingBudget.snapshot().used.d1,3);const t=budget.bindingBudget.reservePost(1,0,1,0);budget.bindingBudget.activatePost(t);await Promise.resolve();await env.DB.prepare('SELECT 1').first();budget.bindingBudget.activateTail(t);return 'BLOCKED';};
  const messages=Array.from({length:10},(_,i)=>({body:{kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:`exp_${i}`,entityVersion:1,traceId:'fixture'},attempts:1,ack(){acks++;},retry(){assert.fail('unexpected retry');}}));
  await worker.queue({queue:'malipang-jobs',messages},h.env,{});assert.ok(captured);assert.equal(acks,10);assert.equal(h.sqlite.prepare("SELECT count(*) n FROM sync_jobs WHERE status='PENDING'").get().n,9);assert.equal(captured.bindingBudget.snapshot().used.d1,4);
 }finally{dispatch.dispatchStablePhase1=old;h.close();}
});
test('failed park never grants budget or dispatches the selected writer',async()=>{
 const h=expenseSqlite(),worker=require('../dist/index.js').default,dispatch=require('../dist/sheets/stable-phase1-dispatch.js'),old=dispatch.dispatchStablePhase1;let calls=0,acks=0,retries=0;
 try{Object.assign(h.env,{CONTINUOUS_PUBLICATION_ENABLED:'true',STABLE_PHASE1_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book'});h.DB.failAt=0;dispatch.dispatchStablePhase1=async()=>{calls++;return 'BLOCKED';};
  const messages=Array.from({length:3},(_,i)=>({body:{kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:`exp_${i}`,entityVersion:1,traceId:'fixture'},attempts:1,ack(){acks++;},retry(){retries++;}}));
  await worker.queue({queue:'malipang-jobs',messages},h.env,{});assert.equal(calls,0);assert.equal(acks,1);assert.equal(retries,2);
 }finally{dispatch.dispatchStablePhase1=old;h.close();}
});
test('mixed expense and attendance batch preserves existing fairness and wraps only selected expense',async()=>{
 const h=expenseSqlite(),worker=require('../dist/index.js').default,dispatch=require('../dist/sheets/stable-phase1-dispatch.js'),old=dispatch.dispatchStablePhase1,seen=[];
 try{Object.assign(h.env,{CONTINUOUS_PUBLICATION_ENABLED:'true',STABLE_PHASE1_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book',NOTICE_QUEUE:{async send(){}}});h.env.JOB_QUEUE.send=async()=>{};
  dispatch.dispatchStablePhase1=async(env,job,_attempt,budget)=>{seen.push({type:job.entityType,metered:!!budget?.bindingBudget,wrapped:env.DB!==h.DB});return 'BLOCKED';};
  const mk=(entityType,id)=>({body:{kind:'SHEETS_SYNC',entityType,entityKey:id,entityVersion:1,traceId:'fixture'},attempts:1,ack(){},retry(){assert.fail('unexpected retry');}});
  for(let i=0;i<2;i++)await worker.queue({queue:'malipang-jobs',messages:[mk('EXPENSE','exp_a'),mk('ATTENDANCE_EVENT','att_a')]},h.env,{});
  assert.deepEqual(seen,[{type:'EXPENSE',metered:true,wrapped:true},{type:'ATTENDANCE_EVENT',metered:false,wrapped:false}]);
 }finally{dispatch.dispatchStablePhase1=old;h.close();}
});
test('single expense handler retains error-tail D1 and queue capacity after post exhaustion',async()=>{
 const h=expenseSqlite(),worker=require('../dist/index.js').default,dispatch=require('../dist/sheets/stable-phase1-dispatch.js'),repos=require('../dist/db/repositories.js'),alerts=require('../dist/line/sync-failure-alerts.js'),old=[dispatch.dispatchStablePhase1,repos.createFailedJob,alerts.wakeSyncFailureAlerts];let captured,retries=0,sends=0;
 try{Object.assign(h.env,{CONTINUOUS_PUBLICATION_ENABLED:'true',STABLE_PHASE1_ENABLED:'true'});h.env.JOB_QUEUE.send=async()=>{sends++;};
  dispatch.dispatchStablePhase1=async(env,_job,_attempt,budget)=>{captured=budget;const t=budget.bindingBudget.reservePost(1,0,2,1);budget.bindingBudget.activatePost(t);try{await env.DB.prepare('SELECT 1').first();await env.DB.prepare('SELECT 2').first();}finally{budget.bindingBudget.activateTail(t);}};
  repos.createFailedJob=async(env)=>{await env.DB.prepare('SELECT 3').first();};alerts.wakeSyncFailureAlerts=async(env)=>{await env.JOB_QUEUE.send({kind:'SYNC_ALERT_SWEEP',traceId:'fixture'});};
  const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_fixture',entityVersion:1,traceId:'synthetic'},message={body:job,attempts:1,ack(){assert.fail('unexpected ack');},retry(){retries++;}};
  await worker.queue({queue:'malipang-jobs',messages:[message]},h.env,{});assert.equal(retries,1);assert.equal(sends,1);assert.deepEqual(captured.bindingBudget.snapshot().used,{d1:2,queue:1});assert.deepEqual(captured.bindingBudget.snapshot().reserved,{d1:0,queue:0});
 }finally{[dispatch.dispatchStablePhase1,repos.createFailedJob,alerts.wakeSyncFailureAlerts]=old;h.close();}
});
