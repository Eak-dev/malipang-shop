import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAttendanceReply} from '../dist/attendance/messages.js';

const employee={employeeId:'EMP001',staffName:'Win',lineUserId:'U2759c683f61e504af0dd7f08a432b6e2',scheduledIn:'04:00',scheduledOut:'16:00',dailyWageSatang:50000,graceMin:5,lateDeductionSatang:0,earlyDeductionSatang:0,canSubmitExpense:false,status:'ACTIVE'};
const base={eventId:'att_1',workDate:'2026-07-24',officialTime:'04:12',status:'NORMAL',lateMinutes:12,confirmedWageSatang:45000,pendingWageSatang:0,validationCode:'OK',version:1};

test('employee check-in reply shows time but no payroll details',()=>{
  const text=buildAttendanceReply(employee,{...base,punchType:'IN'});
  assert.match(text,/04:12/);
  for(const forbidden of ['ยอดหัก','ค่าแรง','Payroll','OT','Late:','Deduction:'])assert.equal(text.includes(forbidden),false,forbidden);
});

test('review reply remains time-only',()=>{
  const text=buildAttendanceReply(employee,{...base,punchType:'OUT',officialTime:'16:05',status:'REVIEW',pendingWageSatang:25000});
  assert.match(text,/16:05/);
  assert.match(text,/ผู้ดูแลจะตรวจสอบ/);
  for(const forbidden of ['250','ยอดหัก','ค่าแรง','Payroll','OT'])assert.equal(text.includes(forbidden),false,forbidden);
});