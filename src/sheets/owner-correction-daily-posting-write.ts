import type {Env} from '../types';
import {numberEnv} from '../shared/env';
import {correctionPeriodHeaderDigest} from '../expense/owner-correction-period-math';
import {isIsoDate} from '../shared/time';
import {legacySourceWallet,resolvePayment} from './daily-expense';
import {batchPatchMetadataRows,type MetadataRowPatch,type SheetRowMetadata} from './client';
import type {DailyPostingReservation,DailyPostingSnapshot} from './owner-correction-daily-posting-reservation';

const columns=[1,2,3,5,6,7,10,11,12,13,14,15,16,21,22];
const amountColumns=new Set([5,6,7,10,11,12,13,14,15,16]);
const formulaColumns=[8,17,20];
const asColumn=(name:string)=>{let n=0;for(const c of name)n=n*26+c.charCodeAt(0)-64;return n-1;};
const blank=(value:unknown)=>value===undefined||value===null||value==='';
/** This proof must come from a trusted complete reader. No live reader is wired. */
export interface DailyPostingWriteObservation{
  marker:SheetRowMetadata|null;headerDigest:string;sheetYear:number;
  monthBlock:{month:number;headerRow:number;totalRow:number};
  values:unknown[];formulas:unknown[];
  /** Reader has verified coverage through column Y, including trailing blanks. */
  observedColumnCount:number;
  completeIdentityAndProtection:boolean;formulasVerified:boolean;
}
export interface DailyPostingWritePorts{
  observe:()=>Promise<DailyPostingWriteObservation|null>;
  patch:(env:Env,patches:MetadataRowPatch[],allowed:number[],beforeDispatch:()=>Promise<void>)=>Promise<void>;
  now:()=>number;
}
export const defaultDailyPostingPatch=batchPatchMetadataRows;
interface WritePlan{metadataId:number;cells:Array<{columnIndex:number;value:string|number}>}
interface Intent{plan_json:string;before_json:string;state:string;dispatch_id:string|null;not_before:string|null}
interface Input{headers:unknown[][];fenceToken:string;syncToken:string}
type PrepareResult='PREPARED'|'PENDING'|'REVIEW';type DispatchResult='PENDING'|'REVIEW';type RecoveryResult='WAIT'|'VALUES_VERIFIED'|'REVIEW';
const guard=`EXISTS(SELECT 1 FROM expense_events e JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version
 JOIN owner_correction_daily_write_fences f ON f.sheet_name=? AND f.lease_token=? AND f.state='OWNED' AND f.lease_until>?
 JOIN owner_correction_daily_identity_latch l ON l.sheet_name=f.sheet_name
 JOIN daily_identity_posting_reservations r ON r.expense_id=e.expense_id AND r.expense_version=e.version
 WHERE e.expense_id=? AND e.status='CONFIRMED' AND e.version=? AND e.updated_at IS ? AND e.description=? AND e.category=? AND e.amount_satang=? AND e.transaction_date=? AND e.payment_key=? AND e.source_wallet=?
 AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>? AND r.sheet_name=? AND r.sheet_id=? AND r.row_number=? AND r.metadata_id=? AND r.header_digest=? AND r.snapshot_json=? AND r.state='VERIFIED'
 AND EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.sheet_name=r.sheet_name AND i.entity_key=e.expense_id AND i.row_number=r.row_number)
 AND NOT EXISTS(SELECT 1 FROM sync_jobs c WHERE c.entity_type='EXPENSE_CORRECTION' AND c.entity_key=e.expense_id AND c.status<>'COMPLETED'))`;
const args=(r:DailyPostingReservation,s:DailyPostingSnapshot,input:Input,now:string)=>[r.sheetName,input.fenceToken,now,s.expenseId,s.version,s.updatedAt,s.description,s.category,s.amountSatang,s.transactionDate,s.paymentKey,s.sourceWallet,input.syncToken,now,r.sheetName,r.sheetId,r.rowNumber,r.metadataId,r.headerDigest,JSON.stringify(s)];
async function getIntent(env:Env,s:DailyPostingSnapshot):Promise<Intent|null>{return env.DB.prepare(`SELECT plan_json,before_json,state,dispatch_id,not_before FROM daily_identity_posting_write_intents WHERE expense_id=? AND expense_version=?`).bind(s.expenseId,s.version).first<Intent>();}
async function observeTwice(ports:DailyPostingWritePorts):Promise<DailyPostingWriteObservation|null>{
  try{const first=await ports.observe();if(!first)return null;const saved=JSON.stringify(first),second=await ports.observe();if(!second||saved!==JSON.stringify(second))return null;return JSON.parse(saved) as DailyPostingWriteObservation;}catch{return null;}
}
function sameTarget(o:DailyPostingWriteObservation,r:DailyPostingReservation,s:DailyPostingSnapshot):boolean{
 const m=o.marker,b=o.monthBlock;return !!(r.expenseId===s.expenseId&&r.version===s.version&&m&&m.metadataId===r.metadataId&&m.metadataKey==='malipang_expense_daily'&&m.metadataValue===s.expenseId&&m.sheetId===r.sheetId&&m.rowIndex===r.rowNumber-1&&o.headerDigest===r.headerDigest&&o.completeIdentityAndProtection===true&&o.formulasVerified===true&&Number.isSafeInteger(o.observedColumnCount)&&o.observedColumnCount>=25&&Array.isArray(o.values)&&Array.isArray(o.formulas)&&b&&Number.isSafeInteger(b.headerRow)&&Number.isSafeInteger(b.totalRow)&&b.headerRow<r.rowNumber&&r.rowNumber<b.totalRow);
}
async function plan(r:DailyPostingReservation,s:DailyPostingSnapshot,input:Input,o:DailyPostingWriteObservation):Promise<WritePlan|null>{
  if(!sameTarget(o,r,s)||!isIsoDate(s.transactionDate)||!Array.isArray(input.headers)||input.headers.length!==3||input.headers.some(row=>!Array.isArray(row))||await correctionPeriodHeaderDigest(input.headers)!==r.headerDigest||!Number.isSafeInteger(s.amountSatang)||s.amountSatang<=0)return null;
  const [year,month,day]=s.transactionDate.split('-').map(Number);let posting:ReturnType<typeof resolvePayment>;try{posting=resolvePayment(input.headers,s.paymentKey,year!,month!,day!);}catch{return null;}
  const amount=asColumn(posting.amountColumn);if(!amountColumns.has(amount)||o.sheetYear!==posting.postingYear||o.monthBlock.month!==posting.postingMonth)return null;
  const values=new Map<number,string|number>(columns.map(column=>[column,'']));values.set(1,posting.postingMonth);values.set(2,posting.postingDay);values.set(3,s.description);values.set(amount,s.amountSatang/100);values.set(21,s.category);values.set(22,legacySourceWallet(s.paymentKey,s.sourceWallet));
  return {metadataId:r.metadataId,cells:[...values].map(([columnIndex,value])=>({columnIndex,value}))};
}
const targetBlank=(o:DailyPostingWriteObservation)=>Array.from({length:25},(_,index)=>index).filter(index=>!formulaColumns.includes(index)).every(index=>blank(o.values[index])&&!(typeof o.formulas[index]==='string'&&(o.formulas[index] as string).startsWith('=')));
function targetMatches(o:DailyPostingWriteObservation,before:DailyPostingWriteObservation,p:WritePlan):boolean{
 if(JSON.stringify(o.formulas)!==JSON.stringify(before.formulas))return false;
 const expected=new Map(p.cells.map(cell=>[cell.columnIndex,cell.value]));
 for(let i=0;i<25;i++){
   if(formulaColumns.includes(i))continue;
   const actual=o.values[i],value=expected.get(i);
   if(value!==undefined){if(value===''?!blank(actual):actual!==value)return false;}
   else if((actual??null)!==(before.values[i]??null))return false;
 }
 return true;
}

/** Prepare D1 intent only. Verifier and report evidence remain external work. */
export async function prepareDailyPostingWrite(env:Env,s:DailyPostingSnapshot,r:DailyPostingReservation,input:Input,ports:DailyPostingWritePorts):Promise<PrepareResult>{
 if(!s||!r||!input?.fenceToken||!input.syncToken||!ports||typeof ports.observe!=='function'||typeof ports.now!=='function'||r.expenseId!==s.expenseId||r.version!==s.version||r.sheetName!==env.SHEET_EXPENSE_DAILY)return 'REVIEW';
 const existing=await getIntent(env,s);if(existing&&existing.state==='IN_FLIGHT')return 'PENDING';if(existing&&existing.state!=='PREPARED')return 'REVIEW';
 const observation=await observeTwice(ports);if(!observation||!targetBlank(observation))return 'REVIEW';const p=await plan(r,s,input,observation);if(!p)return 'REVIEW';
 const at=ports.now(),time=new Date(at);if(!Number.isFinite(at)||!Number.isFinite(time.getTime()))return 'REVIEW';const now=time.toISOString(),pjson=JSON.stringify(p),bjson=JSON.stringify(observation);
 await env.DB.prepare(`INSERT OR IGNORE INTO daily_identity_posting_write_intents(expense_id,expense_version,plan_json,before_json,state,created_at) SELECT ?,?,?,?,'PREPARED',? WHERE ${guard}`)
  .bind(s.expenseId,s.version,pjson,bjson,now,...args(r,s,input,now)).run();
 const saved=await getIntent(env,s);if(saved?.state==='IN_FLIGHT')return 'PENDING';
 const permitted=await env.DB.prepare(`SELECT 1 AS present FROM daily_identity_posting_write_intents WHERE expense_id=? AND expense_version=? AND state='PREPARED' AND plan_json=? AND before_json=? AND ${guard}`).bind(s.expenseId,s.version,pjson,bjson,...args(r,s,input,now)).first<{present:number}>();
 return permitted?'PREPARED':'REVIEW';
}

/** Persist dispatch intent and fence atomically after OAuth, before Sheets. */
export async function dispatchDailyPostingWrite(env:Env,s:DailyPostingSnapshot,r:DailyPostingReservation,input:Input,ports:DailyPostingWritePorts):Promise<DispatchResult>{
 if(!s||!r||!input?.fenceToken||!input.syncToken||!ports||typeof ports.observe!=='function'||typeof ports.patch!=='function'||typeof ports.now!=='function'||r.sheetName!==env.SHEET_EXPENSE_DAILY)return 'REVIEW';
 const saved=await getIntent(env,s);if(!saved)return 'REVIEW';if(saved.state==='IN_FLIGHT')return 'PENDING';if(saved.state!=='PREPARED')return 'REVIEW';
 let p:WritePlan,before:DailyPostingWriteObservation;try{p=JSON.parse(saved.plan_json) as WritePlan;before=JSON.parse(saved.before_json) as DailyPostingWriteObservation;}catch{return 'REVIEW';}
 const verified=async()=>{const current=await observeTwice(ports);return !!(current&&JSON.stringify(current)===saved.before_json&&targetBlank(current)&&JSON.stringify(await plan(r,s,input,current))===saved.plan_json)};
 try{
  if(!await verified())return 'REVIEW';
  await ports.patch(env,[p],columns,async()=>{
   if(!await verified())throw new Error('DAILY_POSTING_WRITE_PREFLIGHT_FAILED');
   const at=ports.now(),timeout=numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),start=new Date(at),end=new Date(at+Math.max(15*60_000,timeout+240_000));if(!Number.isFinite(at)||!Number.isFinite(timeout)||timeout<0||!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime()))throw new Error('DAILY_POSTING_WRITE_TIME_INVALID');
   const now=start.toISOString(),until=end.toISOString(),dispatch=crypto.randomUUID();
   const result=await env.DB.batch([
    env.DB.prepare(`UPDATE daily_identity_posting_write_intents SET state='IN_FLIGHT',dispatch_id=?,fence_token=?,not_before=? WHERE expense_id=? AND expense_version=? AND state='PREPARED' AND plan_json=? AND before_json=? AND ${guard}`)
     .bind(dispatch,input.fenceToken,until,s.expenseId,s.version,saved.plan_json,saved.before_json,...args(r,s,input,now)),
    env.DB.prepare(`UPDATE owner_correction_daily_write_fences SET state='IN_FLIGHT',dispatch_id=?,not_before=?,lease_until=?,updated_at=? WHERE sheet_name=? AND lease_token=? AND state='OWNED' AND lease_until>? AND EXISTS(SELECT 1 FROM daily_identity_posting_write_intents WHERE expense_id=? AND expense_version=? AND state='IN_FLIGHT' AND dispatch_id=?)`)
     .bind(dispatch,until,until,now,r.sheetName,input.fenceToken,now,s.expenseId,s.version,dispatch),
    env.DB.prepare(`UPDATE sync_jobs SET lease_until=MAX(lease_until,?),updated_at=? WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND lease_until>? AND EXISTS(SELECT 1 FROM daily_identity_posting_write_intents WHERE expense_id=? AND expense_version=? AND state='IN_FLIGHT' AND dispatch_id=?)`)
     .bind(until,now,s.expenseId,s.version,input.syncToken,now,s.expenseId,s.version,dispatch),
    env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM daily_identity_posting_write_intents WHERE expense_id=? AND expense_version=? AND state='IN_FLIGHT' AND dispatch_id=?) AND (NOT EXISTS(SELECT 1 FROM owner_correction_daily_write_fences WHERE sheet_name=? AND lease_token=? AND state='IN_FLIGHT' AND dispatch_id=? AND not_before=?) OR NOT EXISTS(SELECT 1 FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND lease_until>=?)) THEN json('daily posting write fence incomplete') ELSE 1 END AS verified`)
     .bind(s.expenseId,s.version,dispatch,r.sheetName,input.fenceToken,dispatch,until,s.expenseId,s.version,input.syncToken,until)
   ]);
   if(result.slice(0,3).some(part=>Number(part?.meta.changes||0)!==1))throw new Error('DAILY_POSTING_WRITE_NOT_ARMED');
  });
 }catch{/* Re-read durable state; never guess whether D1 or Sheets applied. */}
 const current=await getIntent(env,s);return current?.state==='IN_FLIGHT'&&current.plan_json===saved.plan_json&&current.before_json===saved.before_json?'PENDING':'REVIEW';
}

/** Independently verify applied values after the window; no automatic resend. */
export async function recoverDailyPostingWrite(env:Env,s:DailyPostingSnapshot,r:DailyPostingReservation,input:Input,ports:DailyPostingWritePorts):Promise<RecoveryResult>{
 if(!s||!r||!input?.fenceToken||!input.syncToken||!ports||typeof ports.observe!=='function'||typeof ports.now!=='function'||r.sheetName!==env.SHEET_EXPENSE_DAILY)return 'REVIEW';
 const saved=await getIntent(env,s),at=ports.now();if(!saved||saved.state!=='IN_FLIGHT'||!saved.dispatch_id||!saved.not_before||!Number.isFinite(at)||!Number.isFinite(Date.parse(saved.not_before)))return 'REVIEW';if(at<Date.parse(saved.not_before))return 'WAIT';
 let p:WritePlan,before:DailyPostingWriteObservation;try{p=JSON.parse(saved.plan_json) as WritePlan;before=JSON.parse(saved.before_json) as DailyPostingWriteObservation;}catch{return 'REVIEW';}
 const current=await observeTwice(ports);if(!current||!sameTarget(current,r,s)||!sameTarget(before,r,s)||!targetBlank(before)||JSON.stringify(await plan(r,s,input,before))!==saved.plan_json||!targetMatches(current,before,p))return 'REVIEW';
 const t=new Date(ports.now());if(!Number.isFinite(t.getTime()))return 'REVIEW';const now=t.toISOString();
 const updated=await env.DB.prepare(`UPDATE daily_identity_posting_write_intents SET state='VALUES_VERIFIED' WHERE expense_id=? AND expense_version=? AND state='IN_FLIGHT' AND dispatch_id=? AND not_before=? AND not_before<=? AND plan_json=? AND before_json=? AND ${guard}`)
  .bind(s.expenseId,s.version,saved.dispatch_id,saved.not_before,now,saved.plan_json,saved.before_json,...args(r,s,input,now)).run();
 return Number(updated.meta.changes||0)===1?'VALUES_VERIFIED':'REVIEW';
}
