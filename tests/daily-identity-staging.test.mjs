import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url);
const {stageDailyIdentityCandidate,dailyIdentityCandidateStatus}=require('../dist/sheets/daily-identity-staging.js');
const {encodeEnrollmentApproval}=require('../dist/sheets/daily-row-enrollment.js');
const {sha256Hex}=require('../dist/shared/ids.js');
const auth=require('../dist/sheets/google-auth.js');
const literalCols=Array.from({length:25},(_,i)=>i).filter(i=>![8,9,17,18,20].includes(i));

async function fixture(){
 const h=expenseSqlite(),keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
 const pub=Buffer.from(await crypto.subtle.exportKey('raw',keys.publicKey)).toString('base64');
 const headers=[['heading'],['','','','','','','','เงินโอน'],['','','','','','','NON-FIXED']];
 const headerDigest=await sha256Hex(new TextEncoder().encode(JSON.stringify(headers)).buffer);
 const literals=Object.fromEntries(literalCols.map(i=>[i,'']));Object.assign(literals,{1:10,2:10,3:'Synthetic',7:735,21:'general',22:'บัญชีร้าน'});
 const formulas={8:'=SUM(F10:H10)',9:'=J9-I10',17:'=SUM(K10:Q10)',18:'=J10-R10',20:'=DATE($A$5,B10,C10)'};
 const entry={expenseId:'exp1',expenseVersion:1,postingDate:'2026-10-10',amountSatang:73500,paymentKey:'transfer',expenseStatus:'CONFIRMED',sourceWallet:'SHOP_BANK',category:'general',description:'Synthetic',messageId:'synthetic-message-1',rowNumber:10,metadataId:11,headerDigest,literals,formulas};
 const now=Date.now(),approval={version:'daily-row-enrollment-v1',approvalId:'approval-1',reviewerId:'reviewer',spreadsheetId:'book',sheetId:1,leaseId:'fence-token',leaseVersion:1,issuedAtMs:now-1000,expiresAtMs:now+60000,entries:[entry]};
 Object.assign(h.env,{GOOGLE_SPREADSHEET_ID:'book',SHEET_EXPENSE_DAILY:'daily',GOOGLE_SERVICE_ACCOUNT_EMAIL:'worker@example.org',EXTERNAL_API_TIMEOUT_MS:'1000',DAILY_ROW_REVIEWER_ID:'reviewer',DAILY_ROW_REVIEWER_ED25519_PUBLIC_KEY_BASE64:pub,DAILY_ROW_SHEET_ID:'1',DAILY_ROW_APPROVED_PERIOD:'2026-10'});
 function expense(id='exp1',message='synthetic-message-1'){
  h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES(?,?,?,'Synthetic',73500,'transfer','SHOP_BANK','general','2026-10-10','CONFIRMED','now',1)`).run(id,message,'synthetic-user');
  h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES(?,'EXPENSE',?,1,?,'REVIEW',1,'now')`).run(`job-${id}`,id,`trace-${id}`);
 }
 expense();h.sqlite.prepare(`INSERT INTO owner_correction_daily_write_fences(sheet_name,lease_token,lease_until,state,updated_at) VALUES('daily','fence-token','2099-01-01T00:00:00.000Z','OWNED','now')`).run();
 const rows=Array.from({length:20},()=>[]);rows[4]=[2026];rows[5]=['',10,'','รายรับทั้งหมดในบัญชี'];rows[15]=['รวม',10];
 const cells=Array.from({length:25},()=>({}));for(const [i,f] of Object.entries(formulas))cells[Number(i)]={userEnteredValue:{formulaValue:f},effectiveValue:{numberValue:0}};for(const [i,v] of Object.entries(literals))if(v!=='')cells[Number(i)]={userEnteredValue:typeof v==='number'?{numberValue:v}:{stringValue:v},effectiveValue:typeof v==='number'?{numberValue:v}:{stringValue:v}};
 const sheet={properties:{sheetId:1,title:'daily',gridProperties:{rowCount:20,columnCount:25}},protectedRanges:[{range:{sheetId:1},requestingUserCanEdit:true,editors:{users:['worker@example.org']}}]};
 const target={properties:{sheetId:1,title:'daily'},data:[{startRow:9,rowData:[{values:cells}]}]};
 let fetches=0,aba=0,simulateABA=false,abaMutations=0;const oldFetch=globalThis.fetch,oldAuth=auth.getGoogleAccessToken;auth.getGoogleAccessToken=async()=> 'synthetic';
 globalThis.fetch=async(input,init)=>{fetches++;if(simulateABA&&fetches===6){cells[7].userEnteredValue.numberValue=1;cells[7].effectiveValue.numberValue=1;cells[7].userEnteredValue.numberValue=735;cells[7].effectiveValue.numberValue=735;abaMutations+=2;}const url=new URL(String(input));let json;const marker={metadataId:entry.metadataId,visibility:'DOCUMENT',metadataKey:'malipang_expense_daily',metadataValue:entry.expenseId,location:{dimensionRange:{sheetId:1,dimension:'ROWS',startIndex:entry.rowNumber-1,endIndex:entry.rowNumber}}};
  if(url.pathname.endsWith('/developerMetadata:search')){assert.equal(init.method,'POST');json={matchedDeveloperMetadata:[{developerMetadata:marker}]};}
  else if(url.pathname.endsWith(`/developerMetadata/${entry.metadataId}`))json=marker;
  else if(url.pathname.endsWith('/values:batchGet'))json={valueRanges:[{values:rows},{values:headers}]};
  else if(url.searchParams.has('ranges')){aba++;const observed=structuredClone(target);observed.data[0].startRow=entry.rowNumber-1;json={sheets:[observed]};}
  else json={sheets:[sheet]};return new Response(JSON.stringify(json),{status:200,headers:{'content-type':'application/json'}});
 };
 return {h,keys,approval,entry,expense,enableABA(){simulateABA=true;},async sign(){return new Uint8Array(await crypto.subtle.sign('Ed25519',keys.privateKey,encodeEnrollmentApproval(approval)));},get fetches(){return fetches;},get observations(){return aba;},get abaMutations(){return abaMutations;},close(){globalThis.fetch=oldFetch;auth.getGoogleAccessToken=oldAuth;h.close();}};
}

test('signed row may be staged only as provisional evidence and replay cannot release a held job',async()=>{
 const f=await fixture();try{const sig=await f.sign();assert.equal(await stageDailyIdentityCandidate(f.h.env,f.approval,sig),'CANDIDATE_ONLY');
  const row=f.h.sqlite.prepare('SELECT * FROM daily_identity_candidates').get();assert.equal(row.state,'CANDIDATE_ONLY');assert.equal(row.expense_version,1);for(const key of ['approval_digest','signature_digest','reviewer_key_digest'])assert.match(row[key],/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(row),/synthetic-message-1|Synthetic|fence-token/);
  assert.equal(await stageDailyIdentityCandidate(f.h.env,f.approval,sig),'HELD');assert.equal(f.h.sqlite.prepare('SELECT COUNT(*) n FROM daily_identity_candidates').get().n,1);
  assert.equal(f.h.sqlite.prepare(`SELECT status FROM sync_jobs WHERE entity_key='exp1'`).get().status,'REVIEW');assert.equal(f.h.sqlite.prepare('SELECT COUNT(*) n FROM sheet_row_index').get().n,0);assert.equal(f.h.queue.length,0);assert.equal(f.fetches,20);
 }finally{f.close();}
});
test('row, expense, metadata and existing index collisions fail closed',async()=>{
 for(const mode of ['expense','row','metadata','index-row','index-expense']){const f=await fixture();try{
  if(mode==='index-row')f.h.sqlite.prepare(`INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES('daily','other',10)`).run();
  if(mode==='index-expense')f.h.sqlite.prepare(`INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES('daily','exp1',11)`).run();
  if(mode.startsWith('index')){assert.equal(await stageDailyIdentityCandidate(f.h.env,f.approval,await f.sign()),'HELD');assert.equal(f.h.sqlite.prepare('SELECT COUNT(*) n FROM daily_identity_candidates').get().n,0);continue;}
  assert.equal(await stageDailyIdentityCandidate(f.h.env,f.approval,await f.sign()),'CANDIDATE_ONLY');f.approval.approvalId='approval-2';
  if(mode!=='expense'){f.expense('exp2','synthetic-message-2');f.entry.expenseId='exp2';f.entry.messageId='synthetic-message-2';}
  if(mode==='expense'){f.entry.rowNumber=11;f.entry.metadataId=12;}
  if(mode==='row')f.entry.metadataId=12;
  if(mode==='metadata')f.entry.rowNumber=11;
  assert.equal(await stageDailyIdentityCandidate(f.h.env,f.approval,await f.sign()),'HELD');assert.equal(f.h.sqlite.prepare('SELECT COUNT(*) n FROM daily_identity_candidates').get().n,1);
 }finally{f.close();}}
});
test('a replaced fence, changed source or concurrent correction before commit cannot stage evidence',async()=>{
 for(const mode of ['fence','source','job','correction-pending','correction-processing','correction-failed','correction-review']){const f=await fixture();try{const batch=f.h.DB.batch.bind(f.h.DB);f.h.DB.batch=async statements=>{
  if(mode==='fence')f.h.sqlite.prepare(`UPDATE owner_correction_daily_write_fences SET lease_token='replacement'`).run();
  if(mode==='source')f.h.sqlite.prepare(`UPDATE expense_events SET version=2 WHERE expense_id='exp1'`).run();
  if(mode==='job')f.h.sqlite.prepare(`UPDATE sync_jobs SET status='PROCESSING' WHERE entity_key='exp1'`).run();
  if(mode.startsWith('correction-'))f.h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('correction','EXPENSE_CORRECTION','exp1',1,'trace-correction',?,0,'now')`).run(mode.slice('correction-'.length).toUpperCase());
  return batch(statements);
 };
 assert.equal(await stageDailyIdentityCandidate(f.h.env,f.approval,await f.sign()),'HELD');assert.equal(f.h.sqlite.prepare('SELECT COUNT(*) n FROM daily_identity_candidates').get().n,0);assert.equal(f.h.sqlite.prepare('SELECT COUNT(*) n FROM sheet_row_index').get().n,0);
 }finally{f.close();}}
});
test('concurrent independently signed claims serialize and exactly one stages',async()=>{
 const f=await fixture();try{const a=structuredClone(f.approval),b=structuredClone(f.approval);b.approvalId='concurrent-2';
  const sign=async approval=>new Uint8Array(await crypto.subtle.sign('Ed25519',f.keys.privateKey,encodeEnrollmentApproval(approval)));
  const [sigA,sigB]=await Promise.all([sign(a),sign(b)]),results=await Promise.all([stageDailyIdentityCandidate(f.h.env,a,sigA),stageDailyIdentityCandidate(f.h.env,b,sigB)]);
  assert.deepEqual(results.sort(),['CANDIDATE_ONLY','HELD']);assert.equal(f.h.sqlite.prepare('SELECT COUNT(*) n FROM daily_identity_candidates').get().n,1);assert.equal(f.h.queue.length,0);
 }finally{f.close();}
});
test('approval expiring while waiting for the database cannot be staged',async()=>{
 const f=await fixture();try{f.approval.expiresAtMs=Date.now()+200;const batch=f.h.DB.batch.bind(f.h.DB);f.h.DB.batch=async statements=>{await new Promise(resolve=>setTimeout(resolve,250));return batch(statements);};
  assert.equal(await stageDailyIdentityCandidate(f.h.env,f.approval,await f.sign()),'HELD');assert.equal(f.h.sqlite.prepare('SELECT COUNT(*) n FROM daily_identity_candidates').get().n,0);
 }finally{f.close();}
});
test('replay and transaction failure retain prior candidate evidence',async()=>{
 const f=await fixture();try{assert.equal(await stageDailyIdentityCandidate(f.h.env,f.approval,await f.sign()),'CANDIDATE_ONLY');
  f.h.sqlite.prepare(`UPDATE daily_identity_candidates SET observed_at_ms=?,expires_at_ms=? WHERE approval_id='approval-1'`).run(Date.now()-2000,Date.now()-1);f.approval.approvalId='approval-2';f.h.DB.failAt=1;
  assert.equal(await stageDailyIdentityCandidate(f.h.env,f.approval,await f.sign()),'HELD');assert.deepEqual({...f.h.sqlite.prepare(`SELECT approval_id,state FROM daily_identity_candidates`).get()},{approval_id:'approval-1',state:'CANDIDATE_ONLY'});
  f.h.DB.failAt=null;assert.equal(await stageDailyIdentityCandidate(f.h.env,f.approval,await f.sign()),'CANDIDATE_ONLY');assert.deepEqual(f.h.sqlite.prepare(`SELECT state FROM daily_identity_candidates ORDER BY approval_id`).all().map(x=>x.state),['EXPIRED','CANDIDATE_ONLY']);
 }finally{f.close();}
});
test('lost acknowledgement is resolved by exact-evidence status read without replay or release',async()=>{
 const f=await fixture();try{const sig=await f.sign();f.h.DB.failAfterCommit=true;
  assert.equal(await stageDailyIdentityCandidate(f.h.env,f.approval,sig),'HELD');assert.equal(await dailyIdentityCandidateStatus(f.h.env,f.approval,sig),'CANDIDATE_ONLY');
  const altered=sig.slice();altered[0]^=1;assert.equal(await dailyIdentityCandidateStatus(f.h.env,f.approval,altered),'NOT_OBSERVED');
  assert.equal(f.h.sqlite.prepare(`SELECT status FROM sync_jobs WHERE entity_key='exp1'`).get().status,'REVIEW');assert.equal(f.h.queue.length,0);assert.equal(f.h.sqlite.prepare('SELECT COUNT(*) n FROM sheet_row_index').get().n,0);
 }finally{f.close();}
});
test('an expired candidate never makes the same signed approval reusable',async()=>{
 const f=await fixture();try{const sig=await f.sign();assert.equal(await stageDailyIdentityCandidate(f.h.env,f.approval,sig),'CANDIDATE_ONLY');
  f.h.sqlite.prepare(`UPDATE daily_identity_candidates SET observed_at_ms=?,expires_at_ms=? WHERE approval_id='approval-1'`).run(Date.now()-2000,Date.now()-1);
  assert.equal(await stageDailyIdentityCandidate(f.h.env,f.approval,sig),'HELD');assert.deepEqual({...f.h.sqlite.prepare(`SELECT approval_id,state FROM daily_identity_candidates`).get()},{approval_id:'approval-1',state:'EXPIRED'});
 }finally{f.close();}
});
test('stable observations cannot grant permission even if an unobserved ABA occurred',async()=>{
 const f=await fixture();try{f.enableABA();assert.equal(await stageDailyIdentityCandidate(f.h.env,f.approval,await f.sign()),'CANDIDATE_ONLY');assert.equal(f.observations,2);assert.equal(f.abaMutations,2);assert.equal(f.h.sqlite.prepare(`SELECT status FROM sync_jobs WHERE entity_key='exp1'`).get().status,'REVIEW');assert.equal(f.h.sqlite.prepare('SELECT COUNT(*) n FROM sheet_row_index').get().n,0);assert.equal(f.h.queue.length,0);
 }finally{f.close();}
});
test('candidate endpoint is admin-only, disabled by default and never grants release',async()=>{
 const f=await fixture();try{const {handleAdmin}=require('../dist/admin/handler.js'),token='synthetic-long-admin-token-for-test';f.h.env.ADMIN_TOKEN=token;
  const sign=await f.sign(),body=JSON.stringify({approval:f.approval,signature:Buffer.from(sign).toString('base64')});
  const request=(auth=token,payload=body)=>new Request('https://synthetic.invalid/admin/sheets/daily-identity-candidate',{method:'POST',headers:{authorization:`Bearer ${auth}`},body:payload});
  assert.equal((await handleAdmin(request('wrong'),f.h.env,{})).status,401);assert.equal((await handleAdmin(request(),f.h.env,{})).status,404);
  f.h.env.DAILY_ROW_INSPECTOR_ENABLED='true';f.h.env.DAILY_ROW_STAGING_ENABLED='true';
  const invalid=await handleAdmin(request(token,'{bad'),f.h.env,{});assert.deepEqual(await invalid.json(),{ok:true,result:'HELD',releasePermitted:false});
  const r=await handleAdmin(request(),f.h.env,{}),json=await r.json();assert.deepEqual(json,{ok:true,result:'CANDIDATE_ONLY',releasePermitted:false});assert.equal(r.headers.get('cache-control'),'no-store');
  const statusRequest=new Request('https://synthetic.invalid/admin/sheets/daily-identity-candidate-status',{method:'POST',headers:{authorization:`Bearer ${token}`},body});const status=await handleAdmin(statusRequest,f.h.env,{});assert.deepEqual(await status.json(),{ok:true,result:'CANDIDATE_ONLY',releasePermitted:false});
  assert.doesNotMatch(JSON.stringify(json),/exp1|synthetic-message-1|fence-token/);assert.equal(f.h.sqlite.prepare(`SELECT status FROM sync_jobs WHERE entity_key='exp1'`).get().status,'REVIEW');assert.equal(f.h.queue.length,0);
 }finally{f.close();}
});
