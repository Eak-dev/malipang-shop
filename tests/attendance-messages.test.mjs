import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attendanceNotAllowedMessage,buildAttendanceReply,unauthorizedImageMessage,unsupportedImageMessage
} from '../dist/attendance/messages.js';

const employee={employeeId:'EMP001',staffName:'Eak',lineUserId:'U1',scheduledIn:'04:00',scheduledOut:'16:00',dailyWageSatang:50000,graceMin:10,lateDeductionSatang:0,earlyDeductionSatang:0,canSubmitExpense:false,status:'ACTIVE'};
const result={eventId:'att_1',punchType:'IN',workDate:'2026-07-21',officialTime:'08:43',status:'NORMAL',lateMinutes:283,confirmedWageSatang:25000,pendingWageSatang:0,validationCode:'OK',version:1};

function assertThreeLanguages(message){
  assert.match(message,/[ก-๙]/,'Thai text missing');
  assert.match(message,/[A-Za-z]/,'English text missing');
  assert.match(message,/[က-႟]/,'Burmese text missing');
}

function assertNoPayrollDetails(message){
  for(const forbidden of ['ยอดหัก','ค่าแรง','Payroll','OT','Late:','Deduction:','Confirmed wage','Pending wage'])assert.equal(message.includes(forbidden),false,forbidden);
}

test('check-in success is trilingual and shows only identity, date, and official time',()=>{
  const message=buildAttendanceReply(employee,result);
  assertThreeLanguages(message);
  assert.match(message,/บันทึกเวลาเข้างานเรียบร้อย/);
  assert.match(message,/Check-in recorded/);
  assert.match(message,/အလုပ်ဝင်ချိန်/);
  assert.match(message,/2026-07-21/);
  assert.match(message,/08:43/);
  assertNoPayrollDetails(message);
  assert.doesNotMatch(message,/GPS check|Shop clock evidence|Time source/);
});

test('check-out, duplicate, and complete replies are trilingual and payroll-free',()=>{
  for(const punchType of ['OUT','DUPLICATE','COMPLETE']){
    const message=buildAttendanceReply(employee,{...result,punchType});
    assertThreeLanguages(message);
    assertNoPayrollDetails(message);
  }
});

test('attendance permission and image intake failures are trilingual',()=>{
  for(const message of [attendanceNotAllowedMessage(),unsupportedImageMessage(),unauthorizedImageMessage()])assertThreeLanguages(message);
});