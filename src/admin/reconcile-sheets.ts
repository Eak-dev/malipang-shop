import { enqueueSheetSyncBatchDetailed } from "../db/repositories";
import { addDays,isIsoDate,isoDateInBangkok,payrollPeriodFor } from "../shared/time";
import type { Env,SheetsSyncJob } from "../types";

type ReconcileType=Exclude<SheetsSyncJob["entityType"],"SYSTEM_LOG">;
interface Cursor { date:string; key:string }
interface ReconcileInput { fromDate?:string; toDate?:string; limitPerType?:number; cursors?:Partial<Record<ReconcileType,Cursor|null>> }
interface EntityRow { entity_key:unknown; version:unknown; sort_date:unknown; needs_review:unknown }
const entityTypes:ReconcileType[]=["ATTENDANCE_EVENT","DAILY_PAYROLL","WEEKLY_PAYROLL","WAGE_HISTORY","SHIFT_SCHEDULE","OT_REQUEST","EXPENSE","PERSONAL_USE"];

/** Keyset cursors are local to a report type. A null cursor means that type is
 * finished; an omitted cursor starts it from the beginning. This is a bounded,
 * best-effort scan, not a database snapshot: repeat after concurrent changes. */
export async function reconcileSheets(env:Env,input:ReconcileInput={}){
  const today=isoDateInBangkok(),fromDate=input.fromDate||addDays(today,-14),toDate=input.toDate||today,requested=Number(input.limitPerType??200);
  if(!isIsoDate(fromDate)||!isIsoDate(toDate)||fromDate>toDate)throw new Error("fromDate/toDate must be valid YYYY-MM-DD and fromDate must not exceed toDate");
  if(addDays(fromDate,366)<toDate)throw new Error("Reconcile range must not exceed 366 days");
  if(!Number.isSafeInteger(requested)||requested<1||requested>500)throw new Error("limitPerType must be an integer between 1 and 500");
  if(input.cursors!==undefined&&(!input.cursors||typeof input.cursors!=="object"||Array.isArray(input.cursors)))throw new Error("Invalid reconcile cursors");
  for(const [name,cursor] of Object.entries(input.cursors||{})){
    if(!entityTypes.includes(name as ReconcileType)||cursor!==null&&(!cursor||typeof cursor!=="object"||!isIsoDate(cursor.date)||typeof cursor.key!=="string"||!cursor.key||cursor.key.length>500))throw new Error("Invalid reconcile cursor");
  }
  const weekFrom=payrollPeriodFor(fromDate).weekStart,weekTo=payrollPeriodFor(toDate).weekStart,traceId=`reconcile_${crypto.randomUUID()}`;
  // Job or cached-row evidence only identifies a possible earlier projection;
  // it does not prove row identity. Cancellations are always held for review.
  const specs:{type:ReconcileType;table:string;date:string;key:string;where:string;args:string[]}[]=[
    {type:"ATTENDANCE_EVENT",table:"attendance_events",date:"work_date",key:"event_id",where:"work_date BETWEEN ? AND ?",args:[fromDate,toDate]},
    {type:"DAILY_PAYROLL",table:"attendance_daily",date:"work_date",key:"employee_id||'|'||work_date",where:"work_date BETWEEN ? AND ?",args:[fromDate,toDate]},
    {type:"WEEKLY_PAYROLL",table:"payroll_weekly",date:"week_start",key:"employee_id||'|'||week_start",where:"week_start BETWEEN ? AND ?",args:[weekFrom,weekTo]},
    {type:"WAGE_HISTORY",table:"employee_wage_history",date:"effective_from",key:"wage_id",where:"effective_from<=? AND (effective_to IS NULL OR effective_to>=?)",args:[toDate,fromDate]},
    {type:"SHIFT_SCHEDULE",table:"employee_shift_days",date:"work_date",key:"employee_id||'|'||work_date",where:"work_date BETWEEN ? AND ?",args:[fromDate,toDate]},
    {type:"OT_REQUEST",table:"ot_requests",date:"work_date",key:"ot_id",where:"work_date BETWEEN ? AND ?",args:[fromDate,toDate]},
    {type:"EXPENSE",table:"expense_events",date:"transaction_date",key:"expense_id",where:"transaction_date BETWEEN ? AND ? AND (status='CONFIRMED' OR (status='CANCELLED' AND (EXISTS(SELECT 1 FROM sync_jobs s WHERE s.entity_type='EXPENSE' AND s.entity_key=expense_events.expense_id) OR EXISTS(SELECT 1 FROM sheet_row_index r WHERE r.entity_key=expense_events.expense_id))))",args:[fromDate,toDate]},
    {type:"PERSONAL_USE",table:"owner_personal_transactions",date:"transaction_date",key:"personal_use_id",where:"transaction_date BETWEEN ? AND ?",args:[fromDate,toDate]}
  ];
  const pages=await Promise.all(specs.map(async spec=>{
    const cursor=input.cursors?.[spec.type];if(cursor===null)return{spec,rows:[] as EntityRow[],skipped:true};
    const tail=cursor?` AND (${spec.date}>? OR (${spec.date}=? AND (${spec.key})>?))`:"";
    const args:unknown[]=[...spec.args,...(cursor?[cursor.date,cursor.date,cursor.key]:[]),requested+1];
    const needsReview=spec.type==="EXPENSE"?"CASE WHEN status='CANCELLED' THEN 1 ELSE 0 END":"0";
    const result=await env.DB.prepare(`SELECT ${spec.key} entity_key,version,${spec.date} sort_date,${needsReview} needs_review FROM ${spec.table} WHERE ${spec.where}${tail} ORDER BY ${spec.date},(${spec.key}) LIMIT ?`).bind(...args).all<EntityRow>();
    return{spec,rows:result.results||[],skipped:false};
  }));
  const cursors={} as Record<ReconcileType,Cursor|null>,counts={} as Record<ReconcileType,number>,all:SheetsSyncJob[]=[],cancellationReview:{entityKey:string;entityVersion:number;reason:string}[]=[];let hasMore=false;
  for(const {spec,rows} of pages){
    const page=rows.slice(0,requested);counts[spec.type]=page.length;
    for(const row of page){
      if(Number(row.needs_review||0)===1)cancellationReview.push({entityKey:String(row.entity_key),entityVersion:Number(row.version),reason:"CANCELLATION_ROW_IDENTITY_UNVERIFIED"});
      else all.push({kind:"SHEETS_SYNC",entityType:spec.type,entityKey:String(row.entity_key),entityVersion:Number(row.version),traceId});
    }
    if(rows.length>requested){const last=page[page.length-1]!;cursors[spec.type]={date:String(last.sort_date),key:String(last.entity_key)};hasMore=true;}else cursors[spec.type]=null;
  }
  const result=await enqueueSheetSyncBatchDetailed(env,all,true);return{fromDate,toDate,...result,held:result.held+cancellationReview.length,counts,cursors,hasMore,cancellationReview};
}
