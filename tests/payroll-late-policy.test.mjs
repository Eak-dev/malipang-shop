import test from 'node:test';
import assert from 'node:assert/strict';
import {calculatePayroll,PAYROLL_POLICY_CODE,FLAT_LATE_POLICY_CODE} from '../dist/domain/payroll.js';
import {PayrollContextReviewError,resolvePayrollDayContext} from '../dist/payroll/day-context.js';

const today='2030-06-10',workDate='2030-06-09';
const employee={employeeId:'TEST_LATE_A',staffName:'Synthetic policy staff',lineUserId:'synthetic_line_policy',scheduledIn:'09:00',scheduledOut:'18:00',dailyWageSatang:80000,graceMin:10,lateDeductionSatang:0,earlyDeductionSatang:0,canSubmitExpense:false,status:'ACTIVE'};

// Independent stored evidence: 400 - 100 late - 20 early + 30 OT - 5 adjustment = 305 baht.
// Current defaults above intentionally disagree with this historical shift and wage.
function storedV1(overrides={}){
  return{scheduled_in:'08:00',scheduled_out:'17:00',grace_min:5,late_deduction_satang:5000,early_deduction_satang:2000,
    daily_wage_satang:40000,daily_wage_snapshot_satang:40000,time_in:'08:30',time_out:'16:40',late_minutes:30,early_out_minutes:20,
    late_deduction_applied_satang:10000,missing_punch_deduction_satang:0,ot_approved_satang:3000,other_adjustment_satang:-500,
    net_pay_satang:30500,review_flag:0,finalized_at:'2030-06-09T11:00:00.000Z',payroll_policy_code:PAYROLL_POLICY_CODE,...overrides};
}
function storedV2(overrides={}){
  return storedV1({payroll_policy_code:FLAT_LATE_POLICY_CODE,late_deduction_applied_satang:5000,net_pay_satang:35500,...overrides});
}
function resolveStored(daily,env={}){
  return resolvePayrollDayContext(env,{employee,workDate,today,daily,timeIn:daily.time_in,timeOut:daily.time_out});
}
function calculateStored(context,daily){
  return calculatePayroll({...context,timeIn:daily.time_in,timeOut:daily.time_out,review:Boolean(daily.review_flag),
    finalizeMissingPunch:Boolean(daily.finalized_at),otApprovedSatang:daily.ot_approved_satang,otherAdjustmentSatang:daily.other_adjustment_satang});
}
function expectReview(action,reason){
  assert.throws(action,error=>error instanceof PayrollContextReviewError&&error.message===`PAYROLL_CONTEXT_REVIEW_REQUIRED:${reason}`);
}

test('stored V2 remains usable when configuration for selecting new days is malformed',()=>{
  const daily=storedV2();
  for(const env of [
    {PAYROLL_LATE_V2_EFFECTIVE_FROM:'2030-02-30',PAYROLL_LATE_V2_EMPLOYEE_IDS:'TEST_LATE_A'},
    {PAYROLL_LATE_V2_EFFECTIVE_FROM:'2030-06-01',PAYROLL_LATE_V2_EMPLOYEE_IDS:'TEST_LATE_A,TEST_LATE_A'},
  ]){
    const context=resolveStored(daily,env),result=calculateStored(context,daily);
    assert.equal(context.policyCode,FLAT_LATE_POLICY_CODE);
    assert.equal(context.employee.dailyWageSatang,40000);
    assert.equal(context.employee.scheduledIn,'08:00');
    assert.equal(context.employee.graceMin,5);
    assert.equal(context.employee.lateDeductionSatang,5000);
    assert.equal(result.lateDeductionSatang,5000);
    assert.equal(result.netPaySatang,35500);
  }
});

test('V2 refuses a stored grace or deduction setting incompatible with its policy version',()=>{
  for(const invalid of [{grace_min:0},{grace_min:10},{late_deduction_satang:2500},{late_deduction_satang:10000}]){
    expectReview(()=>resolveStored(storedV2(invalid)),'INVALID_V2_SNAPSHOT');
  }
});

test('invalid stored wage values cannot fall back to a valid current or legacy wage',()=>{
  for(const value of [-1,NaN,1.5,Number.MAX_SAFE_INTEGER+1,'40000']){
    expectReview(()=>resolveStored(storedV2({daily_wage_snapshot_satang:value})),'INVALID_daily_wage_snapshot_satang');
  }
  expectReview(()=>resolveStored(storedV2({late_deduction_satang:'5000'})),'INVALID_late_deduction_satang');
});

test('an explicit zero V2 wage snapshot wins over nonzero legacy and current wages',()=>{
  const daily=storedV2({daily_wage_snapshot_satang:0,daily_wage_satang:90000,time_out:'17:00',early_out_minutes:0,
    ot_approved_satang:0,other_adjustment_satang:0,net_pay_satang:0});
  const context=resolveStored(daily),result=calculateStored(context,daily);
  assert.equal(context.employee.dailyWageSatang,0);
  assert.equal(result.baseWageSatang,0);
  assert.equal(result.totalDeductionSatang,0);
  assert.equal(result.netPaySatang,0);
  assert.equal(result.payStatus,'NO_AMOUNT');
  assert.equal(resolveStored(storedV2({daily_wage_snapshot_satang:null})).employee.dailyWageSatang,40000);
});

test('V1 replay uses the stored shift, wage, early deduction, OT and negative adjustment',()=>{
  const daily=storedV1(),context=resolveStored(daily),result=calculateStored(context,daily);
  assert.equal(context.policyCode,PAYROLL_POLICY_CODE);
  assert.equal(context.employee.dailyWageSatang,40000);
  assert.equal(context.employee.scheduledIn,'08:00');
  assert.equal(context.employee.scheduledOut,'17:00');
  assert.equal(context.employee.lateDeductionSatang,5000);
  assert.equal(result.lateDeductionSatang,10000);
  assert.equal(result.earlyDeductionSatang,2000);
  assert.equal(result.otApprovedSatang,3000);
  assert.equal(result.otherAdjustmentSatang,-500);
  assert.equal(result.netPaySatang,30500);
  assert.equal(result.confirmedWageSatang,30500);
});

test('a mismatch in any stored V1 calculation result requires review',()=>{
  for(const [field,value] of [
    ['late_minutes',31],['early_out_minutes',21],['late_deduction_applied_satang',9999],
    ['missing_punch_deduction_satang',100],['net_pay_satang',30501],
  ])expectReview(()=>resolveStored(storedV1({[field]:value})),'V1_STORED_RESULT_DRIFT');
});

test('completing a V1 missing punch requires unambiguous deduction settings, not identical current shift or wage',()=>{
  const daily=storedV1({time_out:null,early_out_minutes:0,late_deduction_applied_satang:0,
    missing_punch_deduction_satang:20000,net_pay_satang:22500,finalized_at:null});
  const current={...employee,scheduledOut:'17:00',graceMin:5,lateDeductionSatang:5000,earlyDeductionSatang:2000};
  const input={employee:current,workDate,today,daily,timeIn:'08:30',timeOut:'16:40'};
  for(const changed of [{graceMin:10},{lateDeductionSatang:0},{earlyDeductionSatang:0}]){
    expectReview(()=>resolvePayrollDayContext({}, {...input,employee:{...current,...changed}}),'V1_CHANGED_PUNCH_CONFIG_AMBIGUOUS');
  }
  // V1 uses the configured late amount as an enable/disable gate, so positive-to-positive is not drift.
  const context=resolvePayrollDayContext({}, {...input,employee:{...current,lateDeductionSatang:2500}});
  const result=calculateStored(context,{...daily,time_out:'16:40'});
  assert.equal(context.employee.scheduledIn,'08:00');
  assert.equal(context.employee.dailyWageSatang,40000);
  assert.equal(result.netPaySatang,30500);
});

test('expected-shift exemption cannot create historical payroll when any punch is supplied',()=>{
  const env={PAYROLL_LATE_V2_EFFECTIVE_FROM:workDate,PAYROLL_LATE_V2_EMPLOYEE_IDS:employee.employeeId};
  const input={employee,workDate,today,expectedAbsence:true,timeIn:null,timeOut:null};
  for(const punches of [{timeIn:'09:00',timeOut:null},{timeIn:null,timeOut:'18:00'},{timeIn:'09:00',timeOut:'18:00'}]){
    expectReview(()=>resolvePayrollDayContext(env,{...input,...punches}),'HISTORICAL_INPUTS_MISSING');
  }
  const context=resolvePayrollDayContext(env,input);
  const result=calculatePayroll({...context,timeIn:null,timeOut:null,review:true,finalizeMissingPunch:true});
  assert.equal(result.missingPunchType,'BOTH');
  assert.equal(result.confirmedWageSatang,0);
  assert.equal(result.payStatus,'REVIEW');
});
