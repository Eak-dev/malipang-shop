import test from 'node:test';
import assert from 'node:assert/strict';
import {weeklyPayrollSyncEntityKey} from '../dist/attendance/service.js';

test('attendance weekly sync uses Thursday cycle key for release week',()=>{
  assert.equal(weeklyPayrollSyncEntityKey('EMP001','2026-07-23'),'EMP001|2026-07-23');
  assert.equal(weeklyPayrollSyncEntityKey('EMP001','2026-07-29'),'EMP001|2026-07-23');
});

test('attendance weekly sync starts next cycle on Thursday',()=>{
  assert.equal(weeklyPayrollSyncEntityKey('EMP001','2026-07-30'),'EMP001|2026-07-30');
});
