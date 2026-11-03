import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),{writeNewPersonalUnderClaim}=require('../dist/sheets/stable-personal-writer.js'),{withStableWorkbookClaim}=require('../dist/sheets/stable-workbook-claim.js');

function fixture(){
 const h=expenseSqlite(),original={getSheetGridInfo:client.getSheetGridInfo,batchGetSheetFormulaValues:client.batchGetSheetFormulaValues,batchWriteValues:client.batchWriteValues},prepare=h.DB.prepare;
 h.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run;s.run=async function(){const result=await run.call(this);return{...result,success:true};};return s;};
 Object.assign(h.env,{GOOGLE_SPREADSHEET_ID:'book',SHEET_PERSONAL_USE_RAW:'personal'});
 h.sqlite.exec("UPDATE stable_sync_cutover SET state='ACTIVE',activated_at='now'; INSERT INTO owner_personal_transactions(personal_use_id,message_id,line_user_id,transaction_type,description,amount_satang,source_wallet,transaction_date,status,created_at,updated_at,version) VALUES('personal_1','message','owner','PERSONAL_USE','example',10000,'SHOP_BANK','2026-10-13','CONFIRMED','now','now',2); INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('job','PERSONAL_USE','personal_1',2,'fixture','PROCESSING','now','2099-01-01T00:00:00.000Z','lease')");
 const rows=[['Personal_Use_ID','Transaction_Type','Transaction_Date','Description','Amount_Baht','Source_Wallet','Status','Message_ID','Trace_ID','Submitted_By','Branch_ID','Approved_At','Created_At','Updated_At','Version']],job={kind:'SHEETS_SYNC',entityType:'PERSONAL_USE',entityKey:'personal_1',entityVersion:2,traceId:'fixture'};let writes=0,lose=false,change=false;
 client.getSheetGridInfo=async()=>({sheetId:7,rowCount:100,columnCount:15});
 client.batchGetSheetFormulaValues=async()=>[rows.map(row=>[...row])];
 client.batchWriteValues=async(_env,data,before)=>{if(change)h.sqlite.exec("UPDATE owner_personal_transactions SET description='changed' WHERE personal_use_id='personal_1'");await before();writes++;rows.push([...data[0].values[0]]);if(lose)throw Error('provider acknowledgement lost');};
 return{...h,job,rows,writes:()=>writes,lose(){lose=true;},change(){change=true;},close(){Object.assign(client,original);h.close();}};
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
test('a changed source before dispatch holds the attempt without writing',async()=>{
 const h=fixture();try{h.change();await assert.rejects(withStableWorkbookClaim(h.env,t=>writeNewPersonalUnderClaim(h.env,h.job,'lease',t)));assert.equal(h.writes(),0);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 }finally{h.close();}
});
test('a duplicate ID or an aliased sheet stops before any provider write',async()=>{
 for(const mode of ['duplicate','alias']){const h=fixture();try{
  if(mode==='duplicate')h.rows.push(['personal_1'],['personal_1']);else h.env.SHEET_EXPENSE_DAILY='personal';
  await assert.rejects(withStableWorkbookClaim(h.env,t=>writeNewPersonalUnderClaim(h.env,h.job,'lease',t)));
  assert.equal(h.writes(),0);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 }finally{h.close();}}
});
