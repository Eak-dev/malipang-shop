import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {grantSyntheticOpenPeriods,syntheticCorrectionHeaders,syntheticCorrectionHeaderDigest,syntheticCorrectionReport} from './helpers/owner-correction-periods.mjs';
import {cancelOwnerCorrectionDraft,commitOwnerCorrection,createOwnerCorrectionDraft,loadOwnerExpense,ownerCorrectionStatus} from '../dist/expense/owner-correction-repository.js';
import {holdOwnerCorrectionForReview,listOwnerCorrectionManualReviews,ownerCorrectionManualReviewSummary,retryOwnerCorrectionManualReview} from '../dist/expense/owner-correction-manual-review.js';
import {handleOwnerCorrectionPostback,handleOwnerCorrectionText} from '../dist/expense/owner-correction-service.js';
import {handleAdmin} from '../dist/admin/handler.js';
const owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},staff={employeeId:'TEST_STAFF',lineUserId:'fixture_staff'},other={employeeId:'TEST_OWNER_TWO',lineUserId:'fixture_owner_two'};
async function setup(field='transactionDate',value='2026-11-01'){
  const h=ownerOrderFixture(),now=Date.now();h.env.OWNER_EXPENSE_CORRECTION_ENABLED='true';
  h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
    VALUES('exp_manual','msg_manual','fixture_staff','Synthetic supplier',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
  const before=await loadOwnerExpense(h.env,owner,'exp_manual'),id=await createOwnerCorrectionDraft(h.env,owner,before,field,value,now);return {...h,now,before,id};
}
test('only the verified owner can hold, list and cancel a request without changing the expense',async()=>{
  const h=await setup();try{
    assert.equal(await holdOwnerCorrectionForReview(h.env,staff,h.id,'CROSS_MONTH',h.now),'STALE');assert.equal(await holdOwnerCorrectionForReview(h.env,other,h.id,'CROSS_MONTH',h.now),'STALE');
    assert.equal(await holdOwnerCorrectionForReview(h.env,owner,h.id,'CROSS_MONTH',h.now),'HELD');assert.equal(await holdOwnerCorrectionForReview(h.env,owner,h.id,'CROSS_MONTH',h.now),'HELD');
    assert.equal(await ownerCorrectionStatus(h.env,owner,h.id,h.now+60*60_000),'MANUAL_REVIEW');assert.equal((await listOwnerCorrectionManualReviews(h.env,owner)).length,1);assert.equal((await listOwnerCorrectionManualReviews(h.env,staff)).length,0);assert.equal((await listOwnerCorrectionManualReviews(h.env,other)).length,0);
    assert.deepEqual(await ownerCorrectionManualReviewSummary(h.env),[{reason:'CROSS_MONTH',count:1}]);assert.equal(h.sqlite.prepare('SELECT transaction_date FROM expense_events').get().transaction_date,'2026-10-28');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
    assert.equal(await cancelOwnerCorrectionDraft(h.env,staff,h.id,h.now+60*60_000),false);assert.equal(await cancelOwnerCorrectionDraft(h.env,owner,h.id,h.now+60*60_000),true);assert.equal(await ownerCorrectionStatus(h.env,owner,h.id,h.now+60*60_000),'CANCELLED');assert.deepEqual(await ownerCorrectionManualReviewSummary(h.env),[]);
  }finally{h.close()}
});
test('a held request becomes stale if any business field changes even without a version bump',async()=>{
  const h=await setup();try{assert.equal(await holdOwnerCorrectionForReview(h.env,owner,h.id,'CROSS_MONTH',h.now),'HELD');h.sqlite.exec("UPDATE expense_events SET amount_satang=200001 WHERE expense_id='exp_manual'");assert.equal(await ownerCorrectionStatus(h.env,owner,h.id,h.now),'STALE');assert.equal((await listOwnerCorrectionManualReviews(h.env,owner))[0].snapshot_current,0)}finally{h.close()}
});
test('owner can reopen an unchanged held request once without applying it',async()=>{
  const h=await setup();try{
    await holdOwnerCorrectionForReview(h.env,owner,h.id,'CROSS_MONTH',h.now);
    assert.equal(await retryOwnerCorrectionManualReview(h.env,staff,h.id,h.now+60*60_000),null);assert.equal(await retryOwnerCorrectionManualReview(h.env,other,h.id,h.now+60*60_000),null);
    const [first,second]=await Promise.all([retryOwnerCorrectionManualReview(h.env,owner,h.id,h.now+60*60_000),retryOwnerCorrectionManualReview(h.env,owner,h.id,h.now+60*60_000)]);
    assert.ok(first);assert.equal(first,second);assert.notEqual(first,h.id);assert.equal(await ownerCorrectionStatus(h.env,owner,first,h.now+60*60_000),'DRAFT');
    assert.equal(h.sqlite.prepare('SELECT status FROM expense_owner_correction_manual_reviews WHERE correction_id=?').get(h.id).status,'RESOLVED');assert.equal(await ownerCorrectionStatus(h.env,owner,h.id,h.now+60*60_000),'CANCELLED');
    assert.equal(h.sqlite.prepare('SELECT transaction_date FROM expense_events').get().transaction_date,'2026-10-28');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
    assert.equal(await holdOwnerCorrectionForReview(h.env,owner,first,'CROSS_MONTH',h.now+60*60_000),'HELD');assert.deepEqual(await ownerCorrectionManualReviewSummary(h.env),[{reason:'CROSS_MONTH',count:1}]);
  }finally{h.close()}
});
test('reopening fails closed for a changed snapshot and rolls back every batch failure',async()=>{
  {const h=await setup();try{await holdOwnerCorrectionForReview(h.env,owner,h.id,'CROSS_MONTH',h.now);h.sqlite.exec("UPDATE expense_events SET amount_satang=200001 WHERE expense_id='exp_manual'");assert.equal(await retryOwnerCorrectionManualReview(h.env,owner,h.id,h.now),null);assert.equal(h.sqlite.prepare('SELECT status FROM expense_owner_correction_manual_reviews').get().status,'OPEN')}finally{h.close()}}
  for(let index=0;index<4;index++){const h=await setup();try{await holdOwnerCorrectionForReview(h.env,owner,h.id,'SHEET_CHECK',h.now);h.DB.failAt=index;await assert.rejects(retryOwnerCorrectionManualReview(h.env,owner,h.id,h.now),/fixture batch failure/);h.DB.failAt=null;assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_owner_corrections').get().n,1);assert.equal(h.sqlite.prepare('SELECT status FROM expense_owner_correction_manual_reviews').get().status,'OPEN');assert.equal(await ownerCorrectionStatus(h.env,owner,h.id,h.now),'MANUAL_REVIEW')}finally{h.close()}}
});
test('manual review pagination uses a stable tie breaker without dropping requests',async()=>{
  const h=await setup();try{
    assert.equal(await holdOwnerCorrectionForReview(h.env,owner,h.id,'CROSS_MONTH',h.now),'HELD');
    for(let i=0;i<9;i++){const id=await createOwnerCorrectionDraft(h.env,owner,h.before,'description',`Synthetic description ${i}`,h.now);assert.equal(await holdOwnerCorrectionForReview(h.env,owner,id,'SHEET_CHECK',h.now),'HELD')}
    const first=await listOwnerCorrectionManualReviews(h.env,owner),last=first[7],second=await listOwnerCorrectionManualReviews(h.env,owner,last.created_at,last.correction_id);
    assert.equal(first.length,9);assert.equal(second.length,2);assert.equal(new Set([...first.slice(0,8),...second].map(row=>row.correction_id)).size,10);
  }finally{h.close()}
});
test('a manual hold racing the D1 commit blocks the entire financial change',async()=>{
  const h=await setup('category','transport');try{
    await grantSyntheticOpenPeriods(h,h.id);const plan={expenseId:h.before.expenseId,dailyMetadataId:1,rawMetadataId:2,patches:[{metadataId:1,cells:[{columnIndex:21,value:'transport'}]},{metadataId:2,cells:[{columnIndex:6,value:'transport'}]}],originalRows:[{metadataId:1,values:Array(22).fill(null)},{metadataId:2,values:[null,null,null,null,null,null,'general']}],rebind:null,headerDigest:syntheticCorrectionHeaderDigest,reportBaseline:syntheticCorrectionReport(h.before)};
    const evidence={ownerVerified:true,snapshotCurrent:true,sourcePeriod:'OPEN',destinationPeriod:'OPEN',itemCount:0,receiptAllocationVerified:false,rowIdentityVerified:true,projectionTargetsVerified:true,reportDeduplicationVerified:true,syncInProgress:false,periodHeaders:syntheticCorrectionHeaders()},batch=h.DB.batch.bind(h.DB);
    h.DB.batch=async statements=>{h.sqlite.prepare(`INSERT INTO expense_owner_correction_manual_reviews(correction_id,expense_id,owner_employee_id,reason_code,status,created_at,updated_at) VALUES(?,?,?,'SHEET_CHECK','OPEN','now','now')`).run(h.id,'exp_manual','TEST_OWNER');return batch(statements)};
    assert.equal(await commitOwnerCorrection(h.env,owner,h.id,evidence,'trace',h.now,plan),null);assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
  }finally{h.close()}
});
test('LINE exposes a durable review card, owner list and safe cancellation',async()=>{
  const h=await setup();try{
    const services={periods:async()=>null,decision:async()=> 'STALE',confirmed:async()=> 'UNSUPPORTED'},post=(action,line='fixture_owner')=>h.capture(()=>handleOwnerCorrectionPostback(h.env,h.event(line,{type:'postback',postback:{data:`a=${action}&id=${h.id}&v=1`}}),'trace',services));
    await post('owner_correction_execute');assert.match(JSON.stringify(h.messages.at(-1)),/รอตรวจเพิ่มเติม/);assert.equal(await ownerCorrectionStatus(h.env,owner,h.id),'MANUAL_REVIEW');
    await h.capture(()=>handleOwnerCorrectionText(h.env,h.event('fixture_owner',{message:{type:'text',id:'synthetic_list',text:'รายการแก้ไขรอตรวจ'}}),'trace'));assert.match(JSON.stringify(h.messages.at(-1)),/Synthetic supplier/);
    await post('owner_correction_status','fixture_staff');assert.match(JSON.stringify(h.messages.at(-1)),/สำหรับเจ้าของ/);
    await post('owner_correction_cancel');assert.equal(await ownerCorrectionStatus(h.env,owner,h.id),'CANCELLED');
  }finally{h.close()}
});
test('LINE retry shows a fresh comparison and requires another owner confirmation',async()=>{
  const h=await setup();try{
    await holdOwnerCorrectionForReview(h.env,owner,h.id,'SHEET_CHECK',h.now);
    const post=(line='fixture_owner')=>h.capture(()=>handleOwnerCorrectionPostback(h.env,h.event(line,{type:'postback',postback:{data:`a=owner_correction_review_retry&id=${h.id}`}}),'trace'));
    await post('fixture_staff');assert.match(JSON.stringify(h.messages.at(-1)),/สำหรับเจ้าของ/);
    await post();assert.match(JSON.stringify(h.messages.at(-1)),/ตรวจการแก้ไขก่อนยืนยัน/);assert.equal(h.sqlite.prepare('SELECT transaction_date FROM expense_events').get().transaction_date,'2026-10-28');
    const next=h.sqlite.prepare('SELECT correction_id FROM expense_owner_corrections WHERE input_id=?').get(`review_retry:${h.id}`).correction_id;await post();assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_owner_corrections').get().n,2);assert.equal(await ownerCorrectionStatus(h.env,owner,next),'DRAFT');
  }finally{h.close()}
});
test('an unverified legacy bank total is tracked with its specific review reason',async()=>{
  const h=await setup('amountSatang','2100');try{
    const services={periods:async()=>null,decision:async()=> 'STALE',confirmed:async()=> 'LEGACY_BANK_REVIEW'};
    await h.capture(()=>handleOwnerCorrectionPostback(h.env,h.event('fixture_owner',{type:'postback',postback:{data:`a=owner_correction_execute&id=${h.id}&v=1`}}),'trace',services));
    assert.match(JSON.stringify(h.messages.at(-1)),/ยอดธนาคารของระบบเดิมยังรอตรวจ/);assert.deepEqual(await ownerCorrectionManualReviewSummary(h.env),[{reason:'LEGACY_BANK',count:1}]);assert.equal(h.sqlite.prepare('SELECT amount_satang FROM expense_events').get().amount_satang,200000);
  }finally{h.close()}
});
test('admin summary exposes counts only and requires authentication',async()=>{
  const h=await setup();try{
    await holdOwnerCorrectionForReview(h.env,owner,h.id,'CROSS_MONTH',h.now);h.env.OWNER_EXPENSE_CORRECTION_ENABLED='false';h.env.ADMIN_TOKEN='a'.repeat(40);
    const request=token=>new Request('https://example.invalid/admin/owner-correction/review-summary',{headers:{authorization:`Bearer ${token}`}});
    assert.equal((await handleAdmin(request('wrong'),h.env,{})).status,401);const response=await handleAdmin(request(h.env.ADMIN_TOKEN),h.env,{}),body=await response.json();assert.equal(response.status,200);assert.deepEqual(body.reasons,[{reason:'CROSS_MONTH',count:1}]);assert.doesNotMatch(JSON.stringify(body),/exp_manual|fixture_staff/);
    const queue=token=>new Request('https://example.invalid/admin/owner-correction/review-queue?kind=manual',{headers:{authorization:`Bearer ${token}`}});
    assert.equal((await handleAdmin(queue('wrong'),h.env,{})).status,401);const list=await (await handleAdmin(queue(h.env.ADMIN_TOKEN),h.env,{})).json();assert.equal(list.items.length,1);assert.equal(list.items[0].correctionId,h.id);assert.equal(list.items[0].reason,'CROSS_MONTH');assert.doesNotMatch(JSON.stringify(list),/exp_manual|fixture_staff|Synthetic supplier/);
  }finally{h.close()}
});
test('paused corrections still expose owner-only read-only status and review lists',async()=>{
  const h=await setup();try{
    assert.equal(await holdOwnerCorrectionForReview(h.env,owner,h.id,'CROSS_MONTH',h.now),'HELD');h.env.OWNER_EXPENSE_CORRECTION_ENABLED='false';
    const show=async(line,value)=>h.capture(()=>handleOwnerCorrectionText(h.env,h.event(line,{message:{type:'text',id:'msg_status',text:value}}),'trace'));
    const post=async(line,data)=>h.capture(()=>handleOwnerCorrectionPostback(h.env,h.event(line,{type:'postback',postback:{data}}),'trace'));
    await show('fixture_staff','รายการแก้ไขรอตรวจ');assert.match(JSON.stringify(h.messages.at(-1)),/สำหรับเจ้าของ/);
    await show('fixture_owner','รายการแก้ไขรอตรวจ');assert.match(JSON.stringify(h.messages.at(-1)),/Synthetic supplier/);
    await show('fixture_owner_two','รายการแก้ไขรอตรวจ');assert.doesNotMatch(JSON.stringify(h.messages.at(-1)),/Synthetic supplier/);
    await post('fixture_owner',`a=owner_correction_status&id=${h.id}`);assert.match(JSON.stringify(h.messages.at(-1)),/รอตรวจเพิ่มเติม/);assert.doesNotMatch(JSON.stringify(h.messages.at(-1)),/owner_correction_review_retry|owner_correction_cancel/);
    const before=JSON.stringify(h.sqlite.prepare('SELECT * FROM expense_owner_corrections').all());
    for(const action of ['owner_correction_review_retry','owner_correction_cancel','owner_correction_confirm','owner_correction_execute','owner_correction_period_set','owner_correction_input']){
      await post('fixture_owner',`a=${action}&id=${h.id}&v=1`);assert.match(JSON.stringify(h.messages.at(-1)),/พักการแก้ไข/);
    }
    await show('fixture_owner','แก้ไขค่าใช้จ่าย');assert.match(JSON.stringify(h.messages.at(-1)),/พักการแก้ไข/);
    assert.equal(JSON.stringify(h.sqlite.prepare('SELECT * FROM expense_owner_corrections').all()),before);
    assert.equal(await show('fixture_owner','ordinary expense text'),false);
  }finally{h.close()}
});
test('before correction migrations, status requests fail closed and ordinary text passes through',async()=>{
  const h=ownerOrderFixture();try{
    h.env.OWNER_EXPENSE_CORRECTION_ENABLED='false';h.sqlite.exec('DROP TABLE expense_owner_correction_manual_reviews');
    const show=value=>h.capture(()=>handleOwnerCorrectionText(h.env,h.event('fixture_owner',{message:{type:'text',id:'msg_pre_migration',text:value}}),'trace'));
    assert.equal(await show('ordinary expense text'),false);assert.equal(await show('สถานะการแก้ไข'),true);assert.match(JSON.stringify(h.messages.at(-1)),/ยังตรวจสถานะไม่ได้/);
    const post=()=>h.capture(()=>handleOwnerCorrectionPostback(h.env,h.event('fixture_owner',{type:'postback',postback:{data:'a=owner_correction_history_next'}}),'trace'));
    assert.equal(await post(),true);assert.match(JSON.stringify(h.messages.at(-1)),/ยังตรวจสถานะไม่ได้/);
  }finally{h.close()}
});
test('manual review migration is additive and repeatable',async()=>{
  const h=await setup();try{h.sqlite.exec('DROP TABLE expense_owner_correction_manual_reviews');const old=JSON.stringify(h.sqlite.prepare('SELECT * FROM expense_events').all()),sql=readFileSync(new URL('../migrations/0026_owner_correction_manual_reviews.sql',import.meta.url),'utf8');h.sqlite.exec(sql);h.sqlite.exec(sql);assert.equal(JSON.stringify(h.sqlite.prepare('SELECT * FROM expense_events').all()),old);assert.equal(h.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[])}finally{h.close()}
});
