import test from 'node:test';
import assert from 'node:assert/strict';
import {parseOwnerOtCommand} from '../dist/payroll/owner-command.js';

test('creates fixed OT using employee name and today',()=>{
  assert.deepEqual(parseOwnerOtCommand('OT Win วันนี้ 200 16:00-18:00 เตรียมไส้เพิ่ม','2026-07-24'),{
    kind:'CREATE',employeeRef:'Win',workDate:'2026-07-24',fixedAmountBaht:200,plannedStart:'16:00',plannedEnd:'18:00',reason:'เตรียมไส้เพิ่ม'
  });
});

test('creates fixed OT for staff names containing spaces',()=>{
  const command=parseOwnerOtCommand('โอที Laws non พรุ่งนี้ 100 ช่วยปิดร้าน','2026-07-24');
  assert.equal(command.employeeRef,'Laws non');
  assert.equal(command.workDate,'2026-07-25');
  assert.equal(command.fixedAmountBaht,100);
  assert.equal(command.plannedStart,null);
});

test('parses owner final approval and rejection',()=>{
  assert.deepEqual(parseOwnerOtCommand('OT อนุมัติ ot_123 200 งานครบ','2026-07-24'),{kind:'APPROVE',otId:'ot_123',finalAmountBaht:200,note:'งานครบ'});
  assert.deepEqual(parseOwnerOtCommand('OT ไม่อนุมัติ ot_123 พนักงานไม่ได้ทำ','2026-07-24'),{kind:'REJECT',otId:'ot_123',note:'พนักงานไม่ได้ทำ'});
});

test('rejects missing OT reason and invalid time range',()=>{
  assert.throws(()=>parseOwnerOtCommand('OT Win วันนี้ 200','2026-07-24'),/reason/);
  assert.throws(()=>parseOwnerOtCommand('OT Win วันนี้ 200 18:00-16:00 เหตุผล','2026-07-24'),/reason/);
});
