import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),daily=require('../dist/sheets/daily-expense.js'),guard=require('../dist/sheets/owner-correction-daily-identity-guard.js'),fence=require('../dist/sheets/owner-correction-daily-write-fence.js');
const methods=['searchSheetRowMetadata','getSheetProtectedRanges','batchGetSheetValues','readSheetRowsByMetadata','batchGetSheetFormulaValues','getSheetRowMetadataById','batchPatchMetadataRows'];
async function setup(){
 const h=ownerOrderFixture();Object.assign(h.env,{SHEET_EXPENSE_DAILY:'daily',OWNER_EXPENSE_CORRECTION_ENABLED:'true',GOOGLE_SERVICE_ACCOUNT_EMAIL:'worker@example.test'});
 h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,updated_at,version) VALUES('exp_guard','msg_guard','fixture_staff','Synthetic',10000,'transfer','SHOP_BANK','general','2026-10-28','CANCELLED','2026-10-28','2026-10-28',1)`).run();
 h.sqlite.prepare(`INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES('daily','exp_guard',10)`).run();
 const token=await fence.claimCorrectionDailyWriteFence(h.env,'daily');assert.ok(token);assert.equal(await guard.activateDailyIdentityLatch(h.env,'daily',token),true);assert.equal(await fence.releaseCorrectionDailyWriteFence(h.env,'daily',token),true);
 const orig=Object.fromEntries(methods.map(k=>[k,client[k]])),state={marker:{metadataId:101,metadataKey:'malipang_expense_daily',metadataValue:'exp_guard',sheetId:1,rowIndex:9},values:[],formulas:[],others:[['unrelated',200]],patches:0,missingProtection:false,duplicate:false,formula:false,moveBefore:false,moveOnDispatch:false,unknown:false};
 state.values[1]=10;state.values[2]=28;state.values[3]='Synthetic';state.values[7]=100;state.values[21]='general';state.values[22]='บัญชีร้าน';
 const headers=[[],Array(8).fill(null),[],[],[2026]];headers[1][7]='เงินโอน';
 client.searchSheetRowMetadata=async()=>state.duplicate?[{...state.marker},{...state.marker,metadataId:102}]:[{...state.marker}];
 client.getSheetProtectedRanges=async()=>({sheetId:1,ranges:state.missingProtection?[]:[{range:{sheetId:1},warningOnly:false,requestingUserCanEdit:true,editors:{users:['worker@example.test']}}]});
 client.batchGetSheetValues=async()=>[structuredClone(headers)];
 client.readSheetRowsByMetadata=async()=>new Map([[101,structuredClone(state.values)]]);
 client.batchGetSheetFormulaValues=async()=>{const result=[];if(state.formula)result[7]='=1+1';return [[result]]};
 client.getSheetRowMetadataById=async()=>({...state.marker});
 client.batchPatchMetadataRows=async(_env,patches,allowed,before)=>{
   if(state.moveBefore)state.marker.rowIndex++;
   await before();if(state.moveOnDispatch)state.marker.rowIndex++;
   assert.equal(patches[0].metadataId,101);assert.ok(patches[0].cells.every(cell=>allowed.includes(cell.columnIndex)));state.patches++;
   for(const cell of patches[0].cells)state.values[cell.columnIndex]=cell.value;
   if(state.unknown)throw new client.SheetsMutationOutcomeUnknownError(new Error('synthetic timeout'));
 };
 const close=()=>{for(const name of methods)client[name]=orig[name];h.close()};
 return {...h,state,close};
}
test('the permanent latch is installed inert, requires the shared fence and cannot be reset',async()=>{
 const h=ownerOrderFixture();try{h.env.SHEET_EXPENSE_DAILY='daily';const sql=readFileSync(new URL('../migrations/0029_owner_correction_daily_identity_latch.sql',import.meta.url),'utf8');h.sqlite.exec(sql);h.sqlite.exec(sql);
 assert.equal(await guard.dailyIdentityEnforced(h.env,'daily'),false);assert.equal(await guard.activateDailyIdentityLatch(h.env,'daily','wrong'),false);
 const token=await fence.claimCorrectionDailyWriteFence(h.env,'daily');assert.equal(await guard.activateDailyIdentityLatch(h.env,'daily',token),true);assert.equal(await guard.activateDailyIdentityLatch(h.env,'daily',token),false);await fence.releaseCorrectionDailyWriteFence(h.env,'daily',token);
 h.env.OWNER_EXPENSE_CORRECTION_ENABLED='false';assert.equal(await guard.dailyIdentityEnforced(h.env,'daily'),true);assert.throws(()=>h.sqlite.prepare(`DELETE FROM owner_correction_daily_identity_latch`).run(),/permanent/);assert.throws(()=>h.sqlite.prepare(`UPDATE owner_correction_daily_identity_latch SET sheet_name='other'`).run(),/permanent/);
 }finally{h.close()}
});
test('after latch activation the numeric posting paths hold even when the input flag is off',async()=>{
 const h=await setup();try{h.env.OWNER_EXPENSE_CORRECTION_ENABLED='false';let posted=0;const old=client.batchWriteValues;client.batchWriteValues=async()=>{posted++};try{const record={expenseId:'exp_new',transactionDate:'2026-10-28',description:'Synthetic',amountBaht:100,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'general'};
 await assert.rejects(daily.writeConfirmedExpenseToDaily(h.env,record),/DAILY_IDENTITY_REVIEW_REQUIRED/);await assert.rejects(daily.writeConfirmedExpenseWithDocumentItemsToDaily(h.env,record,null,[]),/DAILY_IDENTITY_REVIEW_REQUIRED/);assert.equal(posted,0);
 }finally{client.batchWriteValues=old}}finally{h.close()}
});
test('an installed latch cannot dispatch cancellation if the shared fence table is missing',async()=>{
 const h=await setup();try{h.env.OWNER_EXPENSE_CORRECTION_ENABLED='false';h.sqlite.exec('DROP TABLE owner_correction_daily_write_fences');await assert.rejects(daily.clearCancelledExpenseFromDaily(h.env,'exp_guard'),/DAILY_IDENTITY_REVIEW_REQUIRED/);assert.equal(h.state.patches,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sheet_row_index').get().n,1);}finally{h.close()}
});
test('cancel follows metadata even when a human inserts a row immediately before dispatch',async()=>{
 const h=await setup();try{h.state.moveOnDispatch=true;const rows=await daily.clearCancelledExpenseFromDaily(h.env,'exp_guard');assert.deepEqual(rows,[11]);assert.equal(h.state.patches,1);assert.deepEqual(h.state.others,[['unrelated',200]]);assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM sheet_row_index`).get().n,0);}finally{h.close()}
});
test('unstable, unprotected, duplicate or formula-bearing rows are held without writing',async()=>{
 for(const key of ['moveBefore','missingProtection','duplicate','formula']){const h=await setup();try{h.state[key]=true;await assert.rejects(daily.clearCancelledExpenseFromDaily(h.env,'exp_guard'),/DAILY_IDENTITY_REVIEW_REQUIRED/);assert.equal(h.state.patches,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sheet_row_index').get().n,1);}finally{h.close()}}
});
test('an unknown clear outcome retains fence and the retry only verifies the cleared marker',async()=>{
 const h=await setup();try{h.state.unknown=true;await assert.rejects(daily.clearCancelledExpenseFromDaily(h.env,'exp_guard'),/outcome unknown/);assert.equal(h.state.patches,1);assert.equal(h.sqlite.prepare('SELECT state FROM owner_correction_daily_write_fences').get().state,'IN_FLIGHT');
 await assert.rejects(daily.clearCancelledExpenseFromDaily(h.env,'exp_guard'),/CORRECTION_DAILY_SHEET_BUSY/);h.sqlite.prepare(`UPDATE owner_correction_daily_write_fences SET lease_until='2000-01-01',not_before='2000-01-01'`).run();h.state.unknown=false;
 await daily.clearCancelledExpenseFromDaily(h.env,'exp_guard');assert.equal(h.state.patches,1);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sheet_row_index').get().n,0);
 }finally{h.close()}
});
test('identity hold and unknown provider outcome enter durable REVIEW and repeated queue delivery never writes again',async()=>{
 const sync=require('../dist/sheets/sync.js');
 for(const mode of ['hold','unknown']){const h=await setup(),oldWrite=client.batchWriteValues;try{
  h.sqlite.prepare(`UPDATE expense_events SET status='CONFIRMED' WHERE expense_id='exp_guard'`).run();h.env.SHEET_EXPENSE_RAW='raw';h.env.SHEET_PURCHASE_DETAILS='details';let sends=0;
  client.batchWriteValues=async()=>{sends++;if(mode==='unknown')throw new client.SheetsMutationOutcomeUnknownError(new Error('synthetic timeout'))};
  const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_guard',entityVersion:1,traceId:'synthetic_trace'};
  assert.equal(await sync.syncJob(h.env,job),'REVIEW');const first=h.sqlite.prepare(`SELECT status,last_error FROM sync_jobs WHERE entity_type='EXPENSE'`).get();
  assert.equal(first.status,'REVIEW');assert.equal(first.last_error,mode==='unknown'?'DAILY_IDENTITY_OUTCOME_UNKNOWN':'DAILY_IDENTITY_REVIEW_REQUIRED');assert.equal(sends,1);
  assert.equal(await sync.syncJob(h.env,job),'REVIEW');assert.equal(sends,1);
 }finally{client.batchWriteValues=oldWrite;h.close()}}
});
test('force enqueue and duplicate deliveries preserve a daily identity review and do not write again',async()=>{
 const sync=require('../dist/sheets/sync.js'),repo=require('../dist/db/repositories.js'),worker=require('../dist/index.js').default;
 const h=await setup(),oldWrite=client.batchWriteValues;try{
  h.sqlite.prepare(`UPDATE expense_events SET status='CONFIRMED' WHERE expense_id='exp_guard'`).run();h.env.SHEET_EXPENSE_RAW='raw';h.env.SHEET_PURCHASE_DETAILS='details';let sends=0;
  client.batchWriteValues=async()=>{sends++};const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_guard',entityVersion:1,traceId:'synthetic_trace'};
  assert.equal(await sync.syncJob(h.env,job),'REVIEW');assert.equal(sends,1);
  const before=h.sqlite.prepare(`SELECT status,last_error,trace_id FROM sync_jobs WHERE entity_type='EXPENSE'`).get();
  await repo.enqueueSheetSyncBatch(h.env,[{...job,traceId:'different_trace'}],true);
  assert.deepEqual(h.sqlite.prepare(`SELECT status,last_error,trace_id FROM sync_jobs WHERE entity_type='EXPENSE'`).get(),before);
  for(let i=0;i<2;i++){let ack=0,retry=0;await worker.queue({queue:'malipang-jobs',messages:[{body:job,ack(){ack++},retry(){retry++}}]},h.env,{});assert.equal(ack,1);assert.equal(retry,0)}
  const failed=h.sqlite.prepare(`SELECT status,error FROM failed_jobs WHERE job_key='EXPENSE:exp_guard:1'`).get();assert.equal(failed.status,'OPEN');assert.equal(failed.error,'DAILY_IDENTITY_REVIEW_REQUIRED');assert.equal(sends,1);
 }finally{client.batchWriteValues=oldWrite;h.close()}
});
