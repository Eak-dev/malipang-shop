import { enqueueSheetSyncBatch } from "../db/repositories";
import { addDays,isIsoDate,isoDateInBangkok,weekStartMonday } from "../shared/time";
import type { Env,SheetsSyncJob } from "../types";

interface ReconcileInput { fromDate?:string; toDate?:string; limitPerType?:number }
interface EntityRow { entity_key:unknown; version:unknown }
function jobs(rows:EntityRow[],entityType:SheetsSyncJob["entityType"],traceId:string):SheetsSyncJob[]{return rows.map(row=>({kind:"SHEETS_SYNC",entityType,entityKey:String(row.entity_key),entityVersion:Number(row.version),traceId}));}
export async function reconcileSheets(env:Env,input:ReconcileInput={}):Promise<{fromDate:string;toDate:string;enqueued:number;counts:Record<string,number>}>{
  const today=isoDateInBangkok(),fromDate=input.fromDate||addDays(today,-14),toDate=input.toDate||today,limit=Math.min(500,Math.max(1,Math.floor(Number(input.limitPerType||200))));
  if(!isIsoDate(fromDate)||!isIsoDate(toDate)||fromDate>toDate)throw new Error("fromDate/toDate must be valid YYYY-MM-DD and fromDate must not exceed toDate");
  if(addDays(fromDate,366)<toDate)throw new Error("Reconcile range must not exceed 366 days");
  const weekFrom=weekStartMonday(fromDate),weekTo=weekStartMonday(toDate),traceId=`reconcile_${crypto.randomUUID()}`;
  const [attendance,daily,weekly,wages,shifts,ot,expense]=await Promise.all([
    env.DB.prepare(`SELECT event_id entity_key,version FROM attendance_events WHERE work_date BETWEEN ? AND ? ORDER BY work_date,event_id LIMIT ?`).bind(fromDate,toDate,limit).all<EntityRow>(),
    env.DB.prepare(`SELECT employee_id||'|'||work_date entity_key,version FROM attendance_daily WHERE work_date BETWEEN ? AND ? ORDER BY work_date,employee_id LIMIT ?`).bind(fromDate,toDate,limit).all<EntityRow>(),
    env.DB.prepare(`SELECT employee_id||'|'||week_start entity_key,version FROM payroll_weekly WHERE week_start BETWEEN ? AND ? ORDER BY week_start,employee_id LIMIT ?`).bind(weekFrom,weekTo,limit).all<EntityRow>(),
    env.DB.prepare(`SELECT wage_id entity_key,version FROM employee_wage_history WHERE effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY employee_id,effective_from LIMIT ?`).bind(toDate,fromDate,limit).all<EntityRow>(),
    env.DB.prepare(`SELECT employee_id||'|'||work_date entity_key,version FROM employee_shift_days WHERE work_date BETWEEN ? AND ? ORDER BY work_date,employee_id LIMIT ?`).bind(fromDate,toDate,limit).all<EntityRow>(),
    env.DB.prepare(`SELECT ot_id entity_key,version FROM ot_requests WHERE work_date BETWEEN ? AND ? ORDER BY work_date,employee_id LIMIT ?`).bind(fromDate,toDate,limit).all<EntityRow>(),
    env.DB.prepare(`SELECT expense_id entity_key,1 version FROM expense_events WHERE status='CONFIRMED' AND transaction_date BETWEEN ? AND ? ORDER BY transaction_date,expense_id LIMIT ?`).bind(fromDate,toDate,limit).all<EntityRow>()
  ]);
  const grouped={ATTENDANCE_EVENT:jobs(attendance.results||[],"ATTENDANCE_EVENT",traceId),DAILY_PAYROLL:jobs(daily.results||[],"DAILY_PAYROLL",traceId),WEEKLY_PAYROLL:jobs(weekly.results||[],"WEEKLY_PAYROLL",traceId),WAGE_HISTORY:jobs(wages.results||[],"WAGE_HISTORY",traceId),SHIFT_SCHEDULE:jobs(shifts.results||[],"SHIFT_SCHEDULE",traceId),OT_REQUEST:jobs(ot.results||[],"OT_REQUEST",traceId),EXPENSE:jobs(expense.results||[],"EXPENSE",traceId)};
  const all=Object.values(grouped).flat(),enqueued=await enqueueSheetSyncBatch(env,all,true);return{fromDate,toDate,enqueued,counts:Object.fromEntries(Object.entries(grouped).map(([key,value])=>[key,value.length]))};
}
