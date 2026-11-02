import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {grantSyntheticOpenPeriods,syntheticCorrectionHeaders,syntheticCorrectionHeaderDigest,syntheticCorrectionReport} from './helpers/owner-correction-periods.mjs';
import {commitOwnerCorrection,createOwnerCorrectionDraft,loadOwnerExpense,ownerCorrectionStatus} from '../dist/expense/owner-correction-repository.js';
import {inspectOwnerCorrectionPeriods} from '../dist/expense/owner-correction-periods.js';
import {confirmOwnerCorrection} from '../dist/expense/owner-correction-confirmed.js';
import {handleOwnerCorrectionPostback} from '../dist/expense/owner-correction-service.js';

const owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'};
async function setup(){
  const h=ownerOrderFixture();Object.assign(h.env,{OWNER_EXPENSE_CORRECTION_ENABLED:'true',SHEET_EXPENSE_DAILY:'daily'});
  h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
    VALUES('exp_confirmed_owner','msg_confirmed_owner','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
  const before=await loadOwnerExpense(h.env,owner,'exp_confirmed_owner'),id=await createOwnerCorrectionDraft(h.env,owner,before,'category','transport');await grantSyntheticOpenPeriods(h,id);
  const plan={expenseId:before.expenseId,dailyMetadataId:1,rawMetadataId:2,patches:[{metadataId:1,cells:[{columnIndex:21,value:'transport'}]},{metadataId:2,cells:[{columnIndex:6,value:'transport'}]}],originalRows:[{metadataId:1,values:Array(22).fill(null)},{metadataId:2,values:[null,null,null,null,null,null,'general']}],rebind:null,headerDigest:syntheticCorrectionHeaderDigest,reportBaseline:syntheticCorrectionReport(before)};
  const enqueued=[],headerPorts={headers:async()=>syntheticCorrectionHeaders()};
  const ports={periods:(env,actor,key)=>inspectOwnerCorrectionPeriods(env,actor,key,Date.now(),headerPorts),headers:async()=>syntheticCorrectionHeaders(),protection:async()=>true,dedupe:async()=>true,posting:async()=>({items:[]}),plan:async()=>plan,commit:commitOwnerCorrection,enqueue:async(_env,job)=>{enqueued.push(job)},status:ownerCorrectionStatus};
  return {...h,before,id,plan,ports,enqueued};
}
test('confirmed correction checks gates, atomically saves and queues exactly once',async()=>{
  const h=await setup();try{
    assert.equal(await confirmOwnerCorrection(h.env,owner,h.id,1,'trace',h.ports),'APPLIED');
    assert.equal(await confirmOwnerCorrection(h.env,owner,h.id,1,'trace',h.ports),'APPLIED');
    assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'transport');assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM sync_jobs WHERE entity_type='EXPENSE_CORRECTION'").get().n,1);
    assert.equal(h.enqueued.length,1);assert.equal(h.enqueued[0].entityVersion,2);assert.equal(await ownerCorrectionStatus(h.env,owner,h.id),'SYNC_PENDING');
  }finally{h.close()}
});
test('concurrent confirmations cannot create duplicate transactions or queue jobs',async()=>{
  const h=await setup();try{
    const results=await Promise.all([confirmOwnerCorrection(h.env,owner,h.id,1,'trace',h.ports),confirmOwnerCorrection(h.env,owner,h.id,1,'trace',h.ports)]);
    assert.deepEqual(results,['APPLIED','APPLIED']);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,1);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,1);assert.equal(h.enqueued.length,1);
  }finally{h.close()}
});
test('failed enqueue preserves the committed outbox for scheduled recovery',async()=>{
  const h=await setup();try{
    h.ports.enqueue=async()=>{throw Error('queue unavailable')};assert.equal(await confirmOwnerCorrection(h.env,owner,h.id,1,'trace',h.ports),'APPLIED');
    assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE entity_type='EXPENSE_CORRECTION'").get().status,'PENDING');assert.equal(await ownerCorrectionStatus(h.env,owner,h.id),'SYNC_PENDING');
  }finally{h.close()}
});
test('each missing safety condition keeps the confirmed expense unchanged',async()=>{
  for(const [mode,want] of [['period','PERIOD_REVIEW'],['protection','PROTECTION'],['duplicate','DUPLICATE'],['allocation','ALLOCATION'],['plan','SHEET_REVIEW'],['flag','UNSUPPORTED']]){
    const h=await setup();try{
      if(mode==='period')h.sqlite.exec('DELETE FROM expense_owner_correction_period_decisions');
      if(mode==='protection')h.ports.protection=async()=>false;
      if(mode==='duplicate')h.ports.dedupe=async()=>false;
      if(mode==='allocation')h.ports.posting=async()=>({items:[{},{}]});
      if(mode==='plan')h.ports.plan=async()=>null;
      if(mode==='flag')h.env.SHEETS_SYNC_ENABLED='false';
      assert.equal(await confirmOwnerCorrection(h.env,owner,h.id,1,'trace',h.ports),want,mode);assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
    }finally{h.close()}
  }
});
test('a newer expense snapshot or a hold during preparation prevents commit',async()=>{
  for(const mode of ['stale','hold']){const h=await setup();try{
    if(mode==='stale')h.ports.plan=async()=>{h.sqlite.exec("UPDATE expense_events SET description='changed concurrently'");return h.plan};
    else{const read=h.ports.periods;let calls=0;h.ports.periods=async(...args)=>{const result=await read(...args);if(++calls===2)result.periods[0].decision='HOLD';return result};}
    const result=await confirmOwnerCorrection(h.env,owner,h.id,1,'trace',h.ports);assert.equal(result,mode==='hold'?'PERIOD_REVIEW':'STALE');assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
  }finally{h.close()}}
});
test('LINE displays the final old/new comparison and only the final owner action starts the durable job',async()=>{
  const h=await setup();try{
    const services={periods:h.ports.periods,decision:async()=>{throw Error('not needed')},confirmed:(env,actor,id,version,trace)=>confirmOwnerCorrection(env,actor,id,version,trace,h.ports)};
    const post=data=>h.capture(()=>handleOwnerCorrectionPostback(h.env,h.event('fixture_owner',{type:'postback',postback:{data}}),'trace',services));
    await post(`a=owner_correction_confirm&id=${h.id}&v=1`);assert.match(JSON.stringify(h.messages.at(-1)),/ยืนยันบันทึก/);assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');
    await post(`a=owner_correction_execute&id=${h.id}&v=1`);assert.match(JSON.stringify(h.messages.at(-1)),/กำลังซิงก์/);assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'transport');
    await post(`a=owner_correction_execute&id=${h.id}&v=1`);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,1);assert.equal(h.enqueued.length,1);
  }finally{h.close()}
});
