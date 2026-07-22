import test from 'node:test';
import assert from 'node:assert/strict';
import {handleExpensePostback} from '../dist/expense/service.js';

function harness(status='WAITING_CONFIRM'){
  const row={expense_id:'exp_1',message_id:'msg_1',line_user_id:'U_TEST',description:'ค่าไฟ',amount_satang:12000,payment_key:'transfer',source_wallet:'SHOP_BANK',category:'utilities',transaction_date:'2026-07-22',status};
  const state={row,batches:[],queue:[]};
  const DB={
    prepare(sql){
      return{
        sql,args:[],
        bind(...args){this.args=args;return this;},
        async first(){return sql.includes('SELECT * FROM expense_events')?{...state.row}:null;},
        async run(){
          if(sql.includes("status='CANCELLED'")&&sql.includes("status='WAITING_CONFIRM'")){if(state.row.status!=='WAITING_CONFIRM')return{meta:{changes:0}};state.row.status='CANCELLED';}
          else if(sql.includes("status='CANCELLED'")&&sql.includes("status='CONFIRMED'")){if(state.row.status!=='CONFIRMED')return{meta:{changes:0}};state.row.status='CANCELLED';}
          else if(sql.includes("status='CONFIRMED'")){if(state.row.status!=='WAITING_CONFIRM')return{meta:{changes:0}};state.row.status='CONFIRMED';}
          else if(sql.includes('payment_key=?,source_wallet=?')){state.row.payment_key=this.args[0];state.row.source_wallet=this.args[1];}
          else if(sql.includes('category=?'))state.row.category=this.args[0];
          else if(sql.includes('transaction_date=?'))state.row.transaction_date=this.args[0];
          return{meta:{changes:1}};
        }
      };
    },
    async batch(statements){state.batches.push(statements);return[];}
  };
  const env={DB,JOB_QUEUE:{async sendBatch(messages){state.queue.push(...messages);}},SHEETS_SYNC_ENABLED:'true',RUNTIME_MODE:'shadow',SHADOW_LINE_OUTPUT:'false'};
  const actor={canSubmitExpense:true};
  const event=(data,params)=>({source:{type:'user',userId:'U_TEST'},postback:{data,params}});
  return{state,env,actor,event};
}

test('payment selection updates the draft and matching wallet',async()=>{
  const h=harness();await handleExpensePostback(h.env,h.event('a=expense_set_payment&id=exp_1&payment=firstchoice'),h.actor);
  assert.equal(h.state.row.payment_key,'firstchoice');assert.equal(h.state.row.source_wallet,'CARD_FIRST_CHOICE');assert.equal(h.state.queue.length,0);
});

test('date picker updates the draft date',async()=>{
  const h=harness();await handleExpensePostback(h.env,h.event('a=expense_set_date&id=exp_1',{date:'2026-07-20'}),h.actor);
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
