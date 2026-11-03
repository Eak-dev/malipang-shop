import type {Env} from '../types';
import {getGoogleAccessToken} from './google-auth';
import {fetchWithTimeout,readBoundedJson} from '../shared/async';
import {numberEnv} from '../shared/env';

// Read-only adaptation of #229 identity checks. Positions below are ephemeral
// observations only; no row is stored and no provider mutation is possible.
const inputs=[0,1,2,3,4,5,6,7,10,11,12,13,14,15,16,19,21,22,23,24] as const;
const amounts=[5,6,7,10,11,12,13,14,15,16] as const;
export type DailyRecoveryObservation='MATCHES_RECORDED_INPUTS'|'DIFFERS'|'UNVERIFIED';
export interface DailyRecoveryIdentity {expenseId:string;metadataId:number;baseline:unknown[]}
const blank=(v:unknown)=>v===undefined||v===null||v==='';
const same=(a:unknown,b:unknown)=>blank(a)&&blank(b)||a===b;
async function read(env:Env,path:string,init:RequestInit={}):Promise<unknown>{
 const auth=await getGoogleAccessToken(env),timeout=numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),headers=new Headers(init.headers);headers.set('authorization',`Bearer ${auth}`);if(init.body)headers.set('content-type','application/json');
 const response=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SPREADSHEET_ID}${path}`,{...init,headers},timeout,'Daily recovery read');if(!response.ok){if(response.body)void response.body.cancel().catch(()=>{});throw Error('DAILY_RECOVERY_PROVIDER_UNAVAILABLE');}return readBoundedJson(response,4*1024*1024,timeout,'Daily recovery read');
}
async function grid(env:Env):Promise<{sheetId:number;rowCount:number}>{
 const o=await read(env,'?fields=spreadsheetId,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))') as {spreadsheetId?:unknown;sheets?:Array<{properties?:{sheetId?:number;title?:string;gridProperties?:{rowCount?:number;columnCount?:number}}}>};const sheets=o?.sheets?.filter(x=>x.properties?.title===env.SHEET_EXPENSE_DAILY);const p=sheets?.[0]?.properties,g=p?.gridProperties;
 if(o?.spreadsheetId!==env.GOOGLE_SPREADSHEET_ID||sheets?.length!==1||!Number.isSafeInteger(p?.sheetId)||Number(p?.sheetId)<0||!Number.isSafeInteger(g?.rowCount)||Number(g?.rowCount)<1||Number(g?.rowCount)>5000||!Number.isSafeInteger(g?.columnCount)||Number(g?.columnCount)<25)throw Error('DAILY_RECOVERY_GRID_UNVERIFIED');return{sheetId:Number(p!.sheetId),rowCount:Number(g!.rowCount)};
}
async function metadata(env:Env,id:number):Promise<{sheetId:number;row:number}>{
 const o=await read(env,'/developerMetadata:search',{method:'POST',body:JSON.stringify({dataFilters:[{developerMetadataLookup:{metadataId:id}}]})}) as {matchedDeveloperMetadata?:Array<{developerMetadata?:{metadataId?:number;metadataKey?:string;visibility?:string;location?:{dimensionRange?:{sheetId?:number;dimension?:string;startIndex?:number;endIndex?:number}}}}>};const matches=o?.matchedDeveloperMetadata;if(!Array.isArray(matches)||matches.length!==1)throw Error('DAILY_RECOVERY_METADATA_UNVERIFIED');const m=matches[0]?.developerMetadata,d=m?.location?.dimensionRange;
 if(m?.metadataId!==id||m.metadataKey!=='e'||m.visibility!=='DOCUMENT'||d?.dimension!=='ROWS'||!Number.isSafeInteger(d.sheetId)||Number(d.sheetId)<0||!Number.isSafeInteger(d.startIndex)||Number(d.startIndex)<0||d.endIndex!==Number(d.startIndex)+1)throw Error('DAILY_RECOVERY_METADATA_UNVERIFIED');return{sheetId:Number(d.sheetId),row:Number(d.startIndex)};
}
async function rows(env:Env,info:{sheetId:number;rowCount:number}):Promise<unknown[][]>{
 const quoted=env.SHEET_EXPENSE_DAILY.replace(/'/g,"''"),range=`'${quoted}'!A1:Y${info.rowCount}`,q=new URLSearchParams({ranges:range,valueRenderOption:'FORMULA',dateTimeRenderOption:'SERIAL_NUMBER'});const o=await read(env,`/values:batchGet?${q}`) as {valueRanges?:Array<{range?:unknown;values?:unknown[][]}>};const data=o?.valueRanges;if(!Array.isArray(data)||data.length!==1||![range,`${env.SHEET_EXPENSE_DAILY}!A1:Y${info.rowCount}`].includes(String(data[0]?.range))||!Array.isArray(data[0]?.values)||data[0]!.values!.length>info.rowCount||data[0]!.values!.some(row=>!Array.isArray(row)||row.length>25))throw Error('DAILY_RECOVERY_SNAPSHOT_UNVERIFIED');return data[0]!.values!;
}
async function digest(value:unknown):Promise<string>{const bytes=new TextEncoder().encode(JSON.stringify(value));if(bytes.byteLength>65536)throw Error('DAILY_RECOVERY_EVIDENCE_TOO_LARGE');return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');}
/** MATCHES_RECORDED_INPUTS is only a comparison; the caller must independently
 * prove production enrollment, writer drainage and the desired postimage. */
export async function inspectDailyRecoveryIdentity(env:Env,identity:DailyRecoveryIdentity|null):Promise<{observation:DailyRecoveryObservation;digest:string|null}>{
 if(env.RUNTIME_MODE!=='production'||env.DAILY_RECOVERY_ADMIN_ENABLED!=='true'||!env.GOOGLE_SPREADSHEET_ID||!env.SHEET_EXPENSE_DAILY)throw Error('DAILY_RECOVERY_DISABLED');
 if(!identity)return{observation:'UNVERIFIED',digest:null};const {expenseId,metadataId,baseline}=identity,key=`MALIPANG_EXPENSE:${expenseId}`;
 if(!/^exp_[A-Za-z0-9_-]{1,128}$/.test(expenseId)||!Number.isSafeInteger(metadataId)||metadataId<1||metadataId>2147483647||!Array.isArray(baseline)||baseline.length!==25||baseline[23]!==key||baseline.some(v=>v!==null&&v!==undefined&&typeof v!=='string'&&!(typeof v==='number'&&Number.isFinite(v))))return{observation:'UNVERIFIED',digest:null};
 try{const a=await grid(env),m=await metadata(env,metadataId);if(m.sheetId!==a.sheetId||m.row>=a.rowCount)throw Error('identity');const data=await rows(env,a),found:number[]=[];for(let n=0;n<data.length;n++)if(data[n]?.[23]===key)found.push(n);if(found.length!==1||found[0]!==m.row)throw Error('identity');const actual=data[m.row]!,am=amounts.map(i=>actual[i]).filter(v=>!blank(v));if(am.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0)||am.filter(v=>Number(v)>0).length!==1||inputs.some(i=>typeof actual[i]==='string'&&String(actual[i]).startsWith('=')))throw Error('input');const m2=await metadata(env,metadataId),b=await grid(env);if(m2.sheetId!==m.sheetId||m2.row!==m.row||a.sheetId!==b.sheetId||a.rowCount!==b.rowCount)throw Error('changed');const matched=inputs.every(i=>same(actual[i],baseline[i]));return{observation:matched?'MATCHES_RECORDED_INPUTS':'DIFFERS',digest:await digest([expenseId,metadataId,inputs.map(i=>baseline[i]??null),inputs.map(i=>actual[i]??null)])};}catch{return{observation:'UNVERIFIED',digest:null};}
}
