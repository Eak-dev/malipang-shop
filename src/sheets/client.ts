import type { Env } from "../types";
import { getGoogleAccessToken } from "./google-auth";
import { fetchWithTimeout,readBoundedJson } from "../shared/async";
import { numberEnv } from "../shared/env";
import { buildLedgerMetadataValueRange,verifyLedgerMetadataWitness,type LedgerWriteIdentity,type LedgerMetadataWitness,type LedgerWriteGuard } from './ledger-metadata-writer';
import { baselineMatches,canonicalLedgerBaseline,type LedgerBaseline,type LedgerCellValue } from './ledger-stable-journal';
import { legacyOwnerMonthClosePersonalUseCells,ownerMonthClosePersonalUseCells,planOwnerMonthClosePersonalUseWrites,shouldSkipLegacyOwnerMonthCloseBootstrap } from "./owner-month-close";
import type { MetadataValueRange } from './daily-stable-row-writes';
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
type BeforeSheetsMutationDispatch=()=>void|Promise<void>;
async function sheetsFetch(env:Env,path:string,init:RequestInit,mutation=false,beforeMutationDispatch?:BeforeSheetsMutationDispatch,sanitizeErrorBody=false):Promise<Response>{
  const token=await getGoogleAccessToken(env),headers=new Headers(init.headers);headers.set("Authorization",`Bearer ${token}`);if(init.body)headers.set("content-type","application/json");
  // Authentication can consume the full external timeout on a cold token cache.
  // Run the caller's final CAS only after auth, immediately before the Sheet
  // request can be dispatched, so that wait is outside the mutation fence.
  if(mutation&&beforeMutationDispatch)await beforeMutationDispatch();
  let res:Response;try{res=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SPREADSHEET_ID}${path}`,{...init,headers},numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),`Google Sheets ${init.method||"GET"}`);}catch(error){if(mutation)throw new SheetsMutationOutcomeUnknownError(error);throw error;}
  if(!res.ok){let body="";if(sanitizeErrorBody){if(res.body)void res.body.cancel().catch(()=>{});}else try{body=await res.text();}catch{}const httpError=new SheetsHttpError(res.status,`Sheets HTTP ${res.status}${body?`: ${body}`:""}`,parseRetryAfterSeconds(res.headers.get("Retry-After")));if(mutation&&isAmbiguousSheetsMutationStatus(res.status))throw new SheetsMutationOutcomeUnknownError(httpError);throw httpError;}return res;
}
export async function batchWriteValues(env:Env,data:Array<{range:string;values:unknown[][]}>,beforeMutationDispatch?:BeforeSheetsMutationDispatch):Promise<void>{if(!data.length)return;await sheetsFetch(env,"/values:batchUpdate",{method:"POST",body:JSON.stringify({valueInputOption:"RAW",data})},true,beforeMutationDispatch);}
/**
 * Staging-only transport for an already-verified row metadata ID. This is not
 * a compare-and-swap: identity enrollment, prior contents, old writers, and
 * human edits require separate proof. It is deliberately not wired into sync.
 */
export async function writeDailyByMetadataPrototype(env:Env,range:MetadataValueRange,beforeMutationDispatch:BeforeSheetsMutationDispatch):Promise<void>{
  assertStablePrototype(env);
  if(!Number.isSafeInteger(range.dataFilter.developerMetadataLookup.metadataId)||range.dataFilter.developerMetadataLookup.metadataId<1||range.dataFilter.developerMetadataLookup.metadataId>2147483647||range.values.length!==1||range.values[0]?.length!==25)throw new Error('DAILY_STABLE_METADATA_REQUEST_INVALID');
  const allowed=new Set([1,2,3,5,6,7,10,11,12,13,14,15,16,21,22]);
  if(range.values[0]!.some((value,index)=>!allowed.has(index)&&value!==null))throw new Error('DAILY_STABLE_METADATA_REQUEST_INVALID');
  const response=await sheetsFetch(env,'/values:batchUpdateByDataFilter',{method:'POST',body:JSON.stringify({valueInputOption:'RAW',data:[range],includeValuesInResponse:false})},true,beforeMutationDispatch,true);
  let data:{responses?:Array<{updatedRows?:number}>};
  try{data=await readBoundedJson(response,65536,numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),'Sheets mutation response') as typeof data;}catch(error){throw new SheetsMutationOutcomeUnknownError(error);}
  if(data.responses?.length!==1||data.responses[0]?.updatedRows!==1)throw new SheetsMutationOutcomeUnknownError(new Error('DAILY_STABLE_METADATA_RESPONSE_UNVERIFIED'));
}
/**
 * Experimental single-row, metadata-anchored write. NOT called by live sync.
 * The metadata lookup follows full-row moves; a caller must independently
 * establish identity and exclusive cutover because Sheets has no value CAS.
 * Any unparseable/ambiguous result must remain under manual REVIEW.
 */
export async function writeValuesByMetadataPrototype(env:Env,request:{identity:LedgerWriteIdentity;witness:LedgerMetadataWitness;identityRows:unknown[][];values:readonly unknown[];guard:LedgerWriteGuard;baselineHashes:LedgerBaseline;mode?:'PATCH'|'CANCEL_DETAIL'},beforeMutationDispatch:BeforeSheetsMutationDispatch):Promise<void>{
  if(env.RUNTIME_MODE!=='shadow'||env.SHEETS_LEDGER_ANCHORED_WRITE_PROTOTYPE!=='true'||!env.SHEETS_LEDGER_UAT_SPREADSHEET_ID||!env.SHEETS_LEDGER_PRODUCTION_SPREADSHEET_ID||env.SHEETS_LEDGER_UAT_SPREADSHEET_ID===env.SHEETS_LEDGER_PRODUCTION_SPREADSHEET_ID||env.GOOGLE_SPREADSHEET_ID!==env.SHEETS_LEDGER_UAT_SPREADSHEET_ID)throw new Error('LEDGER_METADATA_WRITER_DISABLED');
  if(!request||!beforeMutationDispatch)throw new Error('LEDGER_METADATA_REQUEST_INVALID');
  verifyLedgerMetadataWitness(request.identity,request.witness,request.identityRows);
  const data=buildLedgerMetadataValueRange(request.identity,request.witness.metadataId,request.values,request.guard,request.mode);
  canonicalLedgerBaseline(request.identity.kind,request.baselineHashes);
  const cells:Record<string,LedgerCellValue>={};for(const index of request.guard.fields)cells[String(index)]=request.guard.observed[index]!.entered;
  if(!await baselineMatches(request.baselineHashes,cells))throw new Error('LEDGER_BASELINE_DIGEST_MISMATCH');
  const response=await sheetsFetch(env,'/values:batchUpdateByDataFilter',{method:'POST',body:JSON.stringify({valueInputOption:'RAW',data:[data]})},true,beforeMutationDispatch,true);
  let result:{totalUpdatedRows?:unknown;responses?:unknown};
  try{result=await readBoundedJson(response,65536,numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),'Sheets metadata update response') as typeof result;}
  catch(error){throw new SheetsMutationOutcomeUnknownError(error);}
  if(Number(result?.totalUpdatedRows)!==1 || !Array.isArray(result.responses) || result.responses.length!==1)throw new SheetsMutationOutcomeUnknownError(new Error('LEDGER_METADATA_UPDATE_COUNT_UNKNOWN'));
}
export async function batchWriteUserEnteredValues(env:Env,data:Array<{range:string;values:unknown[][]}>):Promise<void>{if(!data.length)return;await sheetsFetch(env,"/values:batchUpdate",{method:"POST",body:JSON.stringify({valueInputOption:"USER_ENTERED",data})},true);}
export async function batchClearValues(env:Env,ranges:string[],beforeMutationDispatch?:BeforeSheetsMutationDispatch):Promise<void>{if(!ranges.length)return;await sheetsFetch(env,"/values:batchClear",{method:"POST",body:JSON.stringify({ranges})},true,beforeMutationDispatch);}
export async function batchUpdateSpreadsheet(env:Env,requests:unknown[],beforeMutationDispatch?:BeforeSheetsMutationDispatch):Promise<void>{if(!requests.length)return;await sheetsFetch(env,":batchUpdate",{method:"POST",body:JSON.stringify({requests})},true,beforeMutationDispatch);}
function assertStablePrototype(env:Env):void{
  if(env.RUNTIME_MODE!=='shadow'||env.DAILY_STABLE_ID_PROTOTYPE_ENABLED!=='true'||!env.DAILY_STABLE_UAT_SPREADSHEET_ID||!env.DAILY_STABLE_PRODUCTION_SPREADSHEET_ID||env.DAILY_STABLE_UAT_SPREADSHEET_ID===env.DAILY_STABLE_PRODUCTION_SPREADSHEET_ID||env.GOOGLE_SPREADSHEET_ID!==env.DAILY_STABLE_UAT_SPREADSHEET_ID||!env.DAILY_STABLE_UAT_DATABASE_MARKER||env.DAILY_STABLE_UAT_EXCLUSIVE_EDITORS!=='true')throw new Error('DAILY_STABLE_PROTOTYPE_DISABLED');
}
export async function batchUpdateStablePrototype(env:Env,requests:unknown[],beforeMutationDispatch:BeforeSheetsMutationDispatch):Promise<void>{
  assertStablePrototype(env);if(!requests.length)throw new Error('DAILY_STABLE_EMPTY_REQUEST');
  const response=await sheetsFetch(env,':batchUpdate',{method:'POST',body:JSON.stringify({requests})},true,beforeMutationDispatch,true);
  try{await readBoundedJson(response,262144,numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),'Sheets mutation response');}catch(error){throw new SheetsMutationOutcomeUnknownError(error);}
}
export async function stablePrototypeSnapshot(env:Env,range:string,formulas:boolean):Promise<unknown[][]>{
  assertStablePrototype(env);const q=new URLSearchParams({ranges:range,valueRenderOption:formulas?'FORMULA':'UNFORMATTED_VALUE',dateTimeRenderOption:'SERIAL_NUMBER'});
  const response=await sheetsFetch(env,`/values:batchGet?${q}`,{method:'GET'},false,undefined,true);
  const data=await readBoundedJson(response,4*1024*1024,numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),'Sheets snapshot') as {valueRanges?:Array<{values?:unknown[][]}>};
  if(data.valueRanges?.length!==1||!Array.isArray(data.valueRanges[0]!.values))throw new Error('DAILY_STABLE_SNAPSHOT_INCOMPLETE');return data.valueRanges[0]!.values!;
}
export function parseStablePrototypeSheetInfo(result:{sheets?:Array<{properties?:{sheetId?:number;title?:string;gridProperties?:{rowCount?:number;columnCount?:number}}}>},title:string):{sheetId:number;rowCount:number;columnCount:number}{
  const matches=(result.sheets??[]).filter(item=>item.properties?.title===title);if(matches.length!==1)throw new Error('DAILY_STABLE_SHEET_NOT_UNIQUE');
  const p=matches[0]!.properties!,g=p.gridProperties;
  if(!Number.isSafeInteger(p.sheetId)||!Number.isSafeInteger(g?.rowCount)||!Number.isSafeInteger(g?.columnCount)||g!.rowCount!<1||g!.rowCount!>5000||g!.columnCount!<25)throw new Error('DAILY_STABLE_SHEET_GRID_UNSUPPORTED');
  return {sheetId:p.sheetId!,rowCount:g!.rowCount!,columnCount:g!.columnCount!};
}
export async function stablePrototypeSheetInfo(env:Env,title:string):Promise<{sheetId:number;rowCount:number;columnCount:number}>{
  assertStablePrototype(env);const response=await sheetsFetch(env,'?fields=sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))',{method:'GET'},false,undefined,true);
  const result=await readBoundedJson(response,1048576,numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),'Sheets tab metadata') as Parameters<typeof parseStablePrototypeSheetInfo>[0];
  return parseStablePrototypeSheetInfo(result,title);
}
type StableAnnotationResponse={sheets?:Array<{properties?:{sheetId?:number};protectedRanges?:Array<{range?:{sheetId?:number;startRowIndex?:number;endRowIndex?:number;startColumnIndex?:number;endColumnIndex?:number}}>;data?:Array<{startRow?:number;rowData?:Array<{values?:Array<{note?:string;dataValidation?:unknown}>}>}>}>};
export function stablePrototypeAnnotationsSafe(result:StableAnnotationResponse,sheetId:number,rows:number[],insertionRow?:number):boolean{
  const sheets=(result.sheets??[]).filter(sheet=>sheet.properties?.sheetId===sheetId);if(sheets.length!==1||!rows.length||rows.some(row=>!Number.isSafeInteger(row)||row<1))return false;
  const sheet=sheets[0]!,data=sheet.data??[];
  for(const row of new Set(rows)){
    const ranges=data.filter(item=>(item.startRow??0)===row-1);if(ranges.length!==1)return false;
    if((ranges[0]!.rowData??[]).some(record=>(record.values??[]).some(cell=>!!cell.note||cell.dataValidation!==undefined)))return false;
  }
  for(const protection of sheet.protectedRanges??[]){
    const r=protection.range;if(!r||r.sheetId!==sheetId)return false;
    const rs=r.startRowIndex??0,re=r.endRowIndex??Number.MAX_SAFE_INTEGER,cs=r.startColumnIndex??0,ce=r.endColumnIndex??Number.MAX_SAFE_INTEGER;
    if(cs<25&&ce>0&&(rows.some(row=>rs<row&&re>row-1)||(insertionRow!==undefined&&re>insertionRow-1)))return false;
  }
  return true;
}
export async function requireStablePrototypeAnnotations(env:Env,sheet:string,sheetId:number,rows:number[],insertionRow?:number):Promise<void>{
  assertStablePrototype(env);const quoted=sheet.replace(/'/g,"''"),query=new URLSearchParams({includeGridData:'true',fields:'sheets(properties(sheetId),protectedRanges(range),data(startRow,rowData(values(note,dataValidation))))'});
  for(const row of new Set(rows))query.append('ranges',`'${quoted}'!A${row}:Y${row}`);
  const response=await sheetsFetch(env,`?${query}`,{method:'GET'},false,undefined,true);
  const result=await readBoundedJson(response,1048576,numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),'Sheets row annotations') as StableAnnotationResponse;
  if(!stablePrototypeAnnotationsSafe(result,sheetId,rows,insertionRow))throw new Error('DAILY_STABLE_ROW_ANNOTATIONS_UNVERIFIED');
}
type StableMetadataResponse={matchedDeveloperMetadata?:Array<{developerMetadata?:{metadataId?:number;metadataKey?:string;visibility?:string;location?:{dimensionRange?:{sheetId?:number;dimension?:string;startIndex?:number;endIndex?:number}}}}>};
export function parseStablePrototypeMetadata(result:StableMetadataResponse):Array<{metadataId:number;sheetId:number;row:number}>{
  const matches=result.matchedDeveloperMetadata??[];if(matches.length>2)throw new Error('DAILY_STABLE_METADATA_DUPLICATE');
  return matches.map(item=>{const m=item.developerMetadata,d=m?.location?.dimensionRange;if(!Number.isSafeInteger(m?.metadataId)||m!.metadataId!<1||m?.metadataKey!=='e'||m.visibility!=='DOCUMENT'||d?.dimension!=='ROWS'||!Number.isSafeInteger(d.sheetId)||!Number.isSafeInteger(d.startIndex)||d.endIndex!==d.startIndex!+1)throw new Error('DAILY_STABLE_METADATA_INVALID');return{metadataId:m!.metadataId!,sheetId:d.sheetId!,row:d.startIndex!+1};});
}
export async function stablePrototypeSearchMetadata(env:Env,filter:Record<string,unknown>):Promise<Array<{metadataId:number;sheetId:number;row:number}>>{
  assertStablePrototype(env);const response=await sheetsFetch(env,'/developerMetadata:search',{method:'POST',body:JSON.stringify({dataFilters:[{developerMetadataLookup:filter}]})},false,undefined,true);
  const result=await readBoundedJson(response,262144,numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),'Sheets metadata') as StableMetadataResponse;
  return parseStablePrototypeMetadata(result);
}
export async function getSheetValues(env:Env,range:string):Promise<unknown[][]>{const encoded=encodeURIComponent(range),data=await sheetsFetch(env,`/values/${encoded}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,{method:"GET"}).then(r=>r.json()) as{values?:unknown[][]};return data.values||[];}
export async function batchGetSheetValues(env:Env,ranges:string[]):Promise<unknown[][][]>{
  if(!ranges.length)return[];const query=new URLSearchParams({valueRenderOption:"UNFORMATTED_VALUE",dateTimeRenderOption:"FORMATTED_STRING"});for(const range of ranges)query.append("ranges",range);
  const data=await sheetsFetch(env,`/values:batchGet?${query.toString()}`,{method:"GET"}).then(r=>r.json()) as{valueRanges?:Array<{values?:unknown[][]}>};return(data.valueRanges||[]).map(item=>item.values||[]);
}
export async function batchGetSheetFormulaValues(env:Env,ranges:string[]):Promise<unknown[][][]>{
  if(!ranges.length)return[];const query=new URLSearchParams({valueRenderOption:"FORMULA",dateTimeRenderOption:"FORMATTED_STRING"});for(const range of ranges)query.append("ranges",range);
  const data=await sheetsFetch(env,`/values:batchGet?${query.toString()}`,{method:"GET"}).then(r=>r.json()) as{valueRanges?:Array<{values?:unknown[][]}>};return(data.valueRanges||[]).map(item=>item.values||[]);
}
export async function getSpreadsheetMetadata(env:Env):Promise<{spreadsheetId:string;title:string;timeZone:string}>{const data=await sheetsFetch(env,"?fields=spreadsheetId,properties(title,timeZone)",{method:"GET"}).then(r=>r.json()) as{spreadsheetId:string;properties?:{title?:string;timeZone?:string}};return{spreadsheetId:data.spreadsheetId,title:String(data.properties?.title||""),timeZone:String(data.properties?.timeZone||"")};}
/** Bounded/sanitized read for the disabled-by-default inspection prototype. */
async function identityInspectionGet(env:Env,path:string):Promise<unknown>{
  const token=await getGoogleAccessToken(env),timeout=numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000);
  const response=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SPREADSHEET_ID}${path}`,{method:'GET',headers:{Authorization:`Bearer ${token}`}},timeout,'Sheets identity inspection');
  if(!response.ok){if(response.body)void response.body.cancel().catch(()=>{});throw new Error('LEDGER_INSPECTION_HTTP_ERROR');}
  return readBoundedJson(response,4*1024*1024,timeout,'Sheets identity response');
}
/** Bounded authenticated read used only by the isolated ledger UAT probe. */
export async function getLedgerUatSnapshotPart(env:Env,path:string):Promise<unknown>{
  if(env.RUNTIME_MODE!=='shadow'||env.SHEETS_LEDGER_ANCHORED_WRITE_PROTOTYPE!=='true'||!env.SHEETS_LEDGER_UAT_SPREADSHEET_ID||!env.SHEETS_LEDGER_PRODUCTION_SPREADSHEET_ID||env.SHEETS_LEDGER_UAT_SPREADSHEET_ID===env.SHEETS_LEDGER_PRODUCTION_SPREADSHEET_ID||env.GOOGLE_SPREADSHEET_ID!==env.SHEETS_LEDGER_UAT_SPREADSHEET_ID)throw new Error('LEDGER_METADATA_READER_DISABLED');
  try{return await identityInspectionGet(env,path);}catch{throw new Error('LEDGER_METADATA_READER_UNAVAILABLE');}
}
/** Grid extent, not a cached row position. Used only by the disabled-by-default inspection prototype. */
export async function getSheetRowCount(env:Env,title:string):Promise<number>{
  const data=await identityInspectionGet(env,"?fields=sheets.properties(title,gridProperties(rowCount))") as{sheets?:Array<{properties?:{title?:string;gridProperties?:{rowCount?:number}}}>};
  const matches=(data.sheets||[]).filter(sheet=>sheet.properties?.title===title);
  const n=matches[0]?.properties?.gridProperties?.rowCount;
  if(matches.length!==1||!Number.isSafeInteger(n)||Number(n)<1)throw new Error("LEDGER_GRID_UNAVAILABLE");
  return Number(n);
}
export async function getSheetIdentityValues(env:Env,range:string):Promise<unknown[][]>{
  const data=await identityInspectionGet(env,`/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`) as {values?:unknown[][]};
  if(data.values!==undefined&&!Array.isArray(data.values))throw new Error('LEDGER_IDENTITY_VALUES_INVALID');
  return data.values||[];
}
export async function getSheetId(env:Env,title:string):Promise<number>{
  const data=await sheetsFetch(env,"?fields=sheets.properties(sheetId,title)",{method:"GET"}).then(r=>r.json()) as{sheets?:Array<{properties?:{sheetId?:number;title?:string}}>};
  const found=(data.sheets||[]).find(sheet=>sheet.properties?.title===title)?.properties?.sheetId;
  if(!Number.isInteger(found))throw new Error(`Google Sheet tab not found: ${title}`);
  return Number(found);
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
    const marker=await batchGetSheetFormulaValues(env,["'04_OWNER_MONTH_CLOSE'!A5","'04_OWNER_MONTH_CLOSE'!A34"]);
    if(marker.length!==2)throw new Error("OWNER_MONTH_CLOSE_LAYOUT_READBACK_INCOMPLETE");
    if(shouldSkipLegacyOwnerMonthCloseBootstrap(marker[0]?.[0]?.[0],marker[1]?.[0]?.[0]))return;
    const cells=ownerMonthClosePersonalUseCells(env.SHEET_PERSONAL_USE_RAW||"V52_PERSONAL_USE_RAW"),qualified=cells.map(cell=>`'04_OWNER_MONTH_CLOSE'!${cell.range}`),current=await batchGetSheetFormulaValues(env,qualified),writes=planOwnerMonthClosePersonalUseWrites(current,cells,legacyOwnerMonthClosePersonalUseCells());
    await batchWriteUserEnteredValues(env,writes.map(cell=>({range:`'04_OWNER_MONTH_CLOSE'!${cell.range}`,values:[[cell.value]]})));
  }
}
function columnName(index:number):string{let n=index,result="";while(n>0){n--;result=String.fromCharCode(65+n%26)+result;n=Math.floor(n/26);}return result;}
