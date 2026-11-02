import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {createOwnerCorrectionDraft,loadOwnerExpense} from '../dist/expense/owner-correction-repository.js';
import {planCategoryMetadata} from '../dist/sheets/owner-correction-metadata.js';
import {bootstrapStableOwnerCorrectionTargets} from '../dist/sheets/owner-correction-stable-bootstrap.js';

async function setup(){
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},now=Date.now();
  h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
    VALUES('exp_stable','msg_stable','fixture_staff','Synthetic driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
  const before=await loadOwnerExpense(h.env,owner,'exp_stable'),id=await createOwnerCorrectionDraft(h.env,owner,before,'category','transport',now);
  const targets=[{sheetId:1,rowIndex:99,key:'malipang_expense_daily',value:'exp_stable'},{sheetId:2,rowIndex:8,key:'malipang_expense_raw',value:'exp_stable'}],metadata=[],sent=[];let next=1000;
  const ports={now:()=>now,newId:()=>++next,
    inspect:async()=>planCategoryMetadata(targets,metadata.map(m=>({sheetId:m.sheetId,rowIndex:m.rowIndex,key:m.metadataKey,value:m.metadataValue,metadataId:m.metadataId}))),
    byId:async(_env,key)=>metadata.find(m=>m.metadataId===key)||null,
    create:async(_env,rows)=>{sent.push(structuredClone(rows));if(rows.some(row=>metadata.some(m=>m.metadataId===row.metadataId)))throw Error('duplicate ID');for(const row of rows)metadata.push({...row});return rows.map(row=>({...row}));}};
  return {...h,owner,now,before,id,targets,metadata,sent,ports};
}
const run=h=>bootstrapStableOwnerCorrectionTargets(h.env,h.owner,h.id,h.before,h.ports);
test('historic rows receive persisted unique metadata IDs before any request',async()=>{
  const h=await setup();try{
    const create=h.ports.create;h.ports.create=async(...args)=>{assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_owner_correction_bootstrap').get().n,1);return create(...args)};
    assert.equal(await run(h),'READY');assert.equal(h.sent.length,1);assert.equal(h.metadata.length,2);assert.equal(new Set(h.metadata.map(m=>m.metadataId)).size,2);
    assert.equal(await run(h),'READY');assert.equal(h.sent.length,1);assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');
  }finally{h.close()}
});
test('lost responses before and after creation reuse the same IDs without duplicate links',async()=>{
  for(const mode of ['before','after']){const h=await setup();try{
    const create=h.ports.create;let first=true;h.ports.create=async(...args)=>{if(first){first=false;if(mode==='after')await create(...args);else h.sent.push(structuredClone(args[1]));throw Error('synthetic lost response')}return create(...args)};
    assert.equal(await run(h),mode==='after'?'READY':'PENDING');assert.equal(await run(h),'READY');assert.equal(h.metadata.length,2);assert.equal(new Set(h.metadata.map(m=>m.metadataId)).size,2);
    if(mode==='before')assert.deepEqual(h.sent[0].map(m=>m.metadataId),h.sent[1].map(m=>m.metadataId));
  }finally{h.close()}}
});
test('overlapping requests use the same IDs and can only attach one association per row',async()=>{
  const h=await setup();try{
    const create=h.ports.create;let release,dispatched;const gate=new Promise(resolve=>{release=resolve}),ready=new Promise(resolve=>{dispatched=resolve});let calls=0;
    h.ports.create=async(...args)=>{if(++calls===1){dispatched();await gate}return create(...args)};
    const first=run(h);await ready;const second=await run(h);release();const one=await first;
    assert.equal(second,'READY');assert.equal(one,'READY');assert.equal(h.metadata.length,2);assert.deepEqual(h.sent[0].map(m=>m.metadataId),h.sent[1].map(m=>m.metadataId));
  }finally{h.close()}
});
test('moved targets and unrelated ID collisions remain held for review',async()=>{
  for(const mode of ['moved','collision']){const h=await setup();try{
    h.ports.create=async()=>{throw Error('synthetic unavailable')};assert.equal(await run(h),'PENDING');
    if(mode==='moved')h.targets[0].rowIndex++;
    else h.ports.byId=async(_env,id)=>({metadataId:id,metadataKey:'unrelated',metadataValue:'unrelated',sheetId:3,rowIndex:0});
    assert.equal(await run(h),'REVIEW');assert.equal(h.metadata.length,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,0);
  }finally{h.close()}}
});
test('revoked or stale owner authority prevents any metadata request',async()=>{
  for(const mode of ['revoked','stale']){const h=await setup();try{
    if(mode==='revoked')h.sqlite.exec("UPDATE employees SET status='INACTIVE' WHERE employee_id='TEST_OWNER'");
    else h.sqlite.exec("UPDATE expense_events SET version=2 WHERE expense_id='exp_stable'");
    assert.equal(await run(h),'STALE');assert.equal(h.sent.length,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_owner_correction_bootstrap').get().n,0);
  }finally{h.close()}}
});
test('bootstrap migration is additive, repeatable and preserves existing financial records',async()=>{
  const h=await setup();try{
    h.sqlite.exec('DROP TABLE expense_owner_correction_bootstrap');const before=JSON.stringify({expenses:h.sqlite.prepare('SELECT * FROM expense_events').all(),drafts:h.sqlite.prepare('SELECT * FROM expense_owner_corrections').all()});
    const migration=readFileSync(new URL('../migrations/0023_owner_correction_bootstrap.sql',import.meta.url),'utf8');h.sqlite.exec(migration);h.sqlite.exec(migration);
    assert.equal(JSON.stringify({expenses:h.sqlite.prepare('SELECT * FROM expense_events').all(),drafts:h.sqlite.prepare('SELECT * FROM expense_owner_corrections').all()}),before);
    assert.equal(h.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{h.close()}
});
