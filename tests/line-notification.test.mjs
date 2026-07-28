import test from "node:test";
import assert from "node:assert/strict";
import {
  downloadLineContent,
  pushConfirmation,
  pushOwnerAlert,
  pushText
} from "../dist/line/api.js";

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

test("optional confirmation notification HTTP 429 is also best effort",async()=>{
  const originalFetch=globalThis.fetch,metrics=[];
  globalThis.fetch=async()=>new Response("rate limited",{status:429});
  try{
    await assert.doesNotReject(pushConfirmation(testEnv(metrics),"recipient","Confirm","Body","yes","no","trace"));
    assert.deepEqual(metricNames(metrics),["line_push_ms","line_notification_failure"]);
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
