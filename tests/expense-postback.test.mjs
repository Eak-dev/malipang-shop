import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {handleExpensePostback,handleExpenseText} from '../dist/expense/service.js';
import {expensePaymentOptions} from '../dist/expense/document.js';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';

function harness(status='WAITING_CONFIRM',overrides={}){
  const {document,...rowOverrides}=overrides;
  const h=expenseSqlite();after(()=>h.close());
  const row={expense_id:'exp_1',message_id:'msg_1',line_user_id:'U_TEST',description:'ค่าไฟ',amount_satang:12000,payment_key:'transfer',source_wallet:'SHOP_BANK',category:'utilities',transaction_date:'2026-07-22',status,trace_id:'fixture_trace',created_at:'2026-01-01T00:00:00.000Z',...rowOverrides};
  const insert=(table,value)=>h.sqlite.prepare(`INSERT INTO ${table}(${Object.keys(value).join(',')}) VALUES(${Object.keys(value).map(()=>'?').join(',')})`).run(...Object.values(value));
  insert('expense_events',row);
  if(document)insert('expense_documents',{document_id:'doc_1',message_id:'doc_msg',line_user_id:'U_TEST',document_type:'RECEIPT',expense_id:'exp_1',status,created_at:row.created_at,...document});
  const state={batches:h.DB.batches,queue:h.queue,
    get row(){return{...h.sqlite.prepare("SELECT * FROM expense_events WHERE expense_id='exp_1'").get()};},
    get document(){return h.sqlite.prepare("SELECT * FROM expense_documents WHERE expense_id='exp_1'").get()??null;},
    get pending(){return h.sqlite.prepare("SELECT * FROM expense_pending_edits WHERE line_user_id='U_TEST'").get()??null;}
  };
  const env=h.env;
  const actor={canSubmitExpense:true};
  const event=(data,params)=>({source:{type:'user',userId:'U_TEST'},postback:{data,params}});
  return{state,env,actor,event};
}

test('payment selection updates the draft and matching wallet',async()=>{
  const h=harness('WAITING_CONFIRM',{payment_key:'unconfirmed',source_wallet:'UNCONFIRMED',category:'not-a-category'});await handleExpensePostback(h.env,h.event('a=expense_set_payment&id=exp_1&payment=firstchoice'),h.actor);
  assert.equal(h.state.row.payment_key,'firstchoice');assert.equal(h.state.row.source_wallet,'CARD_FIRST_CHOICE');assert.equal(h.state.queue.length,0);
});

test('explicit cash payment from shop bank persists both fields without claiming a transfer',async()=>{
  const h=harness('WAITING_CONFIRM',{payment_key:'unconfirmed',source_wallet:'UNCONFIRMED',category:'not-a-category'});
  await handleExpensePostback(h.env,h.event('a=expense_set_payment&id=exp_1&payment=cash&source=SHOP_BANK'),h.actor);
  assert.equal(h.state.row.payment_key,'cash');
  assert.equal(h.state.row.source_wallet,'SHOP_BANK');
  assert.equal(h.state.row.status,'WAITING_CONFIRM','another unresolved field must still block confirmation');
  assert.equal(h.state.row.amount_satang,12000);
  assert.equal(h.state.queue.length,0);
});

test('legacy cash payment postback without a source still selects the cash drawer',async()=>{
  const h=harness('WAITING_CONFIRM',{payment_key:'unconfirmed',source_wallet:'UNCONFIRMED',category:'not-a-category'});
  await handleExpensePostback(h.env,h.event('a=expense_set_payment&id=exp_1&payment=cash'),h.actor);
  assert.equal(h.state.row.payment_key,'cash');
  assert.equal(h.state.row.source_wallet,'CASH_DRAWER');
  assert.equal(h.state.row.status,'WAITING_CONFIRM');
  assert.equal(h.state.queue.length,0);
});

test('invalid transfer from cash drawer is rejected by both payment actions without financial effects',async()=>{
  for(const action of ['expense_set_payment','expense_resolve_payment']){
    const h=harness('WAITING_CONFIRM',{payment_key:'unconfirmed',source_wallet:'UNCONFIRMED'}),before={...h.state.row},prepared=[];
    const originalPrepare=h.env.DB.prepare.bind(h.env.DB);
    h.env.DB.prepare=sql=>{prepared.push(sql);return originalPrepare(sql);};
    await handleExpensePostback(h.env,h.event(`a=${action}&id=exp_1&payment=transfer&source=CASH_DRAWER`),h.actor);
    assert.deepEqual(h.state.row,before,action);
    assert.equal(prepared.some(sql=>/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)),false,action);
    assert.equal(h.state.batches.length,0,action);
    assert.equal(h.state.queue.length,0,action);
  }
});

test('source selection retains cash when the user chooses shop bank',async()=>{
  const h=harness('WAITING_CONFIRM',{payment_key:'cash',source_wallet:'UNCONFIRMED',category:'not-a-category'});
  await handleExpensePostback(h.env,h.event('a=expense_set_source&id=exp_1&source=SHOP_BANK'),h.actor);
  assert.equal(h.state.row.payment_key,'cash');
  assert.equal(h.state.row.source_wallet,'SHOP_BANK');
  assert.equal(h.state.row.status,'WAITING_CONFIRM');
  assert.equal(h.state.queue.length,0);
});

test('bank slip payment and source stay locked against cash-source postbacks',async()=>{
  for(const data of [
    'a=expense_set_payment&id=exp_1&payment=cash&source=SHOP_BANK',
    'a=expense_resolve_payment&id=exp_1&payment=cash&source=CASH_DRAWER',
    'a=expense_set_source&id=exp_1&source=CASH_DRAWER'
  ]){
    const document={document_id:'doc_locked',document_type:'BANK_SLIP',needs_review:1,normalized_json:JSON.stringify({expenseReview:{requiredFields:['payment'],confirmedFields:[]}})};
    const h=harness('WAITING_CONFIRM',{document}),before={...h.state.row},prepared=[];
    const beforeDocument=h.state.document;
    const originalPrepare=h.env.DB.prepare.bind(h.env.DB);
    h.env.DB.prepare=sql=>{prepared.push(sql);return originalPrepare(sql);};
    await handleExpensePostback(h.env,h.event(data),h.actor);
    assert.deepEqual(h.state.row,before);
    assert.deepEqual(h.state.document,beforeDocument);
    assert.equal(prepared.some(sql=>/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)),false);
    assert.equal(h.state.batches.length,0);
    assert.equal(h.state.queue.length,0);
  }
});

test('date picker updates the draft date',async()=>{
  const h=harness('WAITING_CONFIRM',{transaction_date:'invalid-date'});await handleExpensePostback(h.env,h.event('a=expense_set_date&id=exp_1',{date:'2026-07-20'}),h.actor);
  assert.equal(h.state.row.transaction_date,'2026-07-20');
});

test('confirmation persists and enqueues Google Sheets before LINE output',async()=>{
  const h=harness();await handleExpensePostback(h.env,h.event('a=expense_confirm&id=exp_1'),h.actor);
  assert.equal(h.state.row.status,'CONFIRMED');assert.equal(h.state.queue.length,1);assert.equal(h.state.queue[0].body.entityVersion,1);
});

// Undo's transactional audit/outbox contract is exercised against real SQLite
// in expense-undo-integration.test.mjs, not this permissive statement mock.

test('Save cannot finalize a draft with an unconfirmed payment',async()=>{
  const h=harness('WAITING_CONFIRM',{payment_key:'unconfirmed',source_wallet:'UNCONFIRMED'});
  await handleExpensePostback(h.env,h.event('a=expense_confirm&id=exp_1'),h.actor);
  assert.equal(h.state.row.status,'WAITING_CONFIRM');
  assert.equal(h.state.queue.length,0);
});

test('each canonical payment chooser option resolves method and source then finalizes once',async()=>{
  for(const option of expensePaymentOptions){
    const h=harness('WAITING_CONFIRM',{payment_key:'unconfirmed',source_wallet:'UNCONFIRMED'});
    await handleExpensePostback(h.env,h.event(`a=expense_resolve_payment&id=exp_1&payment=${option.paymentKey}&source=${option.sourceWallet}`),h.actor);
    assert.equal(h.state.row.payment_key,option.paymentKey,option.paymentKey);
    assert.equal(h.state.row.source_wallet,option.sourceWallet,option.paymentKey);
    assert.equal(h.state.row.status,'CONFIRMED',option.paymentKey);
    assert.equal(h.state.queue.length,1,option.paymentKey);
  }
});

test('payment chooser double tap and postback redelivery finalize only one Expense',async()=>{
  const h=harness('WAITING_CONFIRM',{payment_key:'unconfirmed',source_wallet:'UNCONFIRMED'});
  const event=h.event('a=expense_resolve_payment&id=exp_1&payment=cash&source=CASH_DRAWER');
  await handleExpensePostback(h.env,event,h.actor);
  await handleExpensePostback(h.env,event,h.actor);
  assert.equal(h.state.row.status,'CONFIRMED');
  assert.equal(h.state.queue.length,1);
});

test('stale payment postback cannot alter a confirmed Expense',async()=>{
  const h=harness('CONFIRMED');
  await handleExpensePostback(h.env,h.event('a=expense_resolve_payment&id=exp_1&payment=cash&source=CASH_DRAWER'),h.actor);
  assert.equal(h.state.row.payment_key,'transfer');
  assert.equal(h.state.row.source_wallet,'SHOP_BANK');
  assert.equal(h.state.queue.length,0);
});

test('a selected payment returns to review without finalizing when another required field is unresolved',async()=>{
  const h=harness('WAITING_CONFIRM',{payment_key:'unconfirmed',source_wallet:'UNCONFIRMED',category:'not-a-category'});
  await handleExpensePostback(h.env,h.event('a=expense_resolve_payment&id=exp_1&payment=transfer&source=SHOP_BANK'),h.actor);
  assert.equal(h.state.row.payment_key,'transfer');
  assert.equal(h.state.row.source_wallet,'SHOP_BANK');
  assert.equal(h.state.row.status,'WAITING_CONFIRM');
  assert.equal(h.state.queue.length,0);
});

test('Cancel from the payment chooser leaves no finalized Expense',async()=>{
  const h=harness('WAITING_CONFIRM',{payment_key:'unconfirmed',source_wallet:'UNCONFIRMED'});
  await handleExpensePostback(h.env,h.event('a=expense_cancel&id=exp_1'),h.actor);
  assert.equal(h.state.row.status,'CANCELLED');
  assert.equal(h.state.queue.length,0);
});

test('guided item correction is scoped to one draft, then the final category selection finalizes once',async()=>{
  const document={document_id:'doc_1',document_type:'BANK_SLIP',review_note:'Please confirm the item and category before saving.',needs_review:1,normalized_json:JSON.stringify({expenseReview:{requiredFields:['description','category'],confirmedFields:[]}})};
  const h=harness('WAITING_CONFIRM',{description:'Transfer to SOMJAI YINGCHAROEN',category:'general',document});
  await handleExpensePostback(h.env,h.event('a=expense_edit_description&id=exp_1'),h.actor);
  assert.deepEqual(h.state.pending&&{expenseId:h.state.pending.expense_id,field:h.state.pending.field},{expenseId:'exp_1',field:'description'});
  await handleExpenseText(h.env,{source:{type:'user',userId:'U_TEST'},message:{id:'edit_message_1',type:'text',text:'ค่าวัตถุดิบตลาดสด'}},'trace_edit',{employeeId:'EMP001',branchId:'B001'});
  assert.equal(h.state.row.description,'ค่าวัตถุดิบตลาดสด');
  assert.equal(h.state.row.status,'WAITING_CONFIRM');
  assert.equal(h.state.pending,null);
  const review=JSON.parse(h.state.document.normalized_json).expenseReview;
  assert.deepEqual(review.confirmedFields,['description']);
  await handleExpensePostback(h.env,h.event('a=expense_set_category&id=exp_1&category=ingredients'),h.actor,{employeeId:'EMP001',branchId:'B001'});
  assert.equal(h.state.row.status,'CONFIRMED');
  assert.equal(h.state.queue.length,1);
});
