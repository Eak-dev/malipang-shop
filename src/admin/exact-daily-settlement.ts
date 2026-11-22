import type {Env, SheetsSyncJob} from '../types';
import {assertContinuousDailyActivated} from '../sheets/continuous-daily-route';
import {proveDailyProviderPostimage} from '../sheets/exact-daily-provider-proof';
import {ReviewRequestBudget} from '../sheets/review-request-budget';
import {stableNoticeStyleFingerprint} from '../sheets/stable-edit-notice';
import {stableExpensePreimageStatement} from '../sheets/stable-expense-preimage';
import {readObservedDailyIncidentSource} from '../sheets/stable-expense-source';
import {
 balancedSqlAnd, DAILY_FAILED_INCIDENT_EVIDENCE_SQL, dailyFailedPayloadDigest,
 failedDailyIncidentFingerprint, readFailedDailyIncidentEvidence, type FailedDailyIncidentEvidence
} from './exact-daily-proof-evidence';

type IncidentEnv = Env & {CONTINUOUS_CANARY_OPERATOR_ENABLED?:string; CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED?:string};
type Operation =
 | {action:'INSPECT'}
 | {action:'PROBE';fingerprint:string}
 | {action:'SETTLE';fingerprint:string;preimageDigest:string;externalWritersFenced:true;ownerSupervising:true};
const hash = /^[a-f0-9]{64}$/;
export function parseExactDailyOperation(value:unknown):Operation|null {
 if(!value || typeof value!=='object' || Array.isArray(value))return null;
 const body=value as Record<string,unknown>, n=Object.keys(body).length;
 if(body.action==='INSPECT' && n===1)return {action:'INSPECT'};
 if(typeof body.fingerprint!=='string' || !hash.test(body.fingerprint))return null;
 if(body.action==='PROBE' && n===2)return {action:'PROBE',fingerprint:body.fingerprint};
 if(body.action==='SETTLE' && n===5 && typeof body.preimageDigest==='string' && hash.test(body.preimageDigest)
   && body.externalWritersFenced===true && body.ownerSupervising===true)
  return {action:'SETTLE',fingerprint:body.fingerprint,preimageDigest:body.preimageDigest,externalWritersFenced:true,ownerSupervising:true};
 return null;
}

const fields = [
 'spreadsheet_id','claim_token','job_id','trace_id','entity_id','source_version','source_revision',
 'source_digest','sheet_id','sheet_name','marker','target_row','before_rows','before_columns',
 'before_digest','payload_digest','notice_stamp','notice_identity','failed_id','failed_queue',
 'failed_trace','failed_key','failed_payload','failed_error','failed_attempts','failed_created',
 'failed_updated','failed_resolved'
] as const satisfies readonly (keyof FailedDailyIncidentEvidence)[];
const match=balancedSqlAnd(fields.map(key=>'proof.'+key+' IS ?'));
const scopeKeys = [
 'GOOGLE_SPREADSHEET_ID','SHEET_EXPENSE_DAILY','SHEET_EXPENSE_RAW','SHEET_PURCHASE_DETAILS','SHEET_ATTENDANCE_RAW',
 'SHEET_DAILY_PAYROLL','SHEET_OT_REQUESTS','SHEET_PERSONAL_USE_RAW','SHEET_SHIFT_SCHEDULE','SHEET_STAFF_CONFIG',
 'SHEET_SYSTEM_LOG','SHEET_WAGE_HISTORY','SHEET_WEEKLY_PAYROLL','CONTINUOUS_REVOKE_REVIEW_CLOSE_ENABLED',
 'CONTINUOUS_PUBLICATION_ENABLED','CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED','CONTINUOUS_CANARY_OPERATOR_ENABLED',
 'CANARY_UNWRITTEN_RECOVERY_ENABLED','EXTERNAL_API_TIMEOUT_MS','GOOGLE_SERVICE_ACCOUNT_EMAIL','GOOGLE_PRIVATE_KEY_BASE64',
 'STABLE_PHASE1_ENABLED','STABLE_CANCELLATION_PREIMAGE_ENABLED','STABLE_RECOVERY_GATE_ENABLED','STABLE_SHEETS_PACING_ENABLED',
 'CONTINUOUS_DAILY_ENABLED','CONTINUOUS_DAILY_SHEET','CONTINUOUS_DAILY_SHEET_ID','CONTINUOUS_RAW_SHEET','CONTINUOUS_RAW_SHEET_ID',
 'CONTINUOUS_DETAIL_SHEET','CONTINUOUS_DETAIL_SHEET_ID','APP_ENV','RUNTIME_MODE','EXACT_DAILY_SETTLEMENT_ENABLED',
 'MONTHLY_REPORT_OPERATOR_ENABLED','CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED','SHEETS_SYNC_ENABLED'
] as const satisfies readonly (keyof IncidentEnv)[];
export function dailyIncidentScope(env:IncidentEnv):string{
 return JSON.stringify([env.CF_VERSION_METADATA?.id,...scopeKeys.map(k=>env[k])]);
}
const off=(value:string|undefined)=>value===undefined||value==='false';
const storedPreimage=`SELECT preimage_digest FROM stable_expense_projection_preimages WHERE spreadsheet_id=?
 AND entity_type='EXPENSE' AND entity_id=? AND projection='DAILY' AND sheet_id=? AND sheet_name=?
 AND source_version=? AND source_digest=? AND preimage_width=?`;

function exactEvidenceGuard(e:FailedDailyIncidentEvidence){
 return {
  sql:`EXISTS(SELECT 1 FROM (${DAILY_FAILED_INCIDENT_EVIDENCE_SQL}) proof WHERE proof.projection_state=? AND ${match})`,
  args:[e.spreadsheet_id,e.projection_state,...fields.map(key=>e[key])]
 };
}

/** Atomic D1 predicate for the same verified projection and immutable preimage while both original holds remain. */
export function verifiedHeldDailyGuard(e:FailedDailyIncidentEvidence,preimageDigest:string){
 if(e.projection_state!=='VERIFIED'||!hash.test(preimageDigest))throw Error('EXACT_HELD_DAILY_INVALID');
 const guard=exactEvidenceGuard(e);
 return {sql:`(${guard.sql} AND EXISTS(${storedPreimage} AND preimage_digest=?))`,
  args:[...guard.args,e.spreadsheet_id,e.entity_id,e.sheet_id,e.sheet_name,e.source_version,e.source_digest,e.before_columns,preimageDigest]};
}

/** D1-only settlement of a previously dispatched projection. The claim, source, failed job
 * and sync job stay held. The immutable preimage and original one-way journal transition
 * commit together. An uncertain acknowledgment is reconciled using INSPECT. */
export async function operateExactDailySettlement(env:IncidentEnv,operation:Operation,expectedVersion:string){
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 const scope=()=>dailyIncidentScope(env);
 const initial=scope(),stable=()=>env.DB===db&&scope()===initial;
 let stage='CONFIG',dispatched=false;
 const held=()=>({ok:false,outcome:dispatched?'UNCERTAIN' as const:'HELD' as const,stage});
 if(!expectedVersion || env.CF_VERSION_METADATA?.id!==expectedVersion || !book ||
    env.EXACT_DAILY_SETTLEMENT_ENABLED!=='true' || env.STABLE_PHASE1_ENABLED!=='true' ||
    env.STABLE_CANCELLATION_PREIMAGE_ENABLED!=='true' || env.STABLE_SHEETS_PACING_ENABLED!=='true' ||
    env.CONTINUOUS_DAILY_ENABLED!=='true' || !['true','false'].includes(env.STABLE_RECOVERY_GATE_ENABLED??'') ||
    ![env.CONTINUOUS_PUBLICATION_ENABLED,env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED,
      env.CONTINUOUS_CANARY_OPERATOR_ENABLED,env.CANARY_UNWRITTEN_RECOVERY_ENABLED].every(off))return held();
 if(operation.action==='SETTLE' && (env.STABLE_RECOVERY_GATE_ENABLED!=='true' ||
   !off(env.MONTHLY_REPORT_OPERATOR_ENABLED) || !off(env.CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED)))return held();
 try {
  stage='INCIDENT';
  const e=await readFailedDailyIncidentEvidence(env,operation.action==='INSPECT'?undefined:operation.fingerprint);
  if(!e||!stable())return held();
  const fingerprint=await failedDailyIncidentFingerprint(e);
  const args=[book,e.entity_id,e.sheet_id,e.sheet_name,e.source_version,e.source_digest,e.before_columns];
  const prior=await db.prepare(storedPreimage).bind(...args).first<{preimage_digest:string}>();
  if(!stable() || (e.projection_state==='VERIFIED'? !prior || !hash.test(prior.preimage_digest) : !!prior))return held();
  if(operation.action==='INSPECT'){
   const again=await readFailedDailyIncidentEvidence(env,fingerprint);
   if(!again||JSON.stringify(e)!==JSON.stringify(again)||!stable())return held();
   return {ok:true,outcome:'INSPECTED' as const,fingerprint,projectionState:e.projection_state,preimageDigest:prior?.preimage_digest??null};
  }
  if(e.projection_state!=='IN_FLIGHT')return held();
  stage='SOURCE';
  const job:SheetsSyncJob={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:e.entity_id,entityVersion:e.source_version,traceId:e.trace_id};
  const readSource=()=>readObservedDailyIncidentSource(env,job,e.claim_token,e.source_digest,e.marker);
  const source=await readSource(),target=await assertContinuousDailyActivated(env);
  if(!source||source.revision!==e.source_revision||source.digest!==e.source_digest||!target||target.sheetId!==e.sheet_id||target.sheet!==e.sheet_name||!stable())return held();
  stage='NOTICE';
  const budget=new ReviewRequestBudget(48,'invocation'),policy={kind:'continuous-expense' as const,budget};
  const notice=()=>stableNoticeStyleFingerprint(env,e.notice_identity,'พักแก้ไฟล์',e.notice_stamp,budget,true);
  const style=await notice();
  if(!style||!stable())return held();
  const proof=await proveDailyProviderPostimage(env,job,e.claim_token,{...e,operation_token:e.claim_token},source,target,policy,
   stable,readSource,async()=>await notice()===style,true,next=>{stage=next},true);
  if(!proof||!stable())return held();
  stage='PREIMAGE';
  const row=proof.snapshot.formula[e.target_row-1];
  if(!row||row.length>e.before_columns)return held();
  const cells=Array.from({length:e.before_columns},(_,i)=>row[i]===undefined||row[i]===''?null:row[i]);
  const preimageDigest=await dailyFailedPayloadDigest(JSON.stringify(cells));
  const latest=await readFailedDailyIncidentEvidence(env,fingerprint);
  if(!latest || JSON.stringify(latest)!==JSON.stringify(e) || !stable())return held();
  if(operation.action==='PROBE')return {ok:true,outcome:'MATCHED' as const,fingerprint,preimageDigest};
  if(operation.preimageDigest!==preimageDigest)return held();

  stage='SETTLEMENT';
  const preimage=await stableExpensePreimageStatement(env,{book,entity:e.entity_id,projection:'DAILY',sheetId:e.sheet_id,
   sheetName:e.sheet_name,version:e.source_version,sourceDigest:e.source_digest,row,width:e.before_columns});
  if(!preimage||!stable())return held();
  const guard=exactEvidenceGuard(e);
  const update=db.prepare(`UPDATE stable_projection_writes SET state='VERIFIED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND projection='DAILY' AND entity_id=? AND operation_token=?
    AND state='IN_FLIGHT' AND ${guard.sql}
   RETURNING 1 AS changed`).bind(book,e.entity_id,e.claim_token,...guard.args);
  // Fail the *transaction* if either CAS or immutable preimage did not land. Do not rely on
  // meta.changes (which can include trigger side effects) or on JavaScript after commit.
  const assertion=db.prepare(`SELECT CASE WHEN changes()=1 AND EXISTS(${storedPreimage} AND preimage_digest=?)
    THEN 1 ELSE json_extract('invalid-json','$') END AS ok`).bind(...args,preimageDigest);
  dispatched=true;
  const result=await db.batch<{ok?:number;changed?:number}>([update,preimage,assertion]);
  if(!stable() || result.length!==3 || !result.every(x=>x.success===true) ||
    result[0]?.results?.length!==1 || result[2]?.results?.[0]?.ok!==1)return held();
  stage='READBACK';
  const after=await readFailedDailyIncidentEvidence(env,fingerprint);
  const receipt=await db.prepare(storedPreimage).bind(...args).first<{preimage_digest:string}>();
  if(!after||JSON.stringify({...after,projection_state:e.projection_state})!==JSON.stringify(e)||
     after.projection_state!=='VERIFIED'||receipt?.preimage_digest!==preimageDigest||!stable())return held();
  return {ok:true,outcome:'SETTLED' as const,fingerprint,preimageDigest};
 }catch{return held();}
}
