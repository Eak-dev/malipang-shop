import test from "node:test";
import assert from "node:assert/strict";
import {handleAttendance} from "../dist/attendance/service.js";
import {
  buildAttendanceNotificationJob,
  deliverLineNotification,
  processLineNotificationMessage,
  recoverPendingLineNotifications
} from "../dist/line/attendance-notification.js";
import {claimInboundEvent} from "../dist/db/repositories.js";

function database(state){
  return{
    prepare(sql){
      return{
        values:[],
        bind(...values){this.values=values;return this;},
        async run(){
          state.sql.push({sql,values:this.values});
          if(sql.includes("INSERT INTO inbound_events"))return{meta:{changes:0}};
          if(sql.includes("INSERT INTO failed_jobs")){
            state.failedPayload=String(this.values[4]);
            state.failedOpen=true;
          }
          if(sql.includes("UPDATE failed_jobs SET status='RESOLVED'"))state.failedOpen=false;
          return{meta:{changes:1}};
        },
        async first(){
          if(sql.includes("SELECT status FROM inbound_events"))return{status:"COMPLETED"};
          if(sql.includes("SELECT payload_json FROM failed_jobs")&&state.failedOpen)return{payload_json:state.failedPayload};
          return null;
        },
        async all(){return{results:[],meta:{}};}
      };
    },
    async batch(statements){state.batchCount+=1;return statements.map(()=>({meta:{changes:1}}));}
  };
}

function fixture(options={}){
  const state={sql:[],batchCount:0,attendanceCommits:0,queued:[],sheetBatches:[],failedPayload:"",failedOpen:false};
  const result=options.result||{eventId:"att_1",punchType:"IN",workDate:"2026-07-29",officialTime:"04:13",status:"NORMAL",lateMinutes:3,confirmedWageSatang:0,pendingWageSatang:50000,validationCode:"OK",version:1};
  const env={
    DB:database(state),
    JOB_QUEUE:{
      async send(job){state.queued.push(job);},
      async sendBatch(messages){state.sheetBatches.push(...messages);}
    },
    ATTENDANCE_COORDINATOR:{
      idFromName(){return{};},
      get(){return{async fetch(){state.attendanceCommits+=1;return Response.json(typeof result==="function"?result(state.attendanceCommits):result);}};}
    },
    EVIDENCE:{async put(){return{};}},
    R2_EVIDENCE_ENABLED:"false",
    SHEETS_SYNC_ENABLED:"true",
    RUNTIME_MODE:"production",
    SHADOW_LINE_OUTPUT:"false",
    LINE_CHANNEL_ACCESS_TOKEN:"token",
    EXTERNAL_API_TIMEOUT_MS:"1000",
    ATTENDANCE_STORE_LAT:"13.89682",
    ATTENDANCE_STORE_LNG:"100.60830",
    ATTENDANCE_ALLOWED_RADIUS_M:"120",
    ATTENDANCE_MAX_PHOTO_AGE_MIN:"3",
    ATTENDANCE_OVERLAY_MIN_CONFIDENCE:"0.9",
    ATTENDANCE_CLOCK_MIN_CONFIDENCE:"0.7"
  };
  return{state,env};
}

const employee={employeeId:"OWN001",staffName:"Test",lineUserId:"U1",scheduledIn:"04:00",scheduledOut:"16:00",dailyWageSatang:50000,graceMin:10,lateDeductionSatang:0,earlyDeductionSatang:0,canSubmitExpense:true,status:"ACTIVE"};
const event={type:"message",timestamp:Date.parse("2026-07-28T21:13:34.700Z"),source:{type:"user",userId:"U1"},message:{id:"M1",type:"image"},webhookEventId:"W1"};
const replyEvent={...event,replyToken:"reply-token"};
const validReading={kind:"CLOCK",hour:null,minute:null,month:null,day:null,weekday:null,confidence:.99,clockFullyVisible:true,clockPresent:true,clockConfidence:.99,overlayPresent:true,overlayTextWhite:true,photoDate:"2026-07-29",photoTime:"04:13:18",latitude:13.89682,longitude:100.60830,locationText:"Yingcharoen Market",overlayRawText:"29 Jul 2026 04:13:18 +13.89682,+100.60830",overlayConfidence:.99,needsNewPhoto:false,note:"",provider:"test",raw:null};

function queueMessage(job){
  const state={acked:0,retries:[]};
  return{
    state,
    message:{body:job,ack(){state.acked+=1;},retry(options){state.retries.push(options||{});}}
  };
}

test("valid Attendance commits once and successful confirmation is delivered",async()=>{
  const {state,env}=fixture();
  assert.equal(await handleAttendance(env,event,employee,validReading,new Uint8Array([1]).buffer,"trace-valid"),true);
  assert.equal(state.attendanceCommits,1);
  assert.equal(state.queued.length,1);
  assert.equal(state.queued[0].kind,"LINE_NOTIFICATION");
  const originalFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(_url,init)=>{calls.push(init);return new Response("{}",{status:200});};
  try{await deliverLineNotification(env,state.queued[0]);}finally{globalThis.fetch=originalFetch;}
  assert.equal(calls.length,1);
  assert.equal(new Headers(calls[0].headers).get("X-Line-Retry-Key"),state.queued[0].retryKey);
  assert.equal(state.attendanceCommits,1);
});

test("valid Attendance uses Reply API and does not require Push capacity",async()=>{
  const {state,env}=fixture(),originalFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{
    calls.push({url:String(url),init});
    if(String(url).endsWith("/v2/bot/message/push"))return new Response('{"message":"You have reached your monthly limit."}',{status:429});
    return new Response("{}",{status:200});
  };
  try{
    assert.equal(await handleAttendance(env,replyEvent,employee,validReading,new Uint8Array([1]).buffer,"trace-reply-valid"),true);
  }finally{globalThis.fetch=originalFetch;}
  assert.equal(state.attendanceCommits,1);
  assert.equal(state.queued.length,0);
  assert.equal(calls.length,1);
  assert.match(calls[0].url,/\/v2\/bot\/message\/reply$/);
  assert.equal(JSON.parse(calls[0].init.body).replyToken,"reply-token");
});

test("stale Attendance uses Reply API rejection and never requires Push capacity",async()=>{
  const {state,env}=fixture(),staleEvent={...replyEvent,timestamp:Date.parse("2026-07-29T01:49:56.663Z"),webhookEventId:"W-stale-reply",message:{id:"M-stale-reply",type:"image"}},originalFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return new Response("{}",{status:200});};
  try{
    assert.equal(await handleAttendance(env,staleEvent,employee,validReading,new Uint8Array([2]).buffer,"trace-stale-reply"),false);
  }finally{globalThis.fetch=originalFetch;}
  assert.equal(state.attendanceCommits,0);
  assert.equal(state.sheetBatches.length,0);
  assert.equal(state.queued.length,0);
  assert.equal(calls.length,1);
  assert.match(calls[0].url,/\/v2\/bot\/message\/reply$/);
  assert.match(JSON.parse(calls[0].init.body).messages[0].text,/old|เก่า|stale/i);
});

test("temporary Reply failure preserves Attendance and creates only notification fallback",async()=>{
  const {state,env}=fixture(),originalFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(url)=>{calls.push(String(url));return new Response("temporary",{status:503});};
  try{
    await assert.doesNotReject(handleAttendance(env,replyEvent,employee,validReading,new Uint8Array([1]).buffer,"trace-reply-temporary"));
  }finally{globalThis.fetch=originalFetch;}
  assert.equal(state.attendanceCommits,1);
  assert.equal(calls.length,1);
  assert.match(calls[0],/\/v2\/bot\/message\/reply$/);
  assert.equal(state.queued.length,1);
  assert.equal(state.queued[0].kind,"LINE_NOTIFICATION");
  assert.equal(state.queued[0].purpose,"ATTENDANCE_RESULT");
});

test("monthly Push quota exhaustion is observable and is not aggressively retried",async()=>{
  const {state,env}=fixture(),job=await buildAttendanceNotificationJob({to:"U1",text:"fallback",identity:"W-quota:result",purpose:"ATTENDANCE_RESULT",traceId:"trace-quota"}),current=queueMessage(job),originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response('{"message":"You have reached your monthly limit."}',{status:429});
  try{await processLineNotificationMessage(env,"malipang-jobs",current.message,1);}finally{globalThis.fetch=originalFetch;}
  assert.equal(current.state.acked,1);
  assert.equal(current.state.retries.length,0);
  assert.equal(state.attendanceCommits,0);
  assert.ok(state.sql.some(item=>item.values.includes("LINE_PUSH_QUOTA_EXHAUSTED")));
  assert.ok(state.sql.some(item=>item.values.includes("line_push_quota_exhausted")));
});

test("temporary LINE failure retries notification only and then succeeds idempotently",async()=>{
  const {state,env}=fixture();
  await handleAttendance(env,event,employee,validReading,new Uint8Array([1]).buffer,"trace-retry");
  const job=state.queued[0],first=queueMessage(job),second=queueMessage(job),retryKeys=[];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{
    retryKeys.push(new Headers(init.headers).get("X-Line-Retry-Key"));
    if(retryKeys.length===1)return new Response("rate limited",{status:429,headers:{"Retry-After":"2"}});
    return new Response("{}",{status:200});
  };
  try{
    await processLineNotificationMessage(env,"malipang-jobs",first.message,1);
    assert.equal(first.state.acked,0);
    assert.equal(first.state.retries.length,1);
    assert.ok(first.state.retries[0].delaySeconds>=60);
    await processLineNotificationMessage(env,"malipang-jobs",second.message,2);
  }finally{globalThis.fetch=originalFetch;}
  assert.equal(second.state.acked,1);
  assert.deepEqual(retryKeys,[job.retryKey,job.retryKey]);
  assert.equal(state.attendanceCommits,1);
  assert.ok(state.sql.some(item=>item.sql.includes("INSERT INTO failed_jobs")));
  assert.ok(state.sql.some(item=>item.sql.includes("UPDATE failed_jobs SET status='RESOLVED'")));
});

test("duplicate webhook claim is terminal before Attendance is processed again",async()=>{
  const {state,env}=fixture();
  const existingAttendanceRecords=1;
  assert.equal(await claimInboundEvent(env,event,"trace-redelivery","2026-07-28T21:13:34.700Z"),"TERMINAL");
  assert.equal(state.attendanceCommits,0);
  assert.equal(existingAttendanceRecords,1);
  assert.equal(state.queued.length,0);
});

test("ambiguous notification enqueue never retries the committed Attendance business event",async()=>{
  const {state,env}=fixture({result:attempt=>attempt===1
    ?{eventId:"att_1",punchType:"IN",workDate:"2026-07-29",officialTime:"04:13",status:"NORMAL",lateMinutes:3,confirmedWageSatang:0,pendingWageSatang:50000,validationCode:"OK",version:1}
    :{eventId:"att_1",punchType:"DUPLICATE",workDate:"2026-07-29",officialTime:"04:13",status:"DUPLICATE",lateMinutes:3,confirmedWageSatang:0,pendingWageSatang:50000,validationCode:"DUPLICATE_MESSAGE",version:1}
  });
  const accepted=[];
  env.JOB_QUEUE.send=async job=>{
    accepted.push(structuredClone(job));
    throw new Error("Queue enqueue result unknown");
  };
  await assert.doesNotReject(handleAttendance(env,event,employee,validReading,new Uint8Array([1]).buffer,"trace-ambiguous"));
  assert.equal(state.attendanceCommits,1);
  assert.equal(accepted.length,1);
  assert.match(accepted[0].messages[0].text,/Check-in recorded/);
  assert.doesNotMatch(accepted[0].messages[0].text,/already complete/i);
  assert.ok(state.failedOpen);
});

test("stale Attendance never commits and rejection notification is retryable",async()=>{
  const {state,env}=fixture();
  const staleEvent={...event,timestamp:Date.parse("2026-07-29T01:49:56.663Z"),webhookEventId:"W-stale",message:{id:"M-stale",type:"image"}};
  assert.equal(await handleAttendance(env,staleEvent,employee,validReading,new Uint8Array([2]).buffer,"trace-stale"),false);
  assert.equal(state.attendanceCommits,0);
  assert.equal(state.sheetBatches.length,0);
  assert.equal(state.queued.length,1);
  assert.equal(state.queued[0].purpose,"ATTENDANCE_REJECTION");
  const first=queueMessage(state.queued[0]),second=queueMessage(state.queued[0]);
  const originalFetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async()=>++calls===1?new Response("temporary",{status:503}):new Response("{}",{status:200});
  try{
    await processLineNotificationMessage(env,"malipang-jobs",first.message,1);
    await processLineNotificationMessage(env,"malipang-jobs",second.message,2);
  }finally{globalThis.fetch=originalFetch;}
  assert.equal(first.state.retries.length,1);
  assert.equal(second.state.acked,1);
  assert.equal(state.attendanceCommits,0);
});

test("permanent notification failure is observable without Attendance replay",async()=>{
  const {state,env}=fixture();
  const job=await buildAttendanceNotificationJob({to:"U1",text:"rejected",identity:"W-permanent:rejection",purpose:"ATTENDANCE_REJECTION",traceId:"trace-permanent"});
  const current=queueMessage(job),originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response("bad request",{status:400});
  try{await processLineNotificationMessage(env,"malipang-jobs",current.message,1);}finally{globalThis.fetch=originalFetch;}
  assert.equal(current.state.acked,1);
  assert.equal(current.state.retries.length,0);
  assert.equal(state.attendanceCommits,0);
  const failed=state.sql.find(item=>item.sql.includes("INSERT INTO failed_jobs"));
  assert.ok(failed);
  assert.match(String(failed.values[3]),/^LINE_NOTIFICATION:/);
  assert.ok(state.sql.some(item=>item.values.includes("line_notification_permanent_failure")));
});

test("LINE retry-key 409 is treated as already delivered",async()=>{
  const {env}=fixture(),job=await buildAttendanceNotificationJob({to:"U1",text:"saved",identity:"W-accepted:result",purpose:"ATTENDANCE_RESULT",traceId:"trace-accepted"});
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response('{"message":"already accepted"}',{status:409,headers:{"x-line-accepted-request-id":"accepted"}});
  try{await assert.doesNotReject(deliverLineNotification(env,job));}finally{globalThis.fetch=originalFetch;}
});

test("scheduled recovery atomically re-enqueues stranded notification outbox only",async()=>{
  const job=await buildAttendanceNotificationJob({to:"U1",text:"saved",identity:"W-recover:result",purpose:"ATTENDANCE_RESULT",traceId:"trace-recover"}),state={queued:[],claimed:0,metrics:[]},old="2026-07-29T00:00:00.000Z";
  const env={
    RUNTIME_MODE:"production",
    SHADOW_LINE_OUTPUT:"false",
    JOB_QUEUE:{async send(value){state.queued.push(value);}},
    DB:{
      prepare(sql){
        return{
          values:[],
          bind(...values){this.values=values;return this;},
          async all(){
            if(sql.includes("SELECT id,trace_id,payload_json"))return{results:[{id:"failed_1",trace_id:"trace-recover",payload_json:JSON.stringify(job),updated_at:old}]};
            return{results:[]};
          },
          async run(){
            if(sql.includes("LINE_NOTIFICATION_RECOVERY_ENQUEUED")){state.claimed+=1;return{meta:{changes:state.claimed===1?1:0}};}
            if(sql.includes("INSERT INTO metrics"))state.metrics.push(this.values);
            return{meta:{changes:1}};
          }
        };
      }
    }
  };
  assert.equal(await recoverPendingLineNotifications(env,60,20),1);
  assert.equal(state.queued.length,1);
  assert.equal(state.queued[0].retryKey,job.retryKey);
  assert.equal(await recoverPendingLineNotifications(env,60,20),0);
  assert.equal(state.queued.length,1);
});
