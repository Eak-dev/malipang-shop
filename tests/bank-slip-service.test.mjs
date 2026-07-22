import test from 'node:test';
import assert from 'node:assert/strict';
import {handleExpenseImage} from '../dist/expense/service.js';

function bankReading(overrides={}){
  const document={documentType:'BANK_SLIP',channel:'BANK',institution:'KBank',transactionType:'PAYMENT',transactionStatus:'SUCCESS',printedYear:'26',paymentDate:'2026-07-21',paymentTime:'16:49',referenceId:'REF-NEW',sender:'Eak',senderAccountMasked:'xx6494',recipient:'',recipientAccountMasked:'',merchant:'Ontakan Printing',grossAmountBaht:200,discountAmountBaht:0,paidAmountBaht:200,currency:'THB',suggestedDescription:'Printing expense - Ontakan Printing',suggestedCategory:'marketing',confidence:0.98,needsReview:false,note:'',...overrides};
  return{kind:'BANK_SLIP',hour:null,minute:null,month:null,day:null,weekday:null,confidence:document.confidence,clockFullyVisible:null,needsNewPhoto:false,note:'',provider:'openai',raw:{},document};
}

function harness(duplicate=null){
  const state={runs:[],batches:[]};
  const DB={
    prepare(sql){return{sql,args:[],bind(...args){this.args=args;return this;},async first(){return duplicate;},async run(){state.runs.push({sql:this.sql,args:this.args});return{meta:{changes:1}};}};},
    async batch(statements){state.batches.push(statements.map(statement=>({sql:statement.sql,args:statement.args})));return statements.map(()=>({meta:{changes:1}}));}
  };
  const env={DB,RUNTIME_MODE:'shadow',SHADOW_LINE_OUTPUT:'false'};
  const event={source:{type:'user',userId:'U_TEST'},message:{id:'msg_slip_1',type:'image'}};
  return{state,env,event};
}

test('valid bank slip creates linked WAITING_CONFIRM document and expense without early Sheets sync',async()=>{
  const h=harness();
  await handleExpenseImage(h.env,h.event,bankReading(),'expense/key.jpg','trace_bank','hash-new');
  assert.equal(h.state.batches.length,1);
  const [documentInsert,expenseInsert]=h.state.batches[0];
  assert.match(documentInsert.sql,/INSERT INTO expense_documents/);
  assert.equal(documentInsert.args[5],'WAITING_CONFIRM');
  assert.equal(documentInsert.args[24],20000);
  assert.equal(documentInsert.args[30],'hash-new');
  assert.match(expenseInsert.sql,/INSERT INTO expense_events/);
  assert.equal(expenseInsert.args[4],20000);
  assert.equal(expenseInsert.args[5],'transfer');
  assert.equal(expenseInsert.args[6],'SHOP_BANK');
  assert.equal(expenseInsert.args[8],'2026-07-21');
});

test('duplicate reference or image creates no new records',async()=>{
  const h=harness({document_id:'doc_existing',expense_id:'exp_existing',status:'CONFIRMED'});
  await handleExpenseImage(h.env,h.event,bankReading(),'expense/key.jpg','trace_dup','hash-old');
  assert.equal(h.state.batches.length,0);
  assert.equal(h.state.runs.length,0);
});

test('incomplete bank slip remains review-only and never creates an expense',async()=>{
  const h=harness();
  await handleExpenseImage(h.env,h.event,bankReading({transactionStatus:'PENDING',referenceId:'',paidAmountBaht:null}),'expense/key.jpg','trace_bad','hash-bad');
  assert.equal(h.state.batches.length,0);
  assert.equal(h.state.runs.length,1);
  assert.match(h.state.runs[0].sql,/INSERT INTO expense_documents/);
  assert.equal(h.state.runs[0].args[5],'WAITING_REVIEW');
  assert.equal(h.state.runs[0].args[31],null);
});
