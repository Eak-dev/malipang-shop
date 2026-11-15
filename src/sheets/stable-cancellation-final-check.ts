import {continuousSheetsReadPolicy,type ContinuousSheetsReadPolicy} from './client';
import type {Env,SheetsSyncJob} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,getSheetGridInfo} from './client';
import {columnName} from './daily-expense';
import {readLegacyDailyCoverage} from './legacy-daily-coverage';
import {verifyMixedDailyAccounting,type DailyPublicationAccountingEvidence} from './mixed-daily-accounting';
import {decodeLedgerCarrier,encodeLedgerCarrier} from './atomic-expense-ledger-template';
import {verifyCarrierLedgerSnapshot} from './atomic-expense-ledger-writer';
import {authenticateCarrierLedgerSnapshot} from './atomic-expense-ledger-auth';
import {pendingDailyCancellations,verifyDailyCarrierEvidence} from './daily-carrier-auth';
import {readContinuousReportHealth} from './continuous-report-health';
import {publicationSnapshotRange,type PublicationBatchSnapshot} from './publication-batch-snapshot';

export type CancelProjection={entity_id:string;projection:'DAILY'|'EXPENSE_RAW'|'DETAIL';sheet_id:number;sheet_name:string;source_version:number;source_digest:string;state:string;operation_token?:string};
export type CancelWrite={entity_id:string;projection:'DAILY'|'EXPENSE_RAW'|'DETAIL';cancellation_version:number;previous_version:number;preimage_digest:string;operation_token:string;state:string};
type Snapshot={formula:unknown[][];effective:unknown[][]};
const blank=(v:unknown)=>v===null||v===undefined||v==='';
async function digest(row:unknown[],width:number):Promise<string>{if(row.length>width||row.some(v=>v!==undefined&&v!==null&&typeof v!=='string'&&typeof v!=='boolean'&&!(typeof v==='number'&&Number.isFinite(v))))throw Error('CANCEL_FINAL_PREIMAGE');const b=new TextEncoder().encode(JSON.stringify(Array.from({length:width},(_,i)=>blank(row[i])?null:row[i])));return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),v=>v.toString(16).padStart(2,'0')).join('');}

/** Recheck every cancelled projection on one fresh set of sheet snapshots.
 * Caller owns claim/lease and must recheck D1 source revision before closing.
 * This cannot fence external editors or settle unacknowledged requests. */
export async function verifyStableCancellationFinal(env:Env,job:SheetsSyncJob,projections:CancelProjection[],writes:CancelWrite[],cancelledAt:string,claim:string,publication?:DailyPublicationAccountingEvidence,policy:ContinuousSheetsReadPolicy=continuousSheetsReadPolicy,snapshots?:{before:PublicationBatchSnapshot;after:PublicationBatchSnapshot}):Promise<void>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 if(!book||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!Number.isSafeInteger(job.entityVersion)||job.entityVersion<2||!projections.length||projections.length!==writes.length)throw Error('CANCEL_FINAL_INVALID');
 if(publication&&(!snapshots||publication.markers.get(job.entityKey)?.state!=='REVOKED'||publication.markers.get(job.entityKey)?.version!==job.entityVersion))throw Error('CANCEL_FINAL_PUBLICATION');
 for(const p of projections){const w=writes.filter(x=>x.entity_id===p.entity_id&&x.projection===p.projection);if(p.state!=='VERIFIED'||p.source_version!==job.entityVersion-1||w.length!==1||w[0]!.state!=='VERIFIED'||w[0]!.cancellation_version!==job.entityVersion||w[0]!.previous_version!==p.source_version||!/^[0-9a-f]{64}$/.test(w[0]!.preimage_digest))throw Error('CANCEL_FINAL_JOURNAL');}
 const daily=projections.filter(p=>p.projection==='DAILY');if(daily.length!==1||daily[0]!.entity_id!==job.entityKey)throw Error('CANCEL_FINAL_DAILY');
 const names=[...new Set(projections.map(p=>p.sheet_name))];if(names.length>3||names.some(x=>!x))throw Error('CANCEL_FINAL_TARGET');
 const grids=snapshots?names.map(n=>{const s=snapshots.before.metadata.find(x=>x.title===n);if(!s)throw Error('CANCEL_FINAL_GRID');return{sheetId:s.sheetId,rowCount:s.rowCount,columnCount:s.columnCount};}):await Promise.all(names.map(n=>getSheetGridInfo(env,n,policy)));
 if(grids.some(g=>g.rowCount>5000||g.columnCount>100)||new Set(grids.map(g=>g.sheetId)).size!==names.length)throw Error('CANCEL_FINAL_GRID');
 for(const p of projections)if(grids[names.indexOf(p.sheet_name)]?.sheetId!==p.sheet_id)throw Error('CANCEL_FINAL_GRID');
 const ranges=names.map((name,i)=>`'${name.replace(/'/g,"''")}'!A1:${columnName(grids[i]!.columnCount)}${grids[i]!.rowCount}`);
 const take=async(group?:PublicationBatchSnapshot):Promise<Snapshot[]>=>{const f=group?grids.map(g=>publicationSnapshotRange(group,g.sheetId,1,g.rowCount,1,g.columnCount,'FORMULA')):await batchGetSheetFormulaValues(env,ranges,policy),e=group?grids.map(g=>publicationSnapshotRange(group,g.sheetId,1,g.rowCount,1,g.columnCount,'EFFECTIVE')):await batchGetSheetEffectiveSerialValues(env,ranges,policy),after=group?names.map(n=>{const s=group.metadata.find(x=>x.title===n);return s?{sheetId:s.sheetId,rowCount:s.rowCount,columnCount:s.columnCount}:null;}):await Promise.all(names.map(n=>getSheetGridInfo(env,n,policy)));if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||f.length!==names.length||e.length!==names.length||JSON.stringify(grids)!==JSON.stringify(after)||f.some((rows,i)=>rows.length>grids[i]!.rowCount||rows.some(r=>!Array.isArray(r)||r.length>grids[i]!.columnCount))||e.some((rows,i)=>rows.length>grids[i]!.rowCount||rows.some(r=>!Array.isArray(r)||r.length>grids[i]!.columnCount)))throw Error('CANCEL_FINAL_READ');return names.map((_,i)=>({formula:f[i]!,effective:e[i]!}));};
 const before=await take(snapshots?.before);
 const dailyWrite=writes.find(w=>w.projection==='DAILY'&&w.entity_id===job.entityKey)!;
 const meta=await db.prepare(`SELECT m.sheet_id,m.sheet_name,m.posting_year,m.posting_month FROM stable_daily_cancellation_metadata m WHERE m.spreadsheet_id=? AND m.entity_type='EXPENSE' AND m.entity_id=? AND m.projection='DAILY' AND m.cancellation_version=? AND m.operation_token=?`).bind(book,job.entityKey,job.entityVersion,dailyWrite.operation_token).first<{sheet_id:number;sheet_name:string;posting_year:number;posting_month:number}>();
 if(!meta||meta.sheet_id!==daily[0]!.sheet_id||meta.sheet_name!==daily[0]!.sheet_name||!Number.isInteger(meta.posting_year)||!Number.isInteger(meta.posting_month))throw Error('CANCEL_FINAL_METADATA');
 const dailySnapshot=before[names.indexOf(meta.sheet_name)]!,dailyGrid=grids[names.indexOf(meta.sheet_name)]!,tombstone=`MPD1_CANCELLED_${await digest([dailyWrite.operation_token],1)}`;
 if(dailySnapshot.formula.filter(r=>r[24]===tombstone).length!==1||dailySnapshot.effective.filter(r=>r[24]===tombstone).length!==1)throw Error('CANCEL_FINAL_DAILY_IDENTITY');
 const allDaily=await db.prepare(`SELECT c.operation_token FROM stable_expense_cancellation_writes c JOIN stable_daily_cancellation_metadata m ON m.spreadsheet_id=c.spreadsheet_id AND m.entity_type=c.entity_type AND m.entity_id=c.entity_id AND m.projection=c.projection AND m.cancellation_version=c.cancellation_version AND m.operation_token=c.operation_token WHERE c.spreadsheet_id=? AND c.entity_type='EXPENSE' AND c.projection='DAILY' AND c.state='VERIFIED' AND m.sheet_id=? AND m.sheet_name=?`).bind(book,meta.sheet_id,meta.sheet_name).all<{operation_token:string}>();
 if(allDaily.success!==true||!Array.isArray(allDaily.results))throw Error('CANCEL_FINAL_DAILY_JOURNAL');
 const expectedTombs=await Promise.all(allDaily.results.map(async r=>`MPD1_CANCELLED_${await digest([r.operation_token],1)}`)),actualTombs=dailySnapshot.formula.flatMap(r=>typeof r[24]==='string'&&/^MPD1_CANCELLED_[0-9a-f]{64}$/.test(r[24])?[r[24]]:[]);
 if(new Set(expectedTombs).size!==expectedTombs.length||new Set(actualTombs).size!==actualTombs.length||expectedTombs.length!==actualTombs.length||expectedTombs.some(x=>!actualTombs.includes(x)))throw Error('CANCEL_FINAL_DAILY_JOURNAL');
 const legacy=await readLegacyDailyCoverage(env,meta.posting_year,meta.posting_month,meta.sheet_name,policy,snapshots?.before);
 const pending=await pendingDailyCancellations(env,meta.sheet_name,meta.sheet_id,claim);
 if(!verifyMixedDailyAccounting(dailySnapshot,dailyGrid.rowCount,dailyGrid.columnCount,meta.posting_year,meta.posting_month,legacy.coverage,publication)||!await verifyDailyCarrierEvidence(env,meta.sheet_name,meta.sheet_id,dailyGrid.columnCount,dailySnapshot.formula,undefined,pending))throw Error('CANCEL_FINAL_DAILY_ACCOUNTING');
 for(const projection of ['EXPENSE_RAW','DETAIL'] as const){
  const group=projections.filter(p=>p.projection===projection);if(!group.length)continue;
  const first=group[0]!,sheetIndex=names.indexOf(first.sheet_name),snapshot=before[sheetIndex]!,grid=grids[sheetIndex]!;
  if(group.some(p=>p.sheet_name!==first.sheet_name||p.sheet_id!==first.sheet_id))throw Error('CANCEL_FINAL_TARGET');
  const rows=new Map<string,{index:number;carrier:NonNullable<ReturnType<typeof decodeLedgerCarrier>>}>();
  for(let i=0;i<snapshot.formula.length;i++){const carrier=decodeLedgerCarrier(snapshot.formula[i]?.[25]);if(!carrier||carrier.projection!==projection)continue;const entity=projection==='EXPENSE_RAW'?carrier.expenseId:`${carrier.expenseId}|${carrier.itemId}`;if(rows.has(entity))throw Error('CANCEL_FINAL_LEDGER_IDENTITY');rows.set(entity,{index:i,carrier});}
  const sample=rows.get(first.entity_id);if(!sample||verifyCarrierLedgerSnapshot(snapshot,grid.rowCount,grid.columnCount,projection,sample.carrier)!==sample.index+1)throw Error('CANCEL_FINAL_LEDGER_IDENTITY');
  await authenticateCarrierLedgerSnapshot(env,snapshot,grid.rowCount,projection,first.sheet_name,first.sheet_id);
  for(const p of group){
   const found=rows.get(p.entity_id),w=writes.find(x=>x.entity_id===p.entity_id&&x.projection===projection);if(!found||!w)throw Error('CANCEL_FINAL_LEDGER_IDENTITY');
   const {index,carrier}=found;if(carrier.status!=='CANCELLED'||carrier.cancelVersion!==job.entityVersion||carrier.confirmedVersion!==p.source_version||carrier.cancelledAt!==cancelledAt)throw Error('CANCEL_FINAL_LEDGER_VALUE');
   const confirmed={...carrier,status:'CONFIRMED' as const,cancelVersion:null,cancelledAt:''};delete confirmed.cancelMarker;
   const original=(snapshot.formula[index]??[]).slice();original[25]=encodeLedgerCarrier(confirmed);if(projection==='EXPENSE_RAW')original[17]=null;
   if(await digest(original,grid.columnCount)!==w.preimage_digest)throw Error('CANCEL_FINAL_PREIMAGE');
  }
 }
 if(await readContinuousReportHealth(env,{expenseId:job.entityKey,absent:true,...publication?{absentFromViews:true}:{}},publication?{dailySheet:meta.sheet_name}:undefined,policy,snapshots?.before)!=='OK')throw Error('CANCEL_FINAL_REPORT_UNVERIFIED');
 if(snapshots&&JSON.stringify(snapshots.before)!==JSON.stringify(snapshots.after)||JSON.stringify(await take(snapshots?.after))!==JSON.stringify(before)||JSON.stringify(await readLegacyDailyCoverage(env,meta.posting_year,meta.posting_month,meta.sheet_name,policy,snapshots?.after))!==JSON.stringify(legacy))throw Error('CANCEL_FINAL_CHANGED');
}
