import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
import {claimCorrectionDailyWriteFence as claim,armCorrectionDailyWriteFence as arm,finishCorrectionDailyWriteFence as finish,releaseCorrectionDailyWriteFence as release,withCorrectionDailyWriteFence as withFence} from '../dist/sheets/owner-correction-daily-write-fence.js';
import {SheetsHttpError,SheetsMutationOutcomeUnknownError} from '../dist/sheets/client.js';

test('shared sheet fence serializes writers and stale owner cannot release',async()=>{
 const h=expenseSqlite(),now=Date.now();try{const [a,b]=await Promise.all([claim(h.env,'daily',now),claim(h.env,'daily',now)]),token=a||b;assert.ok(token);assert.equal(Number(Boolean(a))+Number(Boolean(b)),1);assert.equal(await release(h.env,'daily','wrong'),false);assert.equal(await release(h.env,'daily',token),true);const next=await claim(h.env,'daily',now);assert.ok(next);assert.notEqual(next,token);assert.equal(await release(h.env,'daily',token),false);assert.equal(await release(h.env,'daily',next),true);}finally{h.close();}
});
test('unknown dispatch outcome retains fence for full uncertainty window',async()=>{
 const h=expenseSqlite(),now=Date.now();try{const token=await claim(h.env,'daily',now),dispatch=await arm(h.env,'daily',token,now+1000);assert.ok(dispatch);assert.equal(await release(h.env,'daily',token),false);assert.equal(await finish(h.env,'daily',token,'wrong',now+2000),false);assert.equal(await claim(h.env,'daily',now+15*60_000),null);const next=await claim(h.env,'daily',now+15*60_000+1001);assert.ok(next);assert.equal(await finish(h.env,'daily',token,dispatch,now+15*60_000+1002),false);assert.equal(await release(h.env,'daily',next),true);}finally{h.close();}
});
test('migration is repeatable and invalid configuration fails closed',async()=>{
 const h=expenseSqlite(),now=Date.now();try{assert.equal(await claim(h.env,'',now),null);h.env.EXTERNAL_API_TIMEOUT_MS='-1';assert.equal(await claim(h.env,'daily',now),null);const sql=readFileSync(new URL('../migrations/0021_daily_sheet_write_fences.sql',import.meta.url),'utf8');h.sqlite.exec(sql);h.sqlite.exec(sql);assert.equal(h.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);}finally{h.close();}
});
test('unknown outcome remains IN_FLIGHT; definite failures release',async()=>{
 for(const mode of ['success','before-dispatch','known-failure','unknown-failure']){const h=expenseSqlite(),now=Date.now();try{let sent=0;const run=()=>withFence(h.env,'daily',async write=>write(async before=>{if(mode==='before-dispatch')throw Error('auth failed');await before();sent++;if(mode==='known-failure')throw new SheetsHttpError(403,'not allowed');if(mode==='unknown-failure')throw new SheetsMutationOutcomeUnknownError(Error('timeout'));}),()=>now);if(mode==='success')await run();else await assert.rejects(run());assert.equal(sent,mode==='before-dispatch'?0:1);assert.equal(h.sqlite.prepare('SELECT state FROM owner_correction_daily_write_fences').get()?.state,mode==='unknown-failure'?'IN_FLIGHT':undefined);}finally{h.close();}}
});
test('missing migration does not run an unguarded action',async()=>{
 const h=expenseSqlite();try{h.sqlite.exec('DROP TABLE owner_correction_daily_write_fences');let called=false;await assert.rejects(withFence(h.env,'daily',async()=>{called=true;}));assert.equal(called,false);}finally{h.close();}
});

test('daily writers contend on the shared fence before external mutation',async()=>{
 const {createRequire}=await import('node:module');const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),{writeConfirmedExpenseToDaily}=require('../dist/sheets/daily-expense.js');
 const h=expenseSqlite(),oldRead=client.batchGetSheetValues,oldClear=client.batchClearValues,oldWrite=client.batchWriteValues;try{
  Object.assign(h.env,{SHEET_EXPENSE_DAILY:'daily'});const body=Array.from({length:12},()=>[]),headers=[[],Array(8).fill(null),[]];body[5]=[null,10,null,'รายรับทั้งหมดในบัญชี'];body[10]=['รวม',10];headers[1][7]='เงินโอน';client.batchGetSheetValues=async()=>[structuredClone(body),structuredClone(headers)];let clear=0,writes=0,open,entered;const wait=new Promise(resolve=>{open=resolve}),started=new Promise(resolve=>{entered=resolve});
  client.batchClearValues=async(_env,_ranges,before)=>{assert.equal(typeof before,'function');await before();clear++;if(clear===1){entered();await wait;}};client.batchWriteValues=async(_env,_writes,before)=>{assert.equal(typeof before,'function');await before();writes++;};
  for(const id of ['first','second'])h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES(?,?,?,'Synthetic',10000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run(id,'msg-'+id,'fixture');
  const record=id=>({expenseId:id,transactionDate:'2026-10-28',description:'Synthetic',amountBaht:100,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'general',version:1});const first=writeConfirmedExpenseToDaily(h.env,record('first'));await started;await assert.rejects(writeConfirmedExpenseToDaily(h.env,record('second')),/CORRECTION_DAILY_SHEET_BUSY/);assert.equal(clear,1);assert.equal(writes,0);open();await first;assert.equal(writes,1);
 }finally{client.batchGetSheetValues=oldRead;client.batchClearValues=oldClear;client.batchWriteValues=oldWrite;h.close();}
});

test('a loaded confirmed snapshot cannot post after reclassification',async()=>{
 const {createRequire}=await import('node:module');const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),{writeConfirmedExpenseToDaily}=require('../dist/sheets/daily-expense.js');
 const h=expenseSqlite(),oldClear=client.batchClearValues,oldWrite=client.batchWriteValues;try{
  h.env.SHEET_EXPENSE_DAILY='daily';h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('stale','msg','fixture','Synthetic',10000,'transfer','SHOP_BANK','general','2026-10-28','CANCELLED','now',2)`).run();let touched=false;client.batchClearValues=async()=>{touched=true;};client.batchWriteValues=async()=>{touched=true;};
  const stale={expenseId:'stale',transactionDate:'2026-10-28',description:'Synthetic',amountBaht:100,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'general',version:1};await assert.rejects(writeConfirmedExpenseToDaily(h.env,stale),/DAILY_CONFIRMED_SNAPSHOT_CHANGED/);assert.equal(touched,false);
 }finally{client.batchClearValues=oldClear;client.batchWriteValues=oldWrite;h.close();}
});

test('capacity expansion advances state and index together and rolls back on failure',async()=>{
 const {createRequire}=await import('node:module');const require=createRequire(import.meta.url),{mapDailyCapacityExpansion}=require('../dist/sheets/daily-expense.js');
 for(const failAt of [null,1,2,3,4]){const h=expenseSqlite();try{
  h.env.SHEET_EXPENSE_DAILY='daily';h.sqlite.prepare("INSERT INTO daily_sheet_capacity_expansions(sheet_name,month,anchor_total_row,marker,state,created_at,updated_at) VALUES('daily',10,10,'synthetic','PREPARED','now','now')").run();h.sqlite.prepare("INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES('daily','a',10),('daily','b',11)").run();h.DB.failAt=failAt;
  if(failAt===null){assert.equal(await mapDailyCapacityExpansion(h.env,10,10,'synthetic','2026-01-01T00:00:00Z'),true);assert.deepEqual(h.sqlite.prepare("SELECT row_number FROM sheet_row_index ORDER BY entity_key").all().map(r=>r.row_number),[11,12]);assert.equal(h.sqlite.prepare('SELECT state FROM daily_sheet_capacity_expansions').get().state,'MAPPED');assert.equal(await mapDailyCapacityExpansion(h.env,10,10,'synthetic','2026-01-01T00:00:00Z'),false);}else{await assert.rejects(mapDailyCapacityExpansion(h.env,10,10,'synthetic','2026-01-01T00:00:00Z'));assert.deepEqual(h.sqlite.prepare("SELECT row_number FROM sheet_row_index ORDER BY entity_key").all().map(r=>r.row_number),[10,11]);assert.equal(h.sqlite.prepare('SELECT state FROM daily_sheet_capacity_expansions').get().state,'PREPARED');}
 }finally{h.close();}}
});
