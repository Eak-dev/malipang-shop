import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
const require=createRequire(import.meta.url),{reserveDailyPosting}=require('../dist/sheets/owner-correction-daily-posting-reservation.js'),{activateDailyIdentityLatch}=require('../dist/sheets/owner-correction-daily-identity-guard.js'),fence=require('../dist/sheets/owner-correction-daily-write-fence.js');
async function setup(){
 const h=ownerOrderFixture(),now=Date.now();h.env.SHEET_EXPENSE_DAILY='daily';h.env.OWNER_EXPENSE_CORRECTION_ENABLED='true';
 h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,updated_at,version) VALUES('exp_post','msg_post','fixture_staff','Synthetic',10000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','2026-10-28','2026-10-28',1)`).run();
 h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,lease_token,lease_until) VALUES('job_post','EXPENSE','exp_post',1,'trace_post','PROCESSING',1,'2026-10-28','lease_post','2099-01-01')`).run();
 const token=await fence.claimCorrectionDailyWriteFence(h.env,'daily',now);assert.ok(token);assert.equal(await activateDailyIdentityLatch(h.env,'daily',token,now),true);
 const snapshot={expenseId:'exp_post',version:1,updatedAt:'2026-10-28',description:'Synthetic',category:'general',amountSatang:10000,transactionDate:'2026-10-28',paymentKey:'transfer',sourceWallet:'SHOP_BANK'},input={sheetId:1,rowNumber:10,metadataId:123,headers:[[],[],[]],fenceToken:token,syncToken:'lease_post'};
 return {...h,now,snapshot,input};
}
test('reserving a posting requires durable latch plus exact fenced D1 snapshot and is idempotent',async()=>{
 const h=await setup();try{
  const first=await reserveDailyPosting(h.env,h.snapshot,h.input,h.now),again=await reserveDailyPosting(h.env,h.snapshot,h.input,h.now);assert.deepEqual(first,again);assert.equal(first.rowNumber,10);assert.equal(first.metadataId,123);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM daily_identity_posting_reservations').get().n,1);assert.deepEqual({...h.sqlite.prepare('SELECT entity_key,row_number FROM sheet_row_index').get()},{entity_key:'exp_post',row_number:10});
  const sql=readFileSync(new URL('../migrations/0031_daily_identity_posting_reservations.sql',import.meta.url),'utf8');h.sqlite.exec(sql);assert.equal(h.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{h.close()}
});
test('wrong owner job lease, changed expense, expired fence and unlatched sheet never reserve',async()=>{
 for(const mode of ['job','snapshot','fence','unlatched']){const h=await setup();try{
  if(mode==='job')h.input.syncToken='other';if(mode==='snapshot')h.sqlite.prepare(`UPDATE expense_events SET description='changed'`).run();if(mode==='fence')h.input.fenceToken='other';if(mode==='unlatched')h.env.SHEET_EXPENSE_DAILY='another';
  assert.equal(await reserveDailyPosting(h.env,h.snapshot,h.input,h.now),null,mode);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sheet_row_index').get().n,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM daily_identity_posting_reservations').get().n,0);
 }finally{h.close()}}
});
test('occupied candidate or conflicting existing mapping is never overwritten',async()=>{
 for(const [key,row] of [['another',10],['exp_post',11]]){const h=await setup();try{
  h.sqlite.prepare(`INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES('daily',?,?)`).run(key,row);
  assert.equal(await reserveDailyPosting(h.env,h.snapshot,h.input,h.now),null);assert.deepEqual({...h.sqlite.prepare('SELECT entity_key,row_number FROM sheet_row_index').get()},{entity_key:key,row_number:row});assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM daily_identity_posting_reservations').get().n,0);
 }finally{h.close()}}
});
test('after creation a changed target, metadata ID or header cannot silently reuse the reservation',async()=>{
 const h=await setup();try{assert.ok(await reserveDailyPosting(h.env,h.snapshot,h.input,h.now));
  for(const changed of [{...h.input,rowNumber:11},{...h.input,metadataId:124},{...h.input,headers:[[],['changed'],[]]}])assert.equal(await reserveDailyPosting(h.env,h.snapshot,changed,h.now),null);
  assert.equal(h.sqlite.prepare('SELECT row_number,metadata_id FROM daily_identity_posting_reservations').get().metadata_id,123);
 }finally{h.close()}
});
