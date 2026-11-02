import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {AttendanceCoordinator} from '../dist/durable/attendance-coordinator.js';
import {correctAttendance} from '../dist/admin/attendance-correction.js';
import {recoverPendingSheetJobs} from '../dist/db/repositories.js';

class Statement{
  constructor(db,sql){this.db=db;this.sql=sql;this.args=[];}
  bind(...args){this.args=args;return this;}
  async first(){const row=this.db.sqlite.prepare(this.sql).get(...this.args)??null;if(this.db.afterFirst)await this.db.afterFirst(this.sql,this.args,row);return row;}
  async all(){return{results:this.db.sqlite.prepare(this.sql).all(...this.args),meta:{changes:0}};}
  async run(){if(/^\s*SELECT\b/i.test(this.sql))return{results:this.db.sqlite.prepare(this.sql).all(...this.args),meta:{changes:0}};const result=this.db.sqlite.prepare(this.sql).run(...this.args);return{meta:{changes:Number(result.changes)}};}
}
class SqliteD1{
  constructor(sqlite){this.sqlite=sqlite;this.afterFirst=null;}
  prepare(sql){return new Statement(this,sql);}
  async batch(statements){this.sqlite.exec('BEGIN IMMEDIATE');try{const results=[];for(const statement of statements)results.push(await statement.run());this.sqlite.exec('COMMIT');return results;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
}
const employee={employeeId:'FIX001',staffName:'Fixture',lineUserId:'fixture',scheduledIn:'08:00',scheduledOut:'17:00',dailyWageSatang:50000,graceMin:5,lateDeductionSatang:0,earlyDeductionSatang:0,canSubmitExpense:false,status:'ACTIVE'};
function harness(){
  const sqlite=new DatabaseSync(':memory:'),dir=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(dir).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(name,dir),'utf8'));
  sqlite.prepare(`INSERT INTO employees(employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,daily_wage_satang,status,updated_at) VALUES('FIX001','Fixture','fixture','08:00','17:00',50000,'ACTIVE','2026-01-01T00:00:00Z')`).run();
  const DB=new SqliteD1(sqlite),state={storage:{async transaction(){throw new Error('stale DO cache must never be used');}},async blockConcurrencyWhile(fn){return fn();}},queued=[];
  const env={DB,SHEETS_SYNC_ENABLED:'false',JOB_QUEUE:{async sendBatch(messages){queued.push(...messages);}}};
  return{sqlite,DB,env,queued,coordinator:new AttendanceCoordinator(state,env),close(){sqlite.close();}};
}
function input(messageId,time){return{traceId:`trace_${messageId}`,webhookEventId:`webhook_${messageId}`,messageId,receivedAtIso:'2026-01-01T00:00:00Z',employee,reading:{confidence:1,needsNewPhoto:false},workDate:'2026-01-01',officialTime:time,lineTime:time,lineDiffMinutes:0,photoDateTime:'2026-01-01T00:00:00Z',gpsLat:0,gpsLng:0,distanceM:0,attendanceSource:'PHOTO_TIMESTAMP_GPS',clockEvidence:true,clockConfidence:1,overlayRawText:'fixture',imageSha256:`sha_${messageId}`,imageKey:'fixture',validationCode:'OK',validationNote:'',validationReview:false};}
async function commit(h,body){const response=await h.coordinator.fetch(new Request('https://attendance.local/commit',{method:'POST',body:JSON.stringify(body)}));return response.json();}

test('stale or absent DO cache cannot corrupt a retry or next punch after D1 commit',async()=>{
  const h=harness();
  try{
    const first=await commit(h,input('first','08:00'));assert.equal(first.punchType,'IN');
    const duplicate=await commit(h,input('first','08:00'));assert.equal(duplicate.punchType,'DUPLICATE');
    const sync=await h.coordinator.fetch(new Request('https://attendance.local/sync',{method:'POST',body:JSON.stringify({timeIn:null,timeOut:null,version:0})}));assert.equal(sync.status,200);
    const second=await commit(h,input('second','17:00'));assert.equal(second.punchType,'OUT');
    assert.equal((await commit(h,input('third','17:01'))).punchType,'COMPLETE');
    assert.deepEqual({...h.sqlite.prepare(`SELECT time_in,time_out,version FROM attendance_daily WHERE employee_id='FIX001' AND work_date='2026-01-01'`).get()},{time_in:'08:00',time_out:'17:00',version:2});
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM attendance_events WHERE employee_id='FIX001'`).get().n,2);
  }finally{h.close();}
});

test('a correction between reading and committing wins without a partial event or weekly update',async()=>{
  const h=harness();
  try{
    await commit(h,input('first','08:00'));
    const weeklyBefore=JSON.stringify(h.sqlite.prepare(`SELECT * FROM payroll_weekly WHERE employee_id='FIX001'`).get());
    h.DB.afterFirst=async(sql)=>{if(sql.startsWith('SELECT time_in,time_out')){h.DB.afterFirst=null;h.sqlite.prepare(`UPDATE attendance_daily SET time_in='08:05',time_out='16:45',version=version+1 WHERE employee_id='FIX001' AND work_date='2026-01-01'`).run();}};
    await assert.rejects(commit(h,input('second','17:00')),/ATTENDANCE_DAILY_CHANGED_CONCURRENTLY/);
    assert.deepEqual({...h.sqlite.prepare(`SELECT time_in,time_out,version FROM attendance_daily WHERE employee_id='FIX001' AND work_date='2026-01-01'`).get()},{time_in:'08:05',time_out:'16:45',version:2});
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM attendance_events WHERE message_id='second'`).get().n,0);
    assert.equal(JSON.stringify(h.sqlite.prepare(`SELECT * FROM payroll_weekly WHERE employee_id='FIX001'`).get()),weeklyBefore);
  }finally{h.close();}
});

test('a lost response after D1 commit retries as duplicate and the next punch uses D1',async()=>{
  const h=harness();
  try{
    h.DB.afterFirst=async(sql)=>{if(sql.startsWith('SELECT version FROM payroll_weekly')){h.DB.afterFirst=null;throw new Error('injected crash after D1 commit');}};
    await assert.rejects(commit(h,input('first','08:00')),/injected crash after D1 commit/);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM attendance_events WHERE message_id='first'`).get().n,1);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM sync_jobs WHERE status='PENDING'`).get().n,3);
    assert.equal((await commit(h,input('first','08:00'))).punchType,'DUPLICATE');
    assert.equal((await commit(h,input('second','17:00'))).punchType,'OUT');
    assert.deepEqual({...h.sqlite.prepare(`SELECT time_in,time_out,version FROM attendance_daily WHERE employee_id='FIX001' AND work_date='2026-01-01'`).get()},{time_in:'08:00',time_out:'17:00',version:2});
  }finally{h.close();}
});

test('a duplicate older event reports current daily and weekly versions without repeating outboxes',async()=>{
  const h=harness();
  try{
    await commit(h,input('first','08:00'));await commit(h,input('second','17:00'));
    const duplicate=await commit(h,input('first','08:00'));
    assert.equal(duplicate.version,1);assert.equal(duplicate.dailyVersion,2);assert.equal(duplicate.weeklyVersion,2);assert.equal(duplicate.sourceEmployeeId,'FIX001');
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM sync_jobs`).get().n,6);
  }finally{h.close();}
});

test('punch source and weekly updates roll back if an outbox insert fails',async()=>{
  const h=harness();
  try{
    h.sqlite.exec(`CREATE TRIGGER reject_attendance_outbox BEFORE INSERT ON sync_jobs WHEN NEW.entity_type='DAILY_PAYROLL' BEGIN SELECT RAISE(ABORT,'fixture attendance outbox failure'); END;`);
    await assert.rejects(commit(h,input('first','08:00')),/fixture attendance outbox failure/);
    for(const table of ['attendance_events','attendance_daily','payroll_weekly','sync_jobs'])assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
  }finally{h.close();}
});

test('a punch fails closed when its next daily or weekly outbox version is occupied',async()=>{
  for(const entityType of ['DAILY_PAYROLL','WEEKLY_PAYROLL']){
    const h=harness();
    try{
      h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('existing_fixture',?,'FIX001|2026-01-01',1,'fixture','COMPLETED',1,'2026-01-01T00:00:00Z')`).run(entityType);
      await assert.rejects(commit(h,input('first','08:00')),/ATTENDANCE_DAILY_CHANGED_CONCURRENTLY/);
      assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM attendance_events`).get().n,0);
      assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM attendance_daily`).get().n,0);
      assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM payroll_weekly`).get().n,0);
      assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM sync_jobs`).get().n,1);
    }finally{h.close();}
  }
});

test('a duplicate image from another employee returns no foreign payroll information',async()=>{
  const h=harness();
  try{
    await commit(h,input('first','08:00'));
    const other=input('other','08:00');other.employee={...employee,employeeId:'OTHER'};other.imageSha256='sha_first';
    const duplicate=await commit(h,other);
    assert.equal(duplicate.punchType,'DUPLICATE');assert.equal(duplicate.sourceEmployeeId,'FIX001');
    assert.equal(duplicate.officialTime,'');assert.equal(duplicate.confirmedWageSatang,0);assert.equal(duplicate.pendingWageSatang,0);
  }finally{h.close();}
});

test('a concurrently created daily row is never overwritten by a stale first punch',async()=>{
  const h=harness();
  try{
    h.DB.afterFirst=async(sql)=>{if(sql.startsWith('SELECT time_in,time_out')){h.DB.afterFirst=null;h.sqlite.prepare(`INSERT INTO attendance_daily(employee_id,work_date,scheduled_in,scheduled_out,grace_min,late_deduction_satang,early_deduction_satang,time_in,time_out,pay_status,review_flag,version,updated_at) VALUES('FIX001','2026-01-01','08:00','17:00',5,0,0,'08:03',NULL,'REVIEW',1,4,'2026-01-01T00:00:00Z')`).run();}};
    await assert.rejects(commit(h,input('first','08:00')),/ATTENDANCE_DAILY_CHANGED_CONCURRENTLY/);
    assert.deepEqual({...h.sqlite.prepare(`SELECT time_in,time_out,version FROM attendance_daily WHERE employee_id='FIX001'`).get()},{time_in:'08:03',time_out:null,version:4});
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM attendance_events WHERE message_id='first'`).get().n,0);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM payroll_weekly WHERE employee_id='FIX001'`).get().n,0);
  }finally{h.close();}
});

const correction={employeeId:'FIX001',workDate:'2026-01-01',timeIn:'08:02',timeOut:'16:55',reason:'Fixture correction'};
test('admin correction atomically persists all three outboxes while sync is disabled',async()=>{
  const h=harness();
  try{
    const result=await correctAttendance(h.env,correction);assert.equal(result.version,1);
    assert.deepEqual({...h.sqlite.prepare(`SELECT time_in,time_out,version FROM attendance_daily WHERE employee_id='FIX001'`).get()},{time_in:'08:02',time_out:'16:55',version:1});
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM admin_audit WHERE action='ATTENDANCE_CORRECTION'`).get().n,1);
    assert.deepEqual(h.sqlite.prepare(`SELECT entity_type,entity_version,status FROM sync_jobs ORDER BY entity_type`).all().map(row=>({...row})),[{entity_type:'ATTENDANCE_EVENT',entity_version:1,status:'PENDING'},{entity_type:'DAILY_PAYROLL',entity_version:1,status:'PENDING'},{entity_type:'WEEKLY_PAYROLL',entity_version:1,status:'PENDING'}]);
    assert.equal(h.queued.length,0);
    h.sqlite.prepare(`UPDATE sync_jobs SET updated_at='2000-01-01T00:00:00.000Z',next_attempt_at='2000-01-01T00:00:00.000Z'`).run();h.env.SHEETS_SYNC_ENABLED='true';
    assert.equal(await recoverPendingSheetJobs(h.env,0),3);
  }finally{h.close();}
});

test('admin correction cannot overwrite a punch committed after its read',async()=>{
  const h=harness();
  try{
    await commit(h,input('first','08:00'));
    h.DB.afterFirst=async(sql)=>{if(sql.startsWith('SELECT * FROM attendance_daily')){h.DB.afterFirst=null;await commit(h,input('second','17:00'));}};
    await assert.rejects(correctAttendance(h.env,correction),/ATTENDANCE_CORRECTION_STATE_CHANGED_OR_VERSION_CONFLICT/);
    assert.deepEqual({...h.sqlite.prepare(`SELECT time_in,time_out,version FROM attendance_daily WHERE employee_id='FIX001'`).get()},{time_in:'08:00',time_out:'17:00',version:2});
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM attendance_events WHERE validation_code='ADMIN_CORRECTION'`).get().n,0);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM admin_audit WHERE action='ATTENDANCE_CORRECTION'`).get().n,0);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM sync_jobs WHERE trace_id LIKE 'admin_att_%'`).get().n,0);
  }finally{h.close();}
});

test('admin correction cannot overwrite a first punch committed after an empty read',async()=>{
  const h=harness();
  try{
    h.DB.afterFirst=async(sql)=>{if(sql.startsWith('SELECT * FROM attendance_daily')){h.DB.afterFirst=null;await commit(h,input('first','08:00'));}};
    await assert.rejects(correctAttendance(h.env,correction),/ATTENDANCE_CORRECTION_STATE_CHANGED_OR_VERSION_CONFLICT/);
    assert.deepEqual({...h.sqlite.prepare(`SELECT time_in,time_out,version FROM attendance_daily WHERE employee_id='FIX001'`).get()},{time_in:'08:00',time_out:null,version:1});
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM attendance_events WHERE validation_code='ADMIN_CORRECTION'`).get().n,0);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM sync_jobs WHERE trace_id LIKE 'admin_att_%'`).get().n,0);
  }finally{h.close();}
});

test('admin correction rolls back source, weekly, audit and outbox when an outbox fails',async()=>{
  const h=harness();
  try{
    h.sqlite.exec(`CREATE TRIGGER reject_attendance_outbox BEFORE INSERT ON sync_jobs WHEN NEW.entity_type='DAILY_PAYROLL' BEGIN SELECT RAISE(ABORT,'fixture attendance outbox failure'); END;`);
    await assert.rejects(correctAttendance(h.env,correction),/fixture attendance outbox failure/);
    for(const table of ['attendance_events','attendance_daily','payroll_weekly','admin_audit','sync_jobs'])assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${table==='attendance_events'||table==='attendance_daily'||table==='payroll_weekly'?"employee_id='FIX001'":"1=1"}`).get().n,0,table);
  }finally{h.close();}
});

test('admin correction queue failure after commit leaves all three jobs recoverable',async()=>{
  const h=harness();
  try{
    h.env.SHEETS_SYNC_ENABLED='true';h.env.JOB_QUEUE.sendBatch=async()=>{throw new Error('fixture queue unavailable');};
    await assert.rejects(correctAttendance(h.env,correction),/fixture queue unavailable/);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM attendance_events WHERE validation_code='ADMIN_CORRECTION'`).get().n,1);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM sync_jobs WHERE status='PENDING'`).get().n,3);
    h.sqlite.prepare(`UPDATE sync_jobs SET updated_at='2000-01-01T00:00:00.000Z',next_attempt_at='2000-01-01T00:00:00.000Z'`).run();
    h.env.JOB_QUEUE.sendBatch=async(messages)=>{h.queued.push(...messages);};
    assert.equal(await recoverPendingSheetJobs(h.env,0),3);
  }finally{h.close();}
});

test('admin correction after a punch stores the authoritative daily and weekly versions',async()=>{
  const h=harness();
  try{
    await commit(h,input('first','08:00'));
    const result=await correctAttendance(h.env,correction);assert.equal(result.version,2);
    assert.deepEqual({...h.sqlite.prepare(`SELECT time_in,time_out,version FROM attendance_daily WHERE employee_id='FIX001'`).get()},{time_in:'08:02',time_out:'16:55',version:2});
    assert.deepEqual(h.sqlite.prepare(`SELECT entity_type,entity_version FROM sync_jobs WHERE trace_id=? ORDER BY entity_type`).all(result.eventId).map(row=>({...row})),[{entity_type:'ATTENDANCE_EVENT',entity_version:2},{entity_type:'DAILY_PAYROLL',entity_version:2},{entity_type:'WEEKLY_PAYROLL',entity_version:2}]);
  }finally{h.close();}
});

test('admin correction rejects changed OT inputs before creating any correction rows',async()=>{
  const h=harness();
  try{
    h.DB.afterFirst=async(sql)=>{if(sql.startsWith('SELECT COALESCE(SUM(owner_final_amount_satang)')){h.DB.afterFirst=null;h.sqlite.prepare(`INSERT INTO ot_requests(ot_id,employee_id,work_date,reason,fixed_amount_satang,requested_by,owner_preapproved_at,owner_final_status,owner_final_amount_satang,status,created_at,updated_at) VALUES('ot_fixture','FIX001','2026-01-01','Fixture',100,'OWNER','2026-01-01T00:00:00Z','APPROVED',100,'APPROVED','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`).run();}};
    await assert.rejects(correctAttendance(h.env,correction),/ATTENDANCE_CORRECTION_STATE_CHANGED_OR_VERSION_CONFLICT/);
    for(const table of ['attendance_events','attendance_daily','payroll_weekly','sync_jobs'])assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
  }finally{h.close();}
});

test('admin correction rejects changed wage selection before creating any correction rows',async()=>{
  const h=harness();
  try{
    h.DB.afterFirst=async(sql)=>{if(sql.startsWith('SELECT wage_id,daily_wage_satang')){h.DB.afterFirst=null;h.sqlite.prepare(`INSERT INTO employee_wage_history VALUES('wage_fixture','FIX001',60000,'2025-01-01',NULL,'TEST','',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`).run();}};
    await assert.rejects(correctAttendance(h.env,correction),/ATTENDANCE_CORRECTION_STATE_CHANGED_OR_VERSION_CONFLICT/);
    for(const table of ['attendance_events','attendance_daily','payroll_weekly','sync_jobs'])assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
  }finally{h.close();}
});

test('admin correction rechecks live wage even when a legacy daily row exists without a wage snapshot',async()=>{
  const h=harness();
  try{
    // Recreate the legacy fixture with a nullable historical wage field.
    const schema=h.sqlite.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='attendance_daily'`).get().sql;
    assert.match(schema,/daily_wage_satang INTEGER NOT NULL DEFAULT 0/);
    h.sqlite.exec('DROP TABLE attendance_daily');
    h.sqlite.exec(schema.replace('daily_wage_satang INTEGER NOT NULL DEFAULT 0','daily_wage_satang INTEGER DEFAULT 0').replace('daily_wage_snapshot_satang INTEGER NOT NULL DEFAULT 0','daily_wage_snapshot_satang INTEGER DEFAULT 0'));
    h.sqlite.prepare(`INSERT INTO attendance_daily(employee_id,work_date,scheduled_in,scheduled_out,grace_min,late_deduction_satang,early_deduction_satang,time_in,pay_status,review_flag,version,updated_at,daily_wage_satang,daily_wage_snapshot_satang) VALUES('FIX001','2026-01-01','08:00','17:00',5,0,0,'08:00','REVIEW',1,1,'2026-01-01T00:00:00Z',NULL,NULL)`).run();
    h.DB.afterFirst=async(sql)=>{if(sql.startsWith('SELECT wage_id,daily_wage_satang')){h.DB.afterFirst=null;h.sqlite.prepare(`INSERT INTO employee_wage_history VALUES('wage_fixture','FIX001',60000,'2025-01-01',NULL,'TEST','',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`).run();}};
    await assert.rejects(correctAttendance(h.env,correction),/ATTENDANCE_CORRECTION_STATE_CHANGED_OR_VERSION_CONFLICT/);
    assert.deepEqual({...h.sqlite.prepare(`SELECT time_in,time_out,version FROM attendance_daily WHERE employee_id='FIX001'`).get()},{time_in:'08:00',time_out:null,version:1});
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM attendance_events`).get().n,0);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM sync_jobs`).get().n,0);
  }finally{h.close();}
});

test('admin correction fails closed if its next daily or weekly outbox version is already occupied',async()=>{
  for(const entityType of ['DAILY_PAYROLL','WEEKLY_PAYROLL']){
    const h=harness();
    try{
      const entityKey=entityType==='DAILY_PAYROLL'?'FIX001|2026-01-01':'FIX001|2026-01-01';
      h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('existing_fixture',?,?,1,'fixture','COMPLETED',1,'2026-01-01T00:00:00Z')`).run(entityType,entityKey);
      await assert.rejects(correctAttendance(h.env,correction),/ATTENDANCE_CORRECTION_STATE_CHANGED_OR_VERSION_CONFLICT/);
      assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM attendance_events`).get().n,0);
      assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM sync_jobs`).get().n,1);
    }finally{h.close();}
  }
});
