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
const owner={employeeId:'OWN001',role:'OWNER',scope:'ORGANIZATION',branchId:null,branchName:null,employeeStatus:'ACTIVE',roleStatus:'ACTIVE',employee:{employeeId:'OWN001',staffName:'Eak',lineUserId:'U-owner',scheduledIn:'04:00',scheduledOut:'16:00',dailyWageSatang:0,graceMin:0,lateDeductionSatang:0,earlyDeductionSatang:0,canSubmitExpense:true,status:'ACTIVE'}};

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

test('missing Staff ID tells employee to ask verified Owner to run HR SYNC',async()=>{
  const state={sql:[],actor:null,pending:true,staff:null,lineBound:false};
  const calls=await lineReply(()=>handleHrText(env(state),event('EMP004'),null,'trace'));
  assert.match(calls[0].messages[0].text,/HR SYNC/);
  assert.equal(state.sql.some(entry=>entry.sql.includes('INSERT INTO line_identity_bindings')),false);
});

test('provisioned OWN002 follows the ordinary pending Owner approval flow',async()=>{
  const state={sql:[],actor:null,pending:true,staff:{employee_id:'OWN002',staff_name:'Nea',status:'ACTIVE',existing_binding:null},lineBound:false};
  const calls=await lineReply(()=>handleHrText(env(state),event('OWN002'),null,'trace'));
  assert.match(calls[0].messages[0].text,/Waiting for Owner approval/);
  assert.ok(state.sql.some(entry=>entry.sql.includes("PENDING_OWNER_APPROVAL")&&entry.values.includes('OWN002')));
  assert.equal(state.sql.some(entry=>entry.sql.includes('INSERT INTO line_identity_bindings')),false);
});

test('already linked HR returns a sanitised profile without raw LINE user ID',async()=>{
  const state={sql:[],actor:null,pending:false,staff:null,lineBound:false};
  const linked={employeeId:'EMP001',role:'EMPLOYEE',scope:'BRANCH',branchId:'B001',branchName:'Yingcharoen',employeeStatus:'ACTIVE',roleStatus:'ACTIVE',employee:{employeeId:'EMP001',staffName:'Win',lineUserId:'U-SECRET',scheduledIn:'04:00',scheduledOut:'16:00',dailyWageSatang:0,graceMin:10,lateDeductionSatang:0,earlyDeductionSatang:0,canSubmitExpense:true,status:'ACTIVE'}};
  const calls=await lineReply(()=>handleHrText(env(state),event('HR'),linked,'trace'));
  assert.match(calls[0].messages[0].text,/HR Profile/);
  assert.doesNotMatch(calls[0].messages[0].text,/U-SECRET/);
});

test('only an already verified Owner LINE account can list pending identity requests',async()=>{
  const state={sql:[],actor:null,pending:false,staff:null,lineBound:false};
  const calls=await lineReply(()=>handleHrText(env(state),event('HR PENDING'),owner,'trace'));
  assert.match(calls[0].messages[0].text,/No pending requests/);
  const denied=await lineReply(()=>handleHrText(env(state),event('HR PENDING'),null,'trace'));
  assert.match(denied[0].messages[0].text,/verified Owner LINE account/);
});

test('verified Owner can run HR SYNC without creating a LINE binding',async()=>{
  const state={sql:[],actor:null,pending:false,staff:null,lineBound:false};
  let syncCalls=0;
  const calls=await lineReply(()=>handleHrText(env(state),event('HR SYNC'),owner,'trace',{importConfiguredStaff:async()=>{syncCalls++;return{count:5,employees:[]};}}));
  assert.equal(syncCalls,1);
  assert.match(calls[0].messages[0].text,/Processed 5 staff rows/);
  assert.equal(state.sql.some(entry=>entry.sql.includes('INSERT INTO line_identity_bindings')),false);
});

test('non-owner cannot run HR SYNC',async()=>{
  const state={sql:[],actor:null,pending:false,staff:null,lineBound:false};
  let syncCalls=0;
  const calls=await lineReply(()=>handleHrText(env(state),event('HR SYNC'),null,'trace',{importConfiguredStaff:async()=>{syncCalls++;return{count:0,employees:[]};}}));
  assert.equal(syncCalls,0);
  assert.match(calls[0].messages[0].text,/verified Owner LINE account/);
});

test('HR SYNC failure is sanitized and does not create a binding',async()=>{
  const state={sql:[],actor:null,pending:false,staff:null,lineBound:false};
  const calls=await lineReply(()=>handleHrText(env(state),event('HR SYNC'),owner,'trace',{importConfiguredStaff:async()=>{throw new Error('private provider detail');}}));
  assert.match(calls[0].messages[0].text,/HR staff sync failed/);
  assert.doesNotMatch(calls[0].messages[0].text,/private provider detail/);
  assert.equal(state.sql.some(entry=>entry.sql.includes('INSERT INTO line_identity_bindings')),false);
});

test('an already-bound target staff ID is rejected and creates no binding',async()=>{
  const state={sql:[],actor:null,pending:true,staff:{employee_id:'EMP001',staff_name:'Win',status:'ACTIVE',existing_binding:'bound'},lineBound:false};
  const calls=await lineReply(()=>handleHrText(env(state),event('EMP001'),null,'trace'));
  assert.match(calls[0].messages[0].text,/STAFF_ALREADY_LINKED/);
  assert.equal(state.sql.some(entry=>entry.sql.includes('INSERT INTO line_identity_bindings')),false);
});
