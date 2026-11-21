import type { Env } from "../types";
import type {ReviewRequestBudget} from "./review-request-budget";
import { getGoogleAccessToken,type GoogleOAuthLease } from "./google-auth";
import { fetchWithTimeout } from "../shared/async";
import { numberEnv } from "../shared/env";
import { legacyOwnerMonthClosePersonalUseCells,ownerMonthClosePersonalUseCells,planOwnerMonthClosePersonalUseWrites } from "./owner-month-close";
import {readSheetsBody} from './bounded-response';
import {parseMonthlyReportGrid} from './monthly-report-grid';
import {reportBaselineDigest,type ReportGrid} from './monthly-report-baseline';
export class SheetsReadNetworkError extends Error{constructor(){super('SHEETS_READ_NETWORK');this.name='SheetsReadNetworkError';}}
export class SheetsHttpError extends Error{
  constructor(public readonly status:number,message:string,public readonly retryAfterSeconds?:number){super(message);this.name="SheetsHttpError";}
}
export class SheetsMutationOutcomeUnknownError extends Error{
  readonly retryAfterSeconds?:number;
  constructor(cause:unknown){
    const detail=cause instanceof Error?cause.message:String(cause);
    super(`Google Sheets mutation outcome unknown: ${detail}`,{cause});this.name="SheetsMutationOutcomeUnknownError";
    if(typeof cause==="object"&&cause!==null&&"retryAfterSeconds" in cause){const value=Number((cause as{retryAfterSeconds?:unknown}).retryAfterSeconds);if(Number.isFinite(value)&&value>=0)this.retryAfterSeconds=Math.ceil(value);}
  }
}
export function isAmbiguousSheetsMutationStatus(status:number):boolean{return status===408||(status>=500&&status<=599);}
export function parseRetryAfterSeconds(value:string|null,nowMs=Date.now()):number|undefined{
  if(!value)return undefined;
  const seconds=Number(value);if(Number.isFinite(seconds)&&seconds>=0)return Math.ceil(seconds);
  const dateMs=Date.parse(value);return Number.isFinite(dateMs)?Math.max(0,Math.ceil((dateMs-nowMs)/1000)):undefined;
}
export const sheetsReadRetryTiming={wait:(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))};
/** A read is idempotent, so one paced retry of a rate-limited or transient
 * response is safe. Mutations never pass through here. Google refills the
 * per-minute read quota continuously; without Retry-After wait 20 seconds. */
export async function retryIdempotentRead(read:()=>Promise<Response>,allowInClaimWait=true,boundCancellation=false):Promise<Response>{
  const first=await read();if(!allowInClaimWait||first.status!==429&&(first.status<500||first.status>599))return first;
  const retryAfter=parseRetryAfterSeconds(first.headers.get("Retry-After"));try{if(boundCancellation)await Promise.race([first.body?.cancel().catch(()=>{}),new Promise<void>(resolve=>setTimeout(resolve,0))]);else await first.body?.cancel();}catch{}
  await sheetsReadRetryTiming.wait(first.status===429?Math.min(30,Math.max(1,retryAfter??20))*1000:2000);
  return read();
}
type BeforeSheetsMutationDispatch=()=>void|Promise<void>;
/** Explicit opt-in for continuous expense operations. Other callers retain the
 * pre-existing read behavior, including their own retry and body handling. */
export type ContinuousSheetsReadPolicy={readonly kind:'continuous-expense';readonly budget?:ReviewRequestBudget;readonly oauthLease?:GoogleOAuthLease;readonly postWriteRead?:true};
export const continuousSheetsReadPolicy:ContinuousSheetsReadPolicy=Object.freeze({kind:'continuous-expense'});
async function readContinuousSheetsBody(response:Response,remainingMs:number,label:string):Promise<Uint8Array>{
  try{return await readSheetsBody(response,remainingMs,label);}catch(error){if(error instanceof TypeError)throw new SheetsReadNetworkError();throw error;}
}
async function sheetsFetch(env:Env,path:string,init:RequestInit,mutation=false,beforeMutationDispatch?:BeforeSheetsMutationDispatch,readMutationReply=false,readPolicy?:ContinuousSheetsReadPolicy,boundedMutationError=false,mutationBudget?:ReviewRequestBudget,mutationLease?:GoogleOAuthLease):Promise<Response>{
  const budget=readPolicy?.budget??mutationBudget;
  const token=await getGoogleAccessToken(env,budget,readPolicy?.oauthLease??mutationLease),headers=new Headers(init.headers);headers.set("Authorization",`Bearer ${token}`);if(init.body)headers.set("content-type","application/json");
  const ticket=mutation?budget?.claimMutation():undefined;
  try{
  // Authentication can consume the full external timeout on a cold token cache.
  // Run the caller's final CAS only after auth, immediately before the Sheet
  // request can be dispatched, so that wait is outside the mutation fence.
  if(mutation&&beforeMutationDispatch)await beforeMutationDispatch();
  const baseTimeout=numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),timeout=!mutation&&readPolicy?.postWriteRead===true?Math.max(baseTimeout,45000):baseTimeout,label=`Google Sheets ${init.method||"GET"}`;let deadline=0;
  // Manual prevents redirect forwarding and is supported by Workers; every
  // 3xx is non-OK and follows the ordinary fail-closed error path below.
  const send=()=>{(readPolicy?.oauthLease??mutationLease)?.tokenFor(env);if(ticket)ticket.consume();else budget?.consumeRead();deadline=Date.now()+timeout;return fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SPREADSHEET_ID}${path}`,{...init,headers,...(budget?{redirect:"manual" as RequestRedirect}:{})},timeout,label);};
  const idempotentRead=!mutation&&(init.method||"GET")==="GET";
  let res:Response;try{res=idempotentRead?await retryIdempotentRead(send,env.STABLE_SHEETS_PACING_ENABLED!=='true',!!readPolicy):await send();}catch(error){if(mutation)throw new SheetsMutationOutcomeUnknownError(error);if(readPolicy&&error instanceof TypeError)throw new SheetsReadNetworkError();throw error;}
  if(!res.ok){let body="";try{body=readPolicy?new TextDecoder().decode(await readContinuousSheetsBody(res,deadline-Date.now(),label)):readMutationReply||boundedMutationError?new TextDecoder().decode(await readSheetsBody(res,deadline-Date.now(),label)):await res.text();}catch(error){if(readMutationReply||boundedMutationError)throw new SheetsMutationOutcomeUnknownError(error);if(readPolicy)throw error;}const httpError=new SheetsHttpError(res.status,`Sheets HTTP ${res.status}${body?`: ${body}`:""}`,parseRetryAfterSeconds(res.headers.get("Retry-After")));if(mutation&&isAmbiguousSheetsMutationStatus(res.status))throw new SheetsMutationOutcomeUnknownError(httpError);throw httpError;}
  if(readMutationReply){try{const body=await readSheetsBody(res,deadline-Date.now(),label);return new Response(body,{status:res.status,statusText:res.statusText,headers:res.headers});}catch(error){throw new SheetsMutationOutcomeUnknownError(error);}}
  if(readPolicy){const body=await readContinuousSheetsBody(res,deadline-Date.now(),label);return new Response(body,{status:res.status,statusText:res.statusText,headers:res.headers});}return res;
  }finally{ticket?.release();}
}
export async function batchWriteValues(env:Env,data:Array<{range:string;values:unknown[][]}>,beforeMutationDispatch?:BeforeSheetsMutationDispatch):Promise<void>{if(!data.length)return;await sheetsFetch(env,"/values:batchUpdate",{method:"POST",body:JSON.stringify({valueInputOption:"RAW",data})},true,beforeMutationDispatch);}
/** Used only by continuous-expense/cutover notice writes. */
export async function batchWriteContinuousNoticeValues(env:Env,data:Array<{range:string;values:unknown[][]}>,beforeMutationDispatch?:BeforeSheetsMutationDispatch,budget?:ReviewRequestBudget):Promise<void>{if(!data.length)return;await sheetsFetch(env,"/values:batchUpdate",{method:"POST",body:JSON.stringify({valueInputOption:"RAW",data})},true,beforeMutationDispatch,false,undefined,true,budget);}
export async function batchWriteUserEnteredValues(env:Env,data:Array<{range:string;values:unknown[][]}>):Promise<void>{if(!data.length)return;await sheetsFetch(env,"/values:batchUpdate",{method:"POST",body:JSON.stringify({valueInputOption:"USER_ENTERED",data})},true);}
export async function batchClearValues(env:Env,ranges:string[]):Promise<void>{if(!ranges.length)return;await sheetsFetch(env,"/values:batchClear",{method:"POST",body:JSON.stringify({ranges})},true);}
export async function batchUpdateSpreadsheet(env:Env,requests:unknown[],beforeMutationDispatch?:BeforeSheetsMutationDispatch):Promise<void>{if(!requests.length)return;await sheetsFetch(env,":batchUpdate",{method:"POST",body:JSON.stringify({requests})},true,beforeMutationDispatch);}
/** Only for operations whose provider reply is needed to distinguish a
 * conditional no-op from an applied mutation. A malformed/lost reply must be
 * treated by the caller as an uncertain mutation, never blindly retried. */
export async function batchUpdateSpreadsheetWithReply(env:Env,requests:unknown[],beforeMutationDispatch?:BeforeSheetsMutationDispatch,budget?:ReviewRequestBudget,oauthLease?:GoogleOAuthLease):Promise<unknown>{
  if(!requests.length)throw Error('SHEETS_EMPTY_CONDITIONAL_MUTATION');
  const response=await sheetsFetch(env,":batchUpdate",{method:"POST",body:JSON.stringify({requests})},true,beforeMutationDispatch,true,undefined,false,budget,oauthLease);
  try{return await response.json();}catch(error){throw new SheetsMutationOutcomeUnknownError(error);}
}
export async function getSheetValues(env:Env,range:string,readPolicy?:ContinuousSheetsReadPolicy):Promise<unknown[][]>{const encoded=encodeURIComponent(range),data=await sheetsFetch(env,`/values/${encoded}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,{method:"GET"},false,undefined,false,readPolicy).then(r=>r.json()) as{values?:unknown[][]};return data.values||[];}
export async function batchGetSheetValues(env:Env,ranges:string[],readPolicy?:ContinuousSheetsReadPolicy):Promise<unknown[][][]>{
  if(!ranges.length)return[];const query=new URLSearchParams({valueRenderOption:"UNFORMATTED_VALUE",dateTimeRenderOption:"FORMATTED_STRING"});for(const range of ranges)query.append("ranges",range);
  const data=await sheetsFetch(env,`/values:batchGet?${query.toString()}`,{method:"GET"},false,undefined,false,readPolicy).then(r=>r.json()) as{valueRanges?:Array<{values?:unknown[][]}>};return(data.valueRanges||[]).map(item=>item.values||[]);
}
export async function batchGetSheetEffectiveSerialValues(env:Env,ranges:string[],readPolicy?:ContinuousSheetsReadPolicy):Promise<unknown[][][]>{
  if(!ranges.length)return[];const query=new URLSearchParams({valueRenderOption:'UNFORMATTED_VALUE',dateTimeRenderOption:'SERIAL_NUMBER'});for(const range of ranges)query.append('ranges',range);
  const data=await sheetsFetch(env,`/values:batchGet?${query.toString()}`,{method:'GET'},false,undefined,false,readPolicy).then(r=>r.json()) as {valueRanges?:Array<{values?:unknown[][]}>};return(data.valueRanges||[]).map(item=>item.values||[]);
}
export async function batchGetSheetFormulaValues(env:Env,ranges:string[],readPolicy?:ContinuousSheetsReadPolicy):Promise<unknown[][][]>{
  if(!ranges.length)return[];const query=new URLSearchParams({valueRenderOption:"FORMULA",dateTimeRenderOption:"FORMATTED_STRING"});for(const range of ranges)query.append("ranges",range);
  const data=await sheetsFetch(env,`/values:batchGet?${query.toString()}`,{method:"GET"},false,undefined,false,readPolicy).then(r=>r.json()) as{valueRanges?:Array<{values?:unknown[][]}>};return(data.valueRanges||[]).map(item=>item.values||[]);
}
export async function getSpreadsheetMetadata(env:Env):Promise<{spreadsheetId:string;title:string;timeZone:string}>{const data=await sheetsFetch(env,"?fields=spreadsheetId,properties(title,timeZone)",{method:"GET"}).then(r=>r.json()) as{spreadsheetId:string;properties?:{title?:string;timeZone?:string}};return{spreadsheetId:data.spreadsheetId,title:String(data.properties?.title||""),timeZone:String(data.properties?.timeZone||"")};}
export async function getSheetId(env:Env,title:string):Promise<number>{
  const data=await sheetsFetch(env,"?fields=sheets.properties(sheetId,title)",{method:"GET"}).then(r=>r.json()) as{sheets?:Array<{properties?:{sheetId?:number;title?:string}}>};
  const found=(data.sheets||[]).find(sheet=>sheet.properties?.title===title)?.properties?.sheetId;
  if(!Number.isInteger(found))throw new Error(`Google Sheet tab not found: ${title}`);
  return Number(found);
}
/** Read sheet identities without disclosing cell data. Used to ensure a
 * bootstrap cannot collide with an existing sheet title or ID. */
export async function getSpreadsheetSheetProperties(env:Env,readPolicy?:ContinuousSheetsReadPolicy):Promise<Array<{sheetId:number;title:string;rowCount:number;columnCount:number}>>{
  const data=await sheetsFetch(env,'?fields=spreadsheetId,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))',{method:'GET'},false,undefined,false,readPolicy).then(r=>r.json()) as {spreadsheetId?:unknown;sheets?:Array<{properties?:{sheetId?:unknown;title?:unknown;gridProperties?:{rowCount?:unknown;columnCount?:unknown}}}>};
  if(data.spreadsheetId!==env.GOOGLE_SPREADSHEET_ID||!Array.isArray(data.sheets))throw Error('SHEET_PROPERTIES_UNVERIFIED');
  const result=data.sheets.map(sheet=>{const p=sheet.properties,g=p?.gridProperties;if(!p||!g||!Number.isSafeInteger(p.sheetId)||Number(p.sheetId)<0||typeof p.title!=='string'||!p.title||!Number.isSafeInteger(g.rowCount)||Number(g.rowCount)<1||!Number.isSafeInteger(g.columnCount)||Number(g.columnCount)<1)throw Error('SHEET_PROPERTIES_UNVERIFIED');return{sheetId:Number(p.sheetId),title:p.title,rowCount:Number(g.rowCount),columnCount:Number(g.columnCount)};});
  if(new Set(result.map(s=>s.sheetId)).size!==result.length||new Set(result.map(s=>s.title)).size!==result.length)throw Error('SHEET_PROPERTIES_UNVERIFIED');
  return result;
}
/** Grid bounds are used to read every possible identity before appending. */
export async function getSheetGridInfo(env:Env,title:string,readPolicy?:ContinuousSheetsReadPolicy):Promise<{sheetId:number;rowCount:number;columnCount:number}>{
  const data=await sheetsFetch(env,"?fields=sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))",{method:"GET"},false,undefined,false,readPolicy).then(r=>r.json()) as {sheets?:Array<{properties?:{sheetId?:number;title?:string;gridProperties?:{rowCount?:number;columnCount?:number}}}>};
  const found=(data.sheets||[]).filter(sheet=>sheet.properties?.title===title);
  const p=found[0]?.properties,g=p?.gridProperties;
  if(found.length!==1||!Number.isSafeInteger(p?.sheetId)||Number(p?.sheetId)<0||!Number.isSafeInteger(g?.rowCount)||!Number.isSafeInteger(g?.columnCount)||Number(g?.rowCount)<1||Number(g?.columnCount)<1)throw Error('SHEET_GRID_UNVERIFIED');
  return {sheetId:Number(p?.sheetId),rowCount:Number(g?.rowCount),columnCount:Number(g?.columnCount)};
}
/** Read-only incident snapshot. Full-grid structure and values are compared
 * with independent value-range reads; this does not fence another writer. */
export async function readMonthlyReportGrid(env:Env,sheetId:number,baseRows:number,policy:ContinuousSheetsReadPolicy):Promise<ReportGrid>{
 const title='รายวันต่อเนื่อง_แบบร่าง',db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,initial=await getSheetGridInfo(env,title,policy);
 if(!book||initial.sheetId!==sheetId||!Number.isSafeInteger(baseRows)||baseRows<4||baseRows>initial.rowCount||initial.rowCount>5000||initial.columnCount<29||initial.columnCount>100)throw Error('MONTHLY_GRID_DIMENSIONS');
 const range=`'${title}'!A1:${columnName(initial.columnCount)}${initial.rowCount}`,query=new URLSearchParams({includeGridData:'true',fields:'spreadsheetId,properties,namedRanges,developerMetadata,dataSources,dataSourceSchedules,sheets(properties,merges,protectedRanges,conditionalFormats,filterViews,basicFilter,bandedRanges,charts,slicers,developerMetadata,tables,rowGroups,columnGroups,commentAnchors,data(startRow,startColumn,rowMetadata,columnMetadata,rowData(values(userEnteredValue,effectiveValue,formattedValue,note,userEnteredFormat,effectiveFormat,hyperlink,textFormatRuns,dataValidation,pivotTable,dataSourceTable,dataSourceFormula,chipRuns))))'});query.append('ranges',range);
 const raw=await sheetsFetch(env,`?${query.toString()}`,{method:'GET'},false,undefined,false,policy).then(r=>r.json());
 const grid=parseMonthlyReportGrid(raw,book,sheetId,baseRows);if(grid.rows!==initial.rowCount||grid.columns!==initial.columnCount)throw Error('MONTHLY_GRID_DIMENSIONS');
 const [formula,effective]=await Promise.all([batchGetSheetFormulaValues(env,[range],policy),batchGetSheetEffectiveSerialValues(env,[range],policy)]);
 const same=(a:unknown,b:unknown)=>((a===undefined||a===null||a==='')&&(b===undefined||b===null||b===''))||a===b;
 if(formula.length!==1||effective.length!==1||!Array.isArray(formula[0])||!Array.isArray(effective[0])||formula[0]!.length>grid.rows||effective[0]!.length>grid.rows||![...formula[0]!,...effective[0]!].every(row=>Array.isArray(row)&&row.length<=grid.columns))throw Error('MONTHLY_GRID_VALUES_UNVERIFIED');
 for(let r=0;r<grid.rows;r++)for(let c=0;c<grid.columns;c++)if(!same(grid.formula[r]?.[c],formula[0]![r]?.[c])||!same(grid.effective[r]?.[c],effective[0]![r]?.[c]))throw Error('MONTHLY_GRID_VALUES_UNVERIFIED');
 const rawAgain=await sheetsFetch(env,`?${query.toString()}`,{method:'GET'},false,undefined,false,policy).then(r=>r.json()),again=parseMonthlyReportGrid(rawAgain,book,sheetId,baseRows);
 if(await reportBaselineDigest(grid)!==await reportBaselineDigest(again))throw Error('MONTHLY_GRID_CHANGED');
 const end=await getSheetGridInfo(env,title,policy);if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||JSON.stringify(end)!==JSON.stringify(initial))throw Error('MONTHLY_GRID_CHANGED');
 return grid;
}
/** Read only the explicitly written number formats on a single E:U row. */
export async function getSheetCellNumberFormats(env:Env,title:string,sheetId:number,row:number,readPolicy?:ContinuousSheetsReadPolicy):Promise<Array<{type?:string;pattern?:string}|null>>{
 if(!title||!Number.isSafeInteger(sheetId)||sheetId<0||!Number.isSafeInteger(row)||row<1)throw Error('SHEET_FORMAT_RANGE_INVALID');
 const query=new URLSearchParams({includeGridData:'true',fields:'sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(userEnteredFormat(numberFormat)))))'});query.append('ranges',`'${title.replace(/'/g,"''")}'!E${row}:U${row}`);
 const data=await sheetsFetch(env,`?${query.toString()}`,{method:'GET'},false,undefined,false,readPolicy).then(r=>r.json()) as {sheets?:Array<{properties?:{sheetId?:number;title?:string};data?:Array<{startRow?:number;startColumn?:number;rowData?:Array<{values?:Array<{userEnteredFormat?:{numberFormat?:{type?:string;pattern?:string}}}>}>}>}>};
 const matches=(data.sheets||[]).filter(s=>s.properties?.sheetId===sheetId&&s.properties?.title===title),grid=matches[0]?.data?.[0];
 if(matches.length!==1||matches[0]!.data?.length!==1||grid?.startRow!==row-1||grid.startColumn!==4||!Array.isArray(grid.rowData)||grid.rowData.length!==1||!Array.isArray(grid.rowData[0]?.values)||grid.rowData[0]!.values!.length>17)throw Error('SHEET_FORMAT_READ_UNVERIFIED');
 return Array.from({length:17},(_,i)=>grid.rowData![0]!.values![i]?.userEnteredFormat?.numberFormat??null);
}
export async function bootstrapSheets(env:Env):Promise<void>{
  const meta=await sheetsFetch(env,"?fields=sheets.properties",{method:"GET"}).then(r=>r.json()) as{sheets?:Array<{properties:{title:string}}>},existing=new Set((meta.sheets||[]).map(s=>s.properties.title));
  const definitions=[
    [env.SHEET_ATTENDANCE_RAW,["Event_ID","Received_At","Work_Date","Employee_ID","Staff_Name","Punch_Type","Official_Time","LINE_Time","Diff_Min","Status","Confidence","Image_Key","Note","Validation_Code","Message_ID","Trace_ID","Version","Attendance_Source","Photo_DateTime","GPS_Lat","GPS_Lng","Distance_M","Clock_Evidence","Clock_Confidence","Overlay_Raw_Text","Image_SHA256"]],
    [env.SHEET_DAILY_PAYROLL,["Work_Date","Employee_ID","Staff_Name","Scheduled_In","Scheduled_Out","Time_In","Time_Out","Work_Hours","Late_Min","Early_Out_Min","Daily_Wage_Baht","Confirmed_Wage_Baht","Pending_Review_Wage_Baht","Pay_Status","Review_Flag","Version","Wage_Source_ID","Daily_Wage_Snapshot_Baht","Late_Deduction_Baht","Missing_Punch_Type","Missing_Punch_Deduction_Baht","OT_Approved_Baht","Other_Adjustment_Baht","Net_Pay_Baht","Payroll_Policy_Code","Finalized_At"]],
    [env.SHEET_WEEKLY_PAYROLL,["Pay_Date","Period_Start","Employee_ID","Staff_Name","Work_Days","Amount_To_Pay_Baht","Pending_Review_Baht","Status","Version","Base_Wage_Total_Baht","Late_Deduction_Total_Baht","Missing_Punch_Deduction_Total_Baht","OT_Total_Baht","Other_Adjustment_Total_Baht","Net_Pay_Baht","Pending_Review_Count","Period_End"]],
    [env.SHEET_WAGE_HISTORY,["Wage_ID","Employee_ID","Staff_Name","Daily_Wage_Baht","Effective_From","Effective_To","Source","Note","Version","Created_At","Updated_At"]],
    [env.SHEET_SHIFT_SCHEDULE,["Work_Date","Employee_ID","Staff_Name","Scheduled_In","Scheduled_Out","Daily_Wage_Snapshot_Baht","Wage_Source_ID","Status","Note","Version","Updated_At"]],
    [env.SHEET_OT_REQUESTS,["OT_ID","Work_Date","Employee_ID","Staff_Name","Reason","Planned_Start","Planned_End","Fixed_Amount_Baht","Requested_By","Owner_Preapproved_At","Employee_Confirm_Status","Employee_Confirmed_At","Owner_Final_Status","Owner_Final_Amount_Baht","Owner_Final_At","Actual_OT_Min","Status","Note","Version","Updated_At"]],
    [env.SHEET_EXPENSE_RAW,["Expense_ID","Transaction_Date","Description","Amount_Baht","Payment_Key","Source_Wallet","Category","Status","Message_ID","Trace_ID","Submitted_By_Staff_ID","Branch_ID","Document_ID","Document_Type","Vendor","Document_Number","Order_ID"]],
    [env.SHEET_PERSONAL_USE_RAW||"V52_PERSONAL_USE_RAW",["Personal_Use_ID","Transaction_Type","Transaction_Date","Description","Amount_Baht","Source_Wallet","Status","Message_ID","Trace_ID","Submitted_By","Branch_ID","Approved_At","Created_At","Updated_At","Version"]],
    [env.SHEET_PURCHASE_DETAILS||"รายละเอียดการซื้อ",["Purchase_Item_ID","Expense_ID","Document_ID","วันที่ซื้อ","บริษัท/ร้านค้า","เลขที่เอกสาร","รายการสินค้า","จำนวน","หน่วย","ราคาต่อหน่วย","ส่วนลดรายการ","จำนวนเงินรายการ","ส่วนลด/ปรับยอดระดับเอกสาร","ยอดจ่ายจริงของ Expense","หมวด","สาขา","สถานะ","Evidence ref (private)","Created_At","Updated_At / Cancelled_At"]],
    [env.SHEET_SYSTEM_LOG,["Created_At","Trace_ID","Level","Event","Detail"]]
  ] as const;
  const requests=definitions.filter(([name])=>!existing.has(name)).map(([title])=>({addSheet:{properties:{title,gridProperties:{frozenRowCount:1}}}}));if(requests.length)await sheetsFetch(env,":batchUpdate",{method:"POST",body:JSON.stringify({requests})});
  // Never rewrite an existing sheet's headers: several operational tabs carry
  // formulas, formatting and manually maintained labels.  New tabs get their
  // complete header row at creation time.
  const newDefinitions=definitions.filter(([name])=>!existing.has(name));
  await batchWriteValues(env,newDefinitions.map(([name,headers])=>({range:`'${name}'!A1:${columnName(headers.length)}1`,values:[Array.from(headers)]})));
  if(existing.has("04_OWNER_MONTH_CLOSE")){
    const cells=ownerMonthClosePersonalUseCells(env.SHEET_PERSONAL_USE_RAW||"V52_PERSONAL_USE_RAW"),qualified=cells.map(cell=>`'04_OWNER_MONTH_CLOSE'!${cell.range}`),current=await batchGetSheetFormulaValues(env,qualified),writes=planOwnerMonthClosePersonalUseWrites(current,cells,legacyOwnerMonthClosePersonalUseCells());
    await batchWriteUserEnteredValues(env,writes.map(cell=>({range:`'04_OWNER_MONTH_CLOSE'!${cell.range}`,values:[[cell.value]]})));
  }
}
function columnName(index:number):string{let n=index,result="";while(n>0){n--;result=String.fromCharCode(65+n%26)+result;n=Math.floor(n/26);}return result;}
