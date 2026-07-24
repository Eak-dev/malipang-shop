import test from 'node:test';
import assert from 'node:assert/strict';
import {payrollPeriodFor} from '../dist/shared/time.js';

test('20-26 July 2026 payroll is paid Wednesday 29 July',()=>{
  assert.deepEqual(payrollPeriodFor('2026-07-20'),{
    weekStart:'2026-07-20',
    weekEnd:'2026-07-26',
    payDate:'2026-07-29'
  });
  assert.deepEqual(payrollPeriodFor('2026-07-26'),{
    weekStart:'2026-07-20',
    weekEnd:'2026-07-26',
    payDate:'2026-07-29'
  });
});

test('27 July starts a new payroll period paid 5 August',()=>{
  assert.deepEqual(payrollPeriodFor('2026-07-27'),{
    weekStart:'2026-07-27',
    weekEnd:'2026-08-02',
    payDate:'2026-08-05'
  });
});

test('invalid payroll date is rejected',()=>{
  assert.throws(()=>payrollPeriodFor('29/07/2026'),/Invalid payroll date/);
});
