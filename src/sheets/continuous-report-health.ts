import {continuousSheetsReadPolicy,type ContinuousSheetsReadPolicy} from './client';
import type {Env} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,getSpreadsheetSheetProperties} from './client';
import {columnName} from './daily-expense';
import {combinedLedgerSpillFormulas} from '../../scripts/combined-ledger-report-formulas.mjs';
import {publicationSnapshotRange,type PublicationBatchSnapshot} from './publication-batch-snapshot';

const rawView='V52_EXPENSE_RAW_ALL',detailView='V52_PURCHASE_DETAIL_ALL',clean='97_EXPENSE_CLEAN';
const expectedHeaders=['Date','Expense_ID / Legacy row','Description','Amount','Wallet','Category','Source','Sales_Addback_Basis'];
const blank=(x:unknown)=>x===undefined||x===null||x==='';
const error=(x:unknown)=>typeof x==='string'&&/^#(?:REF!|N\/A|ERROR!|DIV\/0!|VALUE!|NUM!|NAME\?|NULL!)/i.test(x);
const sha256=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('');
const quote=(s:string)=>`'${s.replace(/'/g,"''")}'`;
export type SheetProperty={sheetId:number;title:string;rowCount:number;columnCount:number};
type ReportManifestEntry={sheetId:number;sheetName:string;row:number;column:number;after:string};
export type FormulaGroup={sheet:SheetProperty;minRow:number;maxRow:number;minColumn:number;maxColumn:number;entries:ReportManifestEntry[]};

/** Check every exact formula installed by the REPORTS cutover against its
 * durable manifest. DAILY_J is deliberately excluded: row insertions in the
 * daily sheet legitimately move those formulas after cutover. */
export async function planInstalledReportFormulas(env:Env,allSheets:SheetProperty[]):Promise<FormulaGroup[]>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;if(!book)throw Error('REPORT_HEALTH_MANIFEST');
 const record=await db.prepare("SELECT manifest_json,manifest_digest,cell_count FROM continuous_report_cutover_attempts WHERE spreadsheet_id=? AND stage='REPORTS' AND state='VERIFIED'").bind(book).first<{manifest_json:string;manifest_digest:string;cell_count:number}>();
 if(!record||typeof record.manifest_json!=='string'||!/^[0-9a-f]{64}$/.test(record.manifest_digest)||await sha256(record.manifest_json)!==record.manifest_digest||!Number.isSafeInteger(record.cell_count)||record.cell_count<1||record.cell_count>1000)throw Error('REPORT_HEALTH_MANIFEST');
 let entries:ReportManifestEntry[];try{entries=JSON.parse(record.manifest_json);}catch{throw Error('REPORT_HEALTH_MANIFEST');}
 if(!Array.isArray(entries)||entries.length!==record.cell_count)throw Error('REPORT_HEALTH_MANIFEST');
 const groups=new Map<number,FormulaGroup>(),seen=new Set<string>();
 for(const e of entries){
  if(!e||typeof e!=='object'||!Number.isSafeInteger(e.sheetId)||typeof e.sheetName!=='string'||!Number.isSafeInteger(e.row)||e.row<1||!Number.isSafeInteger(e.column)||e.column<1||typeof e.after!=='string'||!/^[0-9a-f]{64}$/.test(e.after))throw Error('REPORT_HEALTH_MANIFEST');
  const found=allSheets.filter(s=>s.sheetId===e.sheetId&&s.title===e.sheetName),key=`${e.sheetId}:${e.row}:${e.column}`;
  if(found.length!==1||e.row>found[0]!.rowCount||e.column>found[0]!.columnCount||seen.has(key))throw Error('REPORT_HEALTH_TARGET');seen.add(key);
  const g=groups.get(e.sheetId);if(g){if(g.sheet.title!==e.sheetName)throw Error('REPORT_HEALTH_TARGET');g.minRow=Math.min(g.minRow,e.row);g.maxRow=Math.max(g.maxRow,e.row);g.minColumn=Math.min(g.minColumn,e.column);g.maxColumn=Math.max(g.maxColumn,e.column);g.entries.push(e);}
  else groups.set(e.sheetId,{sheet:found[0]!,minRow:e.row,maxRow:e.row,minColumn:e.column,maxColumn:e.column,entries:[e]});
 }
 const grouped=[...groups.values()];if(grouped.length>10)throw Error('REPORT_HEALTH_MANIFEST');
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book)throw Error('REPORT_HEALTH_READ');return grouped;
}
export async function verifyInstalledReportFormulas(env:Env,allSheets:SheetProperty[],policy:ContinuousSheetsReadPolicy=continuousSheetsReadPolicy,snapshot?:PublicationBatchSnapshot):Promise<SheetProperty[]>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,grouped=await planInstalledReportFormulas(env,allSheets);
 const values=snapshot?grouped.map(g=>publicationSnapshotRange(snapshot,g.sheet.sheetId,g.minRow,g.maxRow,g.minColumn,g.maxColumn,'FORMULA')):await batchGetSheetFormulaValues(env,grouped.map(g=>`${quote(g.sheet.title)}!${columnName(g.minColumn)}${g.minRow}:${columnName(g.maxColumn)}${g.maxRow}`),policy);
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||values.length!==grouped.length)throw Error('REPORT_HEALTH_READ');
 for(let i=0;i<grouped.length;i++){
  const g=grouped[i]!,rows=values[i];if(!Array.isArray(rows)||rows.length>g.maxRow-g.minRow+1||rows.some(r=>!Array.isArray(r)||r.length>g.maxColumn-g.minColumn+1))throw Error('REPORT_HEALTH_READ');
  for(const e of g.entries){const value=rows[e.row-g.minRow]?.[e.column-g.minColumn];if(typeof value!=='string'||!value.startsWith('=')||await sha256(value)!==e.after)throw Error('REPORT_HEALTH_FORMULA');}
 }
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book)throw Error('REPORT_HEALTH_READ');return grouped.map(g=>g.sheet);
}
export type ReportRows={clean:unknown[][];rawIds:unknown[][];detailIds:unknown[][]};
export type ReportExpectation={expenseId:string;transactionDate:string;amountSatang:number;wallet:string;category:string;itemIds:string[]}|{expenseId:string;absent:true;absentFromViews?:boolean};

/** Verify normalized report contents without guessing identity from amount. */
export function verifyContinuousReportRows(rows:ReportRows,expected?:ReportExpectation):'OK'|'CAPACITY'|'INVALID'{
 if(!Array.isArray(rows.clean)||rows.clean.length>4500||!Array.isArray(rows.rawIds)||!Array.isArray(rows.detailIds)||expectedHeaders.some((h,i)=>rows.clean[0]?.[i]!==h))return 'INVALID';
 const ids=new Set<string>();let last=1;
 for(let i=1;i<rows.clean.length;i++){
  const row=rows.clean[i]??[];if(row.length>8||row.some(error))return 'INVALID';
  if(row.every(blank))continue;
  const id=row[1];if(typeof id!=='string'||!id||ids.has(id)||typeof row[0]!=='number'||!Number.isFinite(row[0])||typeof row[3]!=='number'||!Number.isFinite(row[3]))return 'INVALID';ids.add(id);last=i+1;
 }
 if(last>=4500)return 'CAPACITY';
 if(!expected)return 'OK';
 const target=rows.clean.filter((row,i)=>i>0&&row[1]===expected.expenseId);
 if('absent' in expected){
  if(expected.absentFromViews&&(rows.rawIds.some((r,i)=>!Array.isArray(r)||r.length>1||i>0&&(r.some(error)||r[0]===expected.expenseId))||rows.detailIds.some((r,i)=>!Array.isArray(r)||r.length>2||i>0&&(r.some(error)||r[1]===expected.expenseId))))return 'INVALID';
  return target.length===0?'OK':'INVALID';
 }
 const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(expected.transactionDate);if(target.length!==1||!m||!Number.isSafeInteger(expected.amountSatang))return 'INVALID';
 const date=new Date(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3])));if(date.getUTCFullYear()!==Number(m[1])||date.getUTCMonth()+1!==Number(m[2])||date.getUTCDate()!==Number(m[3]))return 'INVALID';
 const serial=Math.floor((date.getTime()-Date.UTC(1899,11,30))/86400000),r=target[0]!;
 if(r[0]!==serial||typeof r[3]!=='number'||Math.abs(r[3]*100-expected.amountSatang)>0.001||r[4]!==expected.wallet||r[5]!==expected.category.trim().toLowerCase())return 'INVALID';
 if(rows.rawIds.filter((row,i)=>i>0&&row[0]===expected.expenseId).length!==1)return 'INVALID';
 const details=rows.detailIds.filter((row,i)=>i>0&&row[1]===expected.expenseId).map(row=>row[0]);
 if(details.length!==expected.itemIds.length||new Set(expected.itemIds).size!==expected.itemIds.length||expected.itemIds.some(item=>details.filter(x=>x===item).length!==1))return 'INVALID';
 return 'OK';
}

/** Bounded health read; errors, missing rows, duplicate IDs and report spill
 * capacity are held. This is a point-in-time check, not a collaborator lock. */
export async function readContinuousReportHealth(env:Env,expected?:ReportExpectation,publication?:{dailySheet:string},policy:ContinuousSheetsReadPolicy=continuousSheetsReadPolicy,snapshot?:PublicationBatchSnapshot):Promise<'OK'|'CAPACITY'>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,raw=env.CONTINUOUS_RAW_SHEET,detail=env.CONTINUOUS_DETAIL_SHEET;
 if(!book||!raw||!detail||env.SHEET_EXPENSE_RAW!=='V52_EXPENSE_RAW'||(env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ')!=='รายละเอียดการซื้อ')throw Error('REPORT_HEALTH_SCOPE');
 const manifest=await db.prepare("SELECT manifest_json,manifest_digest FROM continuous_report_cutover_attempts WHERE spreadsheet_id=? AND stage='VIEWS' AND state='VERIFIED'").bind(book).first<{manifest_json:string;manifest_digest:string}>();
 if(!manifest||typeof manifest.manifest_json!=='string'||!/^[0-9a-f]{64}$/.test(manifest.manifest_digest))throw Error('REPORT_HEALTH_MANIFEST');
 const hash=await sha256(manifest.manifest_json);if(hash!==manifest.manifest_digest)throw Error('REPORT_HEALTH_MANIFEST');
 let entries:Array<{sheetId:number;title:string;kind:string}>;try{entries=JSON.parse(manifest.manifest_json);}catch{throw Error('REPORT_HEALTH_MANIFEST');}
 if(!Array.isArray(entries)||entries.length!==4)throw Error('REPORT_HEALTH_MANIFEST');
 const names=[env.SHEET_EXPENSE_RAW,raw,env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ',detail,rawView,detailView,clean];
 const select=(all:SheetProperty[])=>names.map(n=>{const matches=all.filter(x=>x.title===n);if(matches.length!==1)throw Error('REPORT_HEALTH_TARGET');return matches[0]!;});
 const allSheets=snapshot?snapshot.metadata:await getSpreadsheetSheetProperties(env,policy),grids=select(allSheets);
 for(const [index,title] of [[1,raw],[3,detail],[4,rawView],[5,detailView]] as const){const found=entries.filter(x=>x.title===title);if(found.length!==1||found[0]!.sheetId!==grids[index]!.sheetId||found[0]!.kind!==(index<4?'LEDGER':'VIEW'))throw Error('REPORT_HEALTH_TARGET');}
 if(new Set(grids.map(g=>g.sheetId)).size!==names.length||grids.slice(0,4).some(g=>g.rowCount>5000)||grids[4]!.rowCount<grids[0]!.rowCount+grids[1]!.rowCount-1||grids[5]!.rowCount<grids[2]!.rowCount+grids[3]!.rowCount-1||grids[6]!.rowCount!==4500||grids[6]!.columnCount<8)throw Error('REPORT_HEALTH_CAPACITY');
 if(publication&&(!publication.dailySheet||publication.dailySheet!==env.CONTINUOUS_DAILY_SHEET))throw Error('REPORT_HEALTH_SCOPE');
 const expectedFormula=combinedLedgerSpillFormulas({rawNew:raw,detailNew:detail,rawCombined:rawView,detailCombined:detailView,rawOldRows:grids[0]!.rowCount,rawNewRows:grids[1]!.rowCount,detailOldRows:grids[2]!.rowCount,detailNewRows:grids[3]!.rowCount,...publication?{publishedDaily:publication.dailySheet}:{}});
 const formulas=snapshot?[publicationSnapshotRange(snapshot,grids[4]!.sheetId,1,1,1,1,'FORMULA'),publicationSnapshotRange(snapshot,grids[5]!.sheetId,1,1,1,1,'FORMULA')]:await batchGetSheetFormulaValues(env,[`'${rawView}'!A1`,`'${detailView}'!A1`],policy);
 if(formulas.length!==2||formulas[0]?.[0]?.[0]!==expectedFormula.raw||formulas[1]?.[0]?.[0]!==expectedFormula.detail)throw Error('REPORT_HEALTH_FORMULA');
 const reportSheets=await verifyInstalledReportFormulas(env,allSheets,policy,snapshot);
 const values=snapshot?[publicationSnapshotRange(snapshot,grids[6]!.sheetId,1,4500,1,8,'EFFECTIVE'),publicationSnapshotRange(snapshot,grids[4]!.sheetId,1,grids[4]!.rowCount,1,1,'EFFECTIVE'),publicationSnapshotRange(snapshot,grids[5]!.sheetId,1,grids[5]!.rowCount,1,2,'EFFECTIVE')]:await batchGetSheetEffectiveSerialValues(env,[`'${clean}'!A1:H4500`,`'${rawView}'!A1:A${grids[4]!.rowCount}`,`'${detailView}'!A1:B${grids[5]!.rowCount}`],policy);
 const allAgain=snapshot?snapshot.metadata:await getSpreadsheetSheetProperties(env,policy),again=select(allAgain),reportsAgain=reportSheets.map(s=>allAgain.find(x=>x.sheetId===s.sheetId&&x.title===s.title));
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||env.CONTINUOUS_RAW_SHEET!==raw||env.CONTINUOUS_DETAIL_SHEET!==detail||publication&&env.CONTINUOUS_DAILY_SHEET!==publication.dailySheet||JSON.stringify(grids)!==JSON.stringify(again)||JSON.stringify(reportSheets)!==JSON.stringify(reportsAgain)||values.length!==3||values[1]?.[0]?.[0]!=='Expense_ID'||values[2]?.[0]?.[0]!=='Purchase_Item_ID')throw Error('REPORT_HEALTH_READ');
 const status=verifyContinuousReportRows({clean:values[0]!,rawIds:values[1]!,detailIds:values[2]!},expected);if(status==='INVALID')throw Error('REPORT_HEALTH_UNVERIFIED');return status;
}
