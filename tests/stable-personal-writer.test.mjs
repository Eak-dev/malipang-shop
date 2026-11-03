import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),notice=require('../dist/sheets/stable-edit-notice.js'),{dispatchStablePhase1}=require('../dist/sheets/stable-phase1-dispatch.js'),{writeNewPersonalUnderClaim}=require('../dist/sheets/stable-personal-writer.js'),{runStablePersonalJob}=require('../dist/sheets/stable-personal-job.js'),{withStableWorkbookClaim}=require('../dist/sheets/stable-workbook-claim.js');

function fixture(){
 const h=expenseSqlite(),original={getSheetGridInfo:client.getSheetGridInfo,batchGetSheetFormulaValues:client.batchGetSheetFormulaValues,batchWriteValues:client.batchWriteValues},prepare=h.DB.prepare;
 h.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run;s.run=async function(){const result=await run.call(this);return{...result,success:true};};return s;};
 Object.assign(h.env,{GOOGLE_SPREADSHEET_ID:'book',SHEET_PERSONAL_USE_RAW:'personal'});
 h.sqlite.exec("UPDATE stable_sync_cutover SET state='ACTIVE',activated_at='now'; INSERT INTO owner_personal_transactions(personal_use_id,message_id,line_user_id,transaction_type,description,amount_satang,source_wallet,transaction_date,status,created_at,updated_at,version) VALUES('personal_1','message','owner','PERSONAL_USE','example',10000,'SHOP_BANK','2026-10-13','CONFIRMED','now','now',2); INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('job','PERSONAL_USE','personal_1',2,'fixture','PROCESSING','now','2099-01-01T00:00:00.000Z','lease')");
 const rows=[['Personal_Use_ID','Transaction_Type','Transaction_Date','Description','Amount_Baht','Source_Wallet','Status','Message_ID','Trace_ID','Submitted_By','Branch_ID','Approved_At','Created_At','Updated_At','Version']],job={kind:'SHEETS_SYNC',entityType:'PERSONAL_USE',entityKey:'personal_1',entityVersion:2,traceId:'fixture'};let writes=0,lose=false,change='';
 client.getSheetGridInfo=async()=>({sheetId:7,rowCount:100,columnCount:15});
 client.batchGetSheetFormulaValues=async()=>[rows.map(row=>[...row])];
 client.batchWriteValues=async(_env,data,before)=>{if(change)h.sqlite.exec("UPDATE owner_personal_transactions SET description='changed' WHERE personal_use_id='personal_1'");if(change==='revert')h.sqlite.exec("UPDATE owner_personal_transactions SET description='example' WHERE personal_use_id='personal_1'");await before();writes++;rows.push([...data[0].values[0]]);if(lose)throw Error('provider acknowledgement lost');};
 return{...h,job,rows,writes:()=>writes,lose(){lose=true;},change(mode='change'){change=mode;},close(){Object.assign(client,original);h.close();}};
}

test('new personal transaction is found by ID after a move and does not write twice',async()=>{
 const h=fixture();try{await withStableWorkbookClaim(h.env,t=>writeNewPersonalUnderClaim(h.env,h.job,'lease',t));assert.equal(h.writes(),1);
  h.rows.splice(1,0,[]);await withStableWorkbookClaim(h.env,t=>writeNewPersonalUnderClaim(h.env,h.job,'lease',t));assert.equal(h.writes(),1);
 }finally{h.close();}
});
test('a lost provider reply holds the workbook and prevents a repeat write',async()=>{
 const h=fixture();try{h.lose();await assert.rejects(withStableWorkbookClaim(h.env,t=>writeNewPersonalUnderClaim(h.env,h.job,'lease',t)));assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
  await assert.rejects(withStableWorkbookClaim(h.env,t=>writeNewPersonalUnderClaim(h.env,h.job,'lease',t)),/BUSY/);assert.equal(h.writes(),1);
 }finally{h.close();}
});
test('a removed identity after a verified write is held instead of appended again',async()=>{
 const h=fixture();try{await withStableWorkbookClaim(h.env,t=>writeNewPersonalUnderClaim(h.env,h.job,'lease',t));assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare('SELECT state FROM stable_projection_writes').get().state,'VERIFIED');
  h.rows[1][0]='';await assert.rejects(withStableWorkbookClaim(h.env,t=>writeNewPersonalUnderClaim(h.env,h.job,'lease',t)));assert.equal(h.writes(),1);
 }finally{h.close();}
});
test('a changed or reverted source before dispatch holds the attempt without writing',async()=>{
 for(const mode of ['change','revert']){const h=fixture();try{h.change(mode);await assert.rejects(withStableWorkbookClaim(h.env,t=>writeNewPersonalUnderClaim(h.env,h.job,'lease',t)));assert.equal(h.writes(),0);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 }finally{h.close();}}
});
test('a duplicate ID or an aliased sheet stops before any provider write',async()=>{
 for(const mode of ['duplicate','alias']){const h=fixture();try{
  if(mode==='duplicate')h.rows.push(['personal_1'],['personal_1']);else h.env.SHEET_EXPENSE_DAILY='personal';
  await assert.rejects(withStableWorkbookClaim(h.env,t=>writeNewPersonalUnderClaim(h.env,h.job,'lease',t)));
  assert.equal(h.writes(),0);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 }finally{h.close();}}
});
test('personal job completes after readback and releases its workbook claim',async()=>{
 const h=fixture();try{await runStablePersonalJob(h.env,h.job,'lease');assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'COMPLETED');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);
 }finally{h.close();}
});
test('phase-one queue dispatch writes a new personal record but holds historical records',async()=>{
 for(const historical of [false,true]){const h=fixture(),old={beginStableNotice:notice.beginStableNotice,endStableNotice:notice.endStableNotice,stableNoticePaused:notice.stableNoticePaused};try{
  h.env.STABLE_PHASE1_ENABLED='true';h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE job_id='job'");if(historical)h.sqlite.exec("INSERT INTO stable_pre_cutover_sources VALUES('PERSONAL_USE','personal_1')");
  notice.beginStableNotice=async(env,token)=>{await env.DB.prepare("UPDATE stable_workbook_claims SET notice_stamp='fixture',notice_identity='fixture' WHERE spreadsheet_id=? AND operation_token=?").bind('book',token).run();};notice.endStableNotice=async()=>{};notice.stableNoticePaused=async()=>true;
  assert.equal(await dispatchStablePhase1(h.env,h.job),historical?'REVIEW':'PROCESSED');assert.equal(h.writes(),historical?0:1);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,historical?'REVIEW':'COMPLETED');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);
 }finally{Object.assign(notice,old);h.close();}}
});
