import test from 'node:test';
import assert from 'node:assert/strict';
import {handleExpenseText} from '../dist/expense/service.js';

function harness(){
  const state={runs:[],batches:[],queue:[]};
  const DB={
    prepare(sql){
      return{
        sql,
        args:[],
        bind(...args){this.args=args;return this;},
        async run(){state.runs.push({sql:this.sql,args:this.args});return{meta:{changes:1}};}
      };
    },
    async batch(statements){state.batches.push(statements.map(statement=>({sql:statement.sql,args:statement.args})));return[];}
  };
  const env={
    DB,
    JOB_QUEUE:{async sendBatch(messages){state.queue.push(...messages);}},
    SHEETS_SYNC_ENABLED:'true',
    RUNTIME_MODE:'shadow',
    SHADOW_LINE_OUTPUT:'false'
  };
  const event=text=>({source:{type:'user',userId:'U_TEST'},message:{id:`msg_${state.runs.length}`,type:'text',text}});
  return{state,env,event};
}

test('cash text writes CONFIRMED expense and enqueues Sheets',async()=>{
  const h=harness();
  await handleExpenseText(h.env,h.event('ไข่ ทอน 375'),'trace_cash');
  assert.equal(h.state.runs.length,1);
  assert.match(h.state.runs[0].sql,/INSERT INTO expense_events/);
  assert.equal(h.state.runs[0].args[9],'CONFIRMED');
  assert.equal(h.state.batches.length,1);
  assert.equal(h.state.queue.length,1);
  assert.equal(h.state.queue[0].body.entityType,'EXPENSE');
});

test('transfer text waits for confirmation and does not enqueue Sheets',async()=>{
  const h=harness();
  await handleExpenseText(h.env,h.event('ค่าไฟ โอน 1200'),'trace_transfer');
  assert.equal(h.state.runs.length,1);
  assert.equal(h.state.runs[0].args[9],'WAITING_CONFIRM');
  assert.equal(h.state.batches.length,0);
  assert.equal(h.state.queue.length,0);
});

test('invalid text does not write D1 or enqueue Sheets',async()=>{
  const h=harness();
  await handleExpenseText(h.env,h.event('ไข่ ทอน 0.001'),'trace_invalid');
  assert.equal(h.state.runs.length,0);
  assert.equal(h.state.batches.length,0);
  assert.equal(h.state.queue.length,0);
});
