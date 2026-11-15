import {continuousSheetsReadPolicy} from './client';
import type {Env,SheetsSyncJob} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,getSheetGridInfo} from './client';
import {columnName} from './daily-expense';
import {decodeAtomicDailyPayload} from './atomic-daily-template';
import {readStableExpenseSource,type StableExpenseSource} from './stable-expense-source';
import {stableWorkbookClaimOwned} from './stable-workbook-claim';
import {assertContinuousDailyActivated} from './continuous-daily-route';
import {continuousAdmissionIntegrity,continuousDailyCutoverIntegrity,continuousReportCutoverIntegrity} from './continuous-daily-cutover';
import {stableSourceIntegrity} from './stable-source-cutover';
import {decodeLedgerCarrier,ledgerCarrierAppendFormulas,ledgerCarrierDisplay,ledgerCarrierFormulas} from './atomic-expense-ledger-template';
import {verifiedInsertDailyPayment} from './insert-daily-writer';
import {paymentOptionForPair} from '../expense/document';

type Snapshot={formula:unknown[][];effective:unknown[][];rowCount:number;columnCount:number};
const blank=(v:unknown)=>v===undefined||v===null||v==='';
const idKey=(id:string)=>`MALIPANG_EXPENSE:${id}`;
const day=(v:unknown):string|null=>{
 if(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)){const d=new Date(`${v}T00:00:00.000Z`);return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v?v:null;}
 if(typeof v==='number'&&Number.isInteger(v)&&v>0){const d=new Date(Date.UTC(1899,11,30)+v*86400000);if(Number.isFinite(d.getTime()))return d.toISOString().slice(0,10);}
 return null;
};

/** Conservative first-attempt reconciliation: identity absence alone is not
 * enough. Any same-day financial row, missing financial date, or identifiable
 * document blocks admission, including rows without stable IDs. */
export function inspectUnwrittenPreCutover(input:{expenseId:string;sourceDate:string;postingDate:string;documentIds:string[];snapshots:Snapshot[]}):{status:'CLEAR'}|{status:'HOLD';reason:string}{
 const hold=(reason:string)=>({status:'HOLD' as const,reason}),{expenseId,sourceDate,postingDate,documentIds,snapshots}=input;
 if(!/^exp_[A-Za-z0-9_-]{1,128}$/.test(expenseId)||!day(sourceDate)||!day(postingDate)||!Array.isArray(snapshots)||snapshots.length!==6||!Array.isArray(documentIds))return hold('INVALID_INPUT');
 const dates=new Set([sourceDate,postingDate]),months=new Set([sourceDate.slice(5,7),postingDate.slice(5,7)]),key=idKey(expenseId);
 for(let s=0;s<snapshots.length;s++){
  const snap=snapshots[s]!;if(!Number.isSafeInteger(snap.rowCount)||snap.rowCount<1||snap.rowCount>5000||!Number.isSafeInteger(snap.columnCount)||snap.columnCount<(s<2?25:s<4?17:20)||snap.columnCount>100||snap.formula.length>snap.rowCount||snap.effective.length>snap.rowCount||[...snap.formula,...snap.effective].some(r=>!Array.isArray(r)||r.length>snap.columnCount))return hold('INCOMPLETE_SNAPSHOT');
  for(let i=s<2?3:1;i<snap.rowCount;i++){
   const f=snap.formula[i]??[],e=snap.effective[i]??[];
   if(s===3||s===5){
    const projection=s===3?'EXPENSE_RAW':'DETAIL',v=f[25],marker=typeof v==='string'&&new RegExp(`^MPL1_EMPTY_${i+1}_[0-9a-f]{32}$`).test(v),payload=decodeLedgerCarrier(v);
    if(marker){if(e[25]!==v||projection==='EXPENSE_RAW'&&!blank(e[17])||Object.entries(ledgerCarrierFormulas(projection,i+1)).some(([c,x])=>f[Number(c)]!==x||!blank(e[Number(c)])))return hold('HELPER_ROW_UNVERIFIED');continue;}
    if(!payload||payload.projection!==projection||e[25]!==v||![ledgerCarrierFormulas(projection,i+1),ledgerCarrierAppendFormulas(projection)].some(t=>Object.entries(t).every(([c,x])=>f[Number(c)]===x))||ledgerCarrierDisplay(payload).some((x,c)=>!(blank(x)&&blank(e[c])||x===e[c])))return hold('HELPER_ROW_UNVERIFIED');
   }
   if(s<2){
    if(f[23]===key||e[23]===key||decodeAtomicDailyPayload(f[24])?.expenseId===expenseId||typeof f[24]==='string'&&f[24].includes(key))return hold('IDENTITY_PRESENT');
    if(typeof f[24]==='string'&&f[24].startsWith('MPD1')&&!decodeAtomicDailyPayload(f[24])&&!/^MPD1_CANCELLED_[0-9a-f]{64}$/.test(f[24]))return hold('DAILY_CARRIER_UNVERIFIED');
    const moneyCols=[5,6,7,8,10,11,12,13,14,15,16];if(moneyCols.some(c=>!blank(e[c])&&(typeof e[c]!=='number'||!Number.isFinite(e[c]))))return hold('FINANCIAL_VALUE_UNVERIFIED');
    const financial=moneyCols.some(c=>typeof e[c]==='number'&&Number.isFinite(e[c])&&e[c]!==0);
    if(!financial||e[0]==='รวม'||e[3]==='รายรับทั้งหมดในบัญชี')continue;
    const full=day(e[20]);if(full&&dates.has(full))return hold('SAME_DAY_FINANCIAL_ROW');
    if(!full){const m=Number(e[1]);if(!Number.isInteger(m)||months.has(String(m).padStart(2,'0')))return hold('UNDATED_FINANCIAL_ROW');}
   }else if(s<4){
    if(f[0]===expenseId||e[0]===expenseId)return hold('IDENTITY_PRESENT');
    if(blank(e[0])&&blank(e[3])&&blank(e[2])){if([...f.slice(0,17),...e.slice(0,17)].some(v=>!blank(v)))return hold('RAW_ROW_UNVERIFIED');continue;}
    const d=day(e[1]);if(!d)return hold('UNDATED_RAW_ROW');if(dates.has(d))return hold('SAME_DAY_RAW_ROW');
   }else{
    if(f[1]===expenseId||e[1]===expenseId||documentIds.includes(String(f[2]??''))||documentIds.includes(String(e[2]??'')))return hold('IDENTITY_PRESENT');
    if(blank(e[0])&&blank(e[6])&&blank(e[11])){if([...f.slice(0,20),...e.slice(0,20)].some(v=>!blank(v)))return hold('DETAIL_ROW_UNVERIFIED');continue;}
    const d=day(e[3]);if(!d)return hold('UNDATED_DETAIL_ROW');if(dates.has(d))return hold('SAME_DAY_DETAIL_ROW');
   }
  }
 }
 return{status:'CLEAR'};
}

/** Exact-target operation under a held claim, after old deployments and their
 * provider requests have been independently fenced and drained. It only
 * records hashes; it does not write Sheets or authorize uncertain replays. */
export async function admitUnwrittenPreCutover(env:Env,job:SheetsSyncJob,lease:string,claim:string,source:StableExpenseSource):Promise<void>{
 const target=await assertContinuousDailyActivated(env),db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 if(!target||!lease||!claim||job.entityType!=='EXPENSE'||job.entityVersion!==1)throw Error('ADMISSION_INVALID');
 const names=[env.SHEET_EXPENSE_DAILY,target.sheet,env.SHEET_EXPENSE_RAW,env.CONTINUOUS_RAW_SHEET!,env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ',env.CONTINUOUS_DETAIL_SHEET!];
 if(names.some(n=>!n)||new Set(names).size!==6)throw Error('ADMISSION_TARGET');
 const initial=JSON.stringify([book,...names,env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET_ID]),stable=()=>env.DB===db&&JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.SHEET_EXPENSE_DAILY,env.CONTINUOUS_DAILY_SHEET,env.SHEET_EXPENSE_RAW,env.CONTINUOUS_RAW_SHEET,env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ',env.CONTINUOUS_DETAIL_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET_ID])===initial;
 const boundary=await db.prepare("SELECT legacy_sheet_id FROM continuous_daily_cutovers WHERE spreadsheet_id=? AND state='ACTIVE'").bind(book).first<{legacy_sheet_id:number}>();if(!boundary||!Number.isSafeInteger(boundary.legacy_sheet_id))throw Error('ADMISSION_TARGET');
 const sourceMatches=async()=>{const s=await readStableExpenseSource(env,job,lease,claim);return !!s&&s.digest===source.digest&&s.revision===source.revision&&s.fingerprint===source.fingerprint&&stable()&&await stableWorkbookClaimOwned(env,claim)&&stable();};
 const capture=async()=>{
  const grids=await Promise.all(names.map(n=>getSheetGridInfo(env,n,continuousSheetsReadPolicy)));if(grids.some(g=>g.rowCount>5000||g.columnCount>100)||new Set(grids.map(g=>g.sheetId)).size!==6||grids[0]!.sheetId!==boundary.legacy_sheet_id||grids[1]!.sheetId!==target.sheetId||grids[3]!.sheetId!==Number(env.CONTINUOUS_RAW_SHEET_ID)||grids[5]!.sheetId!==Number(env.CONTINUOUS_DETAIL_SHEET_ID))throw Error('ADMISSION_GRID');
  const ranges=names.map((n,i)=>`'${n.replace(/'/g,"''")}'!A1:${columnName(grids[i]!.columnCount)}${grids[i]!.rowCount}`),f=await batchGetSheetFormulaValues(env,ranges,continuousSheetsReadPolicy),e=await batchGetSheetEffectiveSerialValues(env,ranges,continuousSheetsReadPolicy),again=await Promise.all(names.map(n=>getSheetGridInfo(env,n,continuousSheetsReadPolicy)));
  if(!stable()||JSON.stringify(grids)!==JSON.stringify(again)||f.length!==6||e.length!==6)throw Error('ADMISSION_READ');
  return grids.map((g,i)=>({...g,formula:f[i]!,effective:e[i]!}));
 };
 if(!await sourceMatches())throw Error('ADMISSION_SOURCE');
 const before=await capture(),raw=String(source.expense.transaction_date??''),m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);if(!m)throw Error('ADMISSION_DATE');
 if(!paymentOptionForPair(String(source.expense.payment_key??''),String(source.expense.source_wallet??'')))throw Error('ADMISSION_PAYMENT');
 const payment=verifiedInsertDailyPayment(before[1]!.formula,String(source.expense.payment_key??''),Number(m[1]),Number(m[2]),Number(m[3])),postingDate=`${payment.postingYear}-${String(payment.postingMonth).padStart(2,'0')}-${String(payment.postingDay).padStart(2,'0')}`;
 const checked=inspectUnwrittenPreCutover({expenseId:job.entityKey,sourceDate:raw,postingDate,documentIds:source.documents.map(d=>String(d.document_id??'')).filter(Boolean),snapshots:before});
 if(checked.status!=='CLEAR')throw Error(`ADMISSION_${checked.reason}`);
 if(JSON.stringify(await capture())!==JSON.stringify(before)||!await sourceMatches())throw Error('ADMISSION_SNAPSHOT_CHANGED');
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({book,job,sourceDigest:source.digest,names,snapshots:before})))),v=>v.toString(16).padStart(2,'0')).join('');
 const result=await db.prepare(`INSERT INTO continuous_daily_source_admissions(spreadsheet_id,expense_id,source_version,source_digest,provider_digest,source_revision,claim_token,admitted_at) SELECT ?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousReportCutoverIntegrity} AND ${continuousAdmissionIntegrity} AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?) AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD') AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=? AND j.entity_version=? AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).bind(book,job.entityKey,job.entityVersion,source.digest,hash,source.revision,claim,source.revision,book,claim,job.entityKey,job.entityVersion,lease).run();
 if(!stable()||result.success!==true||Number(result.meta?.changes)!==1)throw Error('ADMISSION_OUTCOME_UNCERTAIN');
}
