import test from 'node:test';
import assert from 'node:assert/strict';
import {expenseSqlite,imageEvent} from './helpers/expense-sqlite.mjs';
import {handleExpenseImage,handleExpenseText,handleExpensePostback} from '../dist/expense/service.js';
import {normalizeOpenAIVisionResult} from '../dist/vision/openai.js';
import {missingSlipFields,slipInputCard} from '../dist/expense/slip-completion.js';
import {buildExpenseSummaryFlex} from '../dist/expense/flex.js';

const user='fixture_user',actor={employeeId:'employee-local',canSubmitExpense:true};
function slip(overrides={}){
  return {documentType:'BANK_SLIP',channel:'BANK',institution:'Synthetic Bank',transactionType:'PAYMENT',transactionStatus:'SUCCESS',
    paymentDate:'2026-01-10',printedYear:'26',paymentTime:'09:12',referenceId:'REF-LOCAL',sender:'',senderAccountMasked:'',
    recipient:'Fixture shop',recipientAccountMasked:'',merchant:'Fixture shop',grossAmountBaht:null,discountAmountBaht:null,paidAmountBaht:25.50,
    currency:'THB',suggestedDescription:'Synthetic purchase',suggestedCategory:'equipment',confidence:.99,needsReview:false,note:'',...overrides};
}
async function receive(h,document,message='photo',owner=user){
  await handleExpenseImage(h.env,imageEvent(message,owner),{kind:'BANK_SLIP',document,confidence:.99,raw:{},note:''},
    'fixture',message,'hash-'+message,actor);
  return h.sqlite.prepare('SELECT document_id FROM expense_documents WHERE message_id=?').get(message)?.document_id;
}
function row(h,id){return h.sqlite.prepare('SELECT * FROM expense_documents WHERE document_id=?').get(id);}
function count(h,table){return h.sqlite.prepare('SELECT count(*) AS n FROM '+table).get().n;}
function answer(h,id,field,value,owner=user){
  const text='/เติมสลิป '+id+' '+field+' '+value;
  return handleExpenseText(h.env,{source:{type:'user',userId:owner},message:{id:'reply',type:'text',text}},'reply',actor);
}
function click(h,id,action,extra=''){
  return handleExpensePostback(h.env,{source:{type:'user',userId:user},postback:{data:'a='+action+'&id='+id+extra}},actor);
}
for(const [channel,item,category] of [['BANK','หลอดไฟ','equipment'],['G_WALLET','น้ำตาลทรายขาว','ingredients'],['BANK','กาวสองหน้า','general']]){
  test('synthetic slip '+item+' retains entered fields and waits for an explicit save',async()=>{
    const h=expenseSqlite();
    try{
      const doc=slip({channel,paidAmountBaht:null,paymentDate:'',suggestedDescription:'',suggestedCategory:'general',needsReview:true,note:'item and category'});
      const id=await receive(h,doc);
      assert.equal(count(h,'expense_events'),0);
      const card=slipInputCard(id,missingSlipFields(doc));
      const actions=card.contents.body.contents.filter(x=>x.type==='button').map(x=>x.action);
      assert.ok(actions.some(x=>x.fillInText==='/เติมสลิป '+id+' ยอดจ่ายจริง '));
      await answer(h,id,'ยอดจ่ายจริง','25.50','another-user');
      await answer(h,id,'ยอดจ่ายจริง','0.001');
      assert.equal(row(h,id).paid_amount_satang,null);
      await answer(h,id,'ยอดจ่ายจริง','25.50');
      assert.equal(row(h,id).paid_amount_satang,2550);
      await answer(h,id,'ยอดจ่ายจริง','90');
      assert.equal(row(h,id).paid_amount_satang,2550);
      await answer(h,id,'วันที่ชำระ','2026-02-31');
      assert.equal(count(h,'expense_events'),0);
      await answer(h,id,'วันที่ชำระ','2026-01-10');
      const expense=row(h,id).expense_id;
      assert.ok(expense);
      await click(h,expense,'expense_confirm');
      assert.equal(row(h,id).status,'WAITING_CONFIRM');
      await click(h,expense,'expense_edit_description');
      await handleExpenseText(h.env,{source:{type:'user',userId:user},message:{id:'item',type:'text',text:item}},'item',actor);
      await click(h,expense,'expense_set_category','&category='+category);
      const draft=h.sqlite.prepare('SELECT * FROM expense_events WHERE expense_id=?').get(expense);
      assert.equal(draft.description,item);assert.equal(draft.category,category);
      assert.equal(draft.status,'WAITING_CONFIRM');assert.equal(draft.amount_satang,2550);
      assert.equal(count(h,'sync_jobs'),0);assert.equal(h.queue.length,0);
      await click(h,expense,'expense_confirm');
      await click(h,expense,'expense_confirm');
      assert.equal(row(h,id).status,'CONFIRMED');
      assert.equal(count(h,'expense_events'),1);assert.equal(count(h,'sync_jobs'),1);
      assert.equal(JSON.parse(row(h,id).ai_json).paidAmountBaht,null);
    }finally{h.close();}
  });
}
test('paid slip without its reference can be completed without weakening duplicate protection',async()=>{
  const h=expenseSqlite();try{
    await receive(h,slip(),'original');
    const id=await receive(h,slip({referenceId:'',recipient:'',merchant:''}),'second');
    const other=await receive(h,slip({referenceId:''}),'third');
    assert.ok(id&&other);assert.equal(count(h,'expense_events'),1);
    await answer(h,id,'เลขอ้างอิง','REF-LOCAL');
    assert.equal(row(h,id).reference_id,'');assert.equal(count(h,'expense_events'),1);
    await answer(h,id,'เลขอ้างอิง','REF-NEW');
    h.DB.failAt=2;
    await assert.rejects(answer(h,id,'ผู้รับเงิน','ร้านจำลอง'),/fixture batch failure/);
    h.DB.failAt=null;
    assert.equal(row(h,id).expense_id,null);assert.equal(row(h,id).recipient,'');
    await Promise.all([answer(h,id,'ผู้รับเงิน','ร้านจำลอง'),answer(h,id,'ผู้รับเงิน','ร้านจำลอง')]);
    assert.equal(count(h,'expense_events'),2);assert.equal(row(h,id).status,'WAITING_CONFIRM');
    assert.equal(count(h,'sync_jobs'),0);
  }finally{h.close();}
});
test('subsidy, confirmed payment and currency checks still apply to manual amounts',async()=>{
  const h=expenseSqlite();try{
    const id=await receive(h,slip({grossAmountBaht:100,discountAmountBaht:40,paidAmountBaht:null}),'subsidy');
    await answer(h,id,'ยอดจ่ายจริง','60.01');assert.equal(row(h,id).expense_id,null);
    await answer(h,id,'ยอดจ่ายจริง','100');
    assert.equal(row(h,id).expense_id,null);
    await answer(h,id,'ยอดจ่ายจริง','60');
    assert.equal(row(h,id).paid_amount_satang,6000);
    for(const [ref,overrides] of [['pending',{transactionStatus:'PENDING'}],['currency',{currency:'USD'}]]){
      const held=await receive(h,slip({referenceId:ref,paidAmountBaht:null,...overrides}),ref);
      await answer(h,held,'ยอดจ่ายจริง','20');
      assert.equal(row(h,held).expense_id,null);
    }
  }finally{h.close();}
});
test('a category edit on an initially readable slip displays the summary before saving',async()=>{
  const h=expenseSqlite();try{
    const id=await receive(h,slip({suggestedCategory:'general',note:'category',needsReview:true}));
    const expense=row(h,id).expense_id;
    await click(h,expense,'expense_set_category','&category=equipment');
    assert.equal(row(h,id).status,'WAITING_CONFIRM');assert.equal(h.queue.length,0);
    const card=buildExpenseSummaryFlex({expenseId:expense,description:'fixture',amountSatang:2550,transactionDate:'2026-01-10',category:'equipment',paymentKey:'transfer',sourceWallet:'SHOP_BANK'});
    assert.ok(card.contents.footer.contents.some(x=>x.action.data==='a=expense_confirm&id='+expense));
    await click(h,expense,'expense_confirm');
    assert.equal(row(h,id).status,'CONFIRMED');
  }finally{h.close();}
});
test('two slips with unusable reference placeholders wait for distinct usable references',async()=>{
  const h=expenseSqlite();try{
    const first=await receive(h,slip({referenceId:'---'}),'one');
    const second=await receive(h,slip({referenceId:'---'}),'two');
    assert.ok(first&&second);assert.equal(count(h,'expense_events'),0);
    await answer(h,first,'เลขอ้างอิง','---');assert.equal(row(h,first).expense_id,null);
    await answer(h,first,'เลขอ้างอิง','ABC-2');
    await answer(h,second,'เลขอ้างอิง','abc2');assert.equal(row(h,second).expense_id,null);
  }finally{h.close();}
});
test('an older slip with an obsolete payment review can be resumed and saved only with the locked wallet',async()=>{
  const h=expenseSqlite();try{
    const doc=slip(),id=await receive(h,doc),expense=row(h,id).expense_id;
    h.sqlite.prepare('UPDATE expense_documents SET normalized_json=? WHERE document_id=?').run(JSON.stringify({...doc,expenseReview:{requiredFields:['payment'],confirmedFields:[]}}),id);
    await receive(h,doc,'repeat');assert.equal(count(h,'expense_events'),1);
    h.sqlite.prepare("UPDATE expense_events SET payment_key='cash',source_wallet='CASH_DRAWER' WHERE expense_id=?").run(expense);
    await click(h,expense,'expense_confirm');assert.equal(row(h,id).status,'WAITING_CONFIRM');
    h.sqlite.prepare("UPDATE expense_events SET payment_key='transfer',source_wallet='SHOP_BANK' WHERE expense_id=?").run(expense);
    await click(h,expense,'expense_confirm');assert.equal(row(h,id).status,'CONFIRMED');
  }finally{h.close();}
});

test('missing currency and legacy malformed evidence never open the completion flow',async()=>{
  const h=expenseSqlite();try{
    const d=normalizeOpenAIVisionResult({kind:'BANK_SLIP',document:slip({currency:'',paidAmountBaht:null})},{}).document;
    assert.equal(d.currency,'');assert.deepEqual(missingSlipFields(d),[]);
    const id=await receive(h,d);const old={...d};delete old.currency;
    h.sqlite.prepare('UPDATE expense_documents SET ai_json=? WHERE document_id=?').run(JSON.stringify(old),id);
    await receive(h,d,'redelivered');
    await answer(h,id,'ยอดจ่ายจริง','99');
    assert.equal(row(h,id).expense_id,null);assert.equal(count(h,'expense_events'),0);
  }finally{h.close();}
});
