import test from 'node:test';
import assert from 'node:assert/strict';
import {calculatePayroll,PAYROLL_POLICY_CODE,FLAT_LATE_POLICY_CODE,LEGACY_LATE_POLICY_CODE} from '../dist/domain/payroll.js';
import {latePolicyActivation,resolvePayrollDayContext} from '../dist/payroll/day-context.js';
import {AttendanceCoordinator} from '../dist/durable/attendance-coordinator.js';
import {correctAttendance} from '../dist/admin/attendance-correction.js';
import {finalizeFixedOt} from '../dist/admin/payroll-admin.js';
import {recalculateDailyPayroll} from '../dist/payroll/recalculate.js';
import {previewPayrollRange,applyPayrollRange} from '../dist/payroll/range.js';
import {finalizeMissingPunchPayrolls} from '../dist/payroll/finalize.js';
import {employeeFromRow} from '../dist/payroll/repository.js';
import {addDays,isoDateInBangkok,payrollPeriodFor} from '../dist/shared/time.js';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';

const staffId='TEST_LATE_STAFF';
const syntheticEmployee={employeeId:staffId,staffName:'Synthetic payroll staff',lineUserId:'synthetic_line',scheduledIn:'04:00',scheduledOut:'16:00',dailyWageSatang:60000,graceMin:10,lateDeductionSatang:2500,earlyDeductionSatang:0,canSubmitExpense:false,status:'ACTIVE'};
const selected={PAYROLL_LATE_V2_EFFECTIVE_FROM:'2030-01-10',PAYROLL_LATE_V2_EMPLOYEE_IDS:staffId};
const newDay={employee:syntheticEmployee,workDate:'2030-01-10',today:'2030-01-10',timeIn:'04:06',timeOut:'16:00'};

for(const [minutes,expected] of [[0,0],[5,0],[6,5000],[29,5000],[30,5000],[89,5000],[90,5000],[300,5000]]){
  test(`V2 lateness ${minutes} minutes is ${expected} satang for every wage`,()=>{
    for(const wage of [50000,55000,60000,125000]){
      const timeIn=`${String(4+Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
      const context=resolvePayrollDayContext(selected,{...newDay,employee:{...syntheticEmployee,dailyWageSatang:wage},timeIn});
      const result=calculatePayroll({...context,timeIn,timeOut:'16:00',review:false});
      assert.equal(result.lateDeductionSatang,expected);assert.equal(result.netPaySatang,wage-expected);
      assert.equal(context.employee.graceMin,5);assert.equal(context.employee.lateDeductionSatang,5000);
    }
  });
}
test('missing or partial activation remains inactive; date and exact scope are validated',()=>{
  for(const env of [{},{PAYROLL_LATE_V2_EFFECTIVE_FROM:selected.PAYROLL_LATE_V2_EFFECTIVE_FROM},{PAYROLL_LATE_V2_EMPLOYEE_IDS:staffId}]){
    assert.equal(latePolicyActivation(env).active,false);
    assert.equal(resolvePayrollDayContext(env,newDay).policyCode,PAYROLL_POLICY_CODE);
  }
  for(const env of [
    {...selected,PAYROLL_LATE_V2_EFFECTIVE_FROM:'2030-02-30'},
    {...selected,PAYROLL_LATE_V2_EMPLOYEE_IDS:'*'},
    {...selected,PAYROLL_LATE_V2_EMPLOYEE_IDS:`${staffId},${staffId}`},
    {...selected,PAYROLL_LATE_V2_EMPLOYEE_IDS:`${staffId},`},
  ])assert.throws(()=>resolvePayrollDayContext(env,newDay),/PAYROLL_LATE_V2_INVALID/);
  assert.equal(resolvePayrollDayContext(selected,{...newDay,workDate:'2030-01-09',today:'2030-01-09'}).policyCode,PAYROLL_POLICY_CODE);
  assert.equal(resolvePayrollDayContext({...selected,PAYROLL_LATE_V2_EMPLOYEE_IDS:'TEST_OTHER'},newDay).policyCode,PAYROLL_POLICY_CODE);
});
test('V2 scope does not enable an employee opt-out',()=>{
  const context=resolvePayrollDayContext(selected,{...newDay,employee:{...syntheticEmployee,lateDeductionSatang:0}});
  const result=calculatePayroll({...context,timeIn:'09:00',timeOut:'16:00',review:false});
  assert.equal(context.policyCode,FLAT_LATE_POLICY_CODE);assert.equal(context.employee.lateDeductionSatang,0);
  assert.equal(result.lateDeductionSatang,0);assert.equal(result.netPaySatang,60000);
});
test('V2 keeps missing-punch max, early, fixed OT, adjustments and review rules',()=>{
  const context=resolvePayrollDayContext(selected,newDay);
  const missing=calculatePayroll({...context,timeIn:'05:30',timeOut:null,review:false});
  assert.equal(missing.lateDeductionSatang,5000);assert.equal(missing.appliedLateDeductionSatang,0);
  assert.equal(missing.appliedMissingPunchDeductionSatang,30000);assert.equal(missing.totalDeductionSatang,30000);
  assert.equal(missing.confirmedWageSatang,0);assert.equal(missing.pendingWageSatang,30000);assert.equal(missing.payStatus,'REVIEW');
  const complete=calculatePayroll({...context,employee:{...context.employee,earlyDeductionSatang:2500},timeIn:'04:06',timeOut:'15:59',review:false,otApprovedSatang:10000,otherAdjustmentSatang:-1000});
  assert.equal(complete.totalDeductionSatang,7500);assert.equal(complete.netPaySatang,61500);
  const review=calculatePayroll({...context,timeIn:'04:06',timeOut:'16:00',review:true});
  assert.equal(review.pendingWageSatang,55000);assert.equal(review.confirmedWageSatang,0);
});
test('unknown policy cannot enter calculator through an untyped input',()=>{
  assert.throws(()=>calculatePayroll({employee:syntheticEmployee,timeIn:'04:06',timeOut:'16:00',review:false,policyCode:'UNKNOWN'}),/POLICY_UNKNOWN/);
});

function fixture(overrides={}){
  const h=expenseSqlite(),today=isoDateInBangkok(),now=new Date().toISOString();
  const initial={...syntheticEmployee,...overrides};
  h.sqlite.prepare(`INSERT INTO employees(employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,daily_wage_satang,grace_min,late_deduction_satang,early_deduction_satang,can_submit_expense,status,updated_at) VALUES(?,?,?,?,?,?,?,?,?,0,'ACTIVE',?)`).run(staffId,initial.staffName,initial.lineUserId,initial.scheduledIn,initial.scheduledOut,initial.dailyWageSatang,initial.graceMin,initial.lateDeductionSatang,initial.earlyDeductionSatang,now);
  h.sqlite.prepare(`INSERT INTO employee_wage_history(wage_id,employee_id,daily_wage_satang,effective_from,source,note,version,created_at,updated_at) VALUES('wage_synthetic',?,?,'2000-01-01','TEST','synthetic',1,?,?)`).run(staffId,initial.dailyWageSatang,now,now);
  const instances=new Map();
  h.env.ATTENDANCE_COORDINATOR={idFromName:key=>key,get(key){
    if(!instances.has(key)){
      const values=new Map();let tail=Promise.resolve();
      const state={storage:{async transaction(fn){return fn({async get(k){return structuredClone(values.get(k));},async put(k,v){values.set(k,structuredClone(v));}});}},blockConcurrencyWhile(fn){const next=tail.then(fn);tail=next.catch(()=>{});return next;}};
      instances.set(key,new AttendanceCoordinator(state,h.env));
    }
    return{fetch:(url,init)=>instances.get(key).fetch(new Request(url,init))};
  }};
  const employee=()=>employeeFromRow(h.sqlite.prepare('SELECT * FROM employees WHERE employee_id=?').get(staffId));
  const daily=(date=today)=>h.sqlite.prepare('SELECT * FROM attendance_daily WHERE employee_id=? AND work_date=?').get(staffId,date);
  const count=table=>h.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  async function punch(time,id,date=today){
    const input={employee:employee(),workDate:date,officialTime:time,messageId:id,webhookEventId:`webhook_${id}`,traceId:`trace_${id}`,imageSha256:`synthetic_hash_${id}`,imageKey:'synthetic_evidence',reading:{confidence:1,needsNewPhoto:false},lineTime:time,lineDiffMinutes:0,validationReview:false,validationCode:'OK',validationNote:'Synthetic',photoDateTime:`${date}T${time}:00+07:00`,gpsLat:0,gpsLng:0,distanceM:0,attendanceSource:'PHOTO_TIMESTAMP_GPS',clockEvidence:true,clockConfidence:1,overlayRawText:'Synthetic'};
    const result=await h.env.ATTENDANCE_COORDINATOR.get(`${staffId}|${date}`).fetch('https://attendance.local/commit',{method:'POST',body:JSON.stringify(input)});
    return result.json();
  }
  function seedDaily(date,options={}){
    const e={...employee(),...(options.employee||{})},policyCode=options.policyCode||PAYROLL_POLICY_CODE;
    const timeIn=options.timeIn===undefined?'04:40':options.timeIn,timeOut=options.timeOut===undefined?'16:00':options.timeOut;
    const result=calculatePayroll({employee:e,policyCode:policyCode===FLAT_LATE_POLICY_CODE?FLAT_LATE_POLICY_CODE:PAYROLL_POLICY_CODE,timeIn,timeOut,review:options.review||false,finalizeMissingPunch:options.finalized||false,otApprovedSatang:options.ot||0,otherAdjustmentSatang:options.adjustment||0});
    const row={employee_id:staffId,work_date:date,scheduled_in:e.scheduledIn,scheduled_out:e.scheduledOut,grace_min:e.graceMin,late_deduction_satang:e.lateDeductionSatang,early_deduction_satang:e.earlyDeductionSatang,time_in:timeIn,time_out:timeOut,work_minutes:result.workMinutes,late_minutes:result.lateMinutes,early_out_minutes:result.earlyOutMinutes,daily_wage_satang:e.dailyWageSatang,confirmed_wage_satang:result.confirmedWageSatang,pending_wage_satang:result.pendingWageSatang,pay_status:result.payStatus,review_flag:options.review?1:0,version:1,updated_at:now,wage_source_id:'wage_synthetic',daily_wage_snapshot_satang:e.dailyWageSatang,late_deduction_applied_satang:result.appliedLateDeductionSatang,missing_punch_type:result.missingPunchType,missing_punch_deduction_satang:result.appliedMissingPunchDeductionSatang,ot_approved_satang:result.otApprovedSatang,other_adjustment_satang:result.otherAdjustmentSatang,net_pay_satang:result.netPaySatang,payroll_policy_code:policyCode,finalized_at:options.finalized?now:null};
    h.sqlite.prepare(`INSERT INTO attendance_daily(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
    return row;
  }
  function activate(date=today){h.env.PAYROLL_LATE_V2_EFFECTIVE_FROM=date;h.env.PAYROLL_LATE_V2_EMPLOYEE_IDS=staffId;}
  function period(date=today){const p=payrollPeriodFor(date);return{fromDate:p.weekStart,toDate:p.weekEnd};}
  return{...h,today,employee,daily,count,punch,seedDaily,activate,period};
}

test('V2 IN then OUT persists effective context, survives deactivation and retries without duplicates',async()=>{
  const h=fixture();try{
    h.activate();await h.punch('04:06','synthetic_in');
    let row=h.daily();assert.equal(row.grace_min,5);assert.equal(row.late_deduction_satang,5000);assert.equal(row.payroll_policy_code,FLAT_LATE_POLICY_CODE);
    assert.equal(row.confirmed_wage_satang,0);assert.equal(row.pending_wage_satang,30000);assert.equal(row.finalized_at,null);
    delete h.env.PAYROLL_LATE_V2_EFFECTIVE_FROM;delete h.env.PAYROLL_LATE_V2_EMPLOYEE_IDS;
    h.sqlite.prepare('UPDATE employees SET daily_wage_satang=70000,grace_min=90,late_deduction_satang=0,scheduled_in=? WHERE employee_id=?').run('05:00',staffId);
    await h.punch('16:00','synthetic_out');
    row=h.daily();assert.equal(row.confirmed_wage_satang,55000);assert.equal(row.daily_wage_snapshot_satang,60000);assert.equal(row.late_minutes,6);assert.equal(row.grace_min,5);
    assert.equal((await h.punch('16:00','synthetic_out')).punchType,'DUPLICATE');
    assert.equal(h.count('attendance_events'),2);assert.equal(h.count('attendance_daily'),1);
    const preview=await previewPayrollRange(h.env,h.period());
    assert.equal(preview.rows[0].payrollPolicyCode,FLAT_LATE_POLICY_CODE);assert.equal(preview.rows[0].effectiveGraceMin,5);assert.equal(preview.rows[0].lateDeductionEnabled,true);
    assert.equal(preview.totalNetPayBaht,550);
    await recalculateDailyPayroll(h.env,staffId,h.today);
    assert.equal(h.daily().confirmed_wage_satang,55000);assert.equal(h.daily().payroll_policy_code,FLAT_LATE_POLICY_CODE);
    assert.equal(h.sqlite.prepare('SELECT confirmed_amount_satang FROM payroll_weekly WHERE employee_id=?').get(staffId).confirmed_amount_satang,55000);
  }finally{h.close();}
});
test('V2 opt-out snapshot stays disabled after current employee is enabled',async()=>{
  const h=fixture({lateDeductionSatang:0});try{
    h.activate();await h.punch('05:30','optout_in');
    h.sqlite.prepare('UPDATE employees SET late_deduction_satang=5000 WHERE employee_id=?').run(staffId);
    await h.punch('16:00','optout_out');assert.equal(h.daily().late_deduction_satang,0);assert.equal(h.daily().confirmed_wage_satang,60000);
  }finally{h.close();}
});
test('inactive activation captures a normal V1 day and existing V1 cannot be relabelled by backdated activation',async()=>{
  const h=fixture();try{
    await h.punch('04:30','v1_in');h.activate(addDays(h.today,-5));await h.punch('16:00','v1_out');
    assert.equal(h.daily().payroll_policy_code,PAYROLL_POLICY_CODE);assert.equal(h.daily().late_deduction_applied_satang,10000);assert.equal(h.daily().confirmed_wage_satang,50000);
  }finally{h.close();}
});
test('self-consistent historical shift/wage survives changed employee defaults and preview equals apply',async()=>{
  const h=fixture();try{
    const date=addDays(h.today,-7);
    h.seedDaily(date,{employee:{scheduledIn:'03:30',graceMin:5,dailyWageSatang:50000},timeIn:'03:36'});
    h.sqlite.prepare('UPDATE employees SET scheduled_in=?,daily_wage_satang=70000,grace_min=10,late_deduction_satang=0 WHERE employee_id=?').run('04:00',staffId);
    const before=await previewPayrollRange(h.env,h.period(date));assert.equal(before.totalNetPayBaht,450);
    const applied=await applyPayrollRange(h.env,{...h.period(date),runId:'synthetic_run_1'});
    assert.equal(applied.preview.totalNetPayBaht,before.totalNetPayBaht);assert.equal(h.daily(date).net_pay_satang,45000);
    assert.equal(h.daily(date).daily_wage_snapshot_satang,50000);assert.equal(h.daily(date).scheduled_in,'03:30');
    const version=h.daily(date).version;
    assert.equal((await applyPayrollRange(h.env,{...h.period(date),runId:'synthetic_run_1'})).alreadyApplied,true);
    assert.equal(h.daily(date).version,version);assert.equal(h.count('payroll_runs'),1);
  }finally{h.close();}
});
test('V1 stored-result drift blocks preview, apply and correction before any mutation',async()=>{
  const h=fixture();try{
    const date=addDays(h.today,-7);h.seedDaily(date);
    // Reproduce the old writer inconsistency: result used 05:00, but stored schedule stayed 04:00.
    h.sqlite.prepare('UPDATE attendance_daily SET late_minutes=0,late_deduction_applied_satang=0,net_pay_satang=60000,confirmed_wage_satang=60000 WHERE employee_id=?').run(staffId);
    h.sqlite.prepare('UPDATE employees SET scheduled_in=? WHERE employee_id=?').run('05:00',staffId);
    const original=h.daily(date),writes=h.DB.runs.length,batches=h.DB.batches.length;
    await assert.rejects(previewPayrollRange(h.env,h.period(date)),/V1_STORED_RESULT_DRIFT/);
    await assert.rejects(applyPayrollRange(h.env,{...h.period(date),runId:'synthetic_blocked'}),/V1_STORED_RESULT_DRIFT/);
    await assert.rejects(correctAttendance(h.env,{employeeId:staffId,workDate:date,timeIn:'04:40',timeOut:'16:00',reason:'Synthetic correction'}),/V1_STORED_RESULT_DRIFT/);
    assert.deepEqual(h.daily(date),original);assert.equal(h.DB.runs.length,writes);assert.equal(h.DB.batches.length,batches);assert.equal(h.count('payroll_runs'),0);
  }finally{h.close();}
});
test('V2 correction and OT recompute use the retained daily policy and original evidence',async()=>{
  const h=fixture();try{
    h.activate();await h.punch('05:30','correction_in');await h.punch('16:00','correction_out');
    delete h.env.PAYROLL_LATE_V2_EFFECTIVE_FROM;delete h.env.PAYROLL_LATE_V2_EMPLOYEE_IDS;
    await correctAttendance(h.env,{employeeId:staffId,workDate:h.today,timeIn:'04:05',timeOut:'16:30',reason:'Synthetic corrected time'});
    assert.equal(h.daily().net_pay_satang,60000);assert.equal(h.daily().payroll_policy_code,FLAT_LATE_POLICY_CODE);
    h.sqlite.prepare(`INSERT INTO ot_requests(ot_id,employee_id,work_date,reason,fixed_amount_satang,requested_by,owner_preapproved_at,status,created_at,updated_at) VALUES('ot_synthetic',?,?,'Synthetic OT',10000,'TEST','now','PENDING_OWNER_FINAL','now','now')`).run(staffId,h.today);
    await finalizeFixedOt(h.env,{otId:'ot_synthetic',approved:true,finalAmountBaht:100,note:'Synthetic approval'});
    assert.equal(h.daily().net_pay_satang,70000);assert.equal(h.daily().payroll_policy_code,FLAT_LATE_POLICY_CODE);assert.equal(h.daily().ot_approved_satang,10000);
  }finally{h.close();}
});
for(const [code,expected] of [['UNKNOWN_POLICY',/PAYROLL_POLICY_UNKNOWN/],[LEGACY_LATE_POLICY_CODE,/LEGACY_CONTEXT_REVIEW_REQUIRED/]]){
  test(`stored ${code} is blocked before recalc and OT writes`,async()=>{
    const h=fixture();try{
      const date=addDays(h.today,-7);h.seedDaily(date,{policyCode:code});
      h.sqlite.prepare(`INSERT INTO ot_requests(ot_id,employee_id,work_date,reason,fixed_amount_satang,requested_by,owner_preapproved_at,status,created_at,updated_at) VALUES('ot_blocked',?,?,'Synthetic OT',10000,'TEST','now','PENDING_OWNER_FINAL','now','now')`).run(staffId,date);
      const writes=h.DB.runs.length,batches=h.DB.batches.length,queue=h.queue.length;
      await assert.rejects(recalculateDailyPayroll(h.env,staffId,date),expected);
      await assert.rejects(finalizeFixedOt(h.env,{otId:'ot_blocked',approved:true,finalAmountBaht:100}),expected);
      assert.equal(h.DB.runs.length,writes);assert.equal(h.DB.batches.length,batches);assert.equal(h.queue.length,queue);
      assert.equal(h.sqlite.prepare('SELECT status FROM ot_requests WHERE ot_id=?').get('ot_blocked').status,'PENDING_OWNER_FINAL');assert.equal(h.count('admin_audit'),0);
    }finally{h.close();}
  });
}
test('missing historical input is explicit; malformed snapshots are not coerced to zero',async()=>{
  const h=fixture();try{
    const date=addDays(h.today,-1);
    await assert.rejects(correctAttendance(h.env,{employeeId:staffId,workDate:date,timeIn:'04:06',timeOut:'16:00',reason:'Synthetic historical correction'}),/HISTORICAL_INPUTS_MISSING/);
    assert.equal(h.count('attendance_daily'),0);assert.equal(h.count('attendance_events'),0);
    const row=h.seedDaily(date,{employee:{dailyWageSatang:0},timeIn:'04:00'});
    assert.equal(resolvePayrollDayContext({}, {...newDay,workDate:date,daily:row,today:h.today}).employee.dailyWageSatang,0);
    for(const value of [null,'',NaN,-1])assert.throws(()=>resolvePayrollDayContext({}, {...newDay,workDate:date,daily:{...row,grace_min:value},today:h.today}),/INVALID_grace_min/);
    assert.throws(()=>resolvePayrollDayContext({}, {...newDay,workDate:date,daily:{...row,scheduled_in:'25:00'},today:h.today}),/INVALID_scheduled_in/);
  }finally{h.close();}
});
test('scheduled finalization excludes current day, handles V2 absence, and continues past blocked legacy row',async()=>{
  const h=fixture();try{
    const yesterday=addDays(h.today,-1),blockedDate=addDays(h.today,-3),validDate=addDays(h.today,-2);
    h.activate(blockedDate);h.seedDaily(blockedDate,{policyCode:LEGACY_LATE_POLICY_CODE,timeOut:null});
    h.seedDaily(validDate,{employee:{graceMin:5,lateDeductionSatang:5000},policyCode:FLAT_LATE_POLICY_CODE,timeOut:null});
    for(const date of [yesterday,h.today])h.sqlite.prepare(`INSERT INTO employee_shift_days(employee_id,work_date,scheduled_in,scheduled_out,daily_wage_snapshot_satang,wage_source_id,status,note,version,created_at,updated_at) VALUES(?,?,'04:00','16:00',60000,'wage_synthetic','EXPECTED','Synthetic',1,'now','now')`).run(staffId,date);
    const result=await finalizeMissingPunchPayrolls(h.env,{employeeIds:[staffId],fromDate:blockedDate,toDate:h.today});
    assert.equal(result.reviewRequired,1);assert.equal(result.onePunch,1);assert.equal(result.noPunch,1);
    assert.equal(h.daily(blockedDate).finalized_at,null);assert.equal(h.daily(validDate).confirmed_wage_satang,30000);
    assert.equal(h.daily(yesterday).payroll_policy_code,FLAT_LATE_POLICY_CODE);assert.equal(h.daily(yesterday).grace_min,5);assert.equal(h.daily(yesterday).confirmed_wage_satang,0);assert.equal(h.daily(yesterday).pay_status,'REVIEW');
    assert.equal(h.daily(h.today),undefined);
    await assert.rejects(correctAttendance(h.env,{employeeId:staffId,workDate:yesterday,timeIn:'04:06',timeOut:'16:00',reason:'Synthetic absence correction'}),/HISTORICAL_ABSENCE_INPUTS_UNPROVEN/);
  }finally{h.close();}
});
test('masked V1 setting drift rejects a new OUT without raw writes or durable-state poisoning',async()=>{
  const h=fixture();try{
    await h.punch('04:40','masked_in');
    assert.equal(h.daily().pending_wage_satang,30000);assert.equal(h.daily().late_deduction_applied_satang,0);
    h.sqlite.prepare('UPDATE employees SET late_deduction_satang=0 WHERE employee_id=?').run(staffId);
    const before=h.daily(),batches=h.DB.batches.length,writes=h.DB.runs.length;
    await assert.rejects(h.punch('16:00','masked_out'),/V1_CHANGED_PUNCH_CONFIG_AMBIGUOUS/);
    await assert.rejects(correctAttendance(h.env,{employeeId:staffId,workDate:h.today,timeIn:'04:40',timeOut:'16:00',reason:'Synthetic correction'}),/V1_CHANGED_PUNCH_CONFIG_AMBIGUOUS/);
    assert.deepEqual(h.daily(),before);assert.equal(h.count('attendance_events'),1);assert.equal(h.count('admin_audit'),0);
    assert.equal(h.DB.batches.length,batches);assert.equal(h.DB.runs.length,writes);
    // Restoring the known context allows exactly this OUT; the failed attempt did not retain an OUT state.
    h.sqlite.prepare('UPDATE employees SET late_deduction_satang=2500 WHERE employee_id=?').run(staffId);
    const accepted=await h.punch('16:00','masked_out');assert.equal(accepted.punchType,'OUT');
    assert.equal(h.count('attendance_events'),2);assert.equal(h.daily().confirmed_wage_satang,50000);
  }finally{h.close();}
});
test('finalizer scans beyond 100 blocked rows while leaving their historical records untouched',async()=>{
  const h=fixture();try{
    for(let days=2;days<=102;days++)h.seedDaily(addDays(h.today,-days),{policyCode:LEGACY_LATE_POLICY_CODE,timeOut:null});
    const valid=addDays(h.today,-1);h.seedDaily(valid,{timeOut:null});
    const result=await finalizeMissingPunchPayrolls(h.env,{employeeIds:[staffId]});
    assert.equal(result.onePunch,1);assert.equal(result.reviewRequired,101);assert.equal(result.scanLimitReached,false);
    assert.equal(h.daily(valid).confirmed_wage_satang,30000);
    assert.equal(h.sqlite.prepare('SELECT count(*) n FROM attendance_daily WHERE payroll_policy_code=? AND finalized_at IS NULL').get(LEGACY_LATE_POLICY_CODE).n,101);
  }finally{h.close();}
});
test('finalizer explicitly reports its scan cap and supports scoped progress beyond the blocked prefix',async()=>{
  const h=fixture();try{
    for(let days=2;days<=302;days++)h.seedDaily(addDays(h.today,-days),{policyCode:LEGACY_LATE_POLICY_CODE,timeOut:null});
    const valid=addDays(h.today,-1);h.seedDaily(valid,{timeOut:null});
    const result=await finalizeMissingPunchPayrolls(h.env,{employeeIds:[staffId]});
    assert.equal(result.onePunch,0);assert.equal(result.reviewRequired,300);assert.equal(result.scanLimitReached,true);
    assert.equal(h.daily(valid).finalized_at,null);
    const scoped=await finalizeMissingPunchPayrolls(h.env,{employeeIds:[staffId],fromDate:valid,toDate:valid});
    assert.equal(scoped.onePunch,1);assert.equal(scoped.reviewRequired,0);assert.equal(scoped.scanLimitReached,false);
  }finally{h.close();}
});
test('finalizer propagates unexpected database errors rather than classifying them as review',async()=>{
  const h=fixture();try{
    h.seedDaily(addDays(h.today,-1),{timeOut:null});
    const prepare=h.DB.prepare.bind(h.DB);
    h.DB.prepare=sql=>{if(sql.includes('FROM employees WHERE'))throw new Error('synthetic database unavailable');return prepare(sql);};
    await assert.rejects(finalizeMissingPunchPayrolls(h.env),/synthetic database unavailable/);
    assert.equal(h.daily(addDays(h.today,-1)).finalized_at,null);
  }finally{h.close();}
});
test('V1 OUT-only cannot prove scheduled IN: rejected fill has no writes or durable-state poisoning',async()=>{
  const h=fixture();try{
    h.seedDaily(h.today,{timeIn:null,timeOut:'16:00'});
    h.sqlite.prepare('UPDATE employees SET scheduled_in=? WHERE employee_id=?').run('05:00',staffId);
    const before=h.daily(),writes=h.DB.runs.length,batches=h.DB.batches.length;
    await assert.rejects(h.punch('04:40','unproven_in'),/V1_CHANGED_PUNCH_SCHEDULE_AMBIGUOUS/);
    await assert.rejects(correctAttendance(h.env,{employeeId:staffId,workDate:h.today,timeIn:'04:40',timeOut:'16:00',reason:'Synthetic missing IN'}),/V1_CHANGED_PUNCH_SCHEDULE_AMBIGUOUS/);
    assert.deepEqual(h.daily(),before);assert.equal(h.count('attendance_events'),0);assert.equal(h.count('admin_audit'),0);
    assert.equal(h.DB.runs.length,writes);assert.equal(h.DB.batches.length,batches);
    h.sqlite.prepare('UPDATE employees SET scheduled_in=? WHERE employee_id=?').run('04:00',staffId);
    assert.equal((await h.punch('04:40','unproven_in')).punchType,'IN');
    assert.equal(h.count('attendance_events'),1);assert.equal(h.daily().net_pay_satang,50000);
  }finally{h.close();}
});
test('zero-clamped V1 original IN cannot prove a schedule for a later correction',async()=>{
  const h=fixture();try{
    h.seedDaily(h.today,{timeIn:'03:50',timeOut:'16:00'});
    h.sqlite.prepare('UPDATE employees SET scheduled_in=? WHERE employee_id=?').run('05:00',staffId);
    const before=h.daily(),writes=h.DB.runs.length,batches=h.DB.batches.length;
    await assert.rejects(correctAttendance(h.env,{employeeId:staffId,workDate:h.today,timeIn:'04:40',timeOut:'16:00',reason:'Synthetic zero-clamp correction'}),/V1_CHANGED_PUNCH_SCHEDULE_AMBIGUOUS/);
    assert.deepEqual(h.daily(),before);assert.equal(h.DB.runs.length,writes);assert.equal(h.DB.batches.length,batches);assert.equal(h.count('attendance_events'),0);
    // The same ambiguity must not be converted into new evidence while a missing OUT masks net pay.
    assert.throws(()=>resolvePayrollDayContext(h.env,{employee:h.employee(),workDate:h.today,daily:before,timeIn:'04:40',timeOut:null}),/V1_CHANGED_PUNCH_SCHEDULE_AMBIGUOUS/);
  }finally{h.close();}
});
for(const originalOut of [null,'17:00']){
  test(`unproven V1 scheduled OUT (${originalOut??'missing'}) cannot introduce an early deduction`,async()=>{
    const h=fixture({earlyDeductionSatang:2500});try{
      h.seedDaily(h.today,{timeIn:'04:00',timeOut:originalOut});
      h.sqlite.prepare('UPDATE employees SET scheduled_out=? WHERE employee_id=?').run('15:00',staffId);
      const before=h.daily(),writes=h.DB.runs.length,batches=h.DB.batches.length;
      await assert.rejects(correctAttendance(h.env,{employeeId:staffId,workDate:h.today,timeIn:'04:00',timeOut:'15:30',reason:'Synthetic early correction'}),/V1_CHANGED_PUNCH_SCHEDULE_AMBIGUOUS/);
      if(originalOut===null)await assert.rejects(h.punch('15:30','unproven_out'),/V1_CHANGED_PUNCH_SCHEDULE_AMBIGUOUS/);
      assert.deepEqual(h.daily(),before);assert.equal(h.DB.runs.length,writes);assert.equal(h.DB.batches.length,batches);assert.equal(h.count('attendance_events'),0);
    }finally{h.close();}
  });
}
test('original measured lateness proves a day-specific shift for a changed-punch correction',async()=>{
  const h=fixture({graceMin:5,lateDeductionSatang:5000});try{
    const date=addDays(h.today,-7);
    h.seedDaily(date,{employee:{scheduledIn:'03:30',dailyWageSatang:50000},timeIn:'03:36',timeOut:'16:00'});
    h.sqlite.prepare('UPDATE employees SET daily_wage_satang=70000 WHERE employee_id=?').run(staffId);
    await correctAttendance(h.env,{employeeId:staffId,workDate:date,timeIn:'03:40',timeOut:'16:00',reason:'Synthetic evidenced shift'});
    assert.equal(h.daily(date).scheduled_in,'03:30');assert.equal(h.daily(date).late_minutes,10);assert.equal(h.daily(date).daily_wage_snapshot_satang,50000);assert.equal(h.daily(date).net_pay_satang,45000);
  }finally{h.close();}
});
