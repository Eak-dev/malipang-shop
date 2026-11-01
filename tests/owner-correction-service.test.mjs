import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {handleOwnerCorrectionPostback,handleOwnerCorrectionText} from '../dist/expense/owner-correction-service.js';

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
    await post(`a=owner_correction_confirm&id=${draft.correction_id}&v=1`);
    assert.match(JSON.stringify(h.messages.at(-1)),/ยังบันทึกการแก้ไขไม่ได้/);
    assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');
    await post(`a=owner_correction_cancel&id=${draft.correction_id}&v=1`,'fixture_staff');
    assert.equal(h.sqlite.prepare('SELECT status FROM expense_owner_corrections').get().status,'DRAFT');
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
