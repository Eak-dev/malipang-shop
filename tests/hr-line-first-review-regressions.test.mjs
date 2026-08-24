import test from 'node:test';
import assert from 'node:assert/strict';
import {handleHrText} from '../dist/access/hr.js';

function env(){return{DB:{prepare(){return{bind(){return this;},async first(){return null;},async run(){return{meta:{changes:1}};},async all(){return{results:[]};}};},async batch(){return[];}},JOB_QUEUE:{async send(){},async sendBatch(){}},RUNTIME_MODE:'production',SHADOW_LINE_OUTPUT:'false',LINE_CHANNEL_ACCESS_TOKEN:'token',EXTERNAL_API_TIMEOUT_MS:'1000'};}
function event(text){return{type:'message',timestamp:Date.now(),source:{type:'user',userId:'U-owner'},replyToken:'reply',webhookEventId:`W-${text}`,message:{id:`M-${text}`,type:'text',text}};}
const owner={employeeId:'OWN001',role:'OWNER',scope:'ORGANIZATION',branchId:null,branchName:null,employeeStatus:'ACTIVE',roleStatus:'ACTIVE',employee:{employeeId:'OWN001',staffName:'Eak',lineUserId:'U-owner',scheduledIn:'04:00',scheduledOut:'16:00',dailyWageSatang:0,graceMin:0,lateDeductionSatang:0,earlyDeductionSatang:0,canSubmitExpense:true,status:'ACTIVE'}};
const request={requestId:'req-1',externalUserId:'U-new',displayName:'New Staff',pictureUrl:'',status:'PENDING_OWNER_SETUP',employeeId:null,requestedAt:'2026-08-24T05:00:00.000Z',reviewedBy:null};
const target={employeeId:'EMP099',staffName:'Later Staff',role:'EMPLOYEE',branchId:'B001',scheduledIn:'04:00',scheduledOut:'16:00',dailyWageBaht:500};

async function capture(run){const calls=[],original=globalThis.fetch;globalThis.fetch=async(_url,init)=>{calls.push(JSON.parse(init.body));return new Response('{}',{status:200});};try{await run();}finally{globalThis.fetch=original;}return calls;}

test('exact HR LINK selection is validated independently of the limited browse list',async()=>{
  let directLookups=0;
  const calls=await capture(()=>handleHrText(env(),event('HR LINK req-1 EMP099'),owner,'trace',{
    getOnboarding:async()=>request,
    listUnboundStaff:async()=>Array.from({length:20},(_,i)=>({...target,employeeId:`EMP${String(i+1).padStart(3,'0')}`})),
    getUnboundStaff:async(_env,id)=>{directLookups++;return id==='EMP099'?target:null;},
  }));
  assert.equal(directLookups,1);
  const rendered=JSON.stringify(calls[0]?.messages?.[0]||{});
  assert.match(rendered,/EMP099/);
  assert.match(rendered,/HR LINK CONFIRM req-1 EMP099/);
});
