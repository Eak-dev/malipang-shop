import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {seedDailyCategoryBaseline,registerDailyCategoryProjectionTarget,requestDailyCategoryChange,approveDailyCategoryChange,rejectDailyCategoryChange,clearDailyCategoryRejection} from '../dist/sheets/daily-category-repository.js';

async function setup(){
  const h=ownerOrderFixture(),now='2026-02-13T10:00:00.000Z';
  h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at,version)
    VALUES('exp_category','msg_category','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-02-13','CONFIRMED','trace',?,1)`).run(now);
  const row={expenseId:'exp_category',rowNumber:100,metadataId:10,fingerprint:'fixture-fingerprint',category:'general',expenseVersion:1};
  assert.equal(await seedDailyCategoryBaseline(h.env,row),true);
  assert.equal(await registerDailyCategoryProjectionTarget(h.env,{expenseId:'exp_category',targetType:'RAW',itemId:'',metadataId:21,expenseVersion:1}),true);
  const requestId=await requestDailyCategoryChange(h.env,row,'transport');assert.ok(requestId);
  return {...h,row,input:{requestId,row,observedCategory:'transport',owner:{employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},traceId:'trace_approval'}};
}

test('only an active verified owner can atomically approve once with a durable projection outbox',async()=>{
  const h=await setup();try{
    assert.equal(await approveDailyCategoryChange(h.env,{...h.input,owner:{employeeId:'TEST_STAFF',lineUserId:'fixture_staff'}}),null);
    assert.equal(await approveDailyCategoryChange(h.env,h.input),2);
    assert.equal(await approveDailyCategoryChange(h.env,h.input),null);
    const e=h.sqlite.prepare("SELECT category,version,status FROM expense_events WHERE expense_id='exp_category'").get();
    assert.deepEqual({...e},{category:'transport',version:2,status:'CONFIRMED'});
    assert.equal(h.sqlite.prepare("SELECT status FROM daily_category_requests").get().status,'APPROVED');
    assert.equal(h.sqlite.prepare("SELECT count(*) n FROM expense_audit_log WHERE action='EDIT' AND actor_employee_id='TEST_OWNER'").get().n,1);
    const j=h.sqlite.prepare("SELECT entity_type,entity_version,status FROM sync_jobs").get();
    assert.deepEqual({...j},{entity_type:'EXPENSE_CATEGORY',entity_version:2,status:'PENDING'});
  }finally{h.close()}
});

test('changes to the source or a pending sync reject approval without financial writes',async()=>{
  for(const mutation of ["UPDATE expense_events SET version=2 WHERE expense_id='exp_category'","UPDATE daily_category_baselines SET fingerprint='changed'","DELETE FROM daily_category_projection_targets","UPDATE staff_roles SET status='INACTIVE' WHERE employee_id='TEST_OWNER'","INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('busy','EXPENSE','exp_category',1,'t','PROCESSING',1,'now')"]){
    const h=await setup();try{h.sqlite.exec(mutation);assert.equal(await approveDailyCategoryChange(h.env,h.input),null);assert.equal(h.sqlite.prepare("SELECT category FROM expense_events WHERE expense_id='exp_category'").get().category,'general');assert.equal(h.sqlite.prepare("SELECT status FROM daily_category_requests").get().status,'PENDING');}finally{h.close()}
  }
});

test('transaction failure at each boundary rolls back expense, approval, audit and outbox',async()=>{
  for(let failAt=0;failAt<6;failAt++){
    const h=await setup();try{h.DB.failAt=failAt;await assert.rejects(approveDailyCategoryChange(h.env,h.input),/fixture batch failure/);assert.equal(h.sqlite.prepare("SELECT category FROM expense_events WHERE expense_id='exp_category'").get().category,'general');assert.equal(h.sqlite.prepare("SELECT status FROM daily_category_requests").get().status,'PENDING');assert.equal(h.sqlite.prepare("SELECT count(*) n FROM sync_jobs").get().n,0);}finally{h.close()}
  }
});

test('rejection needs an owner, keeps the expense, and suppresses repeats until the sheet returns to baseline',async()=>{
  const h=await setup();try{
    const input={requestId:h.input.requestId,row:h.row,toCategory:'transport',owner:h.input.owner};
    assert.equal(await rejectDailyCategoryChange(h.env,{...input,owner:{employeeId:'TEST_STAFF',lineUserId:'fixture_staff'}}),false);
    assert.equal(await rejectDailyCategoryChange(h.env,input),true);
    assert.equal(await rejectDailyCategoryChange(h.env,input),false);
    assert.equal(h.sqlite.prepare("SELECT category FROM expense_events WHERE expense_id='exp_category'").get().category,'general');
    assert.equal(await requestDailyCategoryChange(h.env,h.row,'transport'),null);
    await clearDailyCategoryRejection(h.env,h.row);
    assert.ok(await requestDailyCategoryChange(h.env,h.row,'transport'));
  }finally{h.close()}
});
