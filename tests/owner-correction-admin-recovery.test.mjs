import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {grantSyntheticOpenPeriods,syntheticCorrectionHeaders,syntheticCorrectionHeaderDigest,syntheticCorrectionReport} from './helpers/owner-correction-periods.mjs';
import {createOwnerCorrectionDraft,loadOwnerExpense,commitOwnerCorrection,listOwnerCorrectionHistory} from '../dist/expense/owner-correction-repository.js';
import {recoverVerifiedOwnerCorrection} from '../dist/admin/owner-correction-recovery.js';
import {processOwnerCorrectionJob} from '../dist/sheets/owner-correction-worker.js';
import {handleAdmin} from '../dist/admin/handler.js';
import {handleOwnerCorrectionText} from '../dist/expense/owner-correction-service.js';

async function setup(){
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},now=Date.now();h.env.OWNER_EXPENSE_CORRECTION_ENABLED='true';
  h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
    VALUES('exp_recover','msg_recover','fixture_staff','Synthetic driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
  const before=await loadOwnerExpense(h.env,owner,'exp_recover'),id=await createOwnerCorrectionDraft(h.env,owner,before,'category','transport',now);await grantSyntheticOpenPeriods(h,id);
  const daily=Array(23).fill(null);Object.assign(daily,{1:10,2:28,3:'Synthetic driver',7:2000,21:'general',22:'บัญชีร้าน'});
  const raw=['exp_recover','2026-10-28','Synthetic driver',2000,'transfer','SHOP_BANK','general','CONFIRMED'];
  const plan={expenseId:'exp_recover',dailyMetadataId:1,rawMetadataId:2,patches:[{metadataId:1,cells:[{columnIndex:21,value:'transport'}]},{metadataId:2,cells:[{columnIndex:6,value:'transport'}]}],originalRows:[{metadataId:1,values:daily},{metadataId:2,values:raw}],rebind:null,headerDigest:syntheticCorrectionHeaderDigest,reportBaseline:syntheticCorrectionReport(before)};
  const evidence={ownerVerified:true,snapshotCurrent:true,sourcePeriod:'OPEN',destinationPeriod:'OPEN',itemCount:0,receiptAllocationVerified:false,rowIdentityVerified:true,projectionTargetsVerified:true,reportDeduplicationVerified:true,syncInProgress:false,periodHeaders:syntheticCorrectionHeaders()};
  assert.equal(await commitOwnerCorrection(h.env,owner,id,evidence,'synthetic_recover_trace',now,plan),2);
  h.sqlite.prepare("UPDATE expense_owner_correction_sync SET phase='REVIEW' WHERE correction_id=?").run(id);h.sqlite.prepare("UPDATE sync_jobs SET status='REVIEW' WHERE entity_type='EXPENSE_CORRECTION'").run();
  const rows=new Map(plan.originalRows.map(row=>[row.metadataId,[...row.values]]));for(const patch of plan.patches)for(const cell of patch.cells)rows.get(patch.metadataId)[cell.columnIndex]=cell.value;
  const jobs=[],ports={now:()=>now,inspect:async()=>({identitiesVerified:true,rows:new Map([...rows].map(([key,value])=>[key,[...value]]))}),report:async()=>structuredClone(plan.reportBaseline),view:async()=> 'VERIFIED',enqueue:async(_env,job)=>{jobs.push(job)}};
  return {...h,id,now,plan,rows,ports,jobs};
}
const recovery=h=>recoverVerifiedOwnerCorrection(h.env,h.id,'verified sheet values',h.ports);
const status=h=>({phase:h.sqlite.prepare('SELECT phase FROM expense_owner_correction_sync').get().phase,job:h.sqlite.prepare("SELECT status FROM sync_jobs WHERE entity_type='EXPENSE_CORRECTION'").get().status,audits:h.sqlite.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='OWNER_CORRECTION_RESUME'").get().n});

test('a twice-verified applied result resumes only read-only reconciliation, once',async()=>{
  const h=await setup();try{
    assert.equal(await recovery(h),'ENQUEUED');assert.deepEqual(status(h),{phase:'IDENTITY_VERIFIED',job:'PENDING',audits:1});assert.equal(h.jobs.length,1);
    assert.equal(await recovery(h),'NOT_REVIEW');assert.equal(h.jobs.length,1);
    const worker={now:()=>h.now,inspect:async()=>{throw Error('no new sheet mutation')},patch:async()=>{throw Error('no new sheet mutation')},inspectRebind:async()=>{throw Error('no move')},rebind:async()=>{throw Error('no move')},reconcile:async()=>({expenseId:'exp_recover',version:2,dailyMatches:true,rawMatches:true,detailsMatch:true,reportsMatch:true,duplicateCount:0,lostCount:0})};
    assert.equal(await processOwnerCorrectionJob(h.env,{expenseId:'exp_recover',version:2},worker),'COMPLETED');assert.equal(status(h).phase,'RECONCILED');
  }finally{h.close()}
});
test('a twice-verified original state resumes the same approved write once',async()=>{
  const h=await setup();try{
    h.rows.get(1)[21]='general';h.rows.get(2)[6]='general';
    assert.equal(await recovery(h),'ENQUEUED');assert.deepEqual(status(h),{phase:'PREPARED',job:'PENDING',audits:1});
    assert.equal(await recovery(h),'NOT_REVIEW');assert.equal(h.jobs.length,1);
    let writes=0;const worker={now:()=>h.now,inspect:async()=>h.ports.inspect(),patch:async(plan,arm)=>{await arm();writes++;for(const patch of plan.patches)for(const cell of patch.cells)h.rows.get(patch.metadataId)[cell.columnIndex]=cell.value},inspectRebind:async()=>{throw Error('no move')},rebind:async()=>{throw Error('no move')},reconcile:async()=>({expenseId:'exp_recover',version:2,dailyMatches:true,rawMatches:true,detailsMatch:true,reportsMatch:true,duplicateCount:0,lostCount:0})};
    assert.equal(await processOwnerCorrectionJob(h.env,{expenseId:'exp_recover',version:2},worker),'COMPLETED');assert.equal(writes,1);assert.equal(status(h).phase,'RECONCILED');
    const audit=h.sqlite.prepare("SELECT after_json FROM admin_audit WHERE action='OWNER_CORRECTION_RESUME'").get();assert.deepEqual(JSON.parse(audit.after_json),{phase:'PREPARED',mode:'VERIFIED_RETRY'});
  }finally{h.close()}
});
test('mixed, unstable or unverified observations remain in review',async()=>{
  for(const mode of ['mixed','unstable','unverified']){const h=await setup();try{
    if(mode==='mixed')h.rows.get(1)[21]='general';
    if(mode==='unstable'){const read=h.ports.inspect;let count=0;h.ports.inspect=async(...args)=>{const result=await read(...args);if(++count===2)result.rows.get(1)[3]='changed';return result}}
    if(mode==='unverified')h.ports.inspect=async()=>({identitiesVerified:false,rows:h.rows});
    assert.equal(await recovery(h),'REVIEW',mode);assert.deepEqual(status(h),{phase:'REVIEW',job:'REVIEW',audits:0});assert.equal(h.jobs.length,0);
  }finally{h.close()}}
});
test('retry requires the unchanged report and original expense snapshot',async()=>{
  for(const mode of ['missing-report','changed-report','changed-expense']){const h=await setup();try{
    h.rows.get(1)[21]='general';h.rows.get(2)[6]='general';
    if(mode==='missing-report')h.ports.report=async()=>null;
    if(mode==='changed-report')h.ports.report=async()=>({...structuredClone(h.plan.reportBaseline),total:h.plan.reportBaseline.total+1});
    if(mode==='changed-expense')h.ports.report=async()=>{h.sqlite.exec("UPDATE expense_events SET amount_satang=1 WHERE expense_id='exp_recover'");return structuredClone(h.plan.reportBaseline)};
    assert.equal(await recovery(h),mode==='changed-expense'?'NOT_REVIEW':'REVIEW',mode);assert.deepEqual(status(h),{phase:'REVIEW',job:'REVIEW',audits:0});assert.equal(h.jobs.length,0);
  }finally{h.close()}}
});
test('a possible in-flight write must finish its full uncertainty window',async()=>{
  const h=await setup();try{h.sqlite.prepare('UPDATE expense_owner_correction_sync SET not_before=?').run(new Date(h.now+1000).toISOString());assert.equal(await recovery(h),'WAIT');assert.deepEqual(status(h),{phase:'REVIEW',job:'REVIEW',audits:0});}
  finally{h.close()}
  const original=await setup();try{original.rows.get(1)[21]='general';original.rows.get(2)[6]='general';original.sqlite.prepare('UPDATE expense_owner_correction_sync SET not_before=?').run(new Date(original.now+1000).toISOString());assert.equal(await recovery(original),'WAIT');assert.deepEqual(status(original),{phase:'REVIEW',job:'REVIEW',audits:0});}finally{original.close()}
});
test('expense changes during the inspection and concurrent requests cannot resume twice',async()=>{
  {const h=await setup();try{const read=h.ports.inspect;let count=0;h.ports.inspect=async(...args)=>{const result=await read(...args);if(++count===2)h.sqlite.exec("UPDATE expense_events SET amount_satang=1 WHERE expense_id='exp_recover'");return result};assert.equal(await recovery(h),'NOT_REVIEW');assert.deepEqual(status(h),{phase:'REVIEW',job:'REVIEW',audits:0});}finally{h.close()}}
  {const h=await setup();try{assert.deepEqual((await Promise.all([recovery(h),recovery(h)])).sort(),['ENQUEUED','NOT_REVIEW']);assert.deepEqual(status(h),{phase:'IDENTITY_VERIFIED',job:'PENDING',audits:1});assert.equal(h.jobs.length,1);}finally{h.close()}}
});
test('each recovery batch failure rolls back state and audit together',async()=>{
  for(let index=0;index<5;index++){const h=await setup();try{h.DB.failAt=index;await assert.rejects(recovery(h),/fixture batch failure/);h.DB.failAt=null;assert.deepEqual(status(h),{phase:'REVIEW',job:'REVIEW',audits:0});}finally{h.close()}}
});
test('a failed queue dispatch keeps the audited outbox recoverable',async()=>{
  const h=await setup();try{h.ports.enqueue=async()=>{throw Error('synthetic queue failure')};assert.equal(await recovery(h),'ENQUEUED');assert.deepEqual(status(h),{phase:'IDENTITY_VERIFIED',job:'PENDING',audits:1});}finally{h.close()}
});
test('the recovery endpoint requires the existing admin authentication',async()=>{
  const h=await setup();try{h.env.ADMIN_TOKEN='a'.repeat(40);const request=new Request('https://example.invalid/admin/owner-correction/recover',{method:'POST',headers:{authorization:'Bearer incorrect','content-type':'application/json'},body:JSON.stringify({correctionId:h.id,reason:'verified sheet values'})});assert.equal((await handleAdmin(request,h.env,{})).status,401);assert.deepEqual(status(h),{phase:'REVIEW',job:'REVIEW',audits:0});}finally{h.close()}
});
test('the authenticated sync review queue exposes only minimal recovery metadata',async()=>{
  const h=await setup();try{
    h.env.ADMIN_TOKEN='a'.repeat(40);const queue=token=>new Request('https://example.invalid/admin/owner-correction/review-queue?kind=sync',{headers:{authorization:`Bearer ${token}`}});
    assert.equal((await handleAdmin(queue('wrong'),h.env,{})).status,401);const response=await handleAdmin(queue(h.env.ADMIN_TOKEN),h.env,{}),body=await response.json();assert.equal(response.status,200);assert.equal(body.items.length,1);assert.equal(body.items[0].correctionId,h.id);assert.equal(body.items[0].reason,'SYNC_REVIEW');assert.doesNotMatch(JSON.stringify(body),/exp_recover|fixture_staff|Synthetic driver/);
    const bad=new Request('https://example.invalid/admin/owner-correction/review-queue?cursor=invalid',{headers:{authorization:`Bearer ${h.env.ADMIN_TOKEN}`}});assert.equal((await handleAdmin(bad,h.env,{})).status,400);
  }finally{h.close()}
});
test('owner can rediscover review, retry and completion statuses after a lost LINE reply',async()=>{
  const h=await setup(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},staff={employeeId:'TEST_STAFF',lineUserId:'fixture_staff'};try{
    const show=line=>h.capture(()=>handleOwnerCorrectionText(h.env,h.event(line,{message:{type:'text',id:`synthetic_${line}`,text:'สถานะการแก้ไข'}}),'trace'));
    await show('fixture_staff');assert.match(JSON.stringify(h.messages.at(-1)),/สำหรับเจ้าของ/);assert.equal((await listOwnerCorrectionHistory(h.env,staff)).length,0);
    await show('fixture_owner');assert.match(JSON.stringify(h.messages.at(-1)),/ซิงก์รอตรวจเพิ่มเติม/);
    h.sqlite.exec("UPDATE expense_owner_correction_sync SET phase='PREPARED'; UPDATE sync_jobs SET status='PENDING' WHERE entity_type='EXPENSE_CORRECTION'");
    await show('fixture_owner');assert.match(JSON.stringify(h.messages.at(-1)),/กำลังซิงก์/);
    h.sqlite.exec("UPDATE sync_jobs SET status='FAILED' WHERE entity_type='EXPENSE_CORRECTION'");await show('fixture_owner');assert.match(JSON.stringify(h.messages.at(-1)),/ซิงก์ไม่สำเร็จ/);
    h.sqlite.exec("UPDATE expense_owner_correction_sync SET phase='RECONCILED'; UPDATE sync_jobs SET status='COMPLETED' WHERE entity_type='EXPENSE_CORRECTION'; UPDATE expense_owner_corrections SET reconciled_at='now'");
    await show('fixture_owner');assert.match(JSON.stringify(h.messages.at(-1)),/ซิงก์และตรวจแล้ว/);assert.equal((await listOwnerCorrectionHistory(h.env,owner)).length,1);
  }finally{h.close()}
});
