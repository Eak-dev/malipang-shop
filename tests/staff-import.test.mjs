import test from 'node:test';
import assert from 'node:assert/strict';
import {importEmployees,parseStaffRows,scopeStaffRows} from '../dist/admin/staff-import.js';
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
  assert.equal(Object.hasOwn(parsed[0],'wageEffectiveFrom'),false);
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
test('wage effective date is imported explicitly',()=>{
  const rows=[
    ['Employee_ID','Staff_Name','LINE_User_ID','Scheduled_In','Scheduled_Out','Status','Daily_Wage','Wage_Effective_From','Grace_Min'],
    ['EMP001','Win','U2759c683f61e504af0dd7f08a432b6e2','04:00','16:00','Active',600,'2026-08-01',5]
  ];
  const [employee]=parseStaffRows(rows);
  assert.equal(employee.dailyWageBaht,600);
  assert.equal(employee.wageEffectiveFrom,'2026-08-01');
});
test('invalid wage effective date is rejected',()=>{
  const rows=[
    ['Employee_ID','Staff_Name','LINE_User_ID','Scheduled_In','Scheduled_Out','Status','Daily_Wage','Wage_Effective_From','Grace_Min'],
    ['EMP001','Win','U2759c683f61e504af0dd7f08a432b6e2','04:00','16:00','Active',600,'01/08/2026',5]
  ];
  assert.throws(()=>parseStaffRows(rows),/Wage_Effective_From/);
});
test('new HR staff rows do not require a raw LINE User ID and accept V1.1 role scope',()=>{
  const rows=[
    ['Employee_ID','Staff_Name','Scheduled_In','Scheduled_Out','Status','Daily_Wage','Grace_Min','Role','Branch_ID'],
    ['EMP004','New staff','04:00','16:00','Active',500,10,'EMPLOYEE','B001']
  ];
  const [employee]=parseStaffRows(rows);
  assert.equal(employee.lineUserId,undefined);
  assert.equal(employee.role,'EMPLOYEE');
  assert.equal(employee.branchId,'B001');
});
test('staff config rejects invalid status and an Owner branch scope',()=>{
  const invalidStatus=[
    ['Employee_ID','Staff_Name','Scheduled_In','Scheduled_Out','Status','Daily_Wage','Grace_Min'],
    ['EMP004','New staff','04:00','16:00','Pending',500,10]
  ];
  assert.throws(()=>parseStaffRows(invalidStatus),/Invalid Status/);
  const ownerBranch=[
    ['Employee_ID','Staff_Name','Scheduled_In','Scheduled_Out','Status','Daily_Wage','Grace_Min','Role','Branch_ID'],
    ['OWN002','Nea','04:00','16:00','Active',0,10,'OWNER','B001']
  ];
  assert.throws(()=>parseStaffRows(ownerBranch),/OWNER must use organization scope/);
});
test('configured staff import is restricted to exact validated employee IDs',()=>{
  const inputs=[{employeeId:'EMP003'},{employeeId:'EMP004'},{employeeId:'EMP005'}];
  assert.deepEqual(scopeStaffRows(inputs,{employeeIds:['EMP004','EMP003']}).map(row=>row.employeeId),['EMP003','EMP004']);
  assert.throws(()=>scopeStaffRows(inputs,{employeeIds:['EMP003','EMP003']}),/unique valid IDs/);
  assert.throws(()=>scopeStaffRows(inputs,{employeeIds:['EMP999']}),/not found/);
  assert.throws(()=>scopeStaffRows(inputs,{employeeIds:[]}),/1-200 IDs/);
});
test('a retired Staff ID cannot be re-imported as a new operational identity',async()=>{
  const env={DB:{prepare(sql){return{bind(){return this;},async first(){return sql.includes('staff_identity_aliases')?{canonical_employee_id:'OWN001'}:null;}};}}};
  await assert.rejects(()=>importEmployees(env,[{employeeId:'EMP_TEST',staffName:'Eak',scheduledIn:'04:00',scheduledOut:'16:00',status:'ACTIVE',dailyWageBaht:500,graceMin:10,lateDeductionBaht:0}]),/Retired Staff ID: EMP_TEST; use OWN001/);
});
