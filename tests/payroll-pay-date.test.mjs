import test from 'node:test';
import assert from 'node:assert/strict';
import {payrollPeriodFor,weeklyPayrollEntityKey} from '../dist/shared/time.js';

test('23-29 July 2026 payroll closes and pays Wednesday 29 July',()=>{
  assert.deepEqual(payrollPeriodFor('2026-07-23'),{
    weekStart:'2026-07-23',
    weekEnd:'2026-07-29',
    payDate:'2026-07-29'
  });
  assert.deepEqual(payrollPeriodFor('2026-07-29'),{
    weekStart:'2026-07-23',
    weekEnd:'2026-07-29',
    payDate:'2026-07-29'
  });
});

test('30 July starts the next payroll period paid 5 August',()=>{
  assert.deepEqual(payrollPeriodFor('2026-07-30'),{
    weekStart:'2026-07-30',
    weekEnd:'2026-08-05',
    payDate:'2026-08-05'
  });
});

test('Thursday-Wednesday payroll works across a month boundary',()=>{
  assert.deepEqual(payrollPeriodFor('2026-02-02'),{
    weekStart:'2026-01-29',
    weekEnd:'2026-02-04',
    payDate:'2026-02-04'
  });
});

test('Thursday-Wednesday payroll works across a year boundary',()=>{
  assert.deepEqual(payrollPeriodFor('2027-01-01'),{
    weekStart:'2026-12-31',
    weekEnd:'2027-01-06',
    payDate:'2027-01-06'
  });
});

test('invalid payroll date is rejected',()=>{
  assert.throws(()=>payrollPeriodFor('29/07/2026'),/Invalid payroll date/);
});

test('all payroll maintenance flows can use the Thursday weekly sync entity key',()=>{
  assert.equal(weeklyPayrollEntityKey('EMP001','2026-07-23'),'EMP001|2026-07-23');
  assert.equal(weeklyPayrollEntityKey('EMP001','2026-07-29'),'EMP001|2026-07-23');
  assert.equal(weeklyPayrollEntityKey('EMP001','2026-07-30'),'EMP001|2026-07-30');
});
