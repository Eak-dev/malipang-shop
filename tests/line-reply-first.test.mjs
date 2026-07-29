import test from "node:test";
import assert from "node:assert/strict";
import {respondFlexToLineEvent,respondTextToLineEvent} from "../dist/line/event-response.js";
import {getLineMessageQuota} from "../dist/line/api.js";
import {lineCapabilityChecks} from "../dist/admin/readiness.js";

function db(state){
  return{
    prepare(sql){
      return{
        values:[],
        bind(...values){this.values=values;return this;},
        async run(){
          state.sql.push({sql,values:this.values});
          if(sql.includes("INSERT INTO failed_jobs"))state.failed+=1;
          return{meta:{changes:1}};
        },
        async first(){return{ok:1};},
        async all(){return{results:[]};}
      };
    }
  };
}
function env(state){
  return{
    DB:db(state),
    JOB_QUEUE:{async send(job){state.queued.push(job);}},
    RUNTIME_MODE:"production",
    SHADOW_LINE_OUTPUT:"false",
    LINE_CHANNEL_ACCESS_TOKEN:"token",
    EXTERNAL_API_TIMEOUT_MS:"1000",
    ATTENDANCE_ENABLED:"true",
    ATTENDANCE_STORE_LAT:"13.89682",
    ATTENDANCE_STORE_LNG:"100.60830",
    ATTENDANCE_ALLOWED_RADIUS_M:"120",
    ATTENDANCE_MAX_PHOTO_AGE_MIN:"3",
    R2_EVIDENCE_ENABLED:"false",
    GOOGLE_SERVICE_ACCOUNT_EMAIL:"service@example.com",
    GOOGLE_PRIVATE_KEY_BASE64:"unused",
    GOOGLE_SPREADSHEET_ID:"sheet",
    SHEET_EXPENSE_DAILY:"daily"
  };
}
const event={type:"message",timestamp:Date.now(),source:{type:"user",userId:"U1"},replyToken:"reply-once",webhookEventId:"W1",message:{id:"M1",type:"text",text:"test"}};

test("synchronous employee text uses one Reply API call and creates no Push job",async()=>{
  const state={sql:[],queued:[],failed:0},testEnv=env(state),calls=[],originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{calls.push({url:String(url),body:JSON.parse(init.body)});return new Response("{}",{status:200});};
  try{
    assert.equal(await respondTextToLineEvent(testEnv,event,"saved",{traceId:"trace",purpose:"EMPLOYEE_RESPONSE"}),"REPLY");
  }finally{globalThis.fetch=originalFetch;}
  assert.equal(calls.length,1);
  assert.match(calls[0].url,/\/reply$/);
  assert.equal(calls[0].body.replyToken,"reply-once");
  assert.equal(state.queued.length,0);
  assert.equal(state.failed,0);
});

test("Expense actionable Flex also uses Reply API without Push regression",async()=>{
  const state={sql:[],queued:[],failed:0},testEnv=env(state),calls=[],originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{calls.push({url:String(url),body:JSON.parse(init.body)});return new Response("{}",{status:200});};
  try{
    assert.equal(await respondFlexToLineEvent(testEnv,{...event,webhookEventId:"W-flex"}, {type:"flex",altText:"Review expense",contents:{type:"bubble"}},{traceId:"trace-flex",purpose:"EXPENSE_RESPONSE"}),"REPLY");
  }finally{globalThis.fetch=originalFetch;}
  assert.equal(calls.length,1);
  assert.match(calls[0].url,/\/reply$/);
  assert.equal(calls[0].body.messages[0].type,"flex");
  assert.equal(state.queued.length,0);
});

test("missing reply token creates one deterministic Push fallback",async()=>{
  const state={sql:[],queued:[],failed:0},testEnv=env(state);
  assert.equal(await respondTextToLineEvent(testEnv,{...event,replyToken:undefined},"saved",{traceId:"trace-fallback",purpose:"EMPLOYEE_RESPONSE"}),"PUSH_FALLBACK");
  assert.equal(state.queued.length,1);
  assert.equal(state.queued[0].kind,"LINE_NOTIFICATION");
  assert.equal(state.failed,1);
});

test("quota endpoints report exhausted Push without sending a message",async()=>{
  const state={sql:[],queued:[],failed:0},testEnv=env(state),calls=[],originalFetch=globalThis.fetch;
  globalThis.fetch=async url=>{
    calls.push(String(url));
    return String(url).endsWith("/quota")
      ?Response.json({type:"limited",value:300})
      :Response.json({totalUsage:300});
  };
  try{
    assert.deepEqual(await getLineMessageQuota(testEnv),{targetType:"limited",targetLimit:300,totalUsage:300,remaining:0,pushCapacity:"EXHAUSTED"});
  }finally{globalThis.fetch=originalFetch;}
  assert.equal(calls.length,2);
  assert.ok(calls.every(url=>url.includes("/quota")));
});

test("readiness treats exhausted Push as degraded while Reply capability remains healthy",()=>{
  const checks=lineCapabilityChecks(
    {ok:true,detail:{displayName:"MaliPang"}},
    {ok:true,detail:{targetType:"limited",targetLimit:300,totalUsage:300,remaining:0,pushCapacity:"EXHAUSTED"}}
  );
  assert.equal(checks.lineReplyCapability.ok,true);
  assert.equal(checks.linePushCapacity.ok,true);
  assert.equal(checks.linePushCapacity.detail.status,"EXHAUSTED");
  assert.equal(checks.linePushCapacity.detail.severity,"DEGRADED");
});
