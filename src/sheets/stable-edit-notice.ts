import type {Env} from '../types';
import {getGoogleAccessToken} from './google-auth';
import {batchWriteValues,parseRetryAfterSeconds,retryIdempotentRead,SheetsHttpError} from './client';
import {fetchWithTimeout} from '../shared/async';
import {numberEnv} from '../shared/env';

const names=['MLP_DAILY_STATUS','MLP_DAILY_STATUS_TIME'] as const;
type Range={namedRangeId:string;sheetId:number;row:number;column:number};
type Cell={value:unknown;note:unknown;validation:unknown;format:unknown;textRuns:unknown;chips:unknown};
type Snapshot={ranges:[Range,Range];cells:[Cell,Cell]};
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const encode=(v:unknown)=>JSON.stringify(v);
const scope=(e:Env)=>encode([e.GOOGLE_SPREADSHEET_ID,e.SHEET_EXPENSE_DAILY,e.GOOGLE_SERVICE_ACCOUNT_EMAIL,e.GOOGLE_PRIVATE_KEY_BASE64,e.EXTERNAL_API_TIMEOUT_MS,e.STABLE_PHASE1_ENABLED]);
function overlaps(a:Range,r:Record<string,unknown>):boolean{
 const sr=r.startRowIndex??0,sc=r.startColumnIndex??0,er=r.endRowIndex??Number.MAX_SAFE_INTEGER,ec=r.endColumnIndex??Number.MAX_SAFE_INTEGER;
 if(!integer(sr)||!integer(sc)||!integer(er)||!integer(ec)||sr>=er||sc>=ec)throw Error('STABLE_NOTICE_STRUCTURE');
 return a.row>=sr&&a.row<er&&a.column>=sc&&a.column<ec;
}
async function get(env:Env,path:string):Promise<unknown>{
 const token=await getGoogleAccessToken(env),res=await retryIdempotentRead(()=>fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SPREADSHEET_ID)}${path}`,{headers:{authorization:`Bearer ${token}`}},numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),'Stable notice read'));
 // Keep the HTTP status for diagnostics; the message stays a stable code.
 if(!res.ok)throw new SheetsHttpError(res.status,'STABLE_NOTICE_READ',parseRetryAfterSeconds(res.headers.get('Retry-After')));return res.json();
}
type Structure={spreadsheetId?:unknown;namedRanges?:Array<{namedRangeId?:unknown;name?:unknown;range?:Record<string,unknown>}>;sheets?:Array<{properties?:{sheetId?:unknown;title?:unknown;gridProperties?:{rowCount?:unknown;columnCount?:unknown;frozenRowCount?:unknown}};merges?:Array<Record<string,unknown>>;protectedRanges?:Array<{range?:Record<string,unknown>;unprotectedRanges?:unknown}>;data?:Array<{startRow?:unknown;startColumn?:unknown;rowData?:Array<{values?:Array<Record<string,unknown>>}>}>}>};
const structureFields='spreadsheetId,namedRanges(namedRangeId,name,range),sheets(properties(sheetId,title,gridProperties(rowCount,columnCount,frozenRowCount)),merges,protectedRanges)';
function parseStructure(env:Env,x:Structure):[Range,Range]{
 if(x.spreadsheetId!==env.GOOGLE_SPREADSHEET_ID||!Array.isArray(x.sheets)||!Array.isArray(x.namedRanges))throw Error('STABLE_NOTICE_STRUCTURE');
 const sheets=x.sheets.filter(s=>s.properties?.title===env.SHEET_EXPENSE_DAILY);if(sheets.length!==1||x.sheets.some(s=>names.includes(s.properties?.title as typeof names[number])))throw Error('STABLE_NOTICE_STRUCTURE');
 const sheet=sheets[0]!,p=sheet.properties!,g=p.gridProperties;if(!integer(p.sheetId)||!g||!integer(g.rowCount)||!integer(g.columnCount)||!integer(g.frozenRowCount))throw Error('STABLE_NOTICE_STRUCTURE');
 const ranges=names.map(name=>{const matches=x.namedRanges!.filter(n=>n.name===name);if(matches.length!==1)throw Error('STABLE_NOTICE_STRUCTURE');const n=matches[0]!,r=n.range,row=r?.startRowIndex??0,column=r?.startColumnIndex??0;if(typeof n.namedRangeId!=='string'||!r||r.sheetId!==p.sheetId||!integer(row)||!integer(column)||r.endRowIndex!==row+1||r.endColumnIndex!==column+1||row>=Number(g.frozenRowCount)||row>=Number(g.rowCount)||column>=Number(g.columnCount))throw Error('STABLE_NOTICE_STRUCTURE');return{namedRangeId:n.namedRangeId,sheetId:p.sheetId as number,row,column};}) as [Range,Range];
 if(ranges[0].namedRangeId===ranges[1].namedRangeId||ranges.some((r,i)=>x.namedRanges!.filter(n=>n.namedRangeId===r.namedRangeId||typeof n.name==='string'&&n.name.toLowerCase()===names[i]!.toLowerCase()).length!==1)||ranges[0].row!==ranges[1].row||ranges[0].column+1!==ranges[1].column)throw Error('STABLE_NOTICE_STRUCTURE');
 for(const a of ranges){for(const r of sheet.merges||[])if(r.sheetId!==undefined&&r.sheetId!==p.sheetId||overlaps(a,r))throw Error('STABLE_NOTICE_STRUCTURE');for(const pRange of sheet.protectedRanges||[])if(!pRange.range||pRange.unprotectedRanges!==undefined||pRange.range.sheetId!==undefined&&pRange.range.sheetId!==p.sheetId||overlaps(a,pRange.range))throw Error('STABLE_NOTICE_STRUCTURE');}
 return ranges;
}
async function structure(env:Env):Promise<[Range,Range]>{
 const query=new URLSearchParams({fields:structureFields});
 return parseStructure(env,await get(env,`?${query}`) as Structure);
}
async function snapshot(env:Env):Promise<Snapshot>{
 const ranges=await structure(env),query=new URLSearchParams({fields:'spreadsheetId,namedRanges(namedRangeId,name,range),sheets(properties(sheetId,title,gridProperties(rowCount,columnCount,frozenRowCount)),merges,protectedRanges,data(startRow,startColumn,rowData(values(userEnteredValue,userEnteredFormat,note,dataValidation,textFormatRuns,chipRuns))))'});for(const name of names)query.append('ranges',name);
 const x=await get(env,`?${query}`) as Structure;
 const sheets=(x.sheets||[]).filter(s=>s.properties?.sheetId===ranges[0].sheetId&&s.properties.title===env.SHEET_EXPENSE_DAILY);if(x.spreadsheetId!==env.GOOGLE_SPREADSHEET_ID||sheets.length!==1||!Array.isArray(sheets[0]!.data))throw Error('STABLE_NOTICE_READ');
 const cells=ranges.map(range=>{const found=sheets[0]!.data!.filter(d=>(d.startRow??0)===range.row&&(d.startColumn??0)===range.column);if(found.length!==1||found[0]!.rowData&&found[0]!.rowData!.length>1||found[0]!.rowData?.[0]?.values&&found[0]!.rowData![0]!.values!.length>1)throw Error('STABLE_NOTICE_READ');const c=found[0]!.rowData?.[0]?.values?.[0]??{};return{value:c.userEnteredValue??null,note:c.note??null,validation:c.dataValidation??null,format:c.userEnteredFormat??null,textRuns:c.textFormatRuns??null,chips:c.chipRuns??null};}) as [Cell,Cell];
 if(encode(ranges)!==encode(parseStructure(env,x))||cells.some(c=>c.note!==null||c.validation!==null||c.textRuns!==null&&encode(c.textRuns)!=='[]'||c.chips!==null&&encode(c.chips)!=='[]'))throw Error('STABLE_NOTICE_CHANGED');return{ranges,cells};
}
function text(cell:Cell):string|null{if(cell.value===null)return null;const value=cell.value as {stringValue?:unknown};if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||typeof value.stringValue!=='string')throw Error('STABLE_NOTICE_CELL');return value.stringValue;}
function stamp():string{const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date()),value=(type:string)=>parts.find(p=>p.type===type)?.value;return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`;}
const unchanged=(a:Snapshot,b:Snapshot)=>encode(a.ranges)===encode(b.ranges)&&a.cells.every((c,i)=>encode(c.format)===encode(b.cells[i]!.format)&&c.note===b.cells[i]!.note&&c.validation===b.cells[i]!.validation&&encode(c.textRuns)===encode(b.cells[i]!.textRuns)&&encode(c.chips)===encode(b.cells[i]!.chips));
const identity=(x:Snapshot)=>encode([x.ranges[0].sheetId,x.ranges[0].namedRangeId,x.ranges[1].namedRangeId]);
async function claim(env:Env,token:string):Promise<{notice_stamp:string|null;notice_identity:string|null}|null>{return env.DB.prepare("SELECT notice_stamp,notice_identity FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind(env.GOOGLE_SPREADSHEET_ID,token).first<{notice_stamp:string|null;notice_identity:string|null}>();}

/** Read-only provider readiness; never grants permission to write. */
export async function stableNoticeReady(env:Env):Promise<boolean>{try{const db=env.DB,initial=scope(env),x=await snapshot(env),status=text(x.cells[0]),time=text(x.cells[1]);return env.DB===db&&scope(env)===initial&&(status===null&&time===null||status==='พร้อมแก้ไข'||status==='พร้อมแก้ไข • มีรายการรอตรวจ');}catch{return false;}}
export async function stableNoticePaused(env:Env,stampValue:string,identityValue:string):Promise<boolean>{try{const db=env.DB,initial=scope(env),x=await snapshot(env);return env.DB===db&&scope(env)===initial&&identity(x)===identityValue&&text(x.cells[0])==='พักแก้ไฟล์'&&text(x.cells[1])===stampValue;}catch{return false;}}
export async function beginStableNotice(env:Env,token:string,wait:(ms:number)=>Promise<void>=ms=>new Promise(resolve=>setTimeout(resolve,ms))):Promise<void>{
 // The pre-image is read inside the dispatch fence, after authentication, so
 // a single read both proves the ready state and guards the write.
 const db=env.DB,initial=scope(env),stable=()=>env.DB===db&&scope(env)===initial,seen:{before?:Snapshot}={},time=stamp();
 await batchWriteValues(env,[{range:names[0],values:[['พักแก้ไฟล์']]},{range:names[1],values:[[time]]}],async()=>{const latest=await snapshot(env),prior=text(latest.cells[0]),priorTime=text(latest.cells[1]);if(!stable()||!await claim(env,token)||!stable()||!(prior===null||prior==='พร้อมแก้ไข'||prior==='พร้อมแก้ไข • มีรายการรอตรวจ')||prior===null&&priorTime!==null)throw Error('STABLE_NOTICE_PREIMAGE');seen.before=latest;});
 const before=seen.before,after=await snapshot(env);if(!before||!stable()||!unchanged(before,after)||text(after.cells[0])!=='พักแก้ไฟล์'||text(after.cells[1])!==time)throw Error('STABLE_NOTICE_UNVERIFIED');
 const saved=await env.DB.prepare("UPDATE stable_workbook_claims SET notice_stamp=?,notice_identity=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='HELD' AND notice_stamp IS NULL AND notice_identity IS NULL").bind(time,identity(after),env.GOOGLE_SPREADSHEET_ID,token).run();if(saved.success!==true||Number(saved.meta?.changes)!==1)throw Error('STABLE_NOTICE_UNCERTAIN');
 await wait(15000);
 if(!stable()||!(await claim(env,token))||!await stableNoticePaused(env,time,identity(after))||!stable())throw Error('STABLE_NOTICE_UNVERIFIED');
}
export async function endStableNotice(env:Env,token:string):Promise<void>{
 const db=env.DB,initial=scope(env),stable=()=>env.DB===db&&scope(env)===initial,current=await claim(env,token);if(!current?.notice_stamp||!current.notice_identity||!stable())throw Error('STABLE_NOTICE_UNVERIFIED');
 const reviews=await db.prepare("SELECT count(*) AS n FROM sync_jobs WHERE status='REVIEW'").first<{n:number}>();if(!reviews||!Number.isSafeInteger(reviews.n)||reviews.n<0||!stable())throw Error('STABLE_NOTICE_UNVERIFIED');
 // As in beginStableNotice, the paused pre-image is read inside the fence.
 const ready=reviews.n?'พร้อมแก้ไข • มีรายการรอตรวจ':'พร้อมแก้ไข',time=stamp(),seen:{before?:Snapshot}={};await batchWriteValues(env,[{range:names[0],values:[[ready]]},{range:names[1],values:[[time]]}],async()=>{const latest=await snapshot(env),again=await claim(env,token);if(!stable()||!again||again.notice_stamp!==current.notice_stamp||again.notice_identity!==current.notice_identity||identity(latest)!==current.notice_identity||text(latest.cells[0])!=='พักแก้ไฟล์'||text(latest.cells[1])!==current.notice_stamp)throw Error('STABLE_NOTICE_CHANGED');seen.before=latest;});
 const before=seen.before,after=await snapshot(env);if(!before||!stable()||!unchanged(before,after)||text(after.cells[0])!==ready||text(after.cells[1])!==time)throw Error('STABLE_NOTICE_UNVERIFIED');
}
