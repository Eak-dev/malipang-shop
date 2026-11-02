import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {commitOwnerCorrection,createOwnerCorrectionDraft,loadOwnerExpense} from '../dist/expense/owner-correction-repository.js';
import {correctionAccountingPeriods,inspectOwnerCorrectionPeriods,recordOwnerCorrectionPeriodDecision} from '../dist/expense/owner-correction-periods.js';
import {handleOwnerCorrectionPostback} from '../dist/expense/owner-correction-service.js';
import {syntheticCorrectionReport} from './helpers/owner-correction-periods.mjs';

const owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},now=Date.parse('2026-10-29T10:00:00Z');
async function setup(){
  const h=ownerOrderFixture();h.env.SHEET_EXPENSE_DAILY='daily';
  h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
    VALUES('exp_period_owner','msg_period_owner','fixture_staff','Driver',200000,'kbank','CARD_KBANK','general','2026-10-28','CONFIRMED','now',1)`).run();
  const before=await loadOwnerExpense(h.env,owner,'exp_period_owner'),id=await createOwnerCorrectionDraft(h.env,owner,before,'transactionDate','2026-09-29',now);
  const headers=[[],Array(11).fill(null),Array(11).fill(null)];headers[1][10]=25;headers[2][10]='Kbank';
  const ports={headers:async()=>structuredClone(headers)};return {...h,before,id,headers,ports};
}

test('period set includes actual payment months and card posting months, not assumed open',async()=>{
  const h=await setup();try{
    const after={...h.before,transactionDate:'2026-09-29'};
    assert.deepEqual(correctionAccountingPeriods(h.before,after,h.headers),['2026-09','2026-10','2026-11']);
    const view=await inspectOwnerCorrectionPeriods(h.env,owner,h.id,now,h.ports);assert.deepEqual(view.periods.map(x=>x.decision),['UNKNOWN','UNKNOWN','UNKNOWN']);assert.match(view.headerDigest,/^[0-9a-f]{64}$/);
  }finally{h.close()}
});

test('only an active owner can attest to an affected period for the current unexpired draft',async()=>{
  const h=await setup();try{
    const view=await inspectOwnerCorrectionPeriods(h.env,owner,h.id,now,h.ports),input={period:'2026-09',headerDigest:view.headerDigest,version:1,decision:'OPEN'};
    assert.equal(await recordOwnerCorrectionPeriodDecision(h.env,{employeeId:'TEST_STAFF',lineUserId:'fixture_staff'},h.id,input,now,h.ports),'STALE');
    assert.equal(await recordOwnerCorrectionPeriodDecision(h.env,owner,h.id,{...input,period:'2026-08'},now,h.ports),'STALE');
    assert.equal(await recordOwnerCorrectionPeriodDecision(h.env,owner,h.id,input,now,h.ports),'RECORDED');
    assert.equal(await recordOwnerCorrectionPeriodDecision(h.env,owner,h.id,input,now,h.ports),'ALREADY');
    assert.equal(await recordOwnerCorrectionPeriodDecision(h.env,owner,h.id,{...input,decision:'HOLD'},now,h.ports),'RECORDED');
    assert.equal(await recordOwnerCorrectionPeriodDecision(h.env,owner,h.id,input,now,h.ports),'CONFLICT');
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_owner_correction_period_decisions').get().n,2);
    assert.equal(await inspectOwnerCorrectionPeriods(h.env,owner,h.id,now+16*60_000,h.ports),null);
  }finally{h.close()}
});

test('changed card cutoff, stale expense or revoked identity invalidates prior decisions',async()=>{
  const h=await setup();try{
    const view=await inspectOwnerCorrectionPeriods(h.env,owner,h.id,now,h.ports),input={period:'2026-09',headerDigest:view.headerDigest,version:1,decision:'OPEN'};
    assert.equal(await recordOwnerCorrectionPeriodDecision(h.env,owner,h.id,input,now,h.ports),'RECORDED');
    h.headers[1][10]=30;assert.equal(await recordOwnerCorrectionPeriodDecision(h.env,owner,h.id,{...input,period:'2026-10'},now,h.ports),'STALE');
    const changed=await inspectOwnerCorrectionPeriods(h.env,owner,h.id,now,h.ports);assert.notEqual(changed.headerDigest,view.headerDigest);assert.ok(changed.periods.every(item=>item.decision==='UNKNOWN'));
    h.sqlite.exec("UPDATE expense_events SET description='Changed concurrently'");assert.equal(await inspectOwnerCorrectionPeriods(h.env,owner,h.id,now,h.ports),null);
    h.sqlite.exec("UPDATE expense_events SET description='Driver'; UPDATE line_identity_bindings SET status='REVOKED' WHERE employee_id='TEST_OWNER'");assert.equal(await inspectOwnerCorrectionPeriods(h.env,owner,h.id,now,h.ports),null);
  }finally{h.close()}
});

test('period decision migration is additive and can be re-applied',async()=>{
  const h=await setup();try{
    const sql=readFileSync(new URL('../migrations/0022_owner_correction_period_decisions.sql',import.meta.url),'utf8');h.sqlite.exec(sql);h.sqlite.exec(sql);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_owner_correction_period_decisions').get().n,0);assert.equal(h.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{h.close()}
});

test('adding period decisions to a production-shaped database preserves existing drafts and expenses',async()=>{
  const h=await setup();try{
    h.sqlite.exec('DROP TABLE expense_owner_correction_period_decisions');
    const prior=JSON.stringify({expenses:h.sqlite.prepare('SELECT * FROM expense_events').all(),drafts:h.sqlite.prepare('SELECT * FROM expense_owner_corrections').all()});
    const sql=readFileSync(new URL('../migrations/0022_owner_correction_period_decisions.sql',import.meta.url),'utf8');h.sqlite.exec(sql);h.sqlite.exec(sql);
    assert.equal(JSON.stringify({expenses:h.sqlite.prepare('SELECT * FROM expense_events').all(),drafts:h.sqlite.prepare('SELECT * FROM expense_owner_corrections').all()}),prior);
    assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(h.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{h.close()}
});

test('LINE asks about each affected month and never treats hold as open',async()=>{
  const h=await setup();try{
    h.env.OWNER_EXPENSE_CORRECTION_ENABLED='true';
    const id=await createOwnerCorrectionDraft(h.env,owner,h.before,'transactionDate','2026-09-29');
    const services={periods:(env,actor,key)=>inspectOwnerCorrectionPeriods(env,actor,key,Date.now(),h.ports),decision:(env,actor,key,input)=>recordOwnerCorrectionPeriodDecision(env,actor,key,input,Date.now(),h.ports)};
    const post=(data,line='fixture_owner')=>h.capture(()=>handleOwnerCorrectionPostback(h.env,h.event(line,{type:'postback',postback:{data}}),'trace',services));
    await post(`a=owner_correction_confirm&id=${id}&v=1`);assert.match(JSON.stringify(h.messages.at(-1)),/ตรวจเดือนบัญชี/);
    const walk=value=>{if(!value||typeof value!=='object')return;if(value.action){assert.ok(value.action.label.length<=20);assert.ok(!value.action.data||value.action.data.length<=300);}for(const child of Object.values(value)){if(Array.isArray(child))child.forEach(walk);else if(child&&typeof child==='object')walk(child);}};walk(h.messages.at(-1));
    const view=await services.periods(h.env,owner,id),part=`id=${id}&v=1&p=2026-09&h=${view.headerDigest}`;
    await post(`a=owner_correction_period_ask&${part}`);assert.match(JSON.stringify(h.messages.at(-1)),/ยังไม่ปิดบัญชีใช่หรือไม่/);
    await post(`a=owner_correction_period_set&${part}&s=HOLD`,'fixture_staff');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_owner_correction_period_decisions').get().n,0);
    await post(`a=owner_correction_period_set&${part}&s=HOLD`);assert.match(JSON.stringify(h.messages.at(-1)),/รอตรวจเพิ่มเติม/);
    await post(`a=owner_correction_confirm&id=${id}&v=1`);assert.match(JSON.stringify(h.messages.at(-1)),/รอตรวจเพิ่มเติม/);
    assert.equal(h.sqlite.prepare('SELECT transaction_date FROM expense_events').get().transaction_date,'2026-10-28');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
  }finally{h.close()}
});

test('D1 transaction requires every actual and posting period to be explicitly open for the reviewed layout',async()=>{
  const h=await setup();try{
    const id=await createOwnerCorrectionDraft(h.env,owner,h.before,'category','transport',now),view=await inspectOwnerCorrectionPeriods(h.env,owner,id,now,h.ports);
    assert.deepEqual(view.periods.map(item=>item.period),['2026-10','2026-11']);
    const plan={expenseId:h.before.expenseId,dailyMetadataId:1,rawMetadataId:2,patches:[{metadataId:1,cells:[{columnIndex:21,value:'transport'}]},{metadataId:2,cells:[{columnIndex:6,value:'transport'}]}],originalRows:[{metadataId:1,values:Array(22).fill(null)},{metadataId:2,values:[null,null,null,null,null,null,'general']}],rebind:null,headerDigest:view.headerDigest,reportBaseline:syntheticCorrectionReport(h.before,'2026-11-28')};
    const evidence={ownerVerified:true,snapshotCurrent:true,sourcePeriod:'OPEN',destinationPeriod:'OPEN',itemCount:0,receiptAllocationVerified:false,rowIdentityVerified:true,projectionTargetsVerified:true,reportDeduplicationVerified:true,syncInProgress:false,periodHeaders:h.headers};
    const answer=(period,decision)=>recordOwnerCorrectionPeriodDecision(h.env,owner,id,{period,decision,headerDigest:view.headerDigest,version:1},now,h.ports);
    assert.equal(await commitOwnerCorrection(h.env,owner,id,evidence,'trace',now,plan),null);
    assert.equal(await answer('2026-10','OPEN'),'RECORDED');assert.equal(await commitOwnerCorrection(h.env,owner,id,evidence,'trace',now,plan),null);
    assert.equal(await answer('2026-11','OPEN'),'RECORDED');assert.equal(await answer('2026-10','HOLD'),'RECORDED');
    assert.equal(await commitOwnerCorrection(h.env,owner,id,evidence,'trace',now,plan),null,'a later hold overrides an earlier open decision');
    assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
  }finally{h.close()}
});

test('a hold recorded after preflight but before the transaction prevents all business writes',async()=>{
  const h=await setup();try{
    const id=await createOwnerCorrectionDraft(h.env,owner,h.before,'category','transport',now),view=await inspectOwnerCorrectionPeriods(h.env,owner,id,now,h.ports);
    for(const item of view.periods)assert.equal(await recordOwnerCorrectionPeriodDecision(h.env,owner,id,{period:item.period,decision:'OPEN',headerDigest:view.headerDigest,version:1},now,h.ports),'RECORDED');
    const plan={expenseId:h.before.expenseId,dailyMetadataId:1,rawMetadataId:2,patches:[{metadataId:1,cells:[{columnIndex:21,value:'transport'}]},{metadataId:2,cells:[{columnIndex:6,value:'transport'}]}],originalRows:[{metadataId:1,values:Array(22).fill(null)},{metadataId:2,values:[null,null,null,null,null,null,'general']}],rebind:null,headerDigest:view.headerDigest,reportBaseline:syntheticCorrectionReport(h.before,'2026-11-28')};
    const evidence={ownerVerified:true,snapshotCurrent:true,sourcePeriod:'OPEN',destinationPeriod:'OPEN',itemCount:0,receiptAllocationVerified:false,rowIdentityVerified:true,projectionTargetsVerified:true,reportDeduplicationVerified:true,syncInProgress:false,periodHeaders:h.headers};
    const batch=h.DB.batch.bind(h.DB);h.DB.batch=async statements=>{h.sqlite.prepare(`INSERT INTO expense_owner_correction_period_decisions(correction_id,period,header_digest,decision,actor_employee_id,created_at) VALUES(?,?,?,'HOLD',?,'2026-10-29T10:00:01.000Z')`).run(id,'2026-10',view.headerDigest,owner.employeeId);return batch(statements);};
    assert.equal(await commitOwnerCorrection(h.env,owner,id,evidence,'trace',now,plan),null);
    assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
  }finally{h.close()}
});
