import test from 'node:test';
import assert from 'node:assert/strict';
import {handleHrText} from '../dist/access/hr.js';

function database(state){
  return {prepare(sql){
    const statement={values:[],bind(...values){this.values=values;return this;},async first(){
      if(sql.includes('FROM line_identity_bindings i JOIN employees'))return state.actor||null;
      if(sql.includes("SELECT request_id FROM identity_link_requests"))return state.pending?{request_id:'req_legacy'}:null;
      if(sql.includes('SELECT e.employee_id,e.staff_name'))return state.staff||null;
      if(sql.includes("SELECT binding_id FROM line_identity_bindings"))return state.lineBound?{binding_id:'bound'}:null;
      return null;
    },async run(){state.sql.push({sql,values:this.values});return{meta:{changes:1}};},async all(){return{results:[]};}};
    return statement;
  },async batch(statements){for(const statement of statements)await statement.run();return[];}};
}
function env(state){return {DB:database(state),JOB_QUEUE:{async send(){}},RUNTIME_MODE:'production',SHADOW_LINE_OUTPUT:'false',LINE_CHANNEL_ACCESS_TOKEN:'token',EXTERNAL_API_TIMEOUT_MS:'1000'};}
function event(text,userId='U00000000000000000001'){return {type:'message',timestamp:Date.now(),source:{type:'user',userId},replyToken:'reply',webhookEventId:`W-${text}`,message:{id:`M-${text}`,type:'text',text}};}
const owner={employeeId:'OWN001',role:'OWNER',scope:'ORGANIZATION',branchId:null,branchName:null,employeeStatus:'ACTIVE',roleStatus:'ACTIVE',employee:{employeeId:'OWN001',staffName:'Eak',lineUserId:'U-owner',scheduledIn:'04:00',scheduledOut:'16:00',dailyWageSatang:0,graceMin:0,lateDeductionSatang:0,earlyDeductionSatang:0,canSubmitExpense:true,status:'ACTIVE'}};
const employeeActor={employeeId:'EMP001',role:'EMPLOYEE',scope:'BRANCH',branchId:'B001',branchName:'Yingcharoen',employeeStatus:'ACTIVE',roleStatus:'ACTIVE',employee:{employeeId:'EMP001',staffName:'Win',lineUserId:'U-SECRET',scheduledIn:'04:00',scheduledOut:'16:00',dailyWageSatang:50000,graceMin:10,lateDeductionSatang:0,earlyDeductionSatang:0,canSubmitExpense:false,status:'ACTIVE'}};
const request={requestId:'req-new-1',externalUserId:'U1234567890123456ABCD',displayName:'Noi New Staff',pictureUrl:'https://example.com/profile.jpg',status:'PENDING_OWNER_SETUP',employeeId:null,requestedAt:'2026-08-24T05:00:00.000Z',reviewedBy:null};
const emp004={employeeId:'EMP004',staffName:'Noi',role:'EMPLOYEE',branchId:'B001',scheduledIn:'04:00',scheduledOut:'16:00',dailyWageBaht:500};

async function lineReply(run){
  const calls=[],original=globalThis.fetch;
  globalThis.fetch=async(url,init={})=>{
    if(String(url).includes('/v2/bot/message/reply')){
      calls.push(JSON.parse(init.body));
      return new Response('{}',{status:200});
    }
    return new Response('{}',{status:200});
  };
  try{await run();}finally{globalThis.fetch=original;}
  return calls;
}
function messageJson(calls){return JSON.stringify(calls[0]?.messages?.[0]||{});}

const profileDeps={
  getLineProfile:async()=>({displayName:request.displayName,pictureUrl:request.pictureUrl}),
  startOnboarding:async(_env,lineUserId,profile)=>({...request,externalUserId:lineUserId,displayName:profile.displayName,pictureUrl:profile.pictureUrl}),
};

test('new employee sends HR once and is not asked for a Staff ID',async()=>{
  const state={sql:[],actor:null,pending:false,staff:null,lineBound:false};
  let starts=0;
  const calls=await lineReply(()=>handleHrText(env(state),event('HR'),null,'trace',{...profileDeps,startOnboarding:async(_env,lineUserId,profile)=>{starts++;return{...request,externalUserId:lineUserId,displayName:profile.displayName,pictureUrl:profile.pictureUrl};}}));
  assert.equal(starts,1);
  assert.equal(calls.length,1);
  assert.match(calls[0].messages[0].text,/waiting for Owner setup/i);
  assert.match(calls[0].messages[0].text,/No Staff ID/i);
  assert.doesNotMatch(calls[0].messages[0].text,/Please enter your Staff ID/i);
  assert.equal(state.sql.some(entry=>entry.sql.includes('PENDING_STAFF_ID')),false);
});

test('Owner bare HR shows who requested onboarding without exposing raw LINE user ID',async()=>{
  const state={sql:[],actor:null,pending:false,staff:null,lineBound:false};
  const calls=await lineReply(()=>handleHrText(env(state),event('HR'),owner,'trace',{listOnboarding:async()=>[request]}));
  const rendered=messageJson(calls);
  assert.match(rendered,/Noi New Staff/);
  assert.match(rendered,/U••••ABCD/);
  assert.doesNotMatch(rendered,/U1234567890123456ABCD/);
  assert.match(rendered,/HR ADD req-new-1/);
  assert.match(rendered,/HR STAFF req-new-1/);
  assert.match(rendered,/HR DECLINE req-new-1/);
});

test('HR ADD only shows a confirmation card and does not create staff yet',async()=>{
  const state={sql:[],actor:null,pending:false,staff:null,lineBound:false};
  let adds=0;
  const calls=await lineReply(()=>handleHrText(env(state),event('HR ADD req-new-1'),owner,'trace',{getOnboarding:async()=>request,addNew:async()=>{adds++;return{employeeId:'EMP005',staffName:'Noi New Staff',idempotent:false};}}));
  assert.equal(adds,0);
  const rendered=messageJson(calls);
  assert.match(rendered,/500 บาท\/วัน/);
  assert.match(rendered,/04:00–16:00/);
  assert.match(rendered,/HR ADD CONFIRM req-new-1/);
});

test('HR ADD CONFIRM invokes new-employee provisioning exactly once',async()=>{
  const state={sql:[],actor:null,pending:false,staff:null,lineBound:false};
  let adds=0;
  const calls=await lineReply(()=>handleHrText(env(state),event('HR ADD CONFIRM req-new-1'),owner,'trace',{getOnboarding:async()=>request,addNew:async()=>{adds++;return{employeeId:'EMP005',staffName:'Noi New Staff',idempotent:false};}}));
  assert.equal(adds,1);
  assert.match(calls[0].messages[0].text,/EMP005/);
  assert.match(calls[0].messages[0].text,/HR_STAFF_CONFIG/);
});

test('Owner can choose an existing unbound EMP004 without creating a duplicate employee',async()=>{
  const state={sql:[],actor:null,pending:false,staff:null,lineBound:false};
  const calls=await lineReply(()=>handleHrText(env(state),event('HR STAFF req-new-1'),owner,'trace',{getOnboarding:async()=>request,listUnboundStaff:async()=>[emp004]}));
  const rendered=messageJson(calls);
  assert.match(rendered,/EMP004/);
  assert.match(rendered,/Noi/);
  assert.match(rendered,/HR LINK req-new-1 EMP004/);
});

test('HR LINK requires an explicit confirmation before binding EMP004',async()=>{
  const state={sql:[],actor:null,pending:false,staff:null,lineBound:false};
  let links=0;
  const preview=await lineReply(()=>handleHrText(env(state),event('HR LINK req-new-1 EMP004'),owner,'trace',{getOnboarding:async()=>request,getUnboundStaff:async()=>emp004,linkExisting:async()=>{links++;return{employeeId:'EMP004',staffName:'Noi',idempotent:false};}}));
  assert.equal(links,0);
  assert.match(messageJson(preview),/HR LINK CONFIRM req-new-1 EMP004/);
  const confirmed=await lineReply(()=>handleHrText(env(state),event('HR LINK CONFIRM req-new-1 EMP004'),owner,'trace',{getOnboarding:async()=>request,linkExisting:async()=>{links++;return{employeeId:'EMP004',staffName:'Noi',idempotent:false};}}));
  assert.equal(links,1);
  assert.match(confirmed[0].messages[0].text,/EMP004/);
  assert.match(confirmed[0].messages[0].text,/เชื่อม LINE/);
});

test('non-owner cannot run Owner onboarding actions',async()=>{
  const state={sql:[],actor:null,pending:false,staff:null,lineBound:false};
  let adds=0;
  const calls=await lineReply(()=>handleHrText(env(state),event('HR ADD CONFIRM req-new-1'),employeeActor,'trace',{addNew:async()=>{adds++;return{employeeId:'EMP005',staffName:'x',idempotent:false};}}));
  assert.equal(adds,0);
  assert.match(calls[0].messages[0].text,/verified Owner LINE account/);
});

test('typing EMP004 after a LINE-first HR request does not enter legacy Staff-ID registration',async()=>{
  const state={sql:[],actor:null,pending:true,staff:{employee_id:'EMP004',staff_name:'Noi',status:'ACTIVE',existing_binding:null},lineBound:false};
  const calls=await lineReply(()=>handleHrText(env(state),event('EMP004'),null,'trace',{hasPendingOnboarding:async()=>true}));
  assert.match(calls[0].messages[0].text,/do not need to enter a Staff ID/i);
  assert.equal(state.sql.some(entry=>entry.sql.includes('PENDING_OWNER_APPROVAL')),false);
});

test('already linked HR returns a sanitised profile without raw LINE user ID',async()=>{
  const state={sql:[],actor:null,pending:false,staff:null,lineBound:false};
  const calls=await lineReply(()=>handleHrText(env(state),event('HR'),employeeActor,'trace'));
  assert.match(calls[0].messages[0].text,/HR Profile/);
  assert.doesNotMatch(calls[0].messages[0].text,/U-SECRET/);
});

test('Owner HR with no pending onboarding explains the one-step employee action',async()=>{
  const state={sql:[],actor:null,pending:false,staff:null,lineBound:false};
  const calls=await lineReply(()=>handleHrText(env(state),event('HR'),owner,'trace',{listOnboarding:async()=>[]}));
  assert.match(calls[0].messages[0].text,/คำขอพนักงานใหม่: 0/);
  assert.match(calls[0].messages[0].text,/พนักงานใหม่ให้พิมพ์ HR/);
});

test('legacy HR PENDING remains Owner-only during transition',async()=>{
  const state={sql:[],actor:null,pending:false,staff:null,lineBound:false};
  const calls=await lineReply(()=>handleHrText(env(state),event('HR PENDING'),owner,'trace'));
  assert.match(calls[0].messages[0].text,/No pending requests/);
  const denied=await lineReply(()=>handleHrText(env(state),event('HR PENDING'),null,'trace'));
  assert.match(denied[0].messages[0].text,/verified Owner LINE account/);
});

test('legacy HR SYNC remains as Owner-only fallback but is no longer normal onboarding',async()=>{
  const state={sql:[],actor:null,pending:false,staff:null,lineBound:false};
  let syncCalls=0;
  const calls=await lineReply(()=>handleHrText(env(state),event('HR SYNC'),owner,'trace',{importConfiguredStaff:async()=>{syncCalls++;return{count:5,employees:[]};}}));
  assert.equal(syncCalls,1);
  assert.match(calls[0].messages[0].text,/legacy fallback/i);
  assert.match(calls[0].messages[0].text,/Processed 5 staff rows/);
  assert.equal(state.sql.some(entry=>entry.sql.includes('INSERT INTO line_identity_bindings')),false);
});

test('non-owner cannot run legacy HR SYNC',async()=>{
  const state={sql:[],actor:null,pending:false,staff:null,lineBound:false};
  let syncCalls=0;
  const calls=await lineReply(()=>handleHrText(env(state),event('HR SYNC'),null,'trace',{importConfiguredStaff:async()=>{syncCalls++;return{count:0,employees:[]};}}));
  assert.equal(syncCalls,0);
  assert.match(calls[0].messages[0].text,/verified Owner LINE account/);
});

test('legacy HR SYNC failure is sanitized and never binds LINE',async()=>{
  const state={sql:[],actor:null,pending:false,staff:null,lineBound:false};
  const calls=await lineReply(()=>handleHrText(env(state),event('HR SYNC'),owner,'trace',{importConfiguredStaff:async()=>{throw new Error('private provider detail');}}));
  assert.match(calls[0].messages[0].text,/HR staff sync failed/);
  assert.doesNotMatch(calls[0].messages[0].text,/private provider detail/);
  assert.equal(state.sql.some(entry=>entry.sql.includes('INSERT INTO line_identity_bindings')),false);
});