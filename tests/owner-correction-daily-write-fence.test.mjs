import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {claimCorrectionDailyWriteFence as claim,armCorrectionDailyWriteFence as arm,finishCorrectionDailyWriteFence as finish,releaseCorrectionDailyWriteFence as release,withCorrectionDailyWriteFence as withFence} from '../dist/sheets/owner-correction-daily-write-fence.js';
import {SheetsHttpError,SheetsMutationOutcomeUnknownError} from '../dist/sheets/client.js';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),{writeConfirmedExpenseToDaily}=require('../dist/sheets/daily-expense.js'),{syncJob}=require('../dist/sheets/sync.js'),correctionWorker=require('../dist/sheets/owner-correction-worker.js'),correctionGoogle=require('../dist/sheets/owner-correction-google.js'),{processOwnerCorrectionRuntime}=require('../dist/sheets/owner-correction-runtime.js');

test('only one writer owns the sheet and stale tokens cannot release a newer claim',async()=>{
  const h=ownerOrderFixture(),now=Date.now();try{
    const [a,b]=await Promise.all([claim(h.env,'daily',now),claim(h.env,'daily',now)]),token=a||b;assert.ok(token);assert.equal(Number(Boolean(a))+Number(Boolean(b)),1);
    assert.equal(await release(h.env,'daily','wrong'),false);assert.equal(await release(h.env,'daily',token),true);
    const next=await claim(h.env,'daily',now);assert.ok(next);assert.notEqual(next,token);assert.equal(await release(h.env,'daily',token),false);assert.equal(await release(h.env,'daily',next),true);
  }finally{h.close()}
});
test('unknown external outcomes retain the sheet fence through the full deadline',async()=>{
  const h=ownerOrderFixture(),now=Date.now();try{
    const token=await claim(h.env,'daily',now),dispatch=await arm(h.env,'daily',token,now+1000);assert.ok(dispatch);
    assert.equal(await release(h.env,'daily',token),false);assert.equal(await finish(h.env,'daily',token,'wrong',now+2000),false);
    assert.equal(await claim(h.env,'daily',now+15*60_000),null);
    const next=await claim(h.env,'daily',now+15*60_000+1001);assert.ok(next);assert.equal(await finish(h.env,'daily',token,dispatch,now+15*60_000+1002),false);assert.equal(await release(h.env,'daily',token),false);assert.equal(await release(h.env,'daily',next),true);
  }finally{h.close()}
});
test('known provider responses allow a new guarded dispatch or release',async()=>{
  const h=ownerOrderFixture(),now=Date.now();try{
    const token=await claim(h.env,'daily',now),first=await arm(h.env,'daily',token,now+1);assert.ok(first);assert.equal(await arm(h.env,'daily',token,now+2),null);
    assert.equal(await finish(h.env,'daily',token,first,now+3),true);const second=await arm(h.env,'daily',token,now+4);assert.ok(second);assert.notEqual(first,second);
    assert.equal(await finish(h.env,'daily',token,first,now+5),false);assert.equal(await finish(h.env,'daily',token,second,now+6),true);assert.equal(await release(h.env,'daily',token),true);
  }finally{h.close()}
});
test('invalid configuration fails closed and the additive migration is repeatable',async()=>{
  const h=ownerOrderFixture(),now=Date.now();try{
    assert.equal(await claim(h.env,'',now),null);assert.equal(await claim(h.env,'daily',NaN),null);h.env.EXTERNAL_API_TIMEOUT_MS='-1';assert.equal(await claim(h.env,'daily',now),null);
    const sql=readFileSync(new URL('../migrations/0027_owner_correction_daily_write_fences.sql',import.meta.url),'utf8');h.sqlite.exec(sql);h.sqlite.exec(sql);assert.equal(h.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{h.close()}
});
test('the wrapper retains unknown outcomes and releases definite failures',async()=>{
  for(const mode of ['success','before-dispatch','known-failure','unknown-failure','ambiguous-http']){const h=ownerOrderFixture(),now=Date.now();try{
    h.env.OWNER_EXPENSE_CORRECTION_ENABLED='true';let sent=0;
    const run=()=>withFence(h.env,'daily',async write=>write(async before=>{
      if(mode==='before-dispatch')throw Error('auth failed');await before();sent++;
      if(mode==='known-failure')throw new SheetsHttpError(403,'not allowed');if(mode==='unknown-failure')throw new SheetsMutationOutcomeUnknownError(Error('timeout'));if(mode==='ambiguous-http')throw new SheetsHttpError(503,'unavailable');
    }),()=>now);
    if(mode==='success')await run();else await assert.rejects(run());
    assert.equal(sent,mode==='before-dispatch'?0:1);const row=h.sqlite.prepare('SELECT state FROM owner_correction_daily_write_fences').get();
    assert.equal(row?.state,['unknown-failure','ambiguous-http'].includes(mode)?'IN_FLIGHT':undefined);if(row)assert.equal(await claim(h.env,'daily',now+100),null);
  }finally{h.close()}}
});
test('feature-off behavior requires no fence migration and preserves the existing operation',async()=>{
  const h=ownerOrderFixture();try{h.env.OWNER_EXPENSE_CORRECTION_ENABLED='false';h.sqlite.exec('DROP TABLE owner_correction_daily_write_fences');let calls=0;
    assert.equal(await withFence(h.env,'daily',async write=>{await write(async before=>{assert.equal(before,undefined);calls++});return 'ok'}),'ok');assert.equal(calls,1);
  }finally{h.close()}
});
test('daily expense writers share the fence before reserving and writing rows',async()=>{
  const h=ownerOrderFixture(),oldRead=client.batchGetSheetValues,oldClear=client.batchClearValues,oldWrite=client.batchWriteValues;try{
    Object.assign(h.env,{OWNER_EXPENSE_CORRECTION_ENABLED:'true',SHEET_EXPENSE_DAILY:'daily'});
    const body=Array.from({length:12},()=>[]),headers=[[],Array(8).fill(null),[]];body[5]=[null,10,null,'รายรับทั้งหมดในบัญชี'];body[10]=['รวม',10];headers[1][7]='เงินโอน';
    client.batchGetSheetValues=async()=>[structuredClone(body),structuredClone(headers)];let clearCount=0,writeCount=0,open,entered;const wait=new Promise(resolve=>{open=resolve}),started=new Promise(resolve=>{entered=resolve});
    client.batchClearValues=async(_env,_ranges,before)=>{assert.equal(typeof before,'function');await before();clearCount++;if(clearCount===1){entered();await wait}};
    client.batchWriteValues=async(_env,_writes,before)=>{assert.equal(typeof before,'function');await before();writeCount++};
    const record=id=>({expenseId:id,transactionDate:'2026-10-28',description:'Synthetic',amountBaht:100,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'general'});
    const first=writeConfirmedExpenseToDaily(h.env,record('exp_synthetic_one'));await started;
    await assert.rejects(writeConfirmedExpenseToDaily(h.env,record('exp_synthetic_two')),/CORRECTION_DAILY_SHEET_BUSY/);assert.equal(clearCount,1);assert.equal(writeCount,0);
    open();const firstResult=await first,secondResult=await writeConfirmedExpenseToDaily(h.env,record('exp_synthetic_two'));assert.notEqual(firstResult.row,secondResult.row);assert.equal(clearCount,2);assert.equal(writeCount,2);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM owner_correction_daily_write_fences').get().n,0);
  }finally{client.batchGetSheetValues=oldRead;client.batchClearValues=oldClear;client.batchWriteValues=oldWrite;h.close()}
});
test('a busy daily fence requeues a normal expense job without treating contention as a failure',async()=>{
  const h=ownerOrderFixture(),oldWrite=client.batchWriteValues;try{
    Object.assign(h.env,{OWNER_EXPENSE_CORRECTION_ENABLED:'true',SHEETS_SYNC_ENABLED:'true',SHEET_EXPENSE_DAILY:'daily',SHEET_EXPENSE_RAW:'raw',SHEET_PURCHASE_DETAILS:'details'});
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_fence_busy','msg_fence_busy','fixture_staff','Synthetic',10000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
    client.batchWriteValues=async()=>{};const token=await claim(h.env,'daily'),job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_fence_busy',entityVersion:1,traceId:'synthetic_trace'};
    assert.equal(await syncJob(h.env,job),'BUSY');assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE entity_type='EXPENSE'").get().status,'PENDING');assert.equal(await release(h.env,'daily',token),true);
  }finally{client.batchWriteValues=oldWrite;h.close()}
});
test('correction runtime uses the same sheet fence for value and identity writes',async()=>{
  const h=ownerOrderFixture(),oldWorker=correctionWorker.processOwnerCorrectionJob,oldPatch=correctionGoogle.patchOwnerCorrectionGoogle,oldRebind=correctionGoogle.rebindOwnerCorrectionGoogle;try{
    Object.assign(h.env,{OWNER_EXPENSE_CORRECTION_ENABLED:'true',SHEETS_SYNC_ENABLED:'true',SHEET_EXPENSE_DAILY:'daily'});let calls=0,armed=0;
    const jobArm=async()=>{assert.equal(h.sqlite.prepare('SELECT state FROM owner_correction_daily_write_fences').get().state,'OWNED');armed++};
    correctionWorker.processOwnerCorrectionJob=async(_env,_job,ports)=>{await ports.patch({},jobArm);await ports.rebind({}, {},jobArm);return 'COMPLETED'};
    correctionGoogle.patchOwnerCorrectionGoogle=async(_env,_plan,before)=>{await before();assert.equal(h.sqlite.prepare('SELECT state FROM owner_correction_daily_write_fences').get().state,'IN_FLIGHT');calls++};correctionGoogle.rebindOwnerCorrectionGoogle=async(_env,_plan,_inspection,before)=>{await before();assert.equal(h.sqlite.prepare('SELECT state FROM owner_correction_daily_write_fences').get().state,'IN_FLIGHT');calls++};
    assert.equal(await processOwnerCorrectionRuntime(h.env,{expenseId:'exp_synthetic',version:2}),'COMPLETED');assert.equal(calls,2);assert.equal(armed,2);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM owner_correction_daily_write_fences').get().n,0);
    const token=await claim(h.env,'daily'),job={kind:'SHEETS_SYNC',entityType:'EXPENSE_CORRECTION',entityKey:'exp_synthetic',entityVersion:2,traceId:'synthetic_trace'};
    assert.equal(await syncJob(h.env,job),'BUSY');assert.equal(calls,2);assert.equal(await release(h.env,'daily',token),true);
  }finally{correctionWorker.processOwnerCorrectionJob=oldWorker;correctionGoogle.patchOwnerCorrectionGoogle=oldPatch;correctionGoogle.rebindOwnerCorrectionGoogle=oldRebind;h.close()}
});
test('a lost correction write response retains the shared fence while recovery waits',async()=>{
  const h=ownerOrderFixture(),oldWorker=correctionWorker.processOwnerCorrectionJob,oldPatch=correctionGoogle.patchOwnerCorrectionGoogle;try{
    Object.assign(h.env,{OWNER_EXPENSE_CORRECTION_ENABLED:'true',SHEET_EXPENSE_DAILY:'daily'});
    correctionWorker.processOwnerCorrectionJob=async(_env,_job,ports)=>{try{await ports.patch({},async()=>{});return 'COMPLETED'}catch{return 'BUSY'}};
    correctionGoogle.patchOwnerCorrectionGoogle=async(_env,_plan,before)=>{await before();throw new SheetsMutationOutcomeUnknownError(Error('synthetic timeout'))};
    assert.equal(await processOwnerCorrectionRuntime(h.env,{expenseId:'exp_synthetic',version:2}),'BUSY');assert.equal(h.sqlite.prepare('SELECT state FROM owner_correction_daily_write_fences').get().state,'IN_FLIGHT');assert.equal(await claim(h.env,'daily'),null);
  }finally{correctionWorker.processOwnerCorrectionJob=oldWorker;correctionGoogle.patchOwnerCorrectionGoogle=oldPatch;h.close()}
});
