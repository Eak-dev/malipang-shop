import type { Env } from "../types";
import { getGoogleAccessToken } from "./google-auth";
import { fetchWithTimeout } from "../shared/async";
import { numberEnv } from "../shared/env";
async function sheetsFetch(env:Env,path:string,init:RequestInit):Promise<Response>{const token=await getGoogleAccessToken(env),headers=new Headers(init.headers);headers.set("Authorization",`Bearer ${token}`);if(init.body)headers.set("content-type","application/json");const res=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SPREADSHEET_ID}${path}`,{...init,headers},numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),`Google Sheets ${init.method||"GET"}`);if(!res.ok)throw new Error(`Sheets HTTP ${res.status}: ${await res.text()}`);return res;}
export async function batchWriteValues(env:Env,data:Array<{range:string;values:unknown[][]}>):Promise<void>{if(!data.length)return;await sheetsFetch(env,"/values:batchUpdate",{method:"POST",body:JSON.stringify({valueInputOption:"RAW",data})});}
export async function batchClearValues(env:Env,ranges:string[]):Promise<void>{if(!ranges.length)return;await sheetsFetch(env,"/values:batchClear",{method:"POST",body:JSON.stringify({ranges})});}
export async function getSheetValues(env:Env,range:string):Promise<unknown[][]>{const encoded=encodeURIComponent(range),data=await sheetsFetch(env,`/values/${encoded}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,{method:"GET"}).then(r=>r.json()) as{values?:unknown[][]};return data.values||[];}
export async function batchGetSheetValues(env:Env,ranges:string[]):Promise<unknown[][][]>{
  if(!ranges.length)return[];const query=new URLSearchParams({valueRenderOption:"UNFORMATTED_VALUE",dateTimeRenderOption:"FORMATTED_STRING"});for(const range of ranges)query.append("ranges",range);
  const data=await sheetsFetch(env,`/values:batchGet?${query.toString()}`,{method:"GET"}).then(r=>r.json()) as{valueRanges?:Array<{values?:unknown[][]}>};return(data.valueRanges||[]).map(item=>item.values||[]);
}
export async function getSpreadsheetMetadata(env:Env):Promise<{spreadsheetId:string;title:string;timeZone:string}>{const data=await sheetsFetch(env,"?fields=spreadsheetId,properties(title,timeZone)",{method:"GET"}).then(r=>r.json()) as{spreadsheetId:string;properties?:{title?:string;timeZone?:string}};return{spreadsheetId:data.spreadsheetId,title:String(data.properties?.title||""),timeZone:String(data.properties?.timeZone||"")};}
export async function bootstrapSheets(env:Env):Promise<void>{
  const meta=await sheetsFetch(env,"?fields=sheets.properties",{method:"GET"}).then(r=>r.json()) as{sheets?:Array<{properties:{title:string}}>},existing=new Set((meta.sheets||[]).map(s=>s.properties.title));
  const definitions=[
    [env.SHEET_ATTENDANCE_RAW,["Event_ID","Received_At","Work_Date","Employee_ID","Staff_Name","Punch_Type","Official_Time","LINE_Time","Diff_Min","Status","Confidence","Image_Key","Note","Validation_Code","Message_ID","Trace_ID","Version","Attendance_Source","Photo_DateTime","GPS_Lat","GPS_Lng","Distance_M","Clock_Evidence","Clock_Confidence","Overlay_Raw_Text","Image_SHA256"]],
    [env.SHEET_DAILY_PAYROLL,["Work_Date","Employee_ID","Staff_Name","Scheduled_In","Scheduled_Out","Time_In","Time_Out","Work_Hours","Late_Min","Early_Out_Min","Daily_Wage_Baht","Confirmed_Wage_Baht","Pending_Review_Wage_Baht","Pay_Status","Review_Flag","Version","Wage_Source_ID","Daily_Wage_Snapshot_Baht","Late_Deduction_Baht","Missing_Punch_Type","Missing_Punch_Deduction_Baht","OT_Approved_Baht","Other_Adjustment_Baht","Net_Pay_Baht","Payroll_Policy_Code","Finalized_At"]],
    [env.SHEET_WEEKLY_PAYROLL,["Pay_Date","Week_Start","Employee_ID","Staff_Name","Work_Days","Amount_To_Pay_Baht","Pending_Review_Baht","Status","Version","Base_Wage_Total_Baht","Late_Deduction_Total_Baht","Missing_Punch_Deduction_Total_Baht","OT_Total_Baht","Other_Adjustment_Total_Baht","Net_Pay_Baht","Pending_Review_Count","Week_End"]],
    [env.SHEET_WAGE_HISTORY,["Wage_ID","Employee_ID","Staff_Name","Daily_Wage_Baht","Effective_From","Effective_To","Source","Note","Version","Created_At","Updated_At"]],
    [env.SHEET_SHIFT_SCHEDULE,["Work_Date","Employee_ID","Staff_Name","Scheduled_In","Scheduled_Out","Daily_Wage_Snapshot_Baht","Wage_Source_ID","Status","Note","Version","Updated_At"]],
    [env.SHEET_OT_REQUESTS,["OT_ID","Work_Date","Employee_ID","Staff_Name","Reason","Planned_Start","Planned_End","Fixed_Amount_Baht","Requested_By","Owner_Preapproved_At","Employee_Confirm_Status","Employee_Confirmed_At","Owner_Final_Status","Owner_Final_Amount_Baht","Owner_Final_At","Actual_OT_Min","Status","Note","Version","Updated_At"]],
    [env.SHEET_EXPENSE_RAW,["Expense_ID","Transaction_Date","Description","Amount_Baht","Payment_Key","Source_Wallet","Category","Status","Message_ID","Trace_ID"]],
    [env.SHEET_SYSTEM_LOG,["Created_At","Trace_ID","Level","Event","Detail"]]
  ] as const;
  const requests=definitions.filter(([name])=>!existing.has(name)).map(([title])=>({addSheet:{properties:{title,gridProperties:{frozenRowCount:1}}}}));if(requests.length)await sheetsFetch(env,":batchUpdate",{method:"POST",body:JSON.stringify({requests})});
  await batchWriteValues(env,definitions.map(([name,headers])=>({range:`'${name}'!A1:${columnName(headers.length)}1`,values:[Array.from(headers)]})));
}
function columnName(index:number):string{let n=index,result="";while(n>0){n--;result=String.fromCharCode(65+n%26)+result;n=Math.floor(n/26);}return result;}
