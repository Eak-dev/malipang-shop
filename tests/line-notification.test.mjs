import test from "node:test";
import assert from "node:assert/strict";
import {
  downloadLineContent,
  pushActionableFlex,
  pushConfirmation,
  pushOwnerAlert,
  pushText
} from "../dist/line/api.js";
import {recoverQuotaExhaustedLineNotifications} from "../dist/line/attendance-notification.js";

function testEnv(metrics){
  return {
    RUNTIME_MODE:"production",
    SHADOW_LINE_OUTPUT:"false",
    LINE_CHANNEL_ACCESS_TOKEN:"test-token",
    LINE_OWNER_USER_ID:"owner",
    EXTERNAL_API_TIMEOUT_MS:"1000",
    DB:{
      prepare(sql){
        return {
          bind(...values){
            return {
              async run(){
                metrics.push({sql,values});
                return {meta:{changes:1}};
              }
            };
          }
        };
      }
    }
  };
}

function metricNames(metrics){
  return metrics
    .filter(item=>item.sql.includes("INSERT INTO metrics"))
    .map(item=>item.values[1]);
}

test("optional text notification HTTP 429 is audited without failing business processing",async()=>{
  const originalFetch=globalThis.fetch,metrics=[];
  globalThis.fetch=async()=>new Response('{"message":"rate limited"}',{status:429});
  try{
    await assert.doesNotReject(pushText(testEnv(metrics),"recipient","saved","trace"));
    assert.deepEqual(metricNames(metrics),["line_push_ms","line_notification_failure"]);
    const failure=metrics.find(item=>item.values[1]==="line_notification_failure");
    assert.deepEqual(JSON.parse(failure.values[3]),{channel:"push",status:"429"});
  }finally{
    globalThis.fetch=originalFetch;
  }
});

test("actionable confirmation notifications remain strict and recoverable",async()=>{
  const originalFetch=globalThis.fetch,metrics=[];
  globalThis.fetch=async()=>new Response("rate limited",{status:429});
  try{
    await assert.rejects(pushActionableFlex(testEnv(metrics),"recipient",{type:"flex"},"trace"),/HTTP 429/);
    await assert.rejects(pushConfirmation(testEnv(metrics),"recipient","Confirm","Body","yes","no","trace"),/HTTP 429/);
    assert.deepEqual(metricNames(metrics),["line_push_ms","line_push_ms"]);
  }finally{
    globalThis.fetch=originalFetch;
  }
});

test("required LINE operations still propagate HTTP failures",async()=>{
  const originalFetch=globalThis.fetch,metrics=[];
  globalThis.fetch=async()=>new Response("rate limited",{status:429});
  try{
    await assert.rejects(pushOwnerAlert(testEnv(metrics),"alert","trace"),/HTTP 429/);
    await assert.rejects(downloadLineContent(testEnv(metrics),"message",false,"trace"),/HTTP 429/);
  }finally{
    globalThis.fetch=originalFetch;
  }
});

test("shadow mode suppresses owner DLQ alerts with all other LINE output",async()=>{
  const originalFetch=globalThis.fetch,metrics=[],env=testEnv(metrics);
  env.RUNTIME_MODE="shadow";
  let calls=0;
  globalThis.fetch=async()=>{calls+=1;return new Response("unexpected",{status:500});};
  try{
    await assert.doesNotReject(pushOwnerAlert(env,"alert","trace"));
    assert.equal(calls,0);
    assert.deepEqual(metricNames(metrics),[]);
  }finally{
    globalThis.fetch=originalFetch;
  }
});

test("manual quota recovery re-enqueues only an existing notification payload",async()=>{
  const writes=[],sent=[];
  const job={kind:"LINE_NOTIFICATION",to:"test-recipient",messages:[{type:"text",text:"saved"}],purpose:"EXPENSE_RESPONSE",retryKey:"retry-key",traceId:"trace"};
  const env={
    RUNTIME_MODE:"production",SHADOW_LINE_OUTPUT:"false",LINE_CHANNEL_ACCESS_TOKEN:"test-token",EXTERNAL_API_TIMEOUT_MS:"1000",
    JOB_QUEUE:{async send(value){sent.push(value);}},
    DB:{prepare(sql){return{bind(...values){return{
      async all(){return{results:sql.includes("LINE_PUSH_QUOTA_EXHAUSTED")?[{id:"failed",trace_id:"trace",payload_json:JSON.stringify(job),updated_at:"2026-07-31T00:00:00Z"}]:[]};},
      async run(){writes.push({sql,values});return{meta:{changes:1}};}
    };}};}}
  };
  const count=await recoverQuotaExhaustedLineNotifications(env,{purpose:"EXPENSE_RESPONSE",limit:1});
  assert.equal(count,1);
  assert.deepEqual(sent,[job]);
  assert.equal(writes.filter(item=>item.sql.includes("LINE_NOTIFICATION_MANUAL_RECOVERY_ENQUEUED")).length,1);
});
