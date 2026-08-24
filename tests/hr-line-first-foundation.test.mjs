import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildStaffConfigRow} from '../dist/sheets/staff-config.js';

test('line-first onboarding migration creates dedicated request, atomic sequence and durable sheet outbox',async()=>{
  const sql=await readFile(new URL('../migrations/0016_line_first_hr_onboarding.sql',import.meta.url),'utf8');
  assert.match(sql,/CREATE TABLE IF NOT EXISTS hr_onboarding_requests/i);
  assert.match(sql,/PENDING_OWNER_SETUP/);
  assert.match(sql,/CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_onboarding_one_pending_line/i);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS staff_id_sequences/i);
  assert.match(sql,/next_number INTEGER NOT NULL/i);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS staff_config_sync_outbox/i);
  assert.match(sql,/PENDING.*PROCESSING.*FAILED.*COMPLETED/s);
});

test('HR_STAFF_CONFIG mirror updates known columns and preserves unrelated owner columns',()=>{
  const headers=['Employee_ID','Staff_Name','LINE_User_ID','Scheduled_In','Scheduled_Out','Status','Daily_Wage','Grace_Min','Deduct_Late','Late_Deduction_Baht','Deduct_Early','Early_Deduction_Baht','Can_Submit_Expense','Role','Branch_ID','Owner_Note'];
  const existing=['EMP004','Old','PENDING_EMP004','08:00','17:00','ACTIVE',400,10,false,0,false,0,false,'EMPLOYEE','B001','KEEP THIS'];
  const row=buildStaffConfigRow(headers,existing,{employeeId:'EMP004',staffName:'Noi',lineUserId:'U123',scheduledIn:'04:00',scheduledOut:'16:00',status:'ACTIVE',dailyWageBaht:500,graceMin:10,lateDeductionBaht:0,earlyDeductionBaht:0,canSubmitExpense:false,role:'EMPLOYEE',branchId:'B001'});
  assert.equal(row[headers.indexOf('Staff_Name')],'Noi');
  assert.equal(row[headers.indexOf('LINE_User_ID')],'U123');
  assert.equal(row[headers.indexOf('Scheduled_In')],'04:00');
  assert.equal(row[headers.indexOf('Daily_Wage')],500);
  assert.equal(row[headers.indexOf('Owner_Note')],'KEEP THIS');
});
