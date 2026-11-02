import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {AttendanceCoordinator} from '../dist/durable/attendance-coordinator.js';

class Statement{
  constructor(db,sql){this.db=db;this.sql=sql;this.args=[];}
  bind(...args){this.args=args;return this;}
  async first(){const row=this.db.sqlite.prepare(this.sql).get(...this.args)??null;if(this.db.afterFirst)await this.db.afterFirst(this.sql,this.args,row);return row;}
  async all(){return{results:this.db.sqlite.prepare(this.sql).all(...this.args),meta:{changes:0}};}
  async run(){const result=this.db.sqlite.prepare(this.sql).run(...this.args);return{meta:{changes:Number(result.changes)}};}
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
  const DB=new SqliteD1(sqlite),state={storage:{async transaction(){throw new Error('stale DO cache must never be used');}},async blockConcurrencyWhile(fn){return fn();}};
  return{sqlite,DB,coordinator:new AttendanceCoordinator(state,{DB}),close(){sqlite.close();}};
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
    assert.equal((await commit(h,input('first','08:00'))).punchType,'DUPLICATE');
    assert.equal((await commit(h,input('second','17:00'))).punchType,'OUT');
    assert.deepEqual({...h.sqlite.prepare(`SELECT time_in,time_out,version FROM attendance_daily WHERE employee_id='FIX001' AND work_date='2026-01-01'`).get()},{time_in:'08:00',time_out:'17:00',version:2});
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
