import test from 'node:test';
import assert from 'node:assert/strict';
import {handleHrText} from '../dist/access/hr.js';

function database(state){
  return {prepare(sql){
    const statement={values:[],bind(...values){this.values=values;return this;},async first(){
      if(sql.includes('FROM line_identity_bindings i JOIN employees'))return state.actor||null;
      if(sql.includes("SELECT request_id FROM identity_link_requests"))return state.pending?{request_id:'req_1'}:null;
      if(sql.includes('SELECT e.employee_id,e.staff_name'))return state.staff||null;
      if(sql.includes("SELECT binding_id FROM line_identity_bindings"))return state.lineBound?{binding_id:'bound'}:null;
      return null;
    },async run(){state.sql.push({sql,values:this.values});return{meta:{changes:1}};},async all(){return{results:[]};}};
    return statement;
  },async batch(statements){for(const statement of statements)await statement.run();return[];}};
}
function env(state){return {DB:database(state),JOB_QUEUE:{async send(){}},RUNTIME_MODE:'production',SHADOW_LINE_OUTPUT:'false',LINE_CHANNEL_ACCESS_TOKEN:'token',EXTERNAL_API_TIMEOUT_MS:'1000'};}
function event(text){return {type:'message',timestamp:Date.now(),source:{type:'user',userId:'U00000000000000000001'},replyToken:'reply',webhookEventId:`W-${text}`,message:{id:`M-${text}`,type:'text',text}};}

async function lineReply(run){
  const calls=[],original=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{calls.push(JSON.parse(init.body));return new Response('{}',{status:200});};
  try{await run();}finally{globalThis.fetch=original;}
  return calls;
}

test('unbound HR starts a pending link request and replies through Reply API',async()=>{
  const state={sql:[],actor:null,pending:false,staff:null,lineBound:false};
  const calls=await lineReply(()=>handleHrText(env(state),event('HR'),null,'trace'));
  assert.equal(calls.length,1);
  assert.match(calls[0].messages[0].text,/HR Registration/);
  assert.ok(state.sql.some(entry=>entry.sql.includes("PENDING_STAFF_ID")));
});

test('Staff ID alone only creates an approval request; it never creates a binding',async()=>{
  const state={sql:[],actor:null,pending:true,staff:{employee_id:'EMP004',staff_name:'New staff',status:'ACTIVE',existing_binding:null},lineBound:false};
  const calls=await lineReply(()=>handleHrText(env(state),event('EMP004'),null,'trace'));
  assert.match(calls[0].messages[0].text,/Waiting for Owner approval/);
  assert.ok(state.sql.some(entry=>entry.sql.includes("PENDING_OWNER_APPROVAL")));
  assert.equal(state.sql.some(entry=>entry.sql.includes('INSERT INTO line_identity_bindings')),false);
});

test('already linked HR returns a sanitised profile without raw LINE user ID',async()=>{
  const state={sql:[],actor:null,pending:false,staff:null,lineBound:false};
  const linked={employeeId:'EMP001',role:'EMPLOYEE',scope:'BRANCH',branchId:'B001',branchName:'Yingcharoen',employeeStatus:'ACTIVE',roleStatus:'ACTIVE',employee:{employeeId:'EMP001',staffName:'Win',lineUserId:'U-SECRET',scheduledIn:'04:00',scheduledOut:'16:00',dailyWageSatang:0,graceMin:10,lateDeductionSatang:0,earlyDeductionSatang:0,canSubmitExpense:true,status:'ACTIVE'}};
  const calls=await lineReply(()=>handleHrText(env(state),event('HR'),linked,'trace'));
  assert.match(calls[0].messages[0].text,/HR Profile/);
  assert.doesNotMatch(calls[0].messages[0].text,/U-SECRET/);
});

test('an already-bound target staff ID is rejected and creates no binding',async()=>{
  const state={sql:[],actor:null,pending:true,staff:{employee_id:'EMP001',staff_name:'Win',status:'ACTIVE',existing_binding:'bound'},lineBound:false};
  const calls=await lineReply(()=>handleHrText(env(state),event('EMP001'),null,'trace'));
  assert.match(calls[0].messages[0].text,/STAFF_ALREADY_LINKED/);
  assert.equal(state.sql.some(entry=>entry.sql.includes('INSERT INTO line_identity_bindings')),false);
});
