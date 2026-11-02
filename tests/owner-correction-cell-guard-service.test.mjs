import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {createOwnerCorrectionDraft,loadOwnerExpense} from '../dist/expense/owner-correction-repository.js';
import {ensureOwnerCorrectionCellGuards} from '../dist/sheets/owner-correction-cell-guard-service.js';

async function setup(){
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},clock={now:Date.now()};
  Object.assign(h.env,{GOOGLE_SERVICE_ACCOUNT_EMAIL:'synthetic@example.invalid',SHEET_EXPENSE_DAILY:'daily'});
  h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
    VALUES('exp_guard','msg_guard','fixture_staff','Synthetic driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
  const before=await loadOwnerExpense(h.env,owner,'exp_guard'),id=await createOwnerCorrectionDraft(h.env,owner,before,'description','New synthetic driver',clock.now);
  h.sqlite.prepare('UPDATE expense_owner_corrections SET expires_at=? WHERE correction_id=?').run(new Date(clock.now+60*60_000).toISOString(),id);
  const plan={expenseId:'exp_guard',dailyMetadataId:12,rawMetadataId:13,patches:[{metadataId:12,cells:[{columnIndex:3,value:'New synthetic driver'}]},{metadataId:13,cells:[{columnIndex:2,value:'New synthetic driver'}]}],originalRows:[],rebind:null};
  const metadata={metadataId:12,metadataKey:'malipang_expense_daily',metadataValue:'exp_guard',sheetId:5,rowIndex:20},ranges=[],sent=[];let next=100;
  const ports={now:()=>clock.now,metadata:async()=>({...metadata}),sheetId:async()=>5,ranges:async()=>({sheetId:5,ranges:structuredClone(ranges)}),
    batch:async(_env,requests,beforeDispatch)=>{await beforeDispatch();sent.push(structuredClone(requests));for(const req of requests)ranges.push({...req.addProtectedRange.protectedRange,protectedRangeId:next++,requestingUserCanEdit:true});}};
  return {...h,owner,before,id,plan,metadata,ranges,sent,ports,clock};
}
const run=h=>ensureOwnerCorrectionCellGuards(h.env,h.owner,h.id,h.before,h.plan,h.ports);
test('cell guard is durable before dispatch, narrowly scoped and reverified',async()=>{
  const h=await setup();try{
    const batch=h.ports.batch;h.ports.batch=async(_env,requests,arm)=>batch(_env,requests,async()=>{await arm();assert.equal(h.sqlite.prepare('SELECT state FROM expense_owner_correction_cell_guards').get().state,'IN_FLIGHT')});
    assert.equal((await run(h)).kind,'READY');assert.equal((await run(h)).kind,'READY');assert.equal(h.sent.length,1);assert.equal(h.ranges.length,1);assert.equal(h.ranges[0].range.startColumnIndex,3);
    assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,0);
  }finally{h.close()}
});
test('lost guard response waits out the provider window before rechecking',async()=>{
  for(const applied of [false,true]){const h=await setup();try{
    const batch=h.ports.batch;let first=true;h.ports.batch=async(_env,requests,arm)=>{if(first){first=false;if(applied)await batch(_env,requests,arm);else{await arm();h.sent.push(structuredClone(requests))}throw Error('synthetic timeout')}return batch(_env,requests,arm)};
    assert.equal((await run(h)).kind,'PENDING');assert.equal((await run(h)).kind,'PENDING');assert.equal(h.sent.length,1);
    h.clock.now+=15*60_000+1;assert.equal((await run(h)).kind,'READY');assert.equal(h.ranges.length,1);assert.equal(h.sent.length,applied?1:2);
  }finally{h.close()}}
});
test('concurrent guard creation cannot dispatch the same request twice',async()=>{
  const h=await setup();try{
    const batch=h.ports.batch;let release,armed;const gate=new Promise(resolve=>{release=resolve}),ready=new Promise(resolve=>{armed=resolve});
    h.ports.batch=async(_env,requests,arm)=>batch(_env,requests,async()=>{await arm();armed();await gate});
    const first=run(h);await ready;assert.equal((await run(h)).kind,'PENDING');release();assert.equal((await first).kind,'READY');assert.equal(h.sent.length,1);
  }finally{h.close()}
});
test('overlapping protection or a moved guard that does not follow the row requires review',async()=>{
  {const h=await setup();try{h.ranges.push({range:{sheetId:5,startRowIndex:20,endRowIndex:21,startColumnIndex:3,endColumnIndex:4},warningOnly:true});assert.equal((await run(h)).kind,'REVIEW');assert.equal(h.sent.length,0)}finally{h.close()}}
  {const h=await setup();try{assert.equal((await run(h)).kind,'READY');h.metadata.rowIndex++;assert.equal((await run(h)).kind,'REVIEW');h.ranges[0].range.startRowIndex++;h.ranges[0].range.endRowIndex++;assert.equal((await run(h)).kind,'READY')}finally{h.close()}}
});
test('insertion immediately before a delayed create never locks a second row on retry',async()=>{
  const h=await setup();try{
    const batch=h.ports.batch;h.ports.batch=async(_env,requests,arm)=>batch(_env,requests,async()=>{await arm();h.metadata.rowIndex++});
    assert.equal((await run(h)).kind,'PENDING');h.clock.now+=15*60_000+1;assert.equal((await run(h)).kind,'REVIEW');assert.equal(h.sent.length,1);assert.equal(h.ranges.length,1);
  }finally{h.close()}
});
test('revoked owner cannot create guards and migration preserves financial records',async()=>{
  const h=await setup();try{
    h.sqlite.exec('DROP TABLE expense_owner_correction_cell_guards');const before=JSON.stringify(h.sqlite.prepare('SELECT * FROM expense_events').all()),migration=readFileSync(new URL('../migrations/0024_owner_correction_cell_guards.sql',import.meta.url),'utf8');h.sqlite.exec(migration);h.sqlite.exec(migration);
    assert.equal(JSON.stringify(h.sqlite.prepare('SELECT * FROM expense_events').all()),before);assert.equal(h.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
    h.sqlite.exec("UPDATE employees SET status='INACTIVE' WHERE employee_id='TEST_OWNER'");assert.equal((await run(h)).kind,'STALE');assert.equal(h.sent.length,0);
  }finally{h.close()}
});
