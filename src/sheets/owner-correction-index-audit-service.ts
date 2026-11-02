import type {Env} from "../types";
import {fetchWithTimeout} from "../shared/async";
import {numberEnv} from "../shared/env";
import {getGoogleAccessToken} from "./google-auth";
import {auditDailyExpenseIndex,type DailyIndexAuditInput,type DailyIndexAuditResult} from "./owner-correction-index-audit";

type AuditMetadata=DailyIndexAuditInput["metadata"];
interface AuditDbSnapshot{expenseIds:string[];mappings:DailyIndexAuditInput["mappings"]}
interface AuditSheetSnapshot{sheetId:number;metadata:AuditMetadata}
interface AuditPorts{db:(env:Env)=>Promise<AuditDbSnapshot|null>;sheet:(env:Env)=>Promise<AuditSheetSnapshot|null>}
export type IndexAuditServiceResult={kind:"REVIEW"}|{kind:"AUDITED";audit:Extract<DailyIndexAuditResult,{valid:true}>};

/** All expenses are deliberately included; pending/cancelled entries may be missing normally. */
export async function readDailyIndexDatabaseSnapshot(env:Env):Promise<AuditDbSnapshot|null>{
  const data=await env.DB.batch<Record<string,unknown>>([
    env.DB.prepare("SELECT COUNT(*) AS count FROM expense_events"),
    env.DB.prepare("SELECT expense_id FROM expense_events ORDER BY expense_id"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM sheet_row_index WHERE sheet_name=?").bind(env.SHEET_EXPENSE_DAILY),
    env.DB.prepare("SELECT entity_key,row_number FROM sheet_row_index WHERE sheet_name=? ORDER BY entity_key").bind(env.SHEET_EXPENSE_DAILY)
  ]);
  if(!Array.isArray(data)||data.length!==4||data.some(result=>{
    if(!result||result.success!==true||!Array.isArray(result.results))return true;
    const response=result as unknown as Record<string,unknown>,meta=response.meta;
    return [response,meta].some(part=>object(part)&&["nextPageToken","next_page_token","pageToken","cursor","hasMore","has_more","truncated","partial"].some(key=>key in part));
  }))return null;
  const counts=[data[0]!.results!,data[2]!.results!],expenses=data[1]!.results!,mappings=data[3]!.results!;
  if(counts.some(rows=>rows.length!==1||!Number.isSafeInteger(rows[0]?.count)||Number(rows[0]!.count)<0)||counts[0]![0]!.count!==expenses.length||counts[1]![0]!.count!==mappings.length)return null;
  if(expenses.some(row=>typeof row.expense_id!=="string")||mappings.some(row=>typeof row.entity_key!=="string"||!Number.isSafeInteger(row.row_number)))return null;
  return {expenseIds:expenses.map(row=>row.expense_id as string),mappings:mappings.map(row=>({entityKey:row.entity_key as string,rowNumber:row.row_number as number}))};
}

async function readJson(env:Env,path:string,method:"GET"|"POST",body?:unknown):Promise<unknown>{
  const token=await getGoogleAccessToken(env),headers=new Headers({Authorization:`Bearer ${token}`});
  if(body!==undefined)headers.set("content-type","application/json");
  const res=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SPREADSHEET_ID)}${path}`,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})},numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),"Google Sheets index audit");
  if(!res.ok)throw new Error(`INDEX_AUDIT_SHEETS_HTTP_${res.status}`);return res.json();
}
const object=(value:unknown):value is Record<string,unknown>=>typeof value==="object"&&value!==null&&!Array.isArray(value);

/** Strictly reject unexpected continuation/partial fields or malformed locations. */
export function parseAuditMetadataResponse(value:unknown):AuditMetadata|null{
  if(!object(value)||Object.keys(value).some(key=>key!=="matchedDeveloperMetadata")||!Array.isArray(value.matchedDeveloperMetadata))return null;
  const out:AuditMetadata=[];
  for(const match of value.matchedDeveloperMetadata){
    if(!object(match)||!object(match.developerMetadata))return null;const m=match.developerMetadata;
    if(!object(m.location)||!object(m.location.dimensionRange))return null;const d=m.location.dimensionRange;
    if(!Number.isSafeInteger(m.metadataId)||Number(m.metadataId)<1||m.metadataKey!=="malipang_expense_daily"||typeof m.metadataValue!=="string"||!m.metadataValue||m.visibility!=="DOCUMENT"||!Number.isSafeInteger(d.sheetId)||Number(d.sheetId)<0||d.dimension!=="ROWS"||!Number.isSafeInteger(d.startIndex)||Number(d.startIndex)<0||d.endIndex!==Number(d.startIndex)+1)return null;
    out.push({metadataId:m.metadataId as number,metadataKey:m.metadataKey,metadataValue:m.metadataValue,sheetId:d.sheetId as number,rowIndex:d.startIndex as number});
  }
  return out.sort((a,b)=>a.metadataId-b.metadataId||a.sheetId-b.sheetId||a.rowIndex-b.rowIndex||a.metadataValue.localeCompare(b.metadataValue));
}

async function readSheet(env:Env):Promise<AuditSheetSnapshot|null>{
  const [identity,raw]=await Promise.all([
    readJson(env,`?fields=${encodeURIComponent("spreadsheetId,sheets(properties(sheetId,title))")}`,"GET"),
    readJson(env,"/developerMetadata:search","POST",{dataFilters:[{developerMetadataLookup:{metadataKey:"malipang_expense_daily",visibility:"DOCUMENT"}}]})
  ]);
  if(!object(identity)||identity.spreadsheetId!==env.GOOGLE_SPREADSHEET_ID||!Array.isArray(identity.sheets))return null;
  const matches=identity.sheets.filter(item=>object(item)&&object(item.properties)&&item.properties.title===env.SHEET_EXPENSE_DAILY);
  if(matches.length!==1||!object(matches[0])||!object(matches[0].properties)||!Number.isSafeInteger(matches[0].properties.sheetId)||Number(matches[0].properties.sheetId)<0)return null;
  const metadata=parseAuditMetadataResponse(raw);return metadata?{sheetId:matches[0].properties.sheetId as number,metadata}:null;
}
const defaults:AuditPorts={db:readDailyIndexDatabaseSnapshot,sheet:readSheet};

/**
 * Two independent snapshots are compared; no cross-service transaction exists.
 * This is diagnostic evidence only, never a write authorization or lock.
 */
export async function readDailyExpenseIndexAudit(env:Env,ports:AuditPorts=defaults):Promise<IndexAuditServiceResult>{
  if(!env.SHEET_EXPENSE_DAILY||!env.GOOGLE_SPREADSHEET_ID)return {kind:"REVIEW"};
  try{
    const read=async()=>{const [db,sheet]=await Promise.all([ports.db(env),ports.sheet(env)]);return db&&sheet?{db,sheet}:null;};
    const first=await read(),second=await read();if(!first||!second||JSON.stringify(first)!==JSON.stringify(second))return {kind:"REVIEW"};
    const audit=auditDailyExpenseIndex({sheetName:env.SHEET_EXPENSE_DAILY,sheetId:first.sheet.sheetId,expenseIds:first.db.expenseIds,mappings:first.db.mappings,metadata:first.sheet.metadata,coverage:{expenses:"ALL_RELEVANT_EXPENSE_IDS",mappings:"ALL_SHEET_MAPPINGS",metadata:"ALL_DOCUMENT_DAILY_METADATA"}});
    return audit.valid?{kind:"AUDITED",audit}:{kind:"REVIEW"};
  }catch{return {kind:"REVIEW"};}
}
