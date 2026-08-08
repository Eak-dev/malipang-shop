import test from 'node:test';
import assert from 'node:assert/strict';
import {handleExpensePostback,handleExpenseText} from '../dist/expense/service.js';
import {expensePaymentOptions} from '../dist/expense/document.js';

function harness(status='WAITING_CONFIRM',overrides={}){
  const {document,...rowOverrides}=overrides;
  const row={expense_id:'exp_1',message_id:'msg_1',line_user_id:'U_TEST',description:'ค่าไฟ',amount_satang:12000,payment_key:'transfer',source_wallet:'SHOP_BANK',category:'utilities',transaction_date:'2026-07-22',status,...rowOverrides};
  const state={row,batches:[],queue:[],pending:null,document:document||null};
  const DB={
    prepare(sql){
      return{
        sql,args:[],
        bind(...args){this.args=args;return this;},
        async first(){
          if(sql.includes('expense_pending_edits'))return state.pending;
          if(sql.includes('FROM expense_documents'))return state.document;
          return sql.includes('SELECT * FROM expense_events')?{...state.row}:null;
        },
        async run(){
          if(sql.includes("status='CANCELLED'")&&sql.includes("status='WAITING_CONFIRM'")){if(state.row.status!=='WAITING_CONFIRM')return{meta:{changes:0}};state.row.status='CANCELLED';}
          else if(sql.includes("status='CANCELLED'")&&sql.includes("status='CONFIRMED'")){if(state.row.status!=='CONFIRMED')return{meta:{changes:0}};state.row.status='CANCELLED';}
          else if(sql.includes("status='CONFIRMED'")){if(state.row.status!=='WAITING_CONFIRM')return{meta:{changes:0}};state.row.status='CONFIRMED';}
          else if(sql.includes('payment_key=?,source_wallet=?')){state.row.payment_key=this.args[0];state.row.source_wallet=this.args[1];}
          else if(sql.includes('category=?'))state.row.category=this.args[0];
          else if(sql.includes('transaction_date=?'))state.row.transaction_date=this.args[0];
          else if(sql.includes('description=?'))state.row.description=this.args[0];
          else if(sql.includes('INSERT INTO expense_pending_edits'))state.pending={expense_id:this.args[1],field:'description',expires_at:this.args[3]};
          else if(sql.includes('DELETE FROM expense_pending_edits'))state.pending=null;
          else if(sql.includes('UPDATE expense_documents SET normalized_json=')&&state.document)state.document.normalized_json=this.args[0];
          return{meta:{changes:1}};
        }
      };
    },
    async batch(statements){
      state.batches.push(statements);
      for(const statement of statements){
        if(statement.sql.includes('DELETE FROM expense_pending_edits'))state.pending=null;
      }
      return[];
    }
  };
  const env={DB,JOB_QUEUE:{async sendBatch(messages){state.queue.push(...messages);}},SHEETS_SYNC_ENABLED:'true',RUNTIME_MODE:'shadow',SHADOW_LINE_OUTPUT:'false'};
  const actor={canSubmitExpense:true};
  const event=(data,params)=>({source:{type:'user',userId:'U_TEST'},postback:{data,params}});
  return{state,env,actor,event};
}

test('payment selection updates the draft and matching wallet',async()=>{
  const h=harness('WAITING_CONFIRM',{payment_key:'unconfirmed',source_wallet:'UNCONFIRMED',category:'not-a-category'});await handleExpensePostback(h.env,h.event('a=expense_set_payment&id=exp_1&payment=firstchoice'),h.actor);
  assert.equal(h.state.row.payment_key,'firstchoice');assert.equal(h.state.row.source_wallet,'CARD_FIRST_CHOICE');assert.equal(h.state.queue.length,0);
});

test('date picker updates the draft date',async()=>{
  const h=harness('WAITING_CONFIRM',{transaction_date:'invalid-date'});await handleExpensePostback(h.env,h.event('a=expense_set_date&id=exp_1',{date:'2026-07-20'}),h.actor);
  assert.equal(h.state.row.transaction_date,'2026-07-20');
});

test('confirmation persists and enqueues Google Sheets before LINE output',async()=>{
  const h=harness();await handleExpensePostback(h.env,h.event('a=expense_confirm&id=exp_1'),h.actor);
  assert.equal(h.state.row.status,'CONFIRMED');assert.equal(h.state.queue.length,1);assert.equal(h.state.queue[0].body.entityVersion,1);
});

test('undo is audit-safe and enqueues a second Sheets version',async()=>{
  const h=harness('CONFIRMED');await handleExpensePostback(h.env,h.event('a=expense_undo&id=exp_1'),h.actor);
  assert.equal(h.state.row.status,'CANCELLED');assert.equal(h.state.queue.length,1);assert.equal(h.state.queue[0].body.entityVersion,2);
});

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
