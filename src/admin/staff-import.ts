import { getSheetValues } from "../sheets/client";
import type { EmployeeImportInput,Env } from "../types";

const required=["Employee_ID","Staff_Name","LINE_User_ID","Scheduled_In","Scheduled_Out","Status","Daily_Wage","Grace_Min"];
function asTime(value:unknown):string{
  if(typeof value==="number"&&value>=0&&value<1){const minutes=Math.round(value*1440)%1440;return`${String(Math.floor(minutes/60)).padStart(2,"0")}:${String(minutes%60).padStart(2,"0")}`;}
  const text=String(value??"").trim();if(/^\d{1,2}:\d{2}$/.test(text)){const[h,m]=text.split(":").map(Number);if(h!<24&&m!<60)return`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;}throw new Error(`Invalid time: ${text}`);
}
function finite(value:unknown,name:string):number{const n=Number(value);if(!Number.isFinite(n)||n<0)throw new Error(`Invalid ${name}`);return n;}
export async function importEmployeesFromConfiguredSheet(env:Env):Promise<{count:number;employees:Array<{employeeId:string;staffName:string;lineUserId:string}>}>{
  const values=await getSheetValues(env,`'${env.SHEET_STAFF_CONFIG}'!A1:Z500`);if(!values.length)throw new Error(`Sheet ${env.SHEET_STAFF_CONFIG} is empty`);
  const inputs=parseStaffRows(values);
  await importEmployees(env,inputs);return{count:inputs.length,employees:inputs.map(({employeeId,staffName,lineUserId})=>({employeeId,staffName,lineUserId}))};
}
export function parseStaffRows(values:unknown[][]):EmployeeImportInput[]{
  const headers=(values[0]||[]).map(v=>String(v??"").trim()),index=new Map(headers.map((h,i)=>[h,i]));for(const name of required)if(!index.has(name))throw new Error(`Missing staff column: ${name}`);
  const at=(row:unknown[],name:string)=>row[index.get(name)!];
  return values.slice(1).filter(row=>String(at(row,"Employee_ID")??"").trim()).map(row=>({
    employeeId:String(at(row,"Employee_ID")).trim(),staffName:String(at(row,"Staff_Name")).trim(),lineUserId:String(at(row,"LINE_User_ID")).trim(),scheduledIn:asTime(at(row,"Scheduled_In")),scheduledOut:asTime(at(row,"Scheduled_Out")),status:String(at(row,"Status")).toLowerCase()==="active"?"ACTIVE":"INACTIVE",dailyWageBaht:finite(at(row,"Daily_Wage"),"Daily_Wage"),graceMin:finite(at(row,"Grace_Min"),"Grace_Min"),lateDeductionBaht:index.has("Late_Deduction_Baht")?finite(at(row,"Late_Deduction_Baht")||0,"Late_Deduction_Baht"):0,earlyDeductionBaht:index.has("Early_Deduction_Baht")?finite(at(row,"Early_Deduction_Baht")||0,"Early_Deduction_Baht"):0,canSubmitExpense:index.has("Can_Submit_Expense")&&[true,"true","yes","1",1].includes(at(row,"Can_Submit_Expense") as never)
  }));
}
export async function importEmployees(env:Env,inputs:EmployeeImportInput[]):Promise<void>{
  if(!Array.isArray(inputs)||inputs.length<1||inputs.length>200)throw new Error("employees must contain 1-200 rows");const ids=new Set<string>(),lines=new Set<string>();
  for(const e of inputs){if(!/^[A-Za-z0-9_-]{1,40}$/.test(e.employeeId)||!e.staffName.trim()||!/^U[a-fA-F0-9]{20,64}$/.test(e.lineUserId)||!/^\d{2}:\d{2}$/.test(e.scheduledIn)||!/^\d{2}:\d{2}$/.test(e.scheduledOut)||!Number.isFinite(e.dailyWageBaht)||e.dailyWageBaht<0||!Number.isFinite(e.graceMin)||e.graceMin<0||!Number.isFinite(e.lateDeductionBaht)||e.lateDeductionBaht<0)throw new Error(`Invalid employee: ${e.employeeId||"unknown"}`);if(ids.has(e.employeeId)||lines.has(e.lineUserId))throw new Error(`Duplicate employee or LINE ID: ${e.employeeId}`);ids.add(e.employeeId);lines.add(e.lineUserId);}
  const now=new Date().toISOString(),release=inputs.map(e=>env.DB.prepare(`UPDATE employees SET line_user_id=? WHERE employee_id=?`).bind(`IMPORT_${e.employeeId}_${crypto.randomUUID()}`,e.employeeId)),upserts=inputs.map(e=>env.DB.prepare(`INSERT INTO employees(employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,daily_wage_satang,grace_min,late_deduction_satang,early_deduction_satang,can_submit_expense,status,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(employee_id) DO UPDATE SET staff_name=excluded.staff_name,line_user_id=excluded.line_user_id,scheduled_in=excluded.scheduled_in,scheduled_out=excluded.scheduled_out,daily_wage_satang=excluded.daily_wage_satang,grace_min=excluded.grace_min,late_deduction_satang=excluded.late_deduction_satang,early_deduction_satang=excluded.early_deduction_satang,status=excluded.status,updated_at=excluded.updated_at`).bind(e.employeeId,e.staffName.trim(),e.lineUserId,e.scheduledIn,e.scheduledOut,Math.round(e.dailyWageBaht*100),Math.round(e.graceMin),Math.round(e.lateDeductionBaht*100),Math.round((e.earlyDeductionBaht||0)*100),e.canSubmitExpense?1:0,e.status,now));
  await env.DB.batch([...release,...upserts]);
}
