import { calculatePayroll,LATE_GRACE_MIN } from "../domain/payroll";
import { approvedOtSatangForDay,resolveWageSnapshot,weeklyPayrollStatement } from "../payroll/repository";
import { randomId } from "../shared/ids";
import { minutesOf } from "../shared/time";
import type { AttendanceCommitRequest,AttendanceCommitResult,Env } from "../types";
interface State{timeIn:string|null;timeOut:string|null;review:boolean;version:number}
export class AttendanceCoordinator{
  constructor(private readonly state:DurableObjectState,private readonly env:Env){}
  async fetch(request:Request):Promise<Response>{
    if(request.method!=="POST")return new Response("Method not allowed",{status:405});
    if(new URL(request.url).pathname==="/sync"){const next=await request.json() as State;await this.state.storage.transaction(async tx=>{await tx.put("state",next);});return Response.json({ok:true});}
    const input=await request.json() as AttendanceCommitRequest;return Response.json(await this.state.blockConcurrencyWhile(async()=>this.commit(input)));
  }
  private async commit(input:AttendanceCommitRequest):Promise<AttendanceCommitResult>{
    const existing=await this.env.DB.prepare(`SELECT a.event_id,a.work_date,a.official_time,a.version,d.late_minutes,d.confirmed_wage_satang,d.pending_wage_satang FROM attendance_events a LEFT JOIN attendance_daily d ON d.employee_id=a.employee_id AND d.work_date=a.work_date WHERE a.message_id=? LIMIT 1`).bind(input.messageId).first<Record<string,unknown>>();
    if(existing)return{eventId:String(existing.event_id),punchType:"DUPLICATE",workDate:String(existing.work_date),officialTime:String(existing.official_time||""),status:"DUPLICATE",lateMinutes:Number(existing.late_minutes||0),confirmedWageSatang:Number(existing.confirmed_wage_satang||0),pendingWageSatang:Number(existing.pending_wage_satang||0),validationCode:"DUPLICATE_MESSAGE",version:Number(existing.version||0)};
    const sameImage=await this.env.DB.prepare(`SELECT a.event_id,a.work_date,a.official_time,a.version,d.late_minutes,d.confirmed_wage_satang,d.pending_wage_satang FROM attendance_events a LEFT JOIN attendance_daily d ON d.employee_id=a.employee_id AND d.work_date=a.work_date WHERE a.image_sha256=? LIMIT 1`).bind(input.imageSha256).first<Record<string,unknown>>();
    if(sameImage)return{eventId:String(sameImage.event_id),punchType:"DUPLICATE",workDate:String(sameImage.work_date),officialTime:String(sameImage.official_time||""),status:"DUPLICATE",lateMinutes:Number(sameImage.late_minutes||0),confirmedWageSatang:Number(sameImage.confirmed_wage_satang||0),pendingWageSatang:Number(sameImage.pending_wage_satang||0),validationCode:"DUPLICATE_IMAGE",version:Number(sameImage.version||0)};
    const daily=await this.env.DB.prepare(`SELECT time_in,time_out,review_flag,version,daily_wage_snapshot_satang,daily_wage_satang,wage_source_id FROM attendance_daily WHERE employee_id=? AND work_date=?`).bind(input.employee.employeeId,input.workDate).first<Record<string,unknown>>();
    const key="state";let current=await this.state.storage.transaction(tx=>tx.get<State>(key));
    if(!current)current={timeIn:daily?.time_in?String(daily.time_in):null,timeOut:daily?.time_out?String(daily.time_out):null,review:Number(daily?.review_flag||0)===1,version:Number(daily?.version||0)};
    if(current.timeIn&&current.timeOut)return{eventId:"",punchType:"COMPLETE",workDate:input.workDate,officialTime:input.officialTime,status:"ALREADY_COMPLETE",lateMinutes:0,confirmedWageSatang:0,pendingWageSatang:0,validationCode:"DAY_ALREADY_COMPLETE",version:current.version};
    let punch:"IN"|"OUT";
    if(current.timeIn)punch="OUT";else if(current.timeOut)punch="IN";else punch=minutesOf(input.officialTime)>=minutesOf(input.employee.scheduledOut)?"OUT":"IN";
    if(punch==="IN")current.timeIn=input.officialTime;else current.timeOut=input.officialTime;
    current.review=current.review||input.validationReview||input.reading.needsNewPhoto;
    const previousWage=Number(daily?.daily_wage_snapshot_satang||daily?.daily_wage_satang||0),resolved=previousWage>0?{wageSourceId:String(daily?.wage_source_id||"LEGACY_SNAPSHOT"),dailyWageSatang:previousWage}:await resolveWageSnapshot(this.env,input.employee,input.workDate);
    const employee={...input.employee,dailyWageSatang:resolved.dailyWageSatang},otApprovedSatang=await approvedOtSatangForDay(this.env,input.employee.employeeId,input.workDate);
    const nextVersion=current.version+1,payroll=calculatePayroll({employee,timeIn:current.timeIn,timeOut:current.timeOut,review:current.review,otApprovedSatang});
    const eventId=randomId("att"),now=new Date().toISOString(),note=input.validationNote;
    await this.env.DB.batch([
      this.env.DB.prepare(`INSERT INTO attendance_events(event_id,webhook_event_id,message_id,employee_id,work_date,punch_type,official_time,status,confidence,line_time,line_diff_minutes,image_key,note,validation_code,trace_id,created_at,version,photo_datetime,gps_lat,gps_lng,distance_m,attendance_source,clock_evidence,clock_confidence,overlay_raw_text,image_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(eventId,input.webhookEventId,input.messageId,input.employee.employeeId,input.workDate,punch,input.officialTime,current.review?"REVIEW":"NORMAL",input.reading.confidence,input.lineTime,input.lineDiffMinutes,input.imageKey,note,input.validationCode,input.traceId,now,nextVersion,input.photoDateTime,input.gpsLat,input.gpsLng,input.distanceM,input.attendanceSource,input.clockEvidence?1:0,input.clockConfidence,input.overlayRawText,input.imageSha256),
      this.env.DB.prepare(`INSERT INTO attendance_daily(
        employee_id,work_date,scheduled_in,scheduled_out,grace_min,late_deduction_satang,early_deduction_satang,time_in,time_out,work_minutes,late_minutes,early_out_minutes,daily_wage_satang,confirmed_wage_satang,pending_wage_satang,pay_status,review_flag,version,updated_at,
        wage_source_id,daily_wage_snapshot_satang,late_deduction_applied_satang,missing_punch_type,missing_punch_deduction_satang,ot_approved_satang,other_adjustment_satang,net_pay_satang,payroll_policy_code,finalized_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
      ON CONFLICT(employee_id,work_date) DO UPDATE SET time_in=excluded.time_in,time_out=excluded.time_out,work_minutes=excluded.work_minutes,late_minutes=excluded.late_minutes,early_out_minutes=excluded.early_out_minutes,daily_wage_satang=excluded.daily_wage_satang,confirmed_wage_satang=excluded.confirmed_wage_satang,pending_wage_satang=excluded.pending_wage_satang,pay_status=excluded.pay_status,review_flag=excluded.review_flag,version=excluded.version,updated_at=excluded.updated_at,wage_source_id=excluded.wage_source_id,daily_wage_snapshot_satang=excluded.daily_wage_snapshot_satang,late_deduction_applied_satang=excluded.late_deduction_applied_satang,missing_punch_type=excluded.missing_punch_type,missing_punch_deduction_satang=excluded.missing_punch_deduction_satang,ot_approved_satang=excluded.ot_approved_satang,other_adjustment_satang=excluded.other_adjustment_satang,net_pay_satang=excluded.net_pay_satang,payroll_policy_code=excluded.payroll_policy_code,finalized_at=NULL`).bind(input.employee.employeeId,input.workDate,input.employee.scheduledIn,input.employee.scheduledOut,LATE_GRACE_MIN,input.employee.lateDeductionSatang,input.employee.earlyDeductionSatang,current.timeIn,current.timeOut,payroll.workMinutes,payroll.lateMinutes,payroll.earlyOutMinutes,resolved.dailyWageSatang,payroll.confirmedWageSatang,payroll.pendingWageSatang,payroll.payStatus,current.review?1:0,nextVersion,now,resolved.wageSourceId,resolved.dailyWageSatang,payroll.appliedLateDeductionSatang,payroll.missingPunchType,payroll.appliedMissingPunchDeductionSatang,payroll.otApprovedSatang,payroll.otherAdjustmentSatang,payroll.netPaySatang,payroll.policyCode),
      weeklyPayrollStatement(this.env,input.employee.employeeId,input.workDate,nextVersion,now)
    ]);
    current.version=nextVersion;await this.state.storage.transaction(async tx=>{await tx.put(key,current!);});
    const status=current.review||payroll.payStatus==="REVIEW"?"REVIEW":"NORMAL";
    return{eventId,punchType:punch,workDate:input.workDate,officialTime:input.officialTime,status,lateMinutes:payroll.lateMinutes,confirmedWageSatang:payroll.confirmedWageSatang,pendingWageSatang:payroll.pendingWageSatang,validationCode:input.validationCode,version:nextVersion};
  }
}
