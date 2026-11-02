import test from 'node:test';
import assert from 'node:assert/strict';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
import {recalculateDailyPayroll} from '../dist/payroll/recalculate.js';
import {finalizeFixedOt} from '../dist/admin/payroll-admin.js';

const date='2026-01-01',finalized='2026-01-02T01:00:00.000Z';
function fixture(finalizedAt){
 const h=expenseSqlite();
 h.sqlite.prepare(`INSERT INTO employees(employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,daily_wage_satang,status,updated_at) VALUES('X','Synthetic','synthetic_x','08:00','17:00',50000,'ACTIVE',?)`).run(finalized);
 h.sqlite.prepare(`INSERT INTO attendance_daily(employee_id,work_date,scheduled_in,scheduled_out,grace_min,late_deduction_satang,early_deduction_satang,time_out,pay_status,updated_at,daily_wage_satang,daily_wage_snapshot_satang,finalized_at) VALUES('X',?,'08:00','17:00',10,0,0,'18:00','READY',?,50000,50000,?)`).run(date,finalized,finalizedAt);
 return h;
}
const read=h=>({...h.sqlite.prepare(`SELECT finalized_at,pay_status,confirmed_wage_satang,pending_wage_satang,ot_approved_satang FROM attendance_daily WHERE employee_id='X'`).get()});

test('finalizing OT preserves previously finalized missing-punch wages',async()=>{
 const h=fixture(finalized);try{
 h.sqlite.prepare(`INSERT INTO ot_requests(ot_id,employee_id,work_date,reason,fixed_amount_satang,requested_by,owner_preapproved_at,created_at,updated_at) VALUES('ot','X',?,'fixture',10000,'fixture',?,?,?)`).run(date,finalized,finalized,finalized);
 await finalizeFixedOt(h.env,{otId:'ot',approved:true});
 assert.deepEqual(read(h),{finalized_at:finalized,pay_status:'READY',confirmed_wage_satang:35000,pending_wage_satang:0,ot_approved_satang:10000});
 const weekly=h.sqlite.prepare(`SELECT confirmed_amount_satang,pending_amount_satang,ot_total_satang FROM payroll_weekly WHERE employee_id='X'`).get();
 assert.deepEqual({...weekly},{confirmed_amount_satang:35000,pending_amount_satang:0,ot_total_satang:10000});
 }finally{h.close();}
});
test('an unfinalized missing-punch day remains pending on an ordinary recalculation',async()=>{
 const h=fixture(null);try{
 await recalculateDailyPayroll(h.env,'X',date,{finalizeMissingPunch:false});
 assert.deepEqual(read(h),{finalized_at:null,pay_status:'REVIEW',confirmed_wage_satang:0,pending_wage_satang:25000,ot_approved_satang:0});
 }finally{h.close();}
});
test('a malformed finalization marker requires review before mutating payroll',async()=>{
 const h=fixture('bad-date');try{
 const before=read(h);
 await assert.rejects(recalculateDailyPayroll(h.env,'X',date),/PAYROLL_FINALIZATION_REVIEW_REQUIRED/);
 assert.deepEqual(read(h),before);
 assert.equal(h.sqlite.prepare(`SELECT count(*) n FROM payroll_weekly`).get().n,0);
 }finally{h.close();}
});
test('changed source data prevents the stale recalculation from writing',async()=>{
 const h=fixture(finalized);try{
 const batch=h.DB.batch.bind(h.DB);h.DB.batch=async statements=>{h.sqlite.prepare(`UPDATE attendance_daily SET time_out='19:00',version=version+1 WHERE employee_id='X'`).run();return batch(statements);};
 await assert.rejects(recalculateDailyPayroll(h.env,'X',date),/PAYROLL_SNAPSHOT_CHANGED_REVIEW_REQUIRED/);
 const row=h.sqlite.prepare(`SELECT time_out,finalized_at,version FROM attendance_daily WHERE employee_id='X'`).get();
 assert.deepEqual({...row},{time_out:'19:00',finalized_at:finalized,version:2});
 assert.equal(h.sqlite.prepare(`SELECT count(*) n FROM payroll_weekly`).get().n,0);
 }finally{h.close();}
});
test('a newly approved OT amount prevents calculation from an older OT snapshot',async()=>{
 const h=fixture(finalized);try{
 h.sqlite.prepare(`INSERT INTO ot_requests(ot_id,employee_id,work_date,reason,fixed_amount_satang,requested_by,owner_preapproved_at,created_at,updated_at) VALUES('ot','X',?,'fixture',10000,'fixture',?,?,?)`).run(date,finalized,finalized,finalized);
 const batch=h.DB.batch.bind(h.DB);h.DB.batch=async statements=>{h.sqlite.prepare(`UPDATE ot_requests SET status='APPROVED',owner_final_status='APPROVED',owner_final_amount_satang=10000 WHERE ot_id='ot'`).run();return batch(statements);};
 const before=read(h);
 await assert.rejects(recalculateDailyPayroll(h.env,'X',date),/PAYROLL_SNAPSHOT_CHANGED_REVIEW_REQUIRED/);
 assert.deepEqual(read(h),before);
 assert.equal(h.sqlite.prepare(`SELECT count(*) n FROM payroll_weekly`).get().n,0);
 }finally{h.close();}
});
test('daily, weekly, and both outboxes roll back together when the batch fails',async()=>{
 const h=fixture(finalized);try{
 const before=read(h);h.DB.failAt=3;
 await assert.rejects(recalculateDailyPayroll(h.env,'X',date),/fixture batch failure/);
 assert.deepEqual(read(h),before);
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM payroll_weekly').get().n,0);
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM sync_jobs').get().n,0);
 }finally{h.close();}
});
test('a lost response after committing payroll leaves both sync outboxes recoverable',async()=>{
 const h=fixture(finalized);try{
 h.env.SHEETS_SYNC_ENABLED='false';h.DB.failAfterCommit=true;
 await assert.rejects(recalculateDailyPayroll(h.env,'X',date),/fixture crash after commit/);
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM payroll_weekly').get().n,1);
 const jobs=h.sqlite.prepare(`SELECT entity_type,status FROM sync_jobs ORDER BY entity_type`).all().map(x=>({...x}));
 assert.deepEqual(jobs,[{entity_type:'DAILY_PAYROLL',status:'PENDING'},{entity_type:'WEEKLY_PAYROLL',status:'PENDING'}]);
 assert.equal(h.queue.length,0);
 }finally{h.close();}
});
