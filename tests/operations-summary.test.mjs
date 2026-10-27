import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {operationsSummary} from '../dist/operations/summary.js';
import {maintenanceSteps} from '../dist/operations/maintenance.js';
import {handleAdmin} from '../dist/admin/handler.js';
import {createFailedJob} from '../dist/db/repositories.js';
const now=Date.parse('2026-10-27T05:00:00.000Z'),secret='SYNTHETIC_PRIVATE_PAYLOAD_DO_NOT_EXPOSE';
const metric=(h,name,value,labels={},offset=-60000)=>h.sqlite.prepare('INSERT INTO metrics(trace_id,name,value_ms,labels_json,created_at) VALUES(?,?,?,?,?)').run(secret,name,value,typeof labels==='string'?labels:JSON.stringify(labels),new Date(now+offset).toISOString());
function healthy(h,offset=-60000){for(const step of maintenanceSteps)metric(h,'scheduled_maintenance_step_ms',10,{step,outcome:'SUCCESS'},offset);}
function inbound(h,id,offset,status='FAILED'){
 h.sqlite.prepare(`INSERT INTO inbound_events(webhook_event_id,message_id,line_user_id,message_type,route,status,attempt_count,error,trace_id,received_at,last_attempt_at) VALUES(?,?,?,'text','ERROR',?,1,?,?,?,?)`).run(id,id,secret,status,secret,secret,new Date(now+offset).toISOString(),new Date(now+offset).toISOString());
}
test('summary reports UNKNOWN before scheduled telemetry exists and separates old failures from new incidents',async()=>{
 const h=ownerOrderFixture();try{
  inbound(h,'synthetic_old',-3*86400000);metric(h,'expense_image_queue_wait_ms',99000,{});
  const r=await operationsSummary(h.env,now);assert.equal(r.status,'UNKNOWN');assert.equal(r.inbound.olderFailedEvents,1);assert.equal(r.inbound.recentFailedEvents,0);
  assert.equal(r.latency.find(x=>x.name==='expense_image_queue_wait_ms').samples,0);assert.ok(r.scheduled.steps.every(s=>s.status==='UNKNOWN'));
 }finally{h.close();}
});
test('summary uses only corrected timing semantics, valid labels and a bounded exact time window',async()=>{
 const h=ownerOrderFixture();try{
  healthy(h);metric(h,'expense_image_queue_wait_ms',99000,{});metric(h,'expense_image_queue_wait_ms',4000,{semantics:'INGRESS_TO_START_V2',clockSkew:'false'});
  metric(h,'expense_image_queue_wait_ms',0,{semantics:'INGRESS_TO_START_V2',clockSkew:'true'});
  metric(h,'expense_image_queue_wait_ms',120000,'not JSON');metric(h,'expense_image_queue_wait_ms',500000,{semantics:'INGRESS_TO_START_V2',clockSkew:'false'},60000);
  metric(h,'expense_image_extraction_ms',9000);metric(h,'expense_image_total_ms',11800);metric(h,'expense_image_end_to_end_ms',15800,{semantics:'INGRESS_TO_COMPLETION_V2',clockSkew:'false'});
  metric(h,secret,123,{step:secret,outcome:secret});metric(h,'scheduled_maintenance_step_ms',1,{step:secret,outcome:'FAILED'});
  const before=h.sqlite.prepare('SELECT total_changes() n').get().n,r=await operationsSummary(h.env,now);
  assert.equal(r.status,'OK');assert.equal(r.latency.find(x=>x.name==='expense_image_queue_wait_ms').samples,1);assert.equal(r.latency.find(x=>x.name==='expense_image_queue_wait_ms').averageMs,4000);
  assert.equal(r.latency.find(x=>x.name==='expense_image_end_to_end_ms').averageMs,15800);assert.equal(h.sqlite.prepare('SELECT total_changes() n').get().n,before);
  assert.doesNotMatch(JSON.stringify(r),new RegExp(secret));assert.doesNotMatch(JSON.stringify(r),/line_user_id|payload_json|image_key|trace_id/);
 }finally{h.close();}
});
test('newest scheduled outcome wins ties and preserves failure history without reporting a recovered step as failed',async()=>{
 const h=ownerOrderFixture();try{
  metric(h,'scheduled_maintenance_step_ms',30,{step:'payroll',outcome:'FAILED'});healthy(h);
  const r=await operationsSummary(h.env,now),payroll=r.scheduled.steps.find(x=>x.step==='payroll');
  assert.equal(payroll.status,'SUCCESS');assert.equal(payroll.attempts,2);assert.equal(payroll.failures,1);assert.equal(r.status,'OK');
  metric(h,'scheduled_maintenance_step_ms',50,{step:'payroll',outcome:'FAILED'},-1000);
  const failed=await operationsSummary(h.env,now);assert.equal(failed.status,'ATTENTION');assert.ok(failed.actions.includes('INSPECT_SCHEDULED_STEPS'));
 }finally{h.close();}
});
test('a cron outage remains STALE beyond 24 hours while counts stay inside the reporting window',async()=>{
 const h=ownerOrderFixture();try{
  healthy(h,-25*3600000);metric(h,'scheduled_maintenance_step_ms',30,{step:'payroll',outcome:'FAILED'},-26*3600000);
  healthy(h,60000);
  const stale=await operationsSummary(h.env,now);
  assert.equal(stale.status,'ATTENTION');assert.ok(stale.actions.includes('INSPECT_SCHEDULED_STEPS'));
  assert.ok(stale.scheduled.steps.every(s=>s.status==='STALE'&&s.lastAttemptAt===new Date(now-25*3600000).toISOString()&&s.attempts===0&&s.failures===0));
  assert.equal(stale.scheduled.steps.find(s=>s.step==='payroll').lastDurationMs,10);
  metric(h,'scheduled_maintenance_step_ms',20,{step:'payroll',outcome:'FAILED'},-1000);
  const recent=await operationsSummary(h.env,now),payroll=recent.scheduled.steps.find(s=>s.step==='payroll');
  assert.equal(payroll.status,'FAILED');assert.equal(payroll.attempts,1);assert.equal(payroll.failures,1);
  assert.ok(recent.scheduled.steps.filter(s=>s.step!=='payroll').every(s=>s.status==='STALE'&&s.attempts===0));
 }finally{h.close();}
});
test('stale cron steps, recent inbound failures and blocked notifications have distinct inspection actions',async()=>{
 const h=ownerOrderFixture();try{
  healthy(h,-16*60000);inbound(h,'synthetic_recent',-1000);inbound(h,'synthetic_future',60000);
  await createFailedJob(h.env,'malipang-jobs',secret,{kind:'LINE_NOTIFICATION',retryKey:'synthetic_quota',messages:[{type:'text',text:secret}],to:secret,purpose:'EXPENSE_RESPONSE'},'LINE_PUSH_QUOTA_EXHAUSTED');
  const r=await operationsSummary(h.env,now);assert.equal(r.status,'ATTENTION');assert.equal(r.inbound.recentFailedEvents,1);assert.equal(r.sideEffects.quotaBlockedNotifications,1);
  assert.ok(r.actions.includes('CHECK_LINE_PUSH_CAPACITY_BEFORE_MANUAL_RECOVERY'));assert.ok(r.actions.includes('INSPECT_INBOUND_WITHOUT_BLIND_REPLAY'));assert.ok(r.scheduled.steps.every(s=>s.status==='STALE'));
  assert.doesNotMatch(JSON.stringify(r),new RegExp(secret));
 }finally{h.close();}
});
test('admin summary denies unauthorized callers before DB access and performs no outbound calls or recovery',async t=>{
 const h=ownerOrderFixture();t.mock.method(Date,'now',()=>now);t.mock.method(globalThis,'fetch',()=>{throw new Error('Network call forbidden');});try{
  h.env.ADMIN_TOKEN='synthetic-long-admin-token-for-local-tests';healthy(h);
  const deniedEnv={...h.env,DB:{prepare(){throw new Error('Unauthorized DB read');}}};
  for(const auth of ['', 'Bearer wrong']){const r=await handleAdmin(new Request('https://local.invalid/admin/operations/summary',{headers:{authorization:auth}}),deniedEnv,{});assert.equal(r.status,401);}
  const response=await handleAdmin(new Request('https://local.invalid/admin/operations/summary',{headers:{authorization:'Bearer '+h.env.ADMIN_TOKEN}}),h.env,{});
  assert.equal(response.status,200);assert.equal((await response.json()).status,'OK');assert.equal(h.queue.length,0);
 }finally{h.close();}
});
test('partial D1 diagnostic failure returns a sanitized 503 and cannot masquerade as a healthy summary',async()=>{
 const env={ADMIN_TOKEN:'synthetic-long-admin-token-for-local-tests',DB:{prepare(){throw new Error(secret);}}};
 const response=await handleAdmin(new Request('https://local.invalid/admin/operations/summary',{headers:{authorization:'Bearer '+env.ADMIN_TOKEN}}),env,{});
 assert.equal(response.status,503);assert.deepEqual(await response.json(),{ok:false,error:'OPERATIONS_SUMMARY_UNAVAILABLE'});
});
test('a response fallback failure is visible even when no notification outbox could be persisted',async()=>{
 const h=ownerOrderFixture();try{
  healthy(h);metric(h,'line_reply_failure',0);metric(h,'line_response_fallback_failure',0,{reason:'ENQUEUE_FAILED',private:secret});
  const r=await operationsSummary(h.env,now);assert.equal(r.status,'ATTENTION');assert.equal(r.sideEffects.replyFailures,1);assert.equal(r.sideEffects.responseFallbackFailures,1);assert.equal(r.inbound.openFailedJobs,0);
  assert.ok(r.actions.includes('INSPECT_UNDELIVERED_RESPONSES'));assert.doesNotMatch(JSON.stringify(r),new RegExp(secret));assert.equal(h.queue.length,0);
 }finally{h.close();}
});
