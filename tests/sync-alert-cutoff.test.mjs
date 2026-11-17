// R1 (#296): incidents recorded between migration 0025 and enabling durable
// alerts are never sent, and closed, handled incidents do not grow forever.
process.env.MALIPANG_TEST_CANDIDATE_FLAGS='1'; // candidate behaviour flags on for this file
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url);
const alerts=require('../dist/line/sync-failure-alerts.js');

const incident=(h,id,{opened,state='OPEN',closed=null,alerted=null})=>h.sqlite.prepare("INSERT INTO sync_alert_incidents(kind,source_id,category,state,opened_at,closed_at,alerted_at) VALUES('JOB',?,'REVIEW',?,?,?,?)").run(id,state,opened,closed,alerted);
const row=(h,id)=>({...h.sqlite.prepare('SELECT state,alerted_at FROM sync_alert_incidents WHERE source_id=?').get(id)});

test('durable alerts require a valid cutoff; without one the main path is kept',()=>{
  const base={SYNC_ALERT_DURABLE_ENABLED:'true'};
  assert.equal(alerts.syncAlertDurableEnabled(base),false);
  for(const bad of ['','yesterday','2026-11-18','2026-11-18T00:00:00+07:00','2026-13-01T00:00:00Z'])assert.equal(alerts.syncAlertDurableEnabled({...base,SYNC_ALERT_DURABLE_SINCE:bad}),false,bad);
  assert.equal(alerts.syncAlertDurableEnabled({...base,SYNC_ALERT_DURABLE_SINCE:'2026-11-18T19:00:00Z'}),true);
  assert.equal(alerts.syncAlertDurableEnabled({SYNC_ALERT_DURABLE_SINCE:'2026-11-18T19:00:00Z'}),false);
  // Normalised to opened_at's millisecond format so string comparison is exact at the boundary.
  assert.equal(alerts.syncAlertDurableCutoff({SYNC_ALERT_DURABLE_SINCE:'2026-11-18T19:00:00Z'}),'2026-11-18T19:00:00.000Z');
});

test('incidents opened before the cutoff are marked handled and never sent; later ones are sent once',async()=>{
  const h=expenseSqlite();try{
    Object.assign(h.env,{RUNTIME_MODE:'production',LINE_OWNER_USER_ID:'synthetic-owner',SYNC_ALERT_DURABLE_SINCE:'2026-11-18T19:00:00Z'});
    const sent=[];h.env.JOB_QUEUE.send=async job=>{sent.push(job);};
    h.sqlite.exec("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('old-job','ATTENDANCE_EVENT','a',1,'t','REVIEW','x'),('boundary-job','ATTENDANCE_EVENT','b',1,'t','REVIEW','x'),('new-job','ATTENDANCE_EVENT','c',1,'t','REVIEW','x')");
    h.sqlite.exec('DELETE FROM sync_alert_incidents');
    incident(h,'old-job',{opened:'2026-11-18T18:59:59.999Z'});
    incident(h,'boundary-job',{opened:'2026-11-18T19:00:00.000Z'});
    incident(h,'new-job',{opened:'2026-11-18T20:00:00.000Z'});
    assert.equal(await alerts.sweepSyncFailureAlerts(h.env),2);
    assert.equal(row(h,'old-job').alerted_at,alerts.PRE_CUTOFF_SUPPRESSED);
    assert.notEqual(row(h,'boundary-job').alerted_at,null);assert.notEqual(row(h,'boundary-job').alerted_at,alerts.PRE_CUTOFF_SUPPRESSED);
    assert.equal(sent.filter(j=>j.kind==='LINE_NOTIFICATION').length,2,'one notification per incident at or after the cutoff, none for the earlier one');
    assert.equal(await alerts.sweepSyncFailureAlerts(h.env),0);
  }finally{h.close();}
});

test('pruning removes only closed, handled incidents past retention, in bounded batches',async()=>{
  const h=expenseSqlite();try{
    Object.assign(h.env,{SYNC_ALERT_DURABLE_SINCE:'2026-01-01T00:00:00Z',SYNC_ALERT_INCIDENT_RETENTION_DAYS:'30'});
    h.sqlite.exec('DELETE FROM sync_alert_incidents');
    const now=Date.parse('2026-11-18T00:00:00.000Z'),old='2026-10-01T00:00:00.000Z',recent='2026-11-10T00:00:00.000Z';
    for(let i=0;i<205;i++)incident(h,`closed-old-${i}`,{opened:old,state:'CLOSED',closed:old,alerted:old});
    incident(h,'closed-recent',{opened:recent,state:'CLOSED',closed:recent,alerted:recent});
    incident(h,'closed-unsent',{opened:old,state:'CLOSED',closed:old});
    incident(h,'open-old',{opened:old,alerted:old});
    assert.deepEqual(await alerts.settleSyncAlertBacklog(h.env,now),{suppressed:0,pruned:200});
    assert.deepEqual(await alerts.settleSyncAlertBacklog(h.env,now),{suppressed:0,pruned:5});
    assert.deepEqual(await alerts.settleSyncAlertBacklog(h.env,now),{suppressed:0,pruned:0});
    const left=h.sqlite.prepare('SELECT source_id FROM sync_alert_incidents ORDER BY source_id').all().map(r=>r.source_id);
    assert.deepEqual(left,['closed-recent','closed-unsent','open-old']);
  }finally{h.close();}
});

test('retention days are bounded and default to 90',()=>{
  assert.equal(alerts.syncAlertRetentionDays({}),90);assert.equal(alerts.syncAlertRetentionDays({SYNC_ALERT_INCIDENT_RETENTION_DAYS:'30'}),30);
  for(const bad of ['0','6','3651','1.5','x'])assert.equal(alerts.syncAlertRetentionDays({SYNC_ALERT_INCIDENT_RETENTION_DAYS:bad}),90,bad);
});
