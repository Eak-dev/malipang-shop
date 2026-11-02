import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {grantSyntheticOpenPeriods,syntheticCorrectionHeaders,syntheticCorrectionHeaderDigest,syntheticCorrectionReport} from './helpers/owner-correction-periods.mjs';
import {commitOwnerCorrection,createOwnerCorrectionDraft,loadOwnerExpense,ownerCorrectionStatus} from '../dist/expense/owner-correction-repository.js';
import {inspectOwnerCorrectionPeriods} from '../dist/expense/owner-correction-periods.js';
import {confirmOwnerCorrection} from '../dist/expense/owner-correction-confirmed.js';
import {handleOwnerCorrectionPostback} from '../dist/expense/owner-correction-service.js';
import {bootstrapStableOwnerCorrectionTargets} from '../dist/sheets/owner-correction-stable-bootstrap.js';
import {planCategoryMetadata} from '../dist/sheets/owner-correction-metadata.js';
import {inspectOwnerCorrectionTargets} from '../dist/sheets/owner-correction-inspection.js';
import {reconcileOwnerCorrection} from '../dist/sheets/owner-correction-reconciliation.js';
import {processOwnerCorrectionJob} from '../dist/sheets/owner-correction-worker.js';

const owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'};
async function setup(){
  const h=ownerOrderFixture();Object.assign(h.env,{OWNER_EXPENSE_CORRECTION_ENABLED:'true',SHEET_EXPENSE_DAILY:'daily'});
  h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
    VALUES('exp_confirmed_owner','msg_confirmed_owner','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
  const before=await loadOwnerExpense(h.env,owner,'exp_confirmed_owner'),id=await createOwnerCorrectionDraft(h.env,owner,before,'category','transport');await grantSyntheticOpenPeriods(h,id);
  const plan={expenseId:before.expenseId,dailyMetadataId:1,rawMetadataId:2,patches:[{metadataId:1,cells:[{columnIndex:21,value:'transport'}]},{metadataId:2,cells:[{columnIndex:6,value:'transport'}]}],originalRows:[{metadataId:1,values:Array(22).fill(null)},{metadataId:2,values:[null,null,null,null,null,null,'general']}],rebind:null,headerDigest:syntheticCorrectionHeaderDigest,reportBaseline:syntheticCorrectionReport(before)};
  const enqueued=[],headerPorts={headers:async()=>syntheticCorrectionHeaders()};
  const ports={periods:(env,actor,key)=>inspectOwnerCorrectionPeriods(env,actor,key,Date.now(),headerPorts),headers:async()=>syntheticCorrectionHeaders(),protection:async()=>true,dedupe:async()=>true,posting:async()=>({items:[]}),bootstrap:async()=>'READY',plan:async()=>plan,commit:commitOwnerCorrection,enqueue:async(_env,job)=>{enqueued.push(job)},status:ownerCorrectionStatus};
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
  for(const [mode,want] of [['period','PERIOD_REVIEW'],['protection','PROTECTION'],['duplicate','DUPLICATE'],['allocation','ALLOCATION'],['metadataPending','METADATA_PENDING'],['metadataReview','SHEET_REVIEW'],['plan','SHEET_REVIEW'],['flag','UNSUPPORTED']]){
    const h=await setup();try{
      if(mode==='period')h.sqlite.exec('DELETE FROM expense_owner_correction_period_decisions');
      if(mode==='protection')h.ports.protection=async()=>false;
      if(mode==='duplicate')h.ports.dedupe=async()=>false;
      if(mode==='allocation')h.ports.posting=async()=>({items:[{},{}]});
      if(mode==='metadataPending')h.ports.bootstrap=async()=>'PENDING';
      if(mode==='metadataReview')h.ports.bootstrap=async()=>'REVIEW';
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

test('historic identity recovery, owner confirmation and queue reconciliation work together',async()=>{
  const h=await setup();try{
    Object.assign(h.env,{SHEET_EXPENSE_RAW:'raw',SHEET_PURCHASE_DETAILS:'detail'});
    const daily=Array(23).fill(null);Object.assign(daily,{1:10,2:28,3:'Driver',7:2000,21:'general',22:'บัญชีร้าน'});
    const raw=['exp_confirmed_owner','2026-10-28','Driver',2000,'transfer','SHOP_BANK','general','CONFIRMED'];
    h.plan.originalRows=[{metadataId:1,values:daily},{metadataId:2,values:raw}];
    const targets=[{sheetId:1,rowIndex:10,key:'malipang_expense_daily',value:h.before.expenseId},{sheetId:2,rowIndex:1,key:'malipang_expense_raw',value:h.before.expenseId}],metadata=[];let next=0,fail=true;
    const bootstrap={now:()=>Date.now(),newId:()=>++next,inspect:async()=>planCategoryMetadata(targets,metadata.map(m=>({sheetId:m.sheetId,rowIndex:m.rowIndex,key:m.metadataKey,value:m.metadataValue,metadataId:m.metadataId}))),byId:async(_env,id)=>metadata.find(m=>m.metadataId===id)||null,
      create:async(_env,rows)=>{if(fail){fail=false;throw Error('synthetic timeout')}metadata.push(...rows.map(row=>({...row})));return rows}};
    h.ports.bootstrap=(env,actor,id,before)=>bootstrapStableOwnerCorrectionTargets(env,actor,id,before,bootstrap);
    assert.equal(await confirmOwnerCorrection(h.env,owner,h.id,1,'trace',h.ports),'METADATA_PENDING');assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');assert.equal(h.enqueued.length,0);
    assert.equal(await confirmOwnerCorrection(h.env,owner,h.id,1,'trace',h.ports),'APPLIED');assert.equal(h.enqueued.length,1);assert.equal(metadata.length,2);
    const rows=new Map(h.plan.originalRows.map(row=>[row.metadataId,[...row.values]]));
    const inspectPorts={sheetId:async(_env,name)=>({daily:1,raw:2,detail:3})[name],metadata:async(_env,key)=>metadata.filter(m=>m.metadataKey===key),rows:async()=>new Map([...rows].map(([id,values])=>[id,[...values]])),headers:async()=>syntheticCorrectionHeaders(),protection:async()=>true};
    const after={...h.before,category:'transport'},report=structuredClone(h.plan.reportBaseline);report.category='transport';report.categories[10]=0;report.categories[7]=2000;
    const recPorts={saved:async()=>({before:h.before,after}),posting:async()=>({expense:h.sqlite.prepare("SELECT * FROM expense_events WHERE expense_id='exp_confirmed_owner'").get()}),projection:async()=>true,placement:async()=>true,report:async()=>report,protection:async()=>true};
    const worker={now:()=>Date.now(),inspect:plan=>inspectOwnerCorrectionTargets(h.env,plan,inspectPorts),patch:async(plan,beforeDispatch)=>{await beforeDispatch();for(const patch of plan.patches)for(const cell of patch.cells)rows.get(patch.metadataId)[cell.columnIndex]=cell.value},inspectRebind:async()=>{throw Error('unexpected move')},rebind:async()=>{throw Error('unexpected move')},reconcile:(plan,job)=>reconcileOwnerCorrection(h.env,plan,job,recPorts)};
    assert.equal(await processOwnerCorrectionJob(h.env,{expenseId:h.before.expenseId,version:2},worker),'COMPLETED');assert.equal(await ownerCorrectionStatus(h.env,owner,h.id),'COMPLETED');
    assert.equal(rows.get(1)[21],'transport');assert.equal(rows.get(2)[6],'transport');assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM expense_audit_log WHERE action='EDIT'").get().n,1);
  }finally{h.close()}
});
