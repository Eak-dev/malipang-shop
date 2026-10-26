import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {buildLineNotificationJob} from '../dist/line/attendance-notification.js';
import {createFailedJob} from '../dist/db/repositories.js';
const require=createRequire(import.meta.url),worker=require('../dist/index.js').default;

async function scheduled(h){const pending=[];await worker.scheduled({},h.env,{waitUntil(p){pending.push(p);p.catch(()=>{});}});assert.equal(pending.length,1);return Promise.allSettled(pending);}
async function withPendingEffects(h){
 h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('synthetic_sync','EXPENSE','synthetic_expense',1,'synthetic_sync_trace','PENDING',0,'2001-01-01T00:00:00.000Z')`).run();
 const job=await buildLineNotificationJob({to:'fixture_owner',messages:[{type:'text',text:'Synthetic result'}],identity:'synthetic_notification',purpose:'EXPENSE_RESPONSE',traceId:'synthetic_notification_trace'});
 await createFailedJob(h.env,'malipang-jobs',job.traceId,job,'LINE_NOTIFICATION_ENQUEUE_FAILED');
 h.sqlite.prepare("UPDATE failed_jobs SET updated_at='2001-01-01T00:00:00.000Z'").run();
}
test('actual scheduled handler continues real outbox recovery after wage refresh fails, without finalizing payroll',async t=>{
 const h=ownerOrderFixture();t.mock.method(console,'error',()=>{});try{
  await withPendingEffects(h);const prepare=h.DB.prepare.bind(h.DB),seen=[];
  h.DB.prepare=sql=>{seen.push(sql);const s=prepare(sql);if(sql.startsWith('UPDATE employees SET'))s.run=async()=>{throw new Error('private error must not escape');};return s;};
  const result=await scheduled(h);assert.equal(result[0].status,'rejected');assert.match(result[0].reason.message,/SCHEDULED_MAINTENANCE_FAILED:payroll/);assert.doesNotMatch(result[0].reason.message,/private error/);
  assert.equal(seen.some(s=>s.startsWith('SELECT employee_id,work_date FROM attendance_daily')),false);
  assert.ok(seen.some(s=>s.includes('UPDATE staff_config_sync_outbox')));
  const kinds=h.queue.map(j=>(j.body||j).kind).sort();assert.deepEqual(kinds,['LINE_NOTIFICATION','SHEETS_SYNC']);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_events').get().n,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM attendance_daily').get().n,0);
  const metrics=h.sqlite.prepare("SELECT labels_json FROM metrics WHERE name='scheduled_maintenance_step_ms'").all().map(x=>JSON.parse(x.labels_json));assert.equal(metrics.length,6);assert.deepEqual(metrics.filter(x=>x.outcome==='FAILED').map(x=>x.step),['payroll']);
  await scheduled(h);assert.equal(h.queue.length,2,'immediate cron replay must respect existing recovery cooldowns');
 }finally{h.close();}
});
test('a lease-marking failure does not skip payroll or later independent scheduled steps',async t=>{
 const h=ownerOrderFixture();t.mock.method(console,'error',()=>{});try{
  const prepare=h.DB.prepare.bind(h.DB),seen=[];h.DB.prepare=sql=>{seen.push(sql);const s=prepare(sql);if(sql.startsWith("UPDATE inbound_events SET status='STALE'"))s.run=async()=>{throw new Error('synthetic lease failure');};return s;};
  const r=await scheduled(h);assert.equal(r[0].status,'rejected');assert.match(r[0].reason.message,/inbound_leases/);
  const wage=seen.findIndex(s=>s.startsWith('UPDATE employees SET')),finalize=seen.findIndex(s=>s.startsWith('SELECT employee_id,work_date FROM attendance_daily'));
  assert.ok(wage>=0&&finalize>wage);assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM metrics WHERE name='scheduled_maintenance_step_ms'").get().n,6);
 }finally{h.close();}
});
test('partial retention audit errors are observable and remain best effort',async t=>{
 const h=ownerOrderFixture();t.mock.method(console,'error',()=>{});try{
  h.env.EVIDENCE_RETENTION_ENABLED='true';h.env.EVIDENCE={async list(){throw new Error('synthetic R2 unavailable');}};
  const r=await scheduled(h);assert.equal(r[0].status,'fulfilled');
  const rows=h.sqlite.prepare("SELECT labels_json FROM metrics WHERE name='scheduled_maintenance_step_ms'").all().map(x=>JSON.parse(x.labels_json));
  assert.deepEqual(rows.filter(x=>x.outcome==='FAILED').map(x=>x.step),['evidence_retention']);
 }finally{h.close();}
});
test('telemetry failures do not interrupt scheduled work or create business records',async t=>{
 const h=ownerOrderFixture();t.mock.method(console,'error',()=>{});try{
  await withPendingEffects(h);const prepare=h.DB.prepare.bind(h.DB);h.DB.prepare=sql=>{const s=prepare(sql);if(sql.startsWith('INSERT INTO metrics'))s.run=async()=>{throw new Error('synthetic telemetry outage');};return s;};
  const r=await scheduled(h);assert.equal(r[0].status,'fulfilled');assert.equal(h.queue.length,2);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_events').get().n,0);
 }finally{h.close();}
});
for(const [step,needle,method,expectedKinds] of [
 ['sheets_recovery','FROM sync_jobs s WHERE','all',['LINE_NOTIFICATION']],
 ['staff_config_recovery','UPDATE staff_config_sync_outbox','run',['LINE_NOTIFICATION','SHEETS_SYNC']],
 ['line_notification_recovery','SELECT id,trace_id,payload_json,updated_at FROM failed_jobs','all',['SHEETS_SYNC']]
])test(`failure in ${step} still attempts every later independent recovery`,async t=>{
 const h=ownerOrderFixture();t.mock.method(console,'error',()=>{});try{
  await withPendingEffects(h);const prepare=h.DB.prepare.bind(h.DB);h.DB.prepare=sql=>{const s=prepare(sql);if(sql.includes(needle))s[method]=async()=>{throw new Error('synthetic maintenance failure');};return s;};
  const r=await scheduled(h);assert.equal(r[0].status,'rejected');assert.equal(r[0].reason.message,'SCHEDULED_MAINTENANCE_FAILED:'+step);
  const metrics=h.sqlite.prepare("SELECT labels_json FROM metrics WHERE name='scheduled_maintenance_step_ms'").all().map(x=>JSON.parse(x.labels_json));
  assert.equal(metrics.length,6);assert.deepEqual(metrics.filter(x=>x.outcome==='FAILED').map(x=>x.step),[step]);
  assert.deepEqual(h.queue.map(j=>(j.body||j).kind).sort(),expectedKinds);
 }finally{h.close();}
});
