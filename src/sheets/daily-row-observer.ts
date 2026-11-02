import type { Env } from '../types';
import { sheetsFetch, batchGetSheetValues } from './client';
import { findMonthBlocks, resolvePayment } from './daily-expense';
import { sha256Hex } from '../shared/ids';

/** Read-only evidence for the still-unwired verified daily posting path.
 * It is NOT an authorization to write, a Sheets CAS, or a substitute for the
 * sheet-wide writer fence and a separately enforced no-human-edit window. */
export interface Marker { metadataId:number; metadataKey:string; metadataValue:string; sheetId:number; rowIndex:number }
interface Range {sheetId?:number;startRowIndex?:number;endRowIndex?:number;startColumnIndex?:number;endColumnIndex?:number}
interface Protection {range?:Range;warningOnly?:boolean;requestingUserCanEdit?:boolean;unprotectedRanges?:unknown[];editors?:{users?:string[];groups?:string[];domainUsersCanEdit?:boolean}}
interface ExtendedValue {numberValue?:number;stringValue?:string;boolValue?:boolean;formulaValue?:string;errorValue?:unknown}
interface Cell {userEnteredValue?:ExtendedValue;effectiveValue?:ExtendedValue}
interface SheetProperties {sheetId?:number;title?:string;gridProperties?:{rowCount?:number;columnCount?:number}}
interface Sheet {properties?:SheetProperties;protectedRanges?:Protection[];data?:Array<{startRow?:number;startColumn?:number;rowData?:Array<{values?:Cell[]}>}>}
interface Spreadsheet {sheets?:Sheet[]}
export interface DailyEvidence {sheet:Sheet; target:Sheet; rows:unknown[][]; headers:unknown[][]; markers:Marker[]; markerById:Marker|null}
export interface DailyExpectation {sheetTitle:string;sheetId:number;rowNumber:number;metadataId:number;expenseId:string;postingDate:string;paymentKey:string;serviceAccount:string;expectedHeaderDigest:string;expectedFormulas:Readonly<Record<number,string>>}
/** Expected literals come from an independently authenticated source and must
 * cover every non-formula cell in A:Y, including blank cells. A candidate
 * Sheet row, caller input, or a row number alone is not a trusted manifest. */
export interface ExistingDailyExpectation extends DailyExpectation {expectedLiterals:Readonly<Record<number,string|number|boolean>>}
export interface DailyRowObservation {marker:Marker;headerDigest:string;sheetYear:number;monthBlock:{month:number;headerRow:number;totalRow:number};values:unknown[];formulas:unknown[];observedColumnCount:25;completeIdentityAndProtection:true;formulasVerified:true}
const quote=(s:string)=>`'${s.replace(/'/g,"''")}'`;
const isBlank=(x:unknown)=>x===undefined||x===null||x==='';
const INPUT_COLS=[1,2,3,5,6,7,10,11,12,13,14,15,16,21,22];
const FORMULA_COLS=[8,9,17,18,20];
const LITERAL_COLS=Array.from({length:25},(_,i)=>i).filter(i=>!FORMULA_COLS.includes(i));
const protectedInputs=(p:Protection[],id:number,row:number,account:string):boolean=>{
  const a=account.trim().toLowerCase();if(!a||!Array.isArray(p)||p.some(x=>{
   const r=x.range;if(!r||r.sheetId!==id)return true;
   const sr=r.startRowIndex??0,sc=r.startColumnIndex??0,er=r.endRowIndex,ec=r.endColumnIndex;
   return !Number.isSafeInteger(sr)||sr<0||!Number.isSafeInteger(sc)||sc<0||(er!==undefined&&(!Number.isSafeInteger(er)||er<=sr))||(ec!==undefined&&(!Number.isSafeInteger(ec)||ec<=sc));
  }))return false;
  return INPUT_COLS.every(column=>{
   const covers=p.filter(x=>{const r=x.range!;return (r.startRowIndex??0)<=row&&(r.endRowIndex??Infinity)>row&&(r.startColumnIndex??0)<=column&&(r.endColumnIndex??Infinity)>column;});
   return covers.length>0&&covers.every(x=>{const u=x.editors?.users;return x.warningOnly!==true&&x.requestingUserCanEdit===true&&!(x.unprotectedRanges?.length)&&x.editors?.domainUsersCanEdit!==true&&!(x.editors?.groups?.length)&&Array.isArray(u)&&u.length>0&&u.every(v=>typeof v==='string'&&v.trim().toLowerCase()===a)});
  });
};
function primitive(v:ExtendedValue|undefined):unknown{
 if(!v)return '';if(typeof v!=='object'||Array.isArray(v)||v.errorValue!==undefined||Object.keys(v).some(k=>!['numberValue','stringValue','boolValue','formulaValue','errorValue'].includes(k)))throw new Error('SHEET_CELL_ERROR');
 const keys=['numberValue','stringValue','boolValue'] as const;const present=keys.filter(k=>v[k]!==undefined);if(present.length>1||v.formulaValue!==undefined)throw new Error('SHEET_VALUE_INVALID');
 if((v.numberValue!==undefined&&(typeof v.numberValue!=='number'||!Number.isFinite(v.numberValue)))||(v.stringValue!==undefined&&typeof v.stringValue!=='string')||(v.boolValue!==undefined&&typeof v.boolValue!=='boolean'))throw new Error('SHEET_VALUE_INVALID');
 return present.length?v[present[0]!]!:'';
}
/** Verify ONE complete read. Caller must hold the exclusive sheet write fence,
 * observe twice, and enforce a maintenance window. Formula manifest is not
 * supplied by the user or learned from the candidate row. */
async function verifyDailyEvidenceMode(e:DailyEvidence,w:DailyExpectation,literals?:ExistingDailyExpectation['expectedLiterals']):Promise<DailyRowObservation|null>{try{
 const p=e.sheet.properties,t=e.target.properties,g=p?.gridProperties;
 if(!w.sheetTitle||!w.expenseId||!Number.isSafeInteger(w.sheetId)||w.sheetId<0||!Number.isSafeInteger(w.rowNumber)||w.rowNumber<6||!Number.isSafeInteger(w.metadataId)||w.metadataId<1||p?.sheetId!==w.sheetId||t?.sheetId!==w.sheetId||p.title!==w.sheetTitle||t.title!==w.sheetTitle||!Number.isSafeInteger(g?.rowCount)||!Number.isSafeInteger(g?.columnCount)||Number(g!.columnCount)<25||w.rowNumber>Number(g!.rowCount)||e.rows.length>Number(g!.rowCount)||!protectedInputs(e.sheet.protectedRanges||[],w.sheetId,w.rowNumber-1,w.serviceAccount))return null;
 const all=e.markers, found=all.filter(m=>m.metadataKey==='malipang_expense_daily'&&m.metadataValue===w.expenseId);
 if(found.length!==1||!e.markerById||JSON.stringify(found[0])!==JSON.stringify(e.markerById))return null;
 const marker=found[0]!;if(marker.metadataId!==w.metadataId||marker.sheetId!==w.sheetId||marker.rowIndex!==w.rowNumber-1||all.filter(m=>m.metadataId===w.metadataId).length!==1||all.filter(m=>m.sheetId===w.sheetId&&m.rowIndex===marker.rowIndex).length!==1)return null;
 const parts=/^(\d{4})-(\d{2})-(\d{2})$/.exec(w.postingDate);if(!parts)return null;
 const year=Number(parts[1]),month=Number(parts[2]),day=Number(parts[3]),date=new Date(Date.UTC(year,month-1,day));if(date.getUTCFullYear()!==year||date.getUTCMonth()+1!==month||date.getUTCDate()!==day)return null;
 if(e.headers.length!==3||e.headers.some(r=>!Array.isArray(r)))return null;
 const headerDigest=await sha256Hex(new TextEncoder().encode(JSON.stringify(e.headers)).buffer as ArrayBuffer);if(headerDigest!==w.expectedHeaderDigest)return null;
 const payment=resolvePayment(e.headers,w.paymentKey,year,month,day),sheetYear=Number(e.rows[4]?.[0]);if(sheetYear!==payment.postingYear)return null;
 const norm=(v:unknown)=>String(v??'').trim().toLowerCase().replace(/[\s_\-/]+/g,'');
 const monthHeaders=e.rows.filter(row=>Number(row?.[1])===payment.postingMonth&&norm(row?.[3])===norm('รายรับทั้งหมดในบัญชี'));
 const monthTotals=e.rows.filter(row=>Number(row?.[1])===payment.postingMonth&&norm(row?.[0])===norm('รวม'));
 const blocks=findMonthBlocks(e.rows),matching=blocks.filter(b=>b.month===payment.postingMonth);if(monthHeaders.length!==1||monthTotals.length!==1||matching.length!==1||blocks.some(b=>b.headerRow>=b.totalRow)||!matching[0]||w.rowNumber<=matching[0].headerRow||w.rowNumber>=matching[0].totalRow)return null;
 const data=e.target.data;if(!Array.isArray(data)||data.length!==1)return null;const grid=data[0]!;
 if((grid.startRow??0)!==w.rowNumber-1||(grid.startColumn??0)!==0||!Array.isArray(grid.rowData)||grid.rowData.length!==1||!Array.isArray(grid.rowData[0]?.values)||grid.rowData[0]!.values!.length>25)return null;
 if(Object.keys(w.expectedFormulas).length!==FORMULA_COLS.length||FORMULA_COLS.some(i=>typeof w.expectedFormulas[i]!=='string'||!w.expectedFormulas[i]!.startsWith('=')))return null;
 if(literals!==undefined&&(Object.keys(literals).length!==LITERAL_COLS.length||LITERAL_COLS.some(i=>!Object.hasOwn(literals,i)||!['string','number','boolean'].includes(typeof literals[i])||(typeof literals[i]==='number'&&!Number.isFinite(literals[i])))))return null;
 const values:unknown[]=[],formulas:unknown[]=[];for(let i=0;i<25;i++){
  const cell=grid.rowData[0]!.values![i]||{},entered=cell.userEnteredValue;const formula=entered?.formulaValue;
  if(FORMULA_COLS.includes(i)){if(formula!==w.expectedFormulas[i]||!entered||Object.keys(entered).length!==1)return null;}else if(formula!==undefined)return null;
  else if(literals===undefined){if(!isBlank(primitive(entered))||!isBlank(primitive(cell.effectiveValue)))return null;}
  else if(primitive(entered)!==literals[i]||primitive(cell.effectiveValue)!==literals[i])return null;
  values.push(primitive(cell.effectiveValue));formulas.push(formula??'');
 }
 return {marker,headerDigest,sheetYear,monthBlock:matching[0],values,formulas,observedColumnCount:25,completeIdentityAndProtection:true,formulasVerified:true};
 }catch{return null;}}
export function verifyDailyEvidence(e:DailyEvidence,w:DailyExpectation):Promise<DailyRowObservation|null>{return verifyDailyEvidenceMode(e,w);}
/** Verify a populated row only against a complete, separately trusted literal
 * manifest; this pure verifier does not authenticate its inputs. */
export function verifyExistingDailyEvidence(e:DailyEvidence,w:ExistingDailyExpectation):Promise<DailyRowObservation|null>{
 if(!w.expectedLiterals||typeof w.expectedLiterals!=='object'||Array.isArray(w.expectedLiterals))return Promise.resolve(null);
 return verifyDailyEvidenceMode(e,w,w.expectedLiterals);
}
function parseMetadata(value:unknown):Marker|null{
 const o=value as {metadataId?:number;metadataKey?:string;metadataValue?:string;location?:{dimensionRange?:{sheetId?:number;dimension?:string;startIndex?:number;endIndex?:number}}};const r=o?.location?.dimensionRange;
 if(!Number.isSafeInteger(o?.metadataId)||Number(o.metadataId)<1||typeof o.metadataKey!=='string'||!o.metadataKey||(o.metadataValue!==undefined&&typeof o.metadataValue!=='string')||!r||!Number.isSafeInteger(r.sheetId)||Number(r.sheetId)<0||r.dimension!=='ROWS'||!Number.isSafeInteger(r.startIndex)||Number(r.startIndex)<0||r.endIndex!==Number(r.startIndex)+1)return null;
 return {metadataId:Number(o.metadataId),metadataKey:o.metadataKey,metadataValue:o.metadataValue??'',sheetId:Number(r.sheetId),rowIndex:Number(r.startIndex)};
}
/** Bounded network read; input lengths are validated before constructing ranges.
 * Missing/duplicate responses, metadata or invalid shapes fail closed. */
export async function readDailyEvidence(env:Env,w:DailyExpectation):Promise<DailyEvidence|null>{try{
 if(w.sheetTitle!==env.SHEET_EXPENSE_DAILY||!env.GOOGLE_SERVICE_ACCOUNT_EMAIL||w.serviceAccount.trim().toLowerCase()!==env.GOOGLE_SERVICE_ACCOUNT_EMAIL.trim().toLowerCase()||!Number.isSafeInteger(w.rowNumber)||w.rowNumber<6||!Number.isSafeInteger(w.metadataId)||w.metadataId<1)return null;
 const fields='sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),protectedRanges(range,warningOnly,requestingUserCanEdit,unprotectedRanges,editors(users,groups,domainUsersCanEdit)))';
 const base=await sheetsFetch(env,`?fields=${encodeURIComponent(fields)}`,{method:'GET'}).then(r=>r.json()) as Spreadsheet;
 const ss=(base.sheets||[]).filter(s=>s.properties?.title===w.sheetTitle);if(ss.length!==1)return null;const sheet=ss[0]!,count=Number(sheet.properties?.gridProperties?.rowCount);if(!Number.isSafeInteger(count)||count<w.rowNumber||count>10000)return null;
 const q=new URLSearchParams();q.append('ranges',`${quote(w.sheetTitle)}!A${w.rowNumber}:Y${w.rowNumber}`);q.set('fields','sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue))))');
 const [targetData,read,search,byId]=await Promise.all([
  sheetsFetch(env,`?${q}`,{method:'GET'}).then(r=>r.json()) as Promise<Spreadsheet>,
  batchGetSheetValues(env,[`${quote(w.sheetTitle)}!A1:D${count}`,`${quote(w.sheetTitle)}!A1:W3`]),
  sheetsFetch(env,'/developerMetadata:search',{method:'POST',body:JSON.stringify({dataFilters:[{developerMetadataLookup:{locationType:'ROW',visibility:'DOCUMENT'}}]})}).then(r=>r.json()) as Promise<{matchedDeveloperMetadata?:Array<{developerMetadata?:unknown}>}>,
  sheetsFetch(env,`/developerMetadata/${w.metadataId}`,{method:'GET'}).then(r=>r.json()) as Promise<unknown>
 ]);
 const targets=(targetData.sheets||[]).filter(s=>s.properties?.title===w.sheetTitle);if(targets.length!==1||read.length!==2||!search||!Array.isArray(search.matchedDeveloperMetadata))return null;
 const markers=search.matchedDeveloperMetadata.map(v=>parseMetadata(v.developerMetadata));if(markers.some(m=>!m))return null;
 return {sheet,target:targets[0]!,rows:read[0]||[],headers:read[1]||[],markers:markers as Marker[],markerById:parseMetadata(byId)};
 }catch{return null;}}
/** Two independent full reads must agree. A shared write fence and external
 * maintenance window remain prerequisites before any mutation. */
export async function observeDailyRow(env:Env,w:DailyExpectation):Promise<DailyRowObservation|null>{
 const a=await readDailyEvidence(env,w);if(!a)return null;const proof=await verifyDailyEvidence(a,w);if(!proof)return null;
 const b=await readDailyEvidence(env,w);if(!b||JSON.stringify(a)!==JSON.stringify(b))return null;return verifyDailyEvidence(b,w);
}
/** Independently fetch twice using the configured service account. Observation
 * is evidence, not write authorization: it requires a separately attested
 * manifest, active sheet-wide fence and human-edit exclusion at mutation. */
export async function observeExistingDailyRow(env:Env,w:ExistingDailyExpectation):Promise<DailyRowObservation|null>{
 if(!w.expectedLiterals||typeof w.expectedLiterals!=='object'||Array.isArray(w.expectedLiterals))return null;
 const a=await readDailyEvidence(env,w);if(!a)return null;const proof=await verifyExistingDailyEvidence(a,w);if(!proof)return null;
 const b=await readDailyEvidence(env,w);if(!b||JSON.stringify(a)!==JSON.stringify(b))return null;return verifyExistingDailyEvidence(b,w);
}
