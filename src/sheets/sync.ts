import type { Env,SheetsSyncJob } from "../types";
import { batchWriteValues } from "./client";
import { safeRecordMetric } from "../db/repositories";
import { clearCancelledExpenseFromDaily,writeConfirmedExpenseToDaily,type DailyExpenseRecord } from "./daily-expense";
import { queueRetryDelaySeconds } from "../shared/retry";
const baht=(value:unknown)=>Number(value||0)/100;
const SHEET_SYNC_LEASE_MS=15*60*1000;
async function allocateRow(env:Env,sheet:string,entityKey:string):Promise<number>{
  const existing=await env.DB.prepare(`SELECT row_number FROM sheet_row_index WHERE sheet_name=? AND entity_key=?`).bind(sheet,entityKey).first<{row_number:number}>();if(existing)return Number(existing.row_number);
  const allocated=await env.DB.prepare(`INSERT INTO sheet_cursors(sheet_name,next_row) VALUES(?,3) ON CONFLICT(sheet_name) DO UPDATE SET next_row=next_row+1 RETURNING next_row-1 AS row_number`).bind(sheet).first<{row_number:number}>(),candidate=Number(allocated?.row_number||2);
  await env.DB.prepare(`INSERT OR IGNORE INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES(?,?,?)`).bind(sheet,entityKey,candidate).run();const finalRow=await env.DB.prepare(`SELECT row_number FROM sheet_row_index WHERE sheet_name=? AND entity_key=?`).bind(sheet,entityKey).first<{row_number:number}>();if(!finalRow)throw new Error("Unable to allocate sheet row");return Number(finalRow.row_number);
}
export async function claimSheetSyncJob(env:Env,job:SheetsSyncJob,nowMs=Date.now()):Promise<string|null>{
  const now=new Date(nowMs).toISOString(),leaseUntil=new Date(nowMs+SHEET_SYNC_LEASE_MS).toISOString(),leaseToken=crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token) VALUES(?,?,?,?,?,'PENDING',0,?,?,NULL,NULL) ON CONFLICT(entity_type,entity_key,entity_version) DO NOTHING`).bind(crypto.randomUUID(),job.entityType,job.entityKey,job.entityVersion,job.traceId,now,now).run();
  const claim=await env.DB.prepare(`UPDATE sync_jobs SET status='PROCESSING',attempt_count=attempt_count+1,last_error=NULL,updated_at=?,next_attempt_at=NULL,lease_until=?,lease_token=? WHERE entity_type=? AND entity_key=? AND entity_version=? AND (((status='PENDING' OR status='FAILED') AND (next_attempt_at IS NULL OR next_attempt_at<=?)) OR (status='PROCESSING' AND lease_until IS NOT NULL AND lease_until<=?))`).bind(now,leaseUntil,leaseToken,job.entityType,job.entityKey,job.entityVersion,now,now).run();
  return Number(claim.meta.changes||0)===1?leaseToken:null;
}
export async function syncJob(env:Env,job:SheetsSyncJob):Promise<void>{
  if(env.SHEETS_SYNC_ENABLED!=="true")return;
  const leaseToken=await claimSheetSyncJob(env,job);if(!leaseToken)return;
  try{
    let sheet="",values:unknown[]=[],expense:Record<string,unknown>|null=null;
    if(job.entityType==="ATTENDANCE_EVENT"){
      const r=await env.DB.prepare(`SELECT a.*,e.staff_name FROM attendance_events a JOIN employees e ON e.employee_id=a.employee_id WHERE event_id=?`).bind(job.entityKey).first<Record<string,unknown>>();if(!r)throw new Error(`Attendance event not found: ${job.entityKey}`);sheet=env.SHEET_ATTENDANCE_RAW;values=[r.event_id,r.created_at,r.work_date,r.employee_id,r.staff_name,r.punch_type,r.official_time,r.line_time,r.line_diff_minutes,r.status,r.confidence,r.image_key,r.note,r.validation_code,r.message_id,r.trace_id,r.version,r.attendance_source,r.photo_datetime,r.gps_lat,r.gps_lng,r.distance_m,Number(r.clock_evidence)===1?"YES":"NO",r.clock_confidence,r.overlay_raw_text,r.image_sha256];
    }else if(job.entityType==="DAILY_PAYROLL"){
      const[employeeId,workDate]=job.entityKey.split("|"),r=await env.DB.prepare(`SELECT d.*,e.staff_name FROM attendance_daily d JOIN employees e ON e.employee_id=d.employee_id WHERE d.employee_id=? AND d.work_date=?`).bind(employeeId,workDate).first<Record<string,unknown>>();if(!r)throw new Error(`Daily payroll not found: ${job.entityKey}`);sheet=env.SHEET_DAILY_PAYROLL;values=[r.work_date,r.employee_id,r.staff_name,r.scheduled_in,r.scheduled_out,r.time_in,r.time_out,Number(r.work_minutes||0)/60,r.late_minutes,r.early_out_minutes,baht(r.daily_wage_satang),baht(r.confirmed_wage_satang),baht(r.pending_wage_satang),r.pay_status,Number(r.review_flag)===1?"YES":"NO",r.version];
    }else if(job.entityType==="WEEKLY_PAYROLL"){
      const[employeeId,weekStart]=job.entityKey.split("|"),r=await env.DB.prepare(`SELECT p.*,e.staff_name FROM payroll_weekly p JOIN employees e ON e.employee_id=p.employee_id WHERE p.employee_id=? AND p.week_start=?`).bind(employeeId,weekStart).first<Record<string,unknown>>();if(!r)throw new Error(`Weekly payroll not found: ${job.entityKey}`);sheet=env.SHEET_WEEKLY_PAYROLL;values=[r.pay_sunday,r.week_start,r.employee_id,r.staff_name,r.work_days,baht(r.confirmed_amount_satang),baht(r.pending_amount_satang),r.status,r.version];
    }else if(job.entityType==="EXPENSE"){
      const r=await env.DB.prepare(`SELECT * FROM expense_events WHERE expense_id=?`).bind(job.entityKey).first<Record<string,unknown>>();if(!r)throw new Error(`Expense not found: ${job.entityKey}`);expense=r;sheet=env.SHEET_EXPENSE_RAW;values=[r.expense_id,r.transaction_date,r.description,baht(r.amount_satang),r.payment_key,r.source_wallet,r.category,r.status,r.message_id,r.trace_id];
    }else throw new Error(`Unsupported sheet entity type: ${job.entityType}`);
    const row=await allocateRow(env,sheet,job.entityKey),end=columnName(values.length),started=Date.now();try{
      await batchWriteValues(env,[{range:`'${sheet}'!A${row}:${end}${row}`,values:[values]}]);
      if(expense){
        if(String(expense.status)==="CONFIRMED")await writeConfirmedExpenseToDaily(env,{expenseId:String(expense.expense_id),transactionDate:String(expense.transaction_date),description:String(expense.description),amountBaht:baht(expense.amount_satang),paymentKey:String(expense.payment_key),sourceWallet:String(expense.source_wallet),category:String(expense.category)} satisfies DailyExpenseRecord);
        else if(String(expense.status)==="CANCELLED")await clearCancelledExpenseFromDaily(env,String(expense.expense_id));
      }
    }finally{await safeRecordMetric(env,job.traceId,"sheets_sync_ms",Date.now()-started,{sheet,entityType:job.entityType,...(expense?{dailySheet:env.SHEET_EXPENSE_DAILY}:{})});}
    await env.DB.prepare(`UPDATE sync_jobs SET status='COMPLETED',updated_at=?,next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error=NULL WHERE entity_type=? AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=?`).bind(new Date().toISOString(),job.entityType,job.entityKey,job.entityVersion,leaseToken).run();
  }catch(error){const nowMs=Date.now(),delaySeconds=queueRetryDelaySeconds(error),nextAttemptAt=new Date(nowMs+(delaySeconds||0)*1000).toISOString();await env.DB.prepare(`UPDATE sync_jobs SET status='FAILED',updated_at=?,next_attempt_at=?,lease_until=NULL,lease_token=NULL,last_error=? WHERE entity_type=? AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=?`).bind(new Date(nowMs).toISOString(),nextAttemptAt,String(error),job.entityType,job.entityKey,job.entityVersion,leaseToken).run();throw error;}
}
function columnName(index:number):string{let n=index,result="";while(n>0){n--;result=String.fromCharCode(65+n%26)+result;n=Math.floor(n/26);}return result;}
