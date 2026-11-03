import type { Env } from "../types";
import { getGoogleAccessToken } from "./google-auth";
import { fetchWithTimeout,readBoundedJson } from "../shared/async";
import { numberEnv } from "../shared/env";
import { buildLedgerMetadataValueRange,verifyLedgerMetadataWitness,type LedgerWriteIdentity,type LedgerMetadataWitness,type LedgerWriteGuard } from './ledger-metadata-writer';
import { baselineMatches,canonicalLedgerBaseline,type LedgerBaseline,type LedgerCellValue } from './ledger-stable-journal';
import {buildExpenseRawProductionAppendRequests,type LedgerUatAppendSnapshot} from './ledger-uat-append-planner';
import type {RawSourceProof} from './raw-source-proof';
import {FullRawAppendIntent} from './full-raw-append-intent';
import {PersonalRawEnrollment} from './personal-raw-enrollment';
import {PersonalHistoricalEnrollment} from './personal-historical-enrollment';
import {HistoricalMarkerRemediation,type HistoricalMarkerKind,type HistoricalMarkerPayload} from '../admin/personal-historical-marker-remediation';
import type {HistoricalMarkerObservation} from './personal-historical-marker-classifier';
import {legacyPersonalWriterOpen} from './personal-legacy-writer-gate';
import type {planPersonalRawEnrollment} from './personal-raw-enrollment-plan';
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
async function sheetsFetch(env:Env,path:string,init:RequestInit,mutation=false,beforeMutationDispatch?:BeforeSheetsMutationDispatch,sanitizeErrors=false):Promise<Response>{
  const token=await getGoogleAccessToken(env),headers=new Headers(init.headers);headers.set("Authorization",`Bearer ${token}`);if(init.body)headers.set("content-type","application/json");
  // Authentication can consume the full external timeout on a cold token cache.
  // Run the caller's final CAS only after auth, immediately before the Sheet
  // request can be dispatched, so that wait is outside the mutation fence.
  if(mutation&&beforeMutationDispatch)await beforeMutationDispatch();
  let res:Response;try{res=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SPREADSHEET_ID}${path}`,{...init,headers},numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),`Google Sheets ${init.method||"GET"}`);}catch(error){if(mutation)throw new SheetsMutationOutcomeUnknownError(error);throw error;}
  if(!res.ok){let body="";if(sanitizeErrors){if(res.body)void res.body.cancel().catch(()=>{});}else try{body=await res.text();}catch{}const httpError=new SheetsHttpError(res.status,`Sheets HTTP ${res.status}${body?`: ${body}`:""}`,parseRetryAfterSeconds(res.headers.get("Retry-After")));if(mutation&&isAmbiguousSheetsMutationStatus(res.status))throw new SheetsMutationOutcomeUnknownError(httpError);throw httpError;}return res;
}
export async function batchWriteValues(env:Env,data:Array<{range:string;values:unknown[][]}>,beforeMutationDispatch?:BeforeSheetsMutationDispatch):Promise<void>{if(!data.length)return;await sheetsFetch(env,"/values:batchUpdate",{method:"POST",body:JSON.stringify({valueInputOption:"RAW",data})},true,beforeMutationDispatch);}
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
/** Full-row shadow adapter only. No runtime route calls this function. A
 * whole-row baseline, durable source/intent guard and controlled editor
 * cutover are still required; this method alone is not an atomic CAS. */
export async function writeRawFullByMetadataUat(env:Env,request:{identity:LedgerWriteIdentity;witness:LedgerMetadataWitness;identityRows:unknown[][];values:readonly unknown[];guard:LedgerWriteGuard;baselineHashes:LedgerBaseline},beforeMutationDispatch:BeforeSheetsMutationDispatch):Promise<void>{
  if(env.RUNTIME_MODE!=='shadow'||env.SHEETS_LEDGER_FULL_PROJECTION_UAT!=='true'||env.SHEETS_LEDGER_ANCHORED_WRITE_PROTOTYPE!=='true'||!env.SHEETS_LEDGER_UAT_SPREADSHEET_ID||!env.SHEETS_LEDGER_PRODUCTION_SPREADSHEET_ID||env.SHEETS_LEDGER_UAT_SPREADSHEET_ID===env.SHEETS_LEDGER_PRODUCTION_SPREADSHEET_ID||env.GOOGLE_SPREADSHEET_ID!==env.SHEETS_LEDGER_UAT_SPREADSHEET_ID)throw new Error('RAW_FULL_WRITER_DISABLED');
  if(!request||!beforeMutationDispatch||request.identity.kind==='PURCHASE_DETAILS')throw new Error('RAW_FULL_REQUEST_INVALID');
  const size=request.identity.kind==='EXPENSE'?17:request.identity.kind==='PERSONAL_USE'?15:0,fields=request.guard?.fields,keys=Object.keys(request.baselineHashes||{});
  if(!size||!Array.isArray(fields)||fields.length!==size-1||keys.length!==size-1||Array.from({length:size-1},(_,i)=>i+1).some(i=>!fields.includes(i)||!/^[a-f0-9]{64}$/.test(request.baselineHashes[String(i)]||'')))throw new Error('RAW_FULL_BASELINE_INCOMPLETE');
  verifyLedgerMetadataWitness(request.identity,request.witness,request.identityRows);
  const data=buildLedgerMetadataValueRange(request.identity,request.witness.metadataId,request.values,request.guard);
  const cells:Record<string,LedgerCellValue>={};for(const index of fields)cells[String(index)]=request.guard.observed[index]!.entered;
  if(!await baselineMatches(request.baselineHashes,cells))throw new Error('RAW_FULL_BASELINE_MISMATCH');
  let response:Response;
  try{response=await sheetsFetch(env,'/values:batchUpdateByDataFilter',{method:'POST',body:JSON.stringify({valueInputOption:'RAW',data:[data]})},true,beforeMutationDispatch,true);}
  catch(error){if(error instanceof SheetsMutationOutcomeUnknownError)throw new SheetsMutationOutcomeUnknownError(new Error('RAW_FULL_REQUEST_OUTCOME_UNKNOWN'));if(error instanceof SheetsHttpError)throw new SheetsHttpError(error.status,`Sheets HTTP ${error.status}`,error.retryAfterSeconds);throw new Error('RAW_FULL_PREFLIGHT_UNAVAILABLE');}
  let result:{totalUpdatedRows?:unknown;responses?:unknown};try{result=await readBoundedJson(response,65536,numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),'Sheets full RAW response') as typeof result;}catch{throw new SheetsMutationOutcomeUnknownError(new Error('RAW_FULL_RESPONSE_UNAVAILABLE'));}
  if(Number(result?.totalUpdatedRows)!==1||!Array.isArray(result.responses)||result.responses.length!==1)throw new SheetsMutationOutcomeUnknownError(new Error('RAW_FULL_UPDATE_COUNT_UNKNOWN'));
}
export async function batchWriteUserEnteredValues(env:Env,data:Array<{range:string;values:unknown[][]}>):Promise<void>{if(!data.length)return;await sheetsFetch(env,"/values:batchUpdate",{method:"POST",body:JSON.stringify({valueInputOption:"USER_ENTERED",data})},true);}
export async function batchClearValues(env:Env,ranges:string[],beforeMutationDispatch?:BeforeSheetsMutationDispatch):Promise<void>{if(!ranges.length)return;await sheetsFetch(env,"/values:batchClear",{method:"POST",body:JSON.stringify({ranges})},true,beforeMutationDispatch);}
export async function batchUpdateSpreadsheet(env:Env,requests:unknown[],beforeMutationDispatch?:BeforeSheetsMutationDispatch):Promise<void>{if(!requests.length)return;await sheetsFetch(env,":batchUpdate",{method:"POST",body:JSON.stringify({requests})},true,beforeMutationDispatch);}
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
/** Candidate production read only; no live route calls it. Configuration
 * flags do not establish editor exclusivity or authorize a mutation. */
function assertRawIdentityProductionReader(env:Env):void{
  if(env.RUNTIME_MODE!=='production'||env.RAW_FULL_IDENTITY_WRITER_ENABLED!=='true'||env.EXPENSE_STABLE_PROJECTION_ENABLED!=='true'||env.DAILY_LEGACY_WRITER_GATE_ENABLED!=='true'||!env.GOOGLE_SPREADSHEET_ID||!env.SHEET_EXPENSE_RAW||!env.SHEET_EXPENSE_DAILY)throw Error('RAW_IDENTITY_READER_DISABLED');
}
export async function getRawIdentityProductionMetadata(env:Env,metadataId:number):Promise<unknown>{
  assertRawIdentityProductionReader(env);if(!Number.isSafeInteger(metadataId)||metadataId<1||metadataId>2147483647)throw Error('RAW_IDENTITY_READER_INVALID');
  try{return await identityInspectionGet(env,`/developerMetadata/${metadataId}?fields=metadataId,metadataKey,visibility,location`);}catch{throw new Error('RAW_IDENTITY_READER_UNAVAILABLE');}
}
export async function getRawIdentityProductionGrid(env:Env):Promise<unknown>{
  assertRawIdentityProductionReader(env);const range=`'${env.SHEET_EXPENSE_RAW.replace(/'/g,"''")}'!A1:Q10000`;
  const query=new URLSearchParams({ranges:range,fields:'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),protectedRanges,merges,data(startRow,startColumn,rowData(values(userEnteredValue,note,dataValidation))))'});
  try{return await identityInspectionGet(env,`?${query.toString()}`);}catch{throw new Error('RAW_IDENTITY_READER_UNAVAILABLE');}
}
/** Default-off read-only personal-use probe; no free-form provider paths. */
function assertPersonalIdentityProductionReader(env:Env):void{
  if(env.RUNTIME_MODE!=='production'||env.PERSONAL_IDENTITY_READER_ENABLED!=='true'||env.PERSONAL_STABLE_PROJECTION_ENABLED!=='true'||!env.GOOGLE_SPREADSHEET_ID||!env.SHEET_PERSONAL_USE_RAW)throw Error('PERSONAL_IDENTITY_READER_DISABLED');
}
export async function getPersonalIdentityProductionMetadata(env:Env,metadataId:number):Promise<unknown>{
  assertPersonalIdentityProductionReader(env);if(!Number.isSafeInteger(metadataId)||metadataId<1||metadataId>2147483647)throw Error('PERSONAL_IDENTITY_READER_INVALID');
  try{return await identityInspectionGet(env,`/developerMetadata/${metadataId}?fields=metadataId,metadataKey,visibility,location`);}catch{throw Error('PERSONAL_IDENTITY_READER_UNAVAILABLE');}
}
/** Read-only search for exactly one metadata ID. Unlike GET-by-ID, a successful
 * search can represent zero matches. Never accept errors as absence. */
export async function searchPersonalProductionMetadataById(env:Env,metadataId:number):Promise<unknown>{
  assertPersonalIdentityProductionReader(env);if(!Number.isSafeInteger(metadataId)||metadataId<1||metadataId>2147483647)throw Error('PERSONAL_METADATA_SEARCH_INVALID');
  try{
    const token=await getGoogleAccessToken(env),timeout=numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000);
    const response=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SPREADSHEET_ID}/developerMetadata:search`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({dataFilters:[{developerMetadataLookup:{metadataId}}]})},timeout,'Sheets personal metadata search');
    if(!response.ok){if(response.body)void response.body.cancel().catch(()=>{});throw Error('unavailable');}
    return await readBoundedJson(response,65536,timeout,'Sheets personal metadata search');
  }catch{throw Error('PERSONAL_METADATA_SEARCH_UNAVAILABLE');}
}
export async function getPersonalIdentityProductionGrid(env:Env):Promise<unknown>{
  assertPersonalIdentityProductionReader(env);const range=`'${env.SHEET_PERSONAL_USE_RAW!.replace(/'/g,"''")}'!A1:O10000`;
  const query=new URLSearchParams({ranges:range,fields:'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),protectedRanges,merges,data(startRow,startColumn,rowData(values(userEnteredValue,note,dataValidation)),rowMetadata(developerMetadata(metadataId,metadataKey,visibility,location))))'});
  try{return await identityInspectionGet(env,`?${query.toString()}`);}catch{throw Error('PERSONAL_IDENTITY_READER_UNAVAILABLE');}
}
export async function getPersonalProductionGridProperties(env:Env):Promise<unknown>{
  assertPersonalIdentityProductionReader(env);const range=`'${env.SHEET_PERSONAL_USE_RAW!.replace(/'/g,"''")}'!A1`;
  const query=new URLSearchParams({ranges:range,fields:'sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))'});
  try{return await identityInspectionGet(env,`?${query.toString()}`);}catch{throw Error('PERSONAL_IDENTITY_READER_UNAVAILABLE');}
}
export async function getPersonalProductionCompleteGrid(env:Env,rows:number,columns:number):Promise<unknown>{
  assertPersonalIdentityProductionReader(env);if(!Number.isSafeInteger(rows)||rows<1||rows>=10000||!Number.isSafeInteger(columns)||columns<15||columns>64||(rows+1)*columns>50000)throw Error('PERSONAL_IDENTITY_READER_INVALID');
  let n=columns,col='';while(n>0){n--;col=String.fromCharCode(65+n%26)+col;n=Math.floor(n/26);}
  const range=`'${env.SHEET_PERSONAL_USE_RAW!.replace(/'/g,"''")}'!A1:${col}${rows}`,query=new URLSearchParams({ranges:range,fields:'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),protectedRanges,merges,data(startRow,startColumn,rowData(values(userEnteredValue,note,dataValidation)),rowMetadata(developerMetadata(metadataId,metadataKey,visibility,location))))'});
  try{return await identityInspectionGet(env,`?${query.toString()}`);}catch{throw Error('PERSONAL_IDENTITY_READER_UNAVAILABLE');}
}
/** Internal one-shot metadata mutation; no runtime route calls this. */
export async function sendPersonalEnrollmentMutation(env:Env,source:RawSourceProof,metadataId:number,token:string,sheetId:number,plan:ReturnType<typeof planPersonalRawEnrollment>,intent:PersonalRawEnrollment):Promise<void>{
  if(env.PERSONAL_ENROLLMENT_ENABLED!=='true')throw Error('PERSONAL_ENROLLMENT_DISABLED');const expected=JSON.stringify(plan);let response:Response;
  try{response=await sheetsFetch(env,':batchUpdate',{method:'POST',body:JSON.stringify({requests:[plan]})},true,async()=>{if(!await PersonalRawEnrollment.authorizeTransport(intent,env,source,metadataId,token,sheetId,expected))throw Error('PERSONAL_ENROLLMENT_FENCE_LOST');},true);}
  catch(error){if(error instanceof SheetsMutationOutcomeUnknownError)throw new SheetsMutationOutcomeUnknownError(new Error('PERSONAL_ENROLLMENT_OUTCOME_UNKNOWN'));if(error instanceof SheetsHttpError)throw new SheetsHttpError(error.status,`Sheets HTTP ${error.status}`,error.retryAfterSeconds);throw Error('PERSONAL_ENROLLMENT_PREFLIGHT_UNAVAILABLE');}
  try{const data=await readBoundedJson(response,65536,numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),'Sheets personal enrollment response') as {replies?:Array<{createDeveloperMetadata?:{developerMetadata?:{metadataId?:unknown;metadataKey?:unknown;visibility?:unknown;location?:{dimensionRange?:{sheetId?:unknown;dimension?:unknown;startIndex?:unknown;endIndex?:unknown}}}}}>};
    const m=data?.replies?.[0]?.createDeveloperMetadata?.developerMetadata,r=m?.location?.dimensionRange,wanted=plan.createDeveloperMetadata.developerMetadata.location.dimensionRange;
    if(!Array.isArray(data?.replies)||data.replies.length!==1||m?.metadataId!==metadataId||m.metadataKey!=='P'||m.visibility!=='DOCUMENT'||r?.sheetId!==sheetId||r.dimension!=='ROWS'||r.startIndex!==wanted.startIndex||r.endIndex!==wanted.endIndex)throw Error('invalid');
  }catch{throw new SheetsMutationOutcomeUnknownError(new Error('PERSONAL_ENROLLMENT_RESPONSE_UNKNOWN'));}
}
/** Historical transport is one-shot and only callable with a branded intent
 * whose fresh source, provider snapshot, and D1 lock still match. */
export async function sendHistoricalPersonalEnrollmentMutation(env:Env,metadataId:number,sheetId:number,plan:ReturnType<typeof planPersonalRawEnrollment>,intent:PersonalHistoricalEnrollment):Promise<string>{
  if(env.PERSONAL_HISTORICAL_WRITER_ENABLED!=='true')throw Error('HISTORICAL_ENROLLMENT_DISABLED');const expected=JSON.stringify(plan);let response:Response;
  try{response=await sheetsFetch(env,':batchUpdate',{method:'POST',body:JSON.stringify({requests:[plan]})},true,async()=>{if(!await PersonalHistoricalEnrollment.authorizeTransport(intent,env,expected))throw Error('HISTORICAL_ENROLLMENT_FENCE_LOST');},true);}
  catch(error){if(error instanceof SheetsMutationOutcomeUnknownError)throw new SheetsMutationOutcomeUnknownError(new Error('HISTORICAL_ENROLLMENT_OUTCOME_UNKNOWN'));if(error instanceof SheetsHttpError)throw new SheetsHttpError(error.status,`Sheets HTTP ${error.status}`,error.retryAfterSeconds);throw Error('HISTORICAL_ENROLLMENT_PREFLIGHT_UNAVAILABLE');}
  try{const data=await readBoundedJson(response,65536,numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),'Sheets historical enrollment response') as {replies?:Array<{createDeveloperMetadata?:{developerMetadata?:{metadataId?:unknown;metadataKey?:unknown;visibility?:unknown;location?:{dimensionRange?:{sheetId?:unknown;dimension?:unknown;startIndex?:unknown;endIndex?:unknown}}}}}>};
    const m=data?.replies?.[0]?.createDeveloperMetadata?.developerMetadata,r=m?.location?.dimensionRange,wanted=plan.createDeveloperMetadata.developerMetadata.location.dimensionRange;
    if(!Array.isArray(data?.replies)||data.replies.length!==1||m?.metadataId!==metadataId||m.metadataKey!=='P'||m.visibility!=='DOCUMENT'||r?.sheetId!==sheetId||r.dimension!=='ROWS'||r.startIndex!==wanted.startIndex||r.endIndex!==wanted.endIndex)throw Error('invalid');
    const bytes=new TextEncoder().encode(JSON.stringify(['historical-provider-ack-v1',metadataId,m.metadataKey,m.visibility,r.sheetId,r.dimension,r.startIndex,r.endIndex]));return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
  }catch{throw new SheetsMutationOutcomeUnknownError(new Error('HISTORICAL_ENROLLMENT_RESPONSE_UNKNOWN'));}
}
/** Internal one-shot transport; only a private branded action can claim it. */
export async function sendHistoricalMarkerMutation(env:Env,kind:HistoricalMarkerKind,metadataId:number,payload:HistoricalMarkerPayload,marker:HistoricalMarkerObservation,intent:HistoricalMarkerRemediation):Promise<void>{
  if(kind!=='ATTACH_ABSENT'||env.PERSONAL_HISTORICAL_MARKER_REMEDIATION_ENABLED!=='true'||!Number.isSafeInteger(metadataId)||metadataId<1||metadataId>2147483647)throw Error('HISTORICAL_MARKER_DISABLED');const expected=JSON.stringify(payload);let response:Response;
  try{response=await sheetsFetch(env,':batchUpdate',{method:'POST',body:JSON.stringify({requests:[payload]})},true,async()=>{if(!await HistoricalMarkerRemediation.authorizeTransport(intent,env,expected))throw Error('HISTORICAL_MARKER_FENCE_LOST');},true);}
  catch(error){if(error instanceof SheetsMutationOutcomeUnknownError)throw new SheetsMutationOutcomeUnknownError(new Error('HISTORICAL_MARKER_OUTCOME_UNKNOWN'));if(error instanceof SheetsHttpError)throw new SheetsHttpError(error.status,`Sheets HTTP ${error.status}`,error.retryAfterSeconds);throw Error('HISTORICAL_MARKER_PREFLIGHT_UNAVAILABLE');}
  try{
    const body=await readBoundedJson(response,65536,numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),'Sheets marker response') as {replies?:Array<{createDeveloperMetadata?:{developerMetadata?:{metadataId?:unknown;metadataKey?:unknown;visibility?:unknown;location?:{dimensionRange?:{sheetId?:unknown;dimension?:unknown;startIndex?:unknown;endIndex?:unknown}}}};deleteDeveloperMetadata?:{deletedDeveloperMetadata?:Array<{metadataId?:unknown;metadataKey?:unknown;visibility?:unknown;location?:{dimensionRange?:{sheetId?:unknown;dimension?:unknown;startIndex?:unknown;endIndex?:unknown}}}>}}>};
    if(!Array.isArray(body?.replies)||body.replies.length!==1)throw Error('invalid');
    if(kind==='ATTACH_ABSENT'){
      if(!('createDeveloperMetadata' in payload)||marker.kind!=='ABSENT')throw Error('invalid');const m=body.replies[0]?.createDeveloperMetadata?.developerMetadata,r=m?.location?.dimensionRange,w=payload.createDeveloperMetadata.developerMetadata.location.dimensionRange;
      if(m?.metadataId!==metadataId||m.metadataKey!=='P'||m.visibility!=='DOCUMENT'||r?.sheetId!==w.sheetId||r.dimension!==w.dimension||r.startIndex!==w.startIndex||r.endIndex!==w.endIndex)throw Error('invalid');
    }else{
      if(!('deleteDeveloperMetadata' in payload)||marker.kind!=='PRESENT')throw Error('invalid');const deleted=body.replies[0]?.deleteDeveloperMetadata?.deletedDeveloperMetadata;if(!Array.isArray(deleted)||deleted.length!==1)throw Error('invalid');const m=deleted[0],r=m?.location?.dimensionRange;
      if(m?.metadataId!==metadataId||m.metadataKey!==marker.metadataKey||m.visibility!==marker.visibility||r?.sheetId!==marker.sheetId||r.dimension!==marker.dimension||r.startIndex!==marker.startIndex||r.endIndex!==marker.endIndex)throw Error('invalid');
    }
  }catch{throw new SheetsMutationOutcomeUnknownError(new Error('HISTORICAL_MARKER_RESPONSE_UNKNOWN'));}
}
/** Bounded, typed properties/grid reads used for planning RAW append. */
export async function getRawProductionGridProperties(env:Env):Promise<unknown>{
  assertRawIdentityProductionReader(env);const range=`'${env.SHEET_EXPENSE_RAW.replace(/'/g,"''")}'!A1`;
  const query=new URLSearchParams({ranges:range,fields:'sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))'});
  try{return await identityInspectionGet(env,`?${query.toString()}`);}catch{throw new Error('RAW_IDENTITY_READER_UNAVAILABLE');}
}
export async function getRawProductionCompleteGrid(env:Env,rows:number,columns:number):Promise<unknown>{
  assertRawIdentityProductionReader(env);if(!Number.isSafeInteger(rows)||rows<1||rows>=10000||!Number.isSafeInteger(columns)||columns<17||columns>64||(rows+1)*columns>50000)throw Error('RAW_IDENTITY_READER_INVALID');
  let n=columns,col='';while(n>0){n--;col=String.fromCharCode(65+n%26)+col;n=Math.floor(n/26);}
  const range=`'${env.SHEET_EXPENSE_RAW.replace(/'/g,"''")}'!A1:${col}${rows}`,query=new URLSearchParams({ranges:range,fields:'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),protectedRanges,merges,data(startRow,startColumn,rowData(values(userEnteredValue,note,dataValidation))))'});
  try{return await identityInspectionGet(env,`?${query.toString()}`);}catch{throw new Error('RAW_IDENTITY_READER_UNAVAILABLE');}
}
/** Internal candidate transport. The caller must have reserved the fixed
 * identity and sheet lock and supply a one-shot final fence. No route calls it. */
export async function sendRawProductionAppendBatch(env:Env,source:RawSourceProof,identity:LedgerWriteIdentity,metadataId:number,snapshot:LedgerUatAppendSnapshot,intent:FullRawAppendIntent,token:string):Promise<void>{
  if(env.RAW_APPEND_WRITER_ENABLED!=='true')throw Error('RAW_APPEND_TRANSPORT_DISABLED');
  const requests=buildExpenseRawProductionAppendRequests(env,source,identity,metadataId,snapshot),body=JSON.stringify({requests});
  let response:Response;try{response=await sheetsFetch(env,':batchUpdate',{method:'POST',body},true,async()=>{if(!await FullRawAppendIntent.authorizeTransport(intent,env,source,identity,metadataId,token,JSON.stringify(requests)))throw Error('RAW_APPEND_FENCE_LOST');},true);}
  catch(error){if(error instanceof SheetsMutationOutcomeUnknownError)throw new SheetsMutationOutcomeUnknownError(new Error('RAW_APPEND_OUTCOME_UNKNOWN'));if(error instanceof SheetsHttpError)throw new SheetsHttpError(error.status,`Sheets HTTP ${error.status}`,error.retryAfterSeconds);throw Error('RAW_APPEND_PREFLIGHT_UNAVAILABLE');}
  try{
    const data=await readBoundedJson(response,65536,numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),'Sheets RAW append response') as {replies?:unknown[]};
    if(!Array.isArray(data?.replies)||data.replies.length!==3)throw Error('invalid');
    const reply=data.replies[2] as {createDeveloperMetadata?:{developerMetadata?:{metadataId?:unknown;metadataKey?:unknown;visibility?:unknown;location?:{dimensionRange?:{sheetId?:unknown;dimension?:unknown;startIndex?:unknown;endIndex?:unknown}}}}};
    const m=reply?.createDeveloperMetadata?.developerMetadata,r=m?.location?.dimensionRange;
    if(m?.metadataId!==metadataId||m.metadataKey!=='E'||m.visibility!=='DOCUMENT'||r?.sheetId!==identity.sheetId||r.dimension!=='ROWS'||!Number.isSafeInteger(r.startIndex)||Number(r.startIndex)<1||r.endIndex!==Number(r.startIndex)+1)throw Error('invalid');
  }catch{throw new SheetsMutationOutcomeUnknownError(new Error('RAW_APPEND_RESPONSE_UNAVAILABLE'));}
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
/** Temporary read-only scope: administrators create missing tabs and verify
 * headers manually. It never mutates existing sheets or the owner close page. */
export async function bootstrapSheets(env:Env):Promise<{mode:'READ_ONLY';missingTabs:string[];headersVerified:false;requiresManualSetup:boolean}>{
  if(!await legacyPersonalWriterOpen(env))throw new Error('PERSONAL_LEGACY_CUTOVER_HOLD');
  const names=[env.SHEET_ATTENDANCE_RAW,env.SHEET_DAILY_PAYROLL,env.SHEET_WEEKLY_PAYROLL,env.SHEET_WAGE_HISTORY,env.SHEET_SHIFT_SCHEDULE,env.SHEET_OT_REQUESTS,env.SHEET_EXPENSE_RAW,env.SHEET_PERSONAL_USE_RAW||'V52_PERSONAL_USE_RAW',env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ',env.SHEET_SYSTEM_LOG];
  if(names.some(name=>typeof name!=='string'||!name)||new Set(names).size!==names.length)throw new Error('BOOTSTRAP_DEFINITIONS_INVALID');
  let meta:{sheets?:Array<{properties?:{sheetId?:unknown;title?:unknown}}>};try{meta=await identityInspectionGet(env,'?fields=sheets.properties(sheetId,title)') as typeof meta;}catch{throw new Error('BOOTSTRAP_INSPECTION_UNAVAILABLE');}
  if(!Array.isArray(meta.sheets)||meta.sheets.some(s=>typeof s.properties?.title!=='string'||!Number.isSafeInteger(s.properties.sheetId)||Number(s.properties.sheetId)<0))throw new Error('BOOTSTRAP_METADATA_INVALID');
  const existing=new Set(meta.sheets.map(s=>s.properties!.title as string)),ids=new Set(meta.sheets.map(s=>Number(s.properties!.sheetId)));if(existing.size!==meta.sheets.length||ids.size!==meta.sheets.length)throw new Error('BOOTSTRAP_METADATA_INVALID');
  const missingTabs=names.filter(name=>!existing.has(name));return{mode:'READ_ONLY',missingTabs,headersVerified:false,requiresManualSetup:true};
}
