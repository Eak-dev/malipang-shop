import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {handleOwnerCorrectionPostback,handleOwnerCorrectionText} from '../dist/expense/owner-correction-service.js';
import {processInbound} from '../dist/router/process-event.js';

test('owner can search a staff expense and preview a correction; confirm stays fail-closed until sync is implemented',async()=>{
  const h=ownerOrderFixture();try{
    h.env.OWNER_EXPENSE_CORRECTION_ENABLED='true';
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_service','msg_service','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
    const send=async text=>h.capture(()=>handleOwnerCorrectionText(h.env,h.event('fixture_owner',{message:{type:'text',id:'text_fixture',text}}),'trace'));
    const post=async(data,line='fixture_owner')=>h.capture(()=>handleOwnerCorrectionPostback(h.env,h.event(line,{type:'postback',postback:{data}}),'trace'));
    assert.equal(await send('แก้ไขค่าใช้จ่าย'),true);assert.equal(await send('Driver'),true);
    assert.match(JSON.stringify(h.messages.at(-1)),/exp_service/);
    await post('a=owner_correction_open&id=exp_service');assert.match(JSON.stringify(h.messages.at(-1)),/แก้หมวด/);
    await post('a=owner_correction_set_category&id=exp_service&v=1&category=transport');
    const draft=h.sqlite.prepare('SELECT correction_id,status FROM expense_owner_corrections').get();assert.equal(draft.status,'DRAFT');
    await post(`a=owner_correction_status&id=${draft.correction_id}`);assert.match(JSON.stringify(h.messages.at(-1)),/ยังไม่ได้ยืนยัน/);
    await post(`a=owner_correction_confirm&id=${draft.correction_id}&v=1`);
    assert.match(JSON.stringify(h.messages.at(-1)),/ตรวจสถานะเดือนบัญชีไม่ได้/);
    assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');
    await post(`a=owner_correction_cancel&id=${draft.correction_id}&v=1`,'fixture_staff');
    assert.equal(h.sqlite.prepare('SELECT status FROM expense_owner_corrections').get().status,'DRAFT');
  }finally{h.close()}
});

test('the real inbound router sends an owner command to the correction flow exactly once',async()=>{
  const h=ownerOrderFixture();try{
    h.env.OWNER_EXPENSE_CORRECTION_ENABLED='true';
    const event=h.event('fixture_owner',{message:{type:'text',id:'synthetic_correction_router',text:'แก้ไขค่าใช้จ่าย'}});
    const job={kind:'LINE_EVENT',event,receivedAtIso:'2026-10-28T10:00:00.000Z',traceId:'synthetic_owner_correction_router'};
    await h.capture(()=>processInbound(job,h.env,{}));await h.capture(()=>processInbound(job,h.env,{}));
    assert.equal(h.messages.length,1);assert.match(JSON.stringify(h.messages[0]),/พิมพ์ชื่อร้าน/);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_owner_correction_inputs').get().n,1);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_events').get().n,0);
  }finally{h.close()}
});

test('the explicit correction command replaces an open order input, and the order input can take control back',async()=>{
  const h=ownerOrderFixture();try{
    h.env.OWNER_EXPENSE_CORRECTION_ENABLED='true';const held=await h.receive();
    await h.post('order_review_input',held.row.document_id,0,{field:'date'});
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_document_review_inputs').get().n,1);
    const event=h.event('fixture_owner',{message:{type:'text',id:'switch_correction',text:'แก้ไขค่าใช้จ่าย'}});
    await h.capture(()=>processInbound({kind:'LINE_EVENT',event,receivedAtIso:new Date().toISOString(),traceId:'switch_correction'},h.env,{}));
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_document_review_inputs').get().n,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_owner_correction_inputs').get().n,1);
    await h.post('order_review_input',held.row.document_id,0,{field:'date'});
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_owner_correction_inputs').get().n,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_document_review_inputs').get().n,1);
  }finally{h.close()}
});

test('opening a result closes the search input so later messages are not captured',async()=>{
  const h=ownerOrderFixture();try{
    h.env.OWNER_EXPENSE_CORRECTION_ENABLED='true';h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_find_owner','msg_find_owner','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','WAITING_CONFIRM','now',1)`).run();
    await h.capture(()=>handleOwnerCorrectionText(h.env,h.event('fixture_owner',{message:{type:'text',id:'search',text:'แก้ไขค่าใช้จ่าย'}}),'trace'));
    await h.capture(()=>handleOwnerCorrectionText(h.env,h.event('fixture_owner',{message:{type:'text',id:'query',text:'Driver'}}),'trace'));
    await h.capture(()=>handleOwnerCorrectionPostback(h.env,h.event('fixture_owner',{type:'postback',postback:{data:'a=owner_correction_open&id=exp_find_owner'}}),'trace'));
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_owner_correction_inputs').get().n,0);
    assert.equal(await h.capture(()=>handleOwnerCorrectionText(h.env,h.event('fixture_owner',{message:{type:'text',id:'later',text:'ค่าขนส่ง'}}),'trace')),false);
  }finally{h.close()}
});
test('disabled feature does not intercept messages or postbacks',async()=>{
  const h=ownerOrderFixture();try{
    assert.equal(await handleOwnerCorrectionText(h.env,h.event('fixture_owner',{message:{type:'text',text:'แก้ไขค่าใช้จ่าย'}}),'trace'),false);
    assert.equal(await handleOwnerCorrectionPostback(h.env,h.event('fixture_owner',{type:'postback',postback:{data:'a=owner_correction_open&id=exp_x'}}),'trace'),false);
  }finally{h.close()}
});

test('typed amount and date create the right draft and repeated input does not change the expense',async()=>{
  const h=ownerOrderFixture();try{
    h.env.OWNER_EXPENSE_CORRECTION_ENABLED='true';
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_input_flow','msg_input_flow','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
    const post=data=>h.capture(()=>handleOwnerCorrectionPostback(h.env,h.event('fixture_owner',{type:'postback',postback:{data}}),'trace'));
    const send=text=>h.capture(()=>handleOwnerCorrectionText(h.env,h.event('fixture_owner',{message:{type:'text',id:'message_fixture',text}}),'trace'));
    await post('a=owner_correction_input&id=exp_input_flow&v=1&field=amountSatang');await send('2,100.50');
    let row=h.sqlite.prepare('SELECT field,before_json,after_json FROM expense_owner_corrections').get();assert.equal(row.field,'amountSatang');assert.equal(JSON.parse(row.after_json).amountSatang,210050);
    assert.equal(await send('2,100.50'),false);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_owner_corrections').get().n,1);
    await post('a=owner_correction_input&id=exp_input_flow&v=1&field=transactionDate');await send('31/08/2569');
    row=h.sqlite.prepare("SELECT field,after_json FROM expense_owner_corrections WHERE field='transactionDate'").get();assert.equal(JSON.parse(row.after_json).transactionDate,'2026-08-31');
    assert.equal(h.sqlite.prepare('SELECT amount_satang FROM expense_events').get().amount_satang,200000);
  }finally{h.close()}
});

test('description and payment selections preview the intended values without editing the expense',async()=>{
  const h=ownerOrderFixture();try{
    h.env.OWNER_EXPENSE_CORRECTION_ENABLED='true';
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_payment_flow','msg_payment_flow','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
    const post=data=>h.capture(()=>handleOwnerCorrectionPostback(h.env,h.event('fixture_owner',{type:'postback',postback:{data}}),'trace'));
    const send=text=>h.capture(()=>handleOwnerCorrectionText(h.env,h.event('fixture_owner',{message:{type:'text',id:'message_fixture',text}}),'trace'));
    await post('a=owner_correction_set_payment&id=exp_payment_flow&v=1&payment=kbank&wallet=CARD_KBANK');
    let row=h.sqlite.prepare("SELECT after_json FROM expense_owner_corrections WHERE field='payment'").get();assert.equal(JSON.parse(row.after_json).paymentKey,'kbank');assert.equal(JSON.parse(row.after_json).sourceWallet,'CARD_KBANK');
    await post('a=owner_correction_input&id=exp_payment_flow&v=1&field=description');await send('ค่าขนส่ง');
    row=h.sqlite.prepare("SELECT after_json FROM expense_owner_corrections WHERE field='description'").get();assert.equal(JSON.parse(row.after_json).description,'ค่าขนส่ง');
    const expense=h.sqlite.prepare('SELECT payment_key,description FROM expense_events').get();assert.equal(expense.payment_key,'transfer');assert.equal(expense.description,'Driver');
  }finally{h.close()}
});
