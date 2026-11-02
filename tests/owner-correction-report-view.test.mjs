import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {createOwnerCorrectionDraft,loadOwnerExpense} from '../dist/expense/owner-correction-repository.js';
import {ensureOwnerCorrectionReportView,inspectOwnerCorrectionReportView} from '../dist/sheets/owner-correction-report-view.js';
import {cleanupOwnerCorrectionReportViews} from '../dist/sheets/owner-correction-report-view-cleanup.js';
import {holdOwnerCorrectionForReview} from '../dist/expense/owner-correction-manual-review.js';

async function setup(){
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},clock={now:Date.now()};h.env.GOOGLE_SERVICE_ACCOUNT_EMAIL='synthetic@example.invalid';
  h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
    VALUES('exp_view','msg_view','fixture_staff','Synthetic driver',200000,'transfer','SHOP_BANK','general','2026-08-15','CONFIRMED','now',1)`).run();
  const before=await loadOwnerExpense(h.env,owner,'exp_view'),id=await createOwnerCorrectionDraft(h.env,owner,before,'category','transport',clock.now);h.sqlite.prepare('UPDATE expense_owner_corrections SET expires_at=? WHERE correction_id=?').run(new Date(clock.now+60*60_000).toISOString(),id);
  const properties=[{sheetId:5,title:'04_OWNER_MONTH_CLOSE',hidden:false}],tags=[],protectedRanges=[],sent=[];let next=100;
  const ports={now:()=>clock.now,newId:()=>++next,properties:async()=>properties.map(x=>({...x})),metadata:async(_env,key)=>tags.find(tag=>tag.metadataId===key)||null,ranges:async(_env,title)=>({sheetId:properties.find(item=>item.title===title)?.sheetId,ranges:structuredClone(protectedRanges)}),
    batch:async(_env,requests,arm)=>{await arm();sent.push(structuredClone(requests));if(requests[0].deleteSheet){const sid=requests[0].deleteSheet.sheetId,index=properties.findIndex(item=>item.sheetId===sid);if(index<0)throw Error('missing view');properties.splice(index,1);for(let i=tags.length-1;i>=0;i--)if(tags[i].sheetId===sid)tags.splice(i,1);protectedRanges.length=0;return}const sheet=requests[0].duplicateSheet,tag=requests[3].createDeveloperMetadata.developerMetadata,protect=requests[4].addProtectedRange.protectedRange;properties.push({sheetId:sheet.newSheetId,title:sheet.newSheetName,hidden:true});tags.push({metadataId:tag.metadataId,metadataKey:tag.metadataKey,metadataValue:tag.metadataValue,sheetId:sheet.newSheetId});protectedRanges.push({...protect,requestingUserCanEdit:true});}};
  return {...h,owner,clock,before,id,properties,tags,protectedRanges,sent,ports};
}
const run=h=>ensureOwnerCorrectionReportView(h.env,h.owner,h.id,h.before,'2026-08',h.ports);
test('month view is created hidden and protected without changing the visible report',async()=>{
  const h=await setup();try{
    const batch=h.ports.batch;h.ports.batch=async(_env,requests,arm)=>batch(_env,requests,async()=>{await arm();assert.equal(h.sqlite.prepare('SELECT state FROM expense_owner_correction_report_views').get().state,'IN_FLIGHT')});
    const result=await run(h);assert.equal(result.kind,'READY');assert.equal(await inspectOwnerCorrectionReportView(h.env,h.id,result.view,h.ports),'VERIFIED');assert.equal((await run(h)).kind,'READY');assert.equal(h.sent.length,1);
    assert.equal(h.sent[0][0].duplicateSheet.sourceSheetId,5);assert.equal(h.sent[0][2].updateCells.rows[0].values[0].userEnteredValue.formulaValue,'=DATE(2026,8,1)');assert.equal(h.properties[0].hidden,false);
  }finally{h.close()}
});
test('uncertain creates wait before rechecking and never create duplicate report views',async()=>{
  for(const applied of [false,true]){const h=await setup();try{
    const batch=h.ports.batch;let first=true;h.ports.batch=async(_env,requests,arm)=>{if(first){first=false;if(applied)await batch(_env,requests,arm);else{await arm();h.sent.push(structuredClone(requests))}throw Error('synthetic timeout')}return batch(_env,requests,arm)};
    assert.equal((await run(h)).kind,'PENDING');assert.equal((await run(h)).kind,'PENDING');h.clock.now+=15*60_000+1;assert.equal((await run(h)).kind,'READY');assert.equal(h.properties.length,2);assert.equal(h.sent.length,applied?1:2);
  }finally{h.close()}}
});
test('conflicting IDs, modified visibility or protection are held for review',async()=>{
  {const h=await setup();try{h.properties.push({sheetId:101,title:'unrelated',hidden:false});assert.equal((await run(h)).kind,'REVIEW');assert.equal(h.sent.length,0)}finally{h.close()}}
  for(const mode of ['hidden','editor','tag']){const h=await setup();try{assert.equal((await run(h)).kind,'READY');if(mode==='hidden')h.properties[1].hidden=false;if(mode==='editor')h.protectedRanges[0].editors.users.push('other@example.invalid');if(mode==='tag')h.tags[0].metadataValue='changed';assert.equal((await run(h)).kind,'REVIEW')}finally{h.close()}}
});
test('concurrent requests create at most one view',async()=>{
  const h=await setup();try{const batch=h.ports.batch;let release,armed;const gate=new Promise(resolve=>{release=resolve}),ready=new Promise(resolve=>{armed=resolve});h.ports.batch=async(_env,requests,arm)=>batch(_env,requests,async()=>{await arm();armed();await gate});const first=run(h);await ready;assert.equal((await run(h)).kind,'PENDING');release();assert.equal((await first).kind,'READY');assert.equal(h.sent.length,1)}finally{h.close()}
});
test('report-view migration is additive and preserves existing expenses',async()=>{
  const h=await setup();try{h.sqlite.exec('DROP TABLE expense_owner_correction_report_views');const old=JSON.stringify(h.sqlite.prepare('SELECT * FROM expense_events').all()),sql=readFileSync(new URL('../migrations/0025_owner_correction_report_views.sql',import.meta.url),'utf8');h.sqlite.exec(sql);h.sqlite.exec(sql);assert.equal(JSON.stringify(h.sqlite.prepare('SELECT * FROM expense_events').all()),old);assert.equal(h.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[])}finally{h.close()}
});
test('finished or cancelled report views are cleaned up without touching the visible report',async()=>{
  for(const mode of ['cancelled','completed','rollback']){const h=await setup();try{
    assert.equal((await run(h)).kind,'READY');assert.deepEqual(await cleanupOwnerCorrectionReportViews(h.env,h.ports),{removed:0,review:0});
    if(mode==='cancelled')h.sqlite.prepare("UPDATE expense_owner_corrections SET status='CANCELLED' WHERE correction_id=?").run(h.id);else h.sqlite.prepare("UPDATE expense_owner_corrections SET status='APPLIED',reconciled_at='now' WHERE correction_id=?").run(h.id);
    if(mode==='rollback')h.env.OWNER_EXPENSE_CORRECTION_ENABLED='false';
    assert.deepEqual(await cleanupOwnerCorrectionReportViews(h.env,h.ports),{removed:1,review:0});assert.deepEqual(h.properties,[{sheetId:5,title:'04_OWNER_MONTH_CLOSE',hidden:false}]);assert.equal(h.tags.length,0);
  }finally{h.close()}}
});
test('cleanup never deletes an altered report view and recovers an unknown delete',async()=>{
  {const h=await setup();try{assert.equal((await run(h)).kind,'READY');h.sqlite.prepare("UPDATE expense_owner_corrections SET status='CANCELLED' WHERE correction_id=?").run(h.id);h.properties[1].title='changed';assert.deepEqual(await cleanupOwnerCorrectionReportViews(h.env,h.ports),{removed:0,review:1});assert.equal(h.properties.length,2)}finally{h.close()}}
  {const h=await setup();try{assert.equal((await run(h)).kind,'READY');h.sqlite.prepare("UPDATE expense_owner_corrections SET status='CANCELLED' WHERE correction_id=?").run(h.id);const batch=h.ports.batch;let first=true;h.ports.batch=async(...args)=>{await batch(...args);if(first){first=false;throw Error('synthetic lost response')}};assert.deepEqual(await cleanupOwnerCorrectionReportViews(h.env,h.ports),{removed:0,review:1});assert.equal(h.properties.length,1);assert.deepEqual(await cleanupOwnerCorrectionReportViews(h.env,h.ports),{removed:0,review:0});h.clock.now+=15*60_000+1;assert.deepEqual(await cleanupOwnerCorrectionReportViews(h.env,h.ports),{removed:1,review:0});assert.equal(h.sent.length,2)}finally{h.close()}}
});
test('a request held for review releases its temporary report view',async()=>{
  const h=await setup();try{assert.equal((await run(h)).kind,'READY');assert.equal(await holdOwnerCorrectionForReview(h.env,h.owner,h.id,'SHEET_CHECK',h.clock.now),'HELD');assert.deepEqual(await cleanupOwnerCorrectionReportViews(h.env,h.ports),{removed:1,review:0});assert.equal(h.properties.length,1)}finally{h.close()}
});
