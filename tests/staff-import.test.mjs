import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStaffRows} from '../dist/admin/staff-import.js';
test('real HR_STAFF_CONFIG mapping remains canonical',()=>{
  const rows=[
    ['Employee_ID','Staff_Name','LINE_User_ID','Scheduled_In','Scheduled_Out','Status','Daily_Wage','Grace_Min','Pay_Mode','Deduct_Late','Deduct_Early','OT_Enabled','OT_Rate_Multiplier','Late_Deduction_Baht'],
    ['EMP001','Win','U2759c683f61e504af0dd7f08a432b6e2',4/24,16/24,'Active',500,10,'','daily','','','',0],
    ['EMP002','Tualek','Uaeed1f48686be8b708e6c2a36a4af39d',4/24,16/24,'Active',500,10,'','daily','','','',0]
  ];
  const parsed=parseStaffRows(rows);
  assert.deepEqual(parsed.map(x=>[x.employeeId,x.staffName,x.scheduledIn,x.scheduledOut]),[['EMP001','Win','04:00','16:00'],['EMP002','Tualek','04:00','16:00']]);
  assert.equal(parsed[0].dailyWageBaht,500);
  assert.equal(parsed[0].lateDeductionBaht,0);
  assert.equal(Object.hasOwn(parsed[0],'canSubmitExpense'),false);
});
test('deduction flags and expense permission are imported',()=>{
  const rows=[
    ['Employee_ID','Staff_Name','LINE_User_ID','Scheduled_In','Scheduled_Out','Status','Daily_Wage','Grace_Min','Deduct_Late','Deduct_Early','Late_Deduction_Baht','Early_Deduction_Baht','Can_Submit_Expense'],
    ['EMP001','Win','U2759c683f61e504af0dd7f08a432b6e2','04:00','16:00','Active',500,10,false,true,50,25,true]
  ];
  const [employee]=parseStaffRows(rows);
  assert.equal(employee.lateDeductionBaht,0);
  assert.equal(employee.earlyDeductionBaht,25);
  assert.equal(employee.canSubmitExpense,true);
});
