import test from 'node:test';
import assert from 'node:assert/strict';
import {processInbound} from '../dist/router/process-event.js';

const ownerRow={
  employee_id:'OWN001',staff_name:'Owner Test',line_user_id:'U_OWNER',scheduled_in:'04:00',scheduled_out:'16:00',
  daily_wage_satang:0,grace_min:0,late_deduction_satang:0,early_deduction_satang:0,can_submit_expense:1,
  status:'ACTIVE',employee_status:'ACTIVE',role:'OWNER',scope:'ORGANIZATION',branch_id:null,role_status:'ACTIVE',branch_name:null
};

function harness(){
  const state={expenseRows:[],personalRows:[],expenseAudits:[],personalAudits:[],syncJobs:[],queue:[],completions:[]};
  const statement=sql=>({sql,args:[],bind(...args){this.args=args;return this;},async first(){
    if(sql.includes('FROM line_identity_bindings i JOIN employees'))return ownerRow;
    return null;
  },async all(){return{results:[]};},async run(){
    if(sql.includes('INSERT INTO inbound_events'))return{meta:{changes:1}};
    if(sql.includes('UPDATE inbound_events SET route=')){state.completions.push({route:this.args[0],status:this.args[1]});return{meta:{changes:1}};}
    if(sql.includes('INSERT INTO expense_events')){state.expenseRows.push({status:this.args[9],args:this.args});return{meta:{changes:1}};}
    if(sql.includes('INSERT INTO expense_audit_log')){state.expenseAudits.push(this.args);return{meta:{changes:1}};}
    if(sql.includes('INSERT INTO owner_personal_transactions')){state.personalRows.push({status:'WAITING_CONFIRM',args:this.args});return{meta:{changes:1}};}
    if(sql.includes('INSERT INTO owner_personal_transaction_audit')){state.personalAudits.push(this.args);return{meta:{changes:1}};}
    if(sql.includes('INSERT INTO sync_jobs')){state.syncJobs.push({entityType:this.args[1],entityVersion:this.args[3]});return{meta:{changes:1}};}
    return{meta:{changes:1}};
  }});
  const DB={prepare:statement,async batch(statements){const results=[];for(const item of statements)results.push(await item.run());return results;}};
  const env={
    DB,JOB_QUEUE:{async sendBatch(messages){state.queue.push(...messages);},async send(message){state.queue.push({body:message});}},
    RUNTIME_MODE:'production',SHADOW_LINE_OUTPUT:'false',EXPENSE_ENABLED:'true',SHEETS_SYNC_ENABLED:'true',
    LINE_CHANNEL_ACCESS_TOKEN:'test-token',EXTERNAL_API_TIMEOUT_MS:'1000'
  };
  return{state,env};
}

async function routeText(h,text,index){
  const event={
    type:'message',timestamp:Date.parse('2026-09-06T00:00:00Z'),source:{type:'user',userId:'U_OWNER'},
    replyToken:`reply_${index}`,webhookEventId:`webhook_${index}`,message:{id:`message_${index}`,type:'text',text}
  };
  await processInbound({kind:'LINE_EVENT',event,receivedAtIso:'2026-09-06T00:00:00.000Z',traceId:`trace_${index}`},h.env,{});
}

test('router reserves every malformed PERSONAL_USE prefix before Expense routing',async t=>{
  const replies=[];
  t.mock.method(globalThis,'fetch',async(_url,init)=>{replies.push(JSON.parse(String(init.body)));return new Response('{}',{status:200});});
  const malformed=[
    'ส่วนตัว ทอน 100',
    'ส่วนตัว: ไข่ ทอน 100',
    'ส่วนตัว, ไข่ โอน 100',
    'PeRsOnAl\u00a0UsE โอน 100',
    'personal ยู | 100 | KBank ร้าน',
    'personal   u | 100 | KBank ร้าน | note | 2026-09-06 | extra',
    'คืนเงินส่วนตัว | nope | เงินสดร้าน | note',
    'PERSONAL RETURN | 100 | บัญชีส่วนตัว | note',
    'คืนเงิน\u00a0personal | 100 | บัญชีร้าน | note | 2026-02-30'
  ];
  for(const [index,input] of malformed.entries()){
    const h=harness();
    await routeText(h,input,index);
    assert.equal(h.state.expenseRows.length,0,input);
    assert.equal(h.state.expenseAudits.length,0,input);
    assert.equal(h.state.personalRows.length,0,input);
    assert.equal(h.state.personalAudits.length,0,input);
    assert.equal(h.state.syncJobs.length,0,input);
    assert.equal(h.state.queue.length,0,input);
    assert.deepEqual(h.state.completions.at(-1),{route:'PERSONAL_USE_TEXT',status:'REJECTED'},input);
  }
  assert.equal(replies.length,malformed.length);
  for(const reply of replies){
    assert.equal(reply.messages[0].type,'text');
    assert.match(reply.messages[0].text,/รูปแบบรายการส่วนตัวไม่ถูกต้อง/);
    assert.match(reply.messages[0].text,/ส่วนตัว \| จำนวน/);
  }
});

test('router keeps valid PERSONAL_USE as a personal draft only',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('{}',{status:200}));
  const h=harness();
  await routeText(h,'ส่วนตัว | 100 | KBank ร้าน | test | 2026-09-06','valid_personal');
  assert.equal(h.state.personalRows.length,1);
  assert.equal(h.state.personalRows[0].status,'WAITING_CONFIRM');
  assert.equal(h.state.personalAudits.length,1);
  assert.equal(h.state.expenseRows.length,0);
  assert.equal(h.state.expenseAudits.length,0);
  assert.equal(h.state.syncJobs.length,0);
  assert.equal(h.state.queue.length,0);
  assert.deepEqual(h.state.completions.at(-1),{route:'PERSONAL_USE_TEXT',status:'COMPLETED'});
});

test('router preserves ordinary Expense behavior outside reserved prefix boundaries',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('{}',{status:200}));
  const quick=harness();
  await routeText(quick,'ไข่ ทอน 375','expense_quick');
  assert.deepEqual(quick.state.expenseRows.map(row=>row.status),['CONFIRMED']);
  assert.equal(quick.state.expenseAudits.length,1);
  assert.equal(quick.state.personalRows.length,0);
  assert.deepEqual(quick.state.syncJobs,[{entityType:'EXPENSE',entityVersion:1}]);
  assert.equal(quick.state.queue.length,1);
  assert.equal(quick.state.queue[0].body.entityType,'EXPENSE');
  assert.deepEqual(quick.state.completions.at(-1),{route:'EXPENSE_TEXT',status:'COMPLETED'});

  const review=harness();
  await routeText(review,'personal utilities transfer 1200','expense_review');
  assert.deepEqual(review.state.expenseRows.map(row=>row.status),['WAITING_CONFIRM']);
  assert.equal(review.state.expenseAudits.length,1);
  assert.equal(review.state.personalRows.length,0);
  assert.equal(review.state.syncJobs.length,0);
  assert.equal(review.state.queue.length,0);
  assert.deepEqual(review.state.completions.at(-1),{route:'EXPENSE_TEXT',status:'COMPLETED'});

  const thaiContinuation=harness();
  await routeText(thaiContinuation,'ส่วนตัวเอง ทอน 100','expense_thai_continuation');
  assert.deepEqual(thaiContinuation.state.expenseRows.map(row=>row.status),['CONFIRMED']);
  assert.equal(thaiContinuation.state.personalRows.length,0);
  assert.deepEqual(thaiContinuation.state.completions.at(-1),{route:'EXPENSE_TEXT',status:'COMPLETED'});
});
