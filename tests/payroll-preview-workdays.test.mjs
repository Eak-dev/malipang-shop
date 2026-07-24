import test from 'node:test';
import assert from 'node:assert/strict';
import {countsAsPayrollWorkDay} from '../dist/payroll/range.js';

test('preview work-day count matches weekly payroll punch rule',()=>{
  assert.equal(countsAsPayrollWorkDay('04:00','16:00'),true);
  assert.equal(countsAsPayrollWorkDay('04:00',null),true);
  assert.equal(countsAsPayrollWorkDay(null,'16:00'),true);
  assert.equal(countsAsPayrollWorkDay(null,null),false);
});
