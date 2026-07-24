import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attendanceNotAllowedMessage,buildAttendanceReply,unauthorizedImageMessage,unsupportedImageMessage
} from '../dist/attendance/messages.js';

const employee={employeeId:'EMP001',staffName:'Eak',lineUserId:'U1',scheduledIn:'04:10',scheduledOut:'16:00',dailyWageSatang:50000,graceMin:5,lateDeductionSatang:0,earlyDeductionSatang:0,canSubmitExpense:false,status:'ACTIVE'};
const result={eventId:'att_1',punchType:'IN',workDate:'2026-07-24',officialTime:'04:27',status:'NORMAL',lateMinutes:17,confirmedWageSatang:45000,pendingWageSatang:0,validationCode:'OK',version:1};

function assertThreeLanguages(message){
  assert.match(message,/[ก-๙]/,'Thai text missing');
  assert.match(message,/[A-Za-z]/,'English text missing');
  assert.match(message,/[က-႟]/,'Burmese text missing');
}

function assertNoPayrollMoney(message){
  for(const forbidden of ['ยอดหัก','ค่าแรง','Payroll','OT','Deduction:','Confirmed wage','Pending wage','Net pay','บาท'])assert.equal(message.includes(forbidden),false,forbidden);
}

test('check-in success is trilingual and shows detailed attendance evidence',()=>{
  const message=buildAttendanceReply(employee,result);
  assertThreeLanguages(message);
  assert.match(message,/บันทึกเวลาเข้างานเรียบร้อยค่ะ/);
  assert.match(message,/Check-in recorded\./);
  assert.match(message,/အလုပ်ဝင်ချိန်/);
  assert.match(message,/2026-07-24/);
  assert.match(message,/04:27/);
  assert.match(message,/อ้างอิงเวลา: Timestamp บนภาพ/);
  assert.match(message,/ตรวจ GPS: ผ่าน/);
  assert.match(message,/ยืนยันนาฬิการ้าน: ผ่าน/);
  assert.match(message,/สาย: 17 นาที/);
  assert.match(message,/สถานะ: ปกติ/);
  assert.match(message,/Time source: Photo timestamp/);
  assert.match(message,/GPS check: Passed/);
  assert.match(message,/Shop clock evidence: Passed/);
  assert.match(message,/Late: 17 minutes/);
  assert.match(message,/Status: OK/);
  assertNoPayrollMoney(message);
});

test('check-out, duplicate, and complete replies are trilingual and payroll-money-free',()=>{
  for(const punchType of ['OUT','DUPLICATE','COMPLETE']){
    const message=buildAttendanceReply(employee,{...result,punchType});
    assertThreeLanguages(message);
    assertNoPayrollMoney(message);
  }
});

test('attendance permission and image intake failures are trilingual',()=>{
  for(const message of [attendanceNotAllowedMessage(),unsupportedImageMessage(),unauthorizedImageMessage()])assertThreeLanguages(message);
});
