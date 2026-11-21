/** Opt-in, D1-serialized Sheets admission pacing.
 * Per-workbook reserved request units, NOT a claim that every Google request
 * is counted. A deliberately conservative max-stage estimate and 75s minimum
 * spacing bound our own writers without adding a D1 query to each Sheets GET
 * (which itself could exceed Workers Free D1 subrequest quota).
 * All Google writes still use the durable workbook claim and readback fences.
 */
import type {Env} from '../types';
import type {RecoveryIdentity} from './stable-recovery-admission';

export const STABLE_SHEETS_PACING_BLOCKED='STABLE_SHEETS_PACING_BLOCKED';
export const STABLE_SHEETS_PACING_UNAVAILABLE='STABLE_SHEETS_PACING_UNAVAILABLE';
const DEFAULT_UNITS=52;
const DEFAULT_BUDGET=55;
const DEFAULT_GAP_MS=75_000;
export function stablePacingConfigured(env:Env):boolean{
 return env.STABLE_SHEETS_PACING_ENABLED!==undefined&&env.STABLE_SHEETS_PACING_ENABLED!=='false';
}
export function stablePacingValid(env:Env):boolean{
 const raw=env.STABLE_SHEETS_READ_BUDGET_PER_MINUTE;
 const budget=raw===undefined?DEFAULT_BUDGET:Number(raw);
 return env.STABLE_SHEETS_PACING_ENABLED==='true'&&env.STABLE_PHASE1_ENABLED==='true'&&!!env.GOOGLE_SPREADSHEET_ID&&
  Number.isSafeInteger(budget)&&budget>=DEFAULT_UNITS&&budget<=60;
}
function limit(env:Env):number{return Number(env.STABLE_SHEETS_READ_BUDGET_PER_MINUTE??DEFAULT_BUDGET);}

/** Read-only, fail-closed preflight when enabled without migration. */
export async function pacingPreflightBlocked(env:Env):Promise<boolean>{
 if(!stablePacingConfigured(env))return false;
 if(!stablePacingValid(env))return true;
 try{
  await env.DB.prepare('SELECT 1 AS present FROM stable_sheet_pacing LIMIT 0').all();
  return false;
 }catch{return true;}
}

/** One atomic reserve before B1/C1 and all projection writes; a full minute
 * of request budget and 75s spacing. No credit refund after uncertainty. */
export async function admitPacedWorkbookOperation(env:Env,identity:RecoveryIdentity|undefined,token:string,nowMs=Date.now()):Promise<boolean>{
 if(!stablePacingConfigured(env))return true;
 if(!stablePacingValid(env)||!identity||!token)return false;
 const minute=Math.floor(nowMs/60_000);
 const budget=limit(env);
 const book=env.GOOGLE_SPREADSHEET_ID;
 await env.DB.prepare("INSERT OR IGNORE INTO stable_sheet_pacing(spreadsheet_id,window_minute,reserved_units,last_admission_ms,total_admissions) VALUES(?,0,0,0,0)").bind(book).run();
 const result=await env.DB.prepare(`UPDATE stable_sheet_pacing
  SET window_minute=?,reserved_units=CASE WHEN window_minute=? THEN reserved_units+? ELSE ? END,
      last_admission_ms=?,total_admissions=total_admissions+1
  WHERE spreadsheet_id=?
    AND (? - last_admission_ms >= ?)
    AND (CASE WHEN window_minute=? THEN reserved_units ELSE 0 END)+? <= ?
    AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.state='HELD' AND c.operation_token=? AND c.notice_stamp IS NULL)`)
 .bind(minute,minute,DEFAULT_UNITS,DEFAULT_UNITS,nowMs,book,nowMs,DEFAULT_GAP_MS,minute,DEFAULT_UNITS,budget,book,token).run();
 if(result.success!==true||!Number.isSafeInteger(result.meta?.changes))throw Error('STABLE_SHEETS_PACING_OUTCOME_UNKNOWN');
 return result.meta.changes===1;
}

export function stableBusyDelaySeconds(attempt:number,random=()=>Math.random()):number{
 const n=Math.min(4,Math.max(0,Math.floor(Number.isFinite(attempt)?attempt-1:0)));
 const base=Math.min(240,30*2**n);
 const jitter=Math.floor(Math.max(0,Math.min(1,random()))*Math.ceil(base*.25));
 return Math.min(300,base+jitter);
}

export interface BusyIdentity{entityType:string;entityKey:string;entityVersion:number}
export async function persistedStableBusyDelay(env:Env,job:BusyIdentity,random=()=>Math.random(),nowMs=Date.now()):Promise<number>{
 if(!stablePacingConfigured(env))return 30;
 if(!stablePacingValid(env))return 300;
 try{
  const result=await env.DB.prepare(`INSERT INTO stable_sheet_busy_backoffs(entity_type,entity_key,entity_version,attempt_count,last_busy_ms)
   VALUES(?,?,?,1,?)
   ON CONFLICT(entity_type,entity_key,entity_version) DO UPDATE SET
    attempt_count=CASE WHEN stable_sheet_busy_backoffs.last_busy_ms<? THEN 1
       ELSE MIN(7,stable_sheet_busy_backoffs.attempt_count+1) END,
    last_busy_ms=excluded.last_busy_ms
   RETURNING attempt_count`)
   .bind(job.entityType,job.entityKey,job.entityVersion,nowMs,nowMs-600_000).first<{attempt_count:number}>();
  return stableBusyDelaySeconds(Number(result?.attempt_count||1),random);
 }catch{
  // No provider mutation is underway in the BUSY branch, so use the maximum
  // conservative delay and retain the original durable outbox.
  console.error('stable-sheets-busy-backoff-unavailable');
  return 300;
 }
}
export async function clearStableBusyBackoff(env:Env,job:BusyIdentity):Promise<void>{
 if(!stablePacingConfigured(env))return;
 await env.DB.prepare('DELETE FROM stable_sheet_busy_backoffs WHERE entity_type=? AND entity_key=? AND entity_version=?')
   .bind(job.entityType,job.entityKey,job.entityVersion).run();
}

export async function stablePacingDiagnostic(env:Env):Promise<{mode:string;reservedUnits?:number;budget?:number;totalAdmissions?:number;lastAdmissionMs?:number}>{
 if(!stablePacingConfigured(env))return{mode:'DISABLED'};
 if(!stablePacingValid(env))return{mode:'INVALID_CONFIG'};
 try{
  const row=await env.DB.prepare('SELECT window_minute,reserved_units,total_admissions,last_admission_ms FROM stable_sheet_pacing WHERE spreadsheet_id=?')
   .bind(env.GOOGLE_SPREADSHEET_ID).first<{window_minute:number;reserved_units:number;total_admissions:number;last_admission_ms:number}>();
  return row?{mode:'OPT_IN',reservedUnits:row.reserved_units,budget:limit(env),totalAdmissions:row.total_admissions,lastAdmissionMs:row.last_admission_ms}:{mode:'UNARMED'};
 }catch{return{mode:'UNAVAILABLE'};}
}
