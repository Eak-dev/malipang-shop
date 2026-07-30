import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root=new URL('..',import.meta.url);
const migration=(name)=>readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
function sqlite(db,input){return execFileSync('/usr/bin/sqlite3',[db],{input,encoding:'utf8'});}
function rows(db,query){return JSON.parse(execFileSync('/usr/bin/sqlite3',['-json',db,query],{encoding:'utf8'})||'[]');}
function apply(db,name){sqlite(db,migration(name));}
function attemptMigration(db,name){return spawnSync('/usr/bin/sqlite3',[db],{input:migration(name),encoding:'utf8'});}

test('full migration chain applies to a clean D1-shaped database',()=>{
  const directory=mkdtempSync(join(tmpdir(),'malipang-owner-identity-clean-'));
  const db=join(directory,'clean.sqlite');
  try{
    for(const name of [
      '0001_initial.sql','0002_rc2_reliability.sql','0003_daily_expense_sheet.sql','0004_bank_slip_expenses.sql',
      '0005_attendance_timestamp_gps.sql','0006_sync_job_lease.sql','0007_payroll_wage_history_fixed_ot.sql',
      '0008_wednesday_pay_date_and_payroll_runs.sql','0009_evidence_retention.sql','0010_shift_schedule_audit.sql',
      '0011_identity_access_foundation.sql','0012_owner_identity_canonicalization.sql','0013_expense_document_foundation.sql'
    ])apply(db,name);
    assert.deepEqual(rows(db,'PRAGMA foreign_key_check'),[]);
    assert.equal(rows(db,`SELECT COUNT(*) AS count FROM employees WHERE employee_id='OWN002'`)[0].count,1);
    assert.equal(rows(db,`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='expense_document_items'`)[0].count,1);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('0013 adds V1.2 Expense document storage without changing historical expense rows',()=>{
  const directory=mkdtempSync(join(tmpdir(),'malipang-expense-v12-'));
  const db=join(directory,'production-shaped.sqlite');
  try{
    for(const name of ['0001_initial.sql','0002_rc2_reliability.sql','0003_daily_expense_sheet.sql','0004_bank_slip_expenses.sql','0005_attendance_timestamp_gps.sql','0006_sync_job_lease.sql','0007_payroll_wage_history_fixed_ot.sql','0008_wednesday_pay_date_and_payroll_runs.sql','0009_evidence_retention.sql','0010_shift_schedule_audit.sql','0011_identity_access_foundation.sql','0012_owner_identity_canonicalization.sql'])apply(db,name);
    sqlite(db,`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at) VALUES('legacy_exp','legacy_msg','legacy_line','legacy',100,'cash','CASH_DRAWER','general','2026-07-30','CONFIRMED','2026-07-30T00:00:00Z');`);
    apply(db,'0013_expense_document_foundation.sql');
    assert.equal(rows(db,`SELECT COUNT(*) AS count FROM expense_events WHERE expense_id='legacy_exp' AND amount_satang=100`)[0].count,1);
    for(const table of ['expense_document_items','expense_document_cases','expense_document_links','expense_audit_log','daily_sheet_capacity_locks','daily_sheet_capacity_expansions'])assert.equal(rows(db,`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='${table}'`)[0].count,1,table);
    assert.deepEqual(rows(db,'PRAGMA foreign_key_check'),[]);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('0012 aborts before mutation if EMP_TEST and OWN001 already coexist',()=>{
  const directory=mkdtempSync(join(tmpdir(),'malipang-owner-identity-collision-'));
  const db=join(directory,'collision.sqlite');
  try{
    for(const name of ['0001_initial.sql','0002_rc2_reliability.sql','0003_daily_expense_sheet.sql','0004_bank_slip_expenses.sql','0005_attendance_timestamp_gps.sql','0006_sync_job_lease.sql','0007_payroll_wage_history_fixed_ot.sql','0008_wednesday_pay_date_and_payroll_runs.sql','0009_evidence_retention.sql','0010_shift_schedule_audit.sql'])apply(db,name);
    sqlite(db,`INSERT INTO employees VALUES('EMP_TEST','Eak','U12345678901234567890','04:00','16:00',50000,10,0,0,1,'ACTIVE','2026-07-30T00:00:00Z');
      INSERT INTO employees VALUES('OWN001','Other','U12345678901234567891','04:00','16:00',0,10,0,0,1,'ACTIVE','2026-07-30T00:00:00Z');`);
    apply(db,'0011_identity_access_foundation.sql');
    sqlite(db,`INSERT INTO attendance_events(event_id,webhook_event_id,message_id,employee_id,work_date,punch_type,status,validation_code,created_at,version) VALUES('att_collision','w','m','EMP_TEST','2026-07-30','IN','NORMAL','OK','2026-07-30T00:00:00Z',1);`);
    const result=attemptMigration(db,'0012_owner_identity_canonicalization.sql');
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/CHECK constraint failed/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('0012 canonicalizes Eak in place, preserves relational history, and provisions unbound Nea idempotently',()=>{
  const directory=mkdtempSync(join(tmpdir(),'malipang-owner-identity-'));
  const db=join(directory,'production-shaped.sqlite');
  try{
    for(const name of [
      '0001_initial.sql','0002_rc2_reliability.sql','0003_daily_expense_sheet.sql','0004_bank_slip_expenses.sql',
      '0005_attendance_timestamp_gps.sql','0006_sync_job_lease.sql','0007_payroll_wage_history_fixed_ot.sql',
      '0008_wednesday_pay_date_and_payroll_runs.sql','0009_evidence_retention.sql','0010_shift_schedule_audit.sql'
    ])apply(db,name);
    sqlite(db,`PRAGMA foreign_keys=ON;
      INSERT INTO employees VALUES
        ('EMP_TEST','Eak','U12345678901234567890','04:00','16:00',50000,10,0,0,1,'ACTIVE','2026-07-30T00:00:00Z'),
        ('EMP001','Win','U12345678901234567891','04:00','16:00',50000,10,0,0,1,'ACTIVE','2026-07-30T00:00:00Z'),
        ('EMP002','Tualek','U12345678901234567892','04:00','16:00',50000,10,0,0,1,'ACTIVE','2026-07-30T00:00:00Z'),
        ('EMP003','Laws non','U12345678901234567893','04:00','16:00',50000,10,0,0,1,'ACTIVE','2026-07-30T00:00:00Z');`);
    apply(db,'0011_identity_access_foundation.sql');
    sqlite(db,`PRAGMA foreign_keys=ON;
      INSERT INTO employee_wage_history VALUES('wage_eak','EMP_TEST',50000,'2026-07-30',NULL,'TEST','',1,'2026-07-30T00:00:00Z','2026-07-30T00:00:00Z');
      INSERT INTO attendance_events(event_id,webhook_event_id,message_id,employee_id,work_date,punch_type,status,validation_code,created_at,version) VALUES('att_1','webhook_1','message_1','EMP_TEST','2026-07-30','IN','NORMAL','OK','2026-07-30T00:00:00Z',1);
      INSERT INTO attendance_daily(employee_id,work_date,scheduled_in,scheduled_out,grace_min,late_deduction_satang,early_deduction_satang,pay_status,updated_at) VALUES('EMP_TEST','2026-07-30','04:00','16:00',10,0,0,'READY','2026-07-30T00:00:00Z');
      INSERT INTO payroll_weekly(employee_id,week_start,pay_sunday,status,updated_at) VALUES('EMP_TEST','2026-07-30','2026-08-05','READY','2026-07-30T00:00:00Z');
      INSERT INTO employee_shift_days(employee_id,work_date,scheduled_in,scheduled_out,daily_wage_snapshot_satang,wage_source_id,status,note,version,created_at,updated_at,created_action_id) VALUES('EMP_TEST','2026-07-30','04:00','16:00',50000,'wage_eak','EXPECTED','',1,'2026-07-30T00:00:00Z','2026-07-30T00:00:00Z','seed');
      INSERT INTO shift_schedule_audit(audit_id,employee_id,work_date,previous_status,new_status,new_scheduled_in,new_scheduled_out,changed_by,reason,action,created_at) VALUES('shift_audit_1','EMP_TEST','2026-07-30',NULL,'EXPECTED','04:00','16:00','EMP_TEST','seed','DEFAULT_GENERATION','2026-07-30T00:00:00Z');
      INSERT INTO ot_requests(ot_id,employee_id,work_date,reason,fixed_amount_satang,requested_by,owner_preapproved_at,created_at,updated_at) VALUES('ot_1','EMP_TEST','2026-07-30','seed',100,'EMP_TEST','2026-07-30T00:00:00Z','2026-07-30T00:00:00Z','2026-07-30T00:00:00Z');
      INSERT INTO payroll_runs(run_id,period_start,period_end,pay_date,status,requested_by,created_at,updated_at) VALUES('run_1','2026-07-30','2026-08-05','2026-08-05','COMPLETED','EMP_TEST','2026-07-30T00:00:00Z','2026-07-30T00:00:00Z');
      INSERT INTO identity_link_requests(request_id,provider,external_user_id,requested_staff_id,status,requested_at,reviewed_by,created_at,updated_at) VALUES('request_1','LINE','U12345678901234567894','EMP_TEST','REJECTED','2026-07-30T00:00:00Z','EMP_TEST','2026-07-30T00:00:00Z','2026-07-30T00:00:00Z');
      INSERT INTO employee_change_requests(change_request_id,employee_id,request_type,reason,status,reviewed_by,created_at,updated_at) VALUES('change_1','EMP_TEST','PROFILE_CORRECTION','seed','APPROVED','EMP_TEST','2026-07-30T00:00:00Z','2026-07-30T00:00:00Z');
      INSERT INTO access_audit_log(audit_id,actor_type,actor_id,action,target_employee_id,reason,before_json,created_at) VALUES('access_old','STAFF','EMP_TEST','LEGACY_TEST','EMP_TEST','seed','{"employeeId":"EMP_TEST"}','2026-07-30T00:00:00Z');
      INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES('V52_DAILY_PAYROLL','EMP_TEST|2026-07-30',2);
      INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at) VALUES('expense_1','expense_msg_1','U12345678901234567890','seed',100,'cash','CASH_DRAWER','general','2026-07-30','CONFIRMED','2026-07-30T00:00:00Z');`);

    apply(db,'0012_owner_identity_canonicalization.sql');
    apply(db,'0012_owner_identity_canonicalization.sql');

    assert.deepEqual(rows(db,`SELECT employee_id,staff_name,status FROM employees WHERE staff_name IN ('Eak','Nea') ORDER BY employee_id`),[
      {employee_id:'OWN001',staff_name:'Eak',status:'ACTIVE'},
      {employee_id:'OWN002',staff_name:'Nea',status:'ACTIVE'}
    ]);
    assert.equal(rows(db,`SELECT COUNT(*) AS count FROM employees WHERE employee_id='EMP_TEST'`)[0].count,0);
    assert.equal(rows(db,`SELECT COUNT(*) AS count FROM employees WHERE staff_name='Eak'`)[0].count,1);
    assert.deepEqual(rows(db,`SELECT employee_id,role,scope,status FROM staff_roles WHERE employee_id IN ('OWN001','OWN002') AND status='ACTIVE' ORDER BY employee_id`),[
      {employee_id:'OWN001',role:'OWNER',scope:'ORGANIZATION',status:'ACTIVE'},
      {employee_id:'OWN002',role:'OWNER',scope:'ORGANIZATION',status:'ACTIVE'}
    ]);
    assert.equal(rows(db,`SELECT COUNT(*) AS count FROM line_identity_bindings WHERE employee_id='OWN001' AND status='VERIFIED'`)[0].count,1);
    assert.equal(rows(db,`SELECT COUNT(*) AS count FROM line_identity_bindings WHERE employee_id='OWN002' AND status='VERIFIED'`)[0].count,0);
    for(const table of ['attendance_events','attendance_daily','payroll_weekly','employee_wage_history','employee_shift_days','shift_schedule_audit','ot_requests','employee_change_requests'])assert.equal(rows(db,`SELECT COUNT(*) AS count FROM ${table} WHERE employee_id='OWN001'`)[0].count,1,table);
    assert.equal(rows(db,`SELECT COUNT(*) AS count FROM payroll_runs WHERE requested_by='OWN001'`)[0].count,1);
    assert.deepEqual(rows(db,`SELECT actor_id,target_employee_id,before_json FROM access_audit_log WHERE audit_id='access_old'`),[{actor_id:'OWN001',target_employee_id:'OWN001',before_json:'{"employeeId":"EMP_TEST"}'}]);
    assert.deepEqual(rows(db,`SELECT legacy_employee_id,canonical_employee_id FROM staff_identity_aliases`),[{legacy_employee_id:'EMP_TEST',canonical_employee_id:'OWN001'}]);
    assert.deepEqual(rows(db,`SELECT entity_key FROM sheet_row_index WHERE sheet_name='V52_DAILY_PAYROLL'`),[{entity_key:'OWN001|2026-07-30'}]);
    assert.equal(rows(db,`SELECT COUNT(*) AS count FROM expense_events WHERE line_user_id='U12345678901234567890'`)[0].count,1);
    assert.deepEqual(rows(db,`SELECT employee_id FROM employees WHERE employee_id IN ('EMP001','EMP002','EMP003') ORDER BY employee_id`),[{employee_id:'EMP001'},{employee_id:'EMP002'},{employee_id:'EMP003'}]);
    assert.deepEqual(rows(db,'PRAGMA foreign_key_check'),[]);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
