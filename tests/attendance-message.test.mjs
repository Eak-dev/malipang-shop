import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAttendanceReply} from '../dist/attendance/messages.js';

const employee={employeeId:'EMP001',staffName:'Eak',lineUserId:'U2759c683f61e504af0dd7f08a432b6e2',scheduledIn:'04:10',scheduledOut:'16:00',dailyWageSatang:50000,graceMin:5,lateDeductionSatang:0,earlyDeductionSatang:0,canSubmitExpense:false,status:'ACTIVE'};
const base={eventId:'att_1',workDate:'2026-07-24',officialTime:'04:27',status:'NORMAL',lateMinutes:17,confirmedWageSatang:45000,pendingWageSatang:0,validationCode:'OK',version:1};

function assertNoPayrollAmounts(text){
  for(const forbidden of ['ยอดหัก','ค่าแรง','Payroll','OT','Deduction:','Net pay','บาท'])assert.equal(text.includes(forbidden),false,forbidden);
}

test('employee check-in reply shows detailed attendance evidence but no payroll money',()=>{
  const text=buildAttendanceReply(employee,{...base,punchType:'IN'});
  assert.match(text,/บันทึกเวลาเข้างานเรียบร้อยค่ะ/);
  assert.match(text,/ชื่อ: Eak/);
  assert.match(text,/วันที่: 2026-07-24/);
  assert.match(text,/เวลาเข้างาน: 04:27/);
  assert.match(text,/อ้างอิงเวลา: Timestamp บนภาพ/);
  assert.match(text,/ตรวจ GPS: ผ่าน/);
  assert.match(text,/ยืนยันนาฬิการ้าน: ผ่าน/);
  assert.match(text,/สาย: 17 นาที/);
  assert.match(text,/สถานะ: ปกติ/);
  assert.match(text,/Check-in recorded\./);
  assert.match(text,/Time source: Photo timestamp/);
  assert.match(text,/GPS check: Passed/);
  assert.match(text,/Shop clock evidence: Passed/);
  assert.match(text,/Late: 17 minutes/);
  assert.match(text,/Status: OK/);
  assertNoPayrollAmounts(text);
});

test('employee check-out reply keeps detailed attendance evidence and review status',()=>{
  const text=buildAttendanceReply(employee,{...base,punchType:'OUT',officialTime:'16:05',status:'REVIEW',pendingWageSatang:25000});
  assert.match(text,/บันทึกเวลาออกงานเรียบร้อยค่ะ/);
  assert.match(text,/เวลาออกงาน: 16:05/);
  assert.match(text,/สถานะ: ต้องตรวจสอบ/);
  assert.match(text,/Check-out recorded\./);
  assert.match(text,/Status: Review required/);
  assertNoPayrollAmounts(text);
});
