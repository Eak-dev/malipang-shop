import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {processInbound} from '../dist/router/process-event.js';

async function route(h,event){
 return h.capture(()=>processInbound({kind:'LINE_EVENT',event,receivedAtIso:new Date().toISOString(),traceId:'synthetic_owner_review_router'},h.env,{}));
}
test('real inbound routing reserves owner review actions, targets date input and deduplicates redelivery',async()=>{
 const h=ownerOrderFixture();try{
  const {row}=await h.receive();
  const event=h.event('fixture_owner',{type:'postback',postback:{data:`a=order_review_input&id=${row.document_id}&v=0&field=date`}});
  await route(h,event);
  const text=h.event('fixture_owner',{message:{id:'synthetic_date_text',type:'text',text:'14/02/69'}});
  await route(h,text);
  assert.equal(JSON.parse((await h.state(row.document_id)).owner_facts_json).date.value,'2026-02-14');
  const audits=h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,messages=h.messages.length;
  await route(h,text);assert.equal(h.messages.length,messages);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,audits);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_events').get().n,0);
  assert.deepEqual(h.sqlite.prepare('SELECT DISTINCT route,status FROM inbound_events').all().map(x=>({...x})),[{route:'EXPENSE_OWNER_REVIEW',status:'COMPLETED'}]);
 }finally{h.close();}
});
test('unknown prefixed actions and unauthorized list commands never fall through to ordinary expense creation',async()=>{
 const h=ownerOrderFixture();try{
  await route(h,h.event('fixture_owner',{type:'postback',postback:{data:'a=order_review_forged&amount=519'}}));
  assert.match(JSON.stringify(h.messages.at(-1)),/เมนูนี้ใช้ไม่ได้/);
  await route(h,h.event('fixture_staff',{message:{id:'synthetic_staff_list',type:'text',text:'รายการค้าง'}}));
  assert.match(JSON.stringify(h.messages.at(-1)),/สำหรับเจ้าของ/);
  await route(h,h.event('fixture_owner',{source:{type:'group',groupId:'synthetic_group',userId:'fixture_owner'},message:{id:'synthetic_group_list',type:'text',text:'รายการค้าง'}}));
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_events').get().n,0);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_document_reviews').get().n,0);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM inbound_events WHERE route='UNSUPPORTED_CHAT' AND status='IGNORED'").get().n,1);
 }finally{h.close();}
});
