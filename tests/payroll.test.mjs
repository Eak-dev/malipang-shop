import test from 'node:test';
import assert from 'node:assert/strict';
import {calculatePayroll,lateDeductionFor} from '../dist/domain/payroll.js';
import {preservedWageSnapshot,resolveWageSnapshot} from '../dist/payroll/repository.js';
const employee={employeeId:'EMP001',staffName:'Win',lineUserId:'U2759c683f61e504af0dd7f08a432b6e2',scheduledIn:'04:00',scheduledOut:'16:00',dailyWageSatang:55000,graceMin:5,lateDeductionSatang:5000,earlyDeductionSatang:500,canSubmitExpense:false,status:'ACTIVE'};
test('late policy boundaries are exact',()=>{
  assert.equal(lateDeductionFor(55000,5),0);
  assert.equal(lateDeductionFor(55000,6),5000);
  assert.equal(lateDeductionFor(55000,29),5000);
  assert.equal(lateDeductionFor(55000,30),10000);
  assert.equal(lateDeductionFor(55000,89),10000);
  assert.equal(lateDeductionFor(55000,90),27500);
});
test('complete day inside five-minute grace is ready',()=>{const r=calculatePayroll({employee,timeIn:'04:05',timeOut:'16:00',review:false});assert.equal(r.confirmedWageSatang,55000);assert.equal(r.payStatus,'READY');});
test('six minutes late deducts fifty baht',()=>{const r=calculatePayroll({employee,timeIn:'04:06',timeOut:'16:00',review:false});assert.equal(r.lateMinutes,6);assert.equal(r.lateDeductionSatang,5000);assert.equal(r.appliedLateDeductionSatang,5000);assert.equal(r.appliedMissingPunchDeductionSatang,0);assert.equal(r.confirmedWageSatang,50000);});
test('late deduction opt-out keeps full wage even when late',()=>{const r=calculatePayroll({employee:{...employee,lateDeductionSatang:0},timeIn:'04:40',timeOut:'16:00',review:false});assert.equal(r.lateMinutes,40);assert.equal(r.lateDeductionSatang,0);assert.equal(r.confirmedWageSatang,55000);});
test('employee grace setting is respected',()=>{const r=calculatePayroll({employee:{...employee,graceMin:10},timeIn:'04:07',timeOut:'16:00',review:false});assert.equal(r.lateMinutes,7);assert.equal(r.lateDeductionSatang,0);assert.equal(r.confirmedWageSatang,55000);});
test('ninety minutes late deducts half of this employee wage',()=>{const r=calculatePayroll({employee,timeIn:'05:30',timeOut:'16:00',review:false});assert.equal(r.lateDeductionSatang,27500);assert.equal(r.appliedLateDeductionSatang,27500);assert.equal(r.confirmedWageSatang,27500);});
test('half-day amount changes with each employee wage',()=>{const r=calculatePayroll({employee:{...employee,dailyWageSatang:62000},timeIn:'05:30',timeOut:'16:00',review:false});assert.equal(r.lateDeductionSatang,31000);assert.equal(r.confirmedWageSatang,31000);});
test('one missing punch is half wage pending until day finalization',()=>{const pending=calculatePayroll({employee,timeIn:'04:00',timeOut:null,review:false});assert.equal(pending.missingPunchType,'MISSING_OUT');assert.equal(pending.missingPunchDeductionSatang,27500);assert.equal(pending.appliedMissingPunchDeductionSatang,27500);assert.equal(pending.pendingWageSatang,27500);assert.equal(pending.payStatus,'REVIEW');const final=calculatePayroll({employee,timeIn:'04:00',timeOut:null,review:false,finalizeMissingPunch:true});assert.equal(final.confirmedWageSatang,27500);assert.equal(final.payStatus,'READY');});
test('late and missing punch do not stack in reports or net pay',()=>{const r=calculatePayroll({employee,timeIn:'04:35',timeOut:null,review:false});assert.equal(r.lateDeductionSatang,10000);assert.equal(r.missingPunchDeductionSatang,27500);assert.equal(r.appliedLateDeductionSatang,0);assert.equal(r.appliedMissingPunchDeductionSatang,27500);assert.equal(r.totalDeductionSatang,27500);assert.equal(r.pendingWageSatang,27500);});
test('both punches missing uses full wage and remains review',()=>{const r=calculatePayroll({employee,timeIn:null,timeOut:null,review:false,finalizeMissingPunch:true});assert.equal(r.missingPunchType,'BOTH');assert.equal(r.missingPunchDeductionSatang,55000);assert.equal(r.appliedLateDeductionSatang,0);assert.equal(r.appliedMissingPunchDeductionSatang,55000);assert.equal(r.netPaySatang,0);assert.equal(r.payStatus,'REVIEW');});
test('approved fixed OT is added to net pay',()=>{const r=calculatePayroll({employee,timeIn:'04:00',timeOut:'17:00',review:false,otApprovedSatang:20000});assert.equal(r.otApprovedSatang,20000);assert.equal(r.confirmedWageSatang,75000);});
test('early deduction remains separate for a complete day',()=>{const r=calculatePayroll({employee,timeIn:'04:00',timeOut:'15:30',review:false});assert.equal(r.earlyOutMinutes,30);assert.equal(r.earlyDeductionSatang,500);assert.equal(r.confirmedWageSatang,54500);});
test('review moves calculated net wage to pending',()=>{const r=calculatePayroll({employee,timeIn:'04:00',timeOut:'16:00',review:true});assert.equal(r.confirmedWageSatang,0);assert.equal(r.pendingWageSatang,55000);assert.equal(r.payStatus,'REVIEW');});
test('zero wage is NO_AMOUNT',()=>{const r=calculatePayroll({employee:{...employee,dailyWageSatang:0},timeIn:'04:00',timeOut:'16:00',review:false});assert.equal(r.payStatus,'NO_AMOUNT');});
test('inactive employee with no punches creates no synthetic wage or review',()=>{const r=calculatePayroll({employee:{...employee,status:'INACTIVE'},timeIn:null,timeOut:null,review:true,finalizeMissingPunch:true});assert.equal(r.baseWageSatang,0);assert.equal(r.netPaySatang,0);assert.equal(r.payStatus,'NO_AMOUNT');});
test('inactive no-punch cleanup preserves approved adjustments',()=>{const r=calculatePayroll({employee:{...employee,status:'INACTIVE'},timeIn:null,timeOut:null,review:true,finalizeMissingPunch:true,otApprovedSatang:10000,otherAdjustmentSatang:5000});assert.equal(r.baseWageSatang,0);assert.equal(r.otApprovedSatang,10000);assert.equal(r.otherAdjustmentSatang,5000);assert.equal(r.confirmedWageSatang,15000);assert.equal(r.payStatus,'READY');});
test('first wage history date is not inferred to be employment start',async()=>{
  const statements=[];
  const env={DB:{prepare(sql){const statement={sql,args:[],bind(...args){this.args=args;return this;},async first(){return sql.includes('ORDER BY effective_from ASC')?{effective_from:'2026-08-27'}:null;}};statements.push(statement);return statement;}}};
  const result=await resolveWageSnapshot(env,employee,'2026-08-25');
  assert.deepEqual(result,{wageSourceId:'EMPLOYEE_CURRENT_FALLBACK',dailyWageSatang:55000,effectiveFrom:'2026-08-25',effectiveTo:null});
  assert.equal(statements.length,1);
});
test('existing zero snapshot is preserved as an intentional value',()=>{
  assert.deepEqual(preservedWageSnapshot({work_date:'2026-08-25',wage_source_id:'OWNER_ZERO',daily_wage_snapshot_satang:0,daily_wage_satang:50000}),{wageSourceId:'OWNER_ZERO',dailyWageSatang:0,effectiveFrom:'2026-08-25',effectiveTo:null});
  assert.equal(preservedWageSnapshot({daily_wage_snapshot_satang:null,daily_wage_satang:null}),null);
});
