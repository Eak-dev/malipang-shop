import test from 'node:test';
import assert from 'node:assert/strict';
import {countsAsPayrollWorkDay,payrollSnapshotSatang} from '../dist/payroll/range.js';

test('preview work-day count matches weekly payroll punch rule',()=>{
  assert.equal(countsAsPayrollWorkDay('04:00','16:00'),true);
  assert.equal(countsAsPayrollWorkDay('04:00',null),true);
  assert.equal(countsAsPayrollWorkDay(null,'16:00'),true);
  assert.equal(countsAsPayrollWorkDay(null,null),false);
});

test('preview preserves an explicit zero-wage snapshot',()=>{
  const employee={dailyWageSatang:50000};
  assert.equal(payrollSnapshotSatang({daily_wage_snapshot_satang:0,daily_wage_satang:50000},employee),0);
  assert.equal(payrollSnapshotSatang({daily_wage_snapshot_satang:null,daily_wage_satang:50000},employee),50000);
});
