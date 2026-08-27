import test from 'node:test';
import assert from 'node:assert/strict';
import {weeklyPayrollSyncEntityKey,weeklyPayrollSyncVersion} from '../dist/attendance/service.js';
import {correctionWeeklySyncVersion} from '../dist/admin/attendance-correction.js';

test('attendance weekly sync uses Thursday cycle key for release week',()=>{
  assert.equal(weeklyPayrollSyncEntityKey('EMP001','2026-07-23'),'EMP001|2026-07-23');
  assert.equal(weeklyPayrollSyncEntityKey('EMP001','2026-07-29'),'EMP001|2026-07-23');
});

test('attendance weekly sync starts next cycle on Thursday',()=>{
  assert.equal(weeklyPayrollSyncEntityKey('EMP001','2026-07-30'),'EMP001|2026-07-30');
});

test('weekly payroll sync uses the monotonic weekly aggregate version',()=>{
  assert.equal(weeklyPayrollSyncVersion({version:2,weeklyVersion:11}),11);
  assert.equal(weeklyPayrollSyncVersion({version:2}),2);
});

test('admin correction sync uses the monotonic weekly aggregate version',()=>{
  assert.equal(correctionWeeklySyncVersion({version:12},3),12);
  assert.equal(correctionWeeklySyncVersion(null,3),3);
});
