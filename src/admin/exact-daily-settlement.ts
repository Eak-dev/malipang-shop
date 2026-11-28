import type {Env, SheetsSyncJob} from '../types';
import {assertContinuousDailyActivated} from '../sheets/continuous-daily-route';
import {proveDailyProviderPostimage} from '../sheets/exact-daily-provider-proof';
import {historicalDailyReceiptDigest,parseHistoricalDailyReceipt,type HistoricalDailyReceipt} from '../sheets/exact-daily-historical-receipt';
import {ReviewRequestBudget} from '../sheets/review-request-budget';
import {stableNoticeStyleFingerprint} from '../sheets/stable-edit-notice';
import {stableExpensePreimageStatement} from '../sheets/stable-expense-preimage';
import {readObservedDailyIncidentSource} from '../sheets/stable-expense-source';
import {
 balancedSqlAnd, DAILY_FAILED_INCIDENT_EVIDENCE_SQL, dailyFailedPayloadDigest,
 failedDailyIncidentFingerprint, readFailedDailyIncidentEvidence, type FailedDailyIncidentEvidence
} from './exact-daily-proof-evidence';

type IncidentEnv = Env & {CONTINUOUS_CANARY_OPERATOR_ENABLED?:string; CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED?:string};
type SettlementObservations={fingerprint:string;preimageDigest:string;externalWritersFenced:true;ownerSupervising:true};
type Operation =
 | {action:'INSPECT'}
 | {action:'INSPECT_HISTORICAL';fingerprint:string}
 | {action:'PROBE';fingerprint:string;historicalReceipt?:HistoricalDailyReceipt}
 | ({action:'SETTLE'}&SettlementObservations)
 | ({action:'SETTLE_HISTORICAL';historicalReceipt:HistoricalDailyReceipt}&SettlementObservations);
const hash = /^[a-f0-9]{64}$/;
export function parseExactDailyOperation(value:unknown):Operation|null {
 if(!value || typeof value!=='object' || Array.isArray(value))return null;
 const body=value as Record<string,unknown>, n=Object.keys(body).length;
 if(body.action==='INSPECT' && n===1)return {action:'INSPECT'};
 if(typeof body.fingerprint!=='string' || !hash.test(body.fingerprint))return null;
 if(body.action==='INSPECT_HISTORICAL'&&n===2)return {action:'INSPECT_HISTORICAL',fingerprint:body.fingerprint};
 if(body.action==='PROBE' && n===2)return {action:'PROBE',fingerprint:body.fingerprint};
 if(body.action==='PROBE' && n===3){
  const historicalReceipt=parseHistoricalDailyReceipt(body.historicalReceipt);
  if(historicalReceipt?.incidentFingerprint===body.fingerprint)return {action:'PROBE',fingerprint:body.fingerprint,historicalReceipt};
 }
 if(typeof body.preimageDigest==='string'&&hash.test(body.preimageDigest)&&body.externalWritersFenced===true&&body.ownerSupervising===true){
  const observations={fingerprint:body.fingerprint,preimageDigest:body.preimageDigest,externalWritersFenced:true,ownerSupervising:true} as const;
  if(body.action==='SETTLE'&&n===5)return {action:'SETTLE',...observations};
  if(body.action==='SETTLE_HISTORICAL'&&n===6){
   const historicalReceipt=parseHistoricalDailyReceipt(body.historicalReceipt);
   if(historicalReceipt?.incidentFingerprint===body.fingerprint)return {action:'SETTLE_HISTORICAL',...observations,historicalReceipt};
  }
 }
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
 'MONTHLY_REPORT_OPERATOR_ENABLED','CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED','SHEETS_SYNC_ENABLED',
 'EXACT_DAILY_HISTORICAL_RECEIPT_SHA256','EXACT_DAILY_HISTORICAL_SETTLEMENT_SHA256','CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED',
 'CONTINUOUS_REVIEW_CLOSE_ENABLED','CONTINUOUS_NOTICE_DISPATCH_ENABLED'
] as const satisfies readonly (keyof IncidentEnv)[];
export function dailyIncidentScope(env:IncidentEnv):string{
 return JSON.stringify([env.CF_VERSION_METADATA?.id,...scopeKeys.map(k=>env[k])]);
}
const off=(value:string|undefined)=>value===undefined||value==='false';
const storedPreimage=`SELECT preimage_digest FROM stable_expense_projection_preimages WHERE spreadsheet_id=?
 AND entity_type='EXPENSE' AND entity_id=? AND projection='DAILY' AND sheet_id=? AND sheet_name=?
 AND source_version=? AND source_digest=? AND preimage_width=?`;
const historicalAuditAction='ISSUE296_HISTORICAL_DAILY_SETTLED';
const historicalAuditReason='APPROVED_HISTORICAL_DAILY_RECEIPT';
const historicalAuditId=(e:FailedDailyIncidentEvidence)=>'issue296:historical-daily:'+JSON.stringify([e.spreadsheet_id,e.claim_token]);
const historicalAuditGuard=`(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='admin_audit' AND name IN
 ('issue296_historical_daily_audit_no_update','issue296_historical_daily_audit_no_delete','issue296_historical_daily_audit_no_replace'))=3`;
const historicalAuditProof=`SELECT 1 FROM admin_audit WHERE id=? AND action=? AND entity_key=? AND reason=? AND before_json IS NULL AND after_json=?`;
const historicalAuditArgs=(e:FailedDailyIncidentEvidence,receipt:string,approval:string,preimage:string)=>
 [historicalAuditId(e),historicalAuditAction,e.entity_id,historicalAuditReason,JSON.stringify([receipt,approval,preimage])];

export function historicalDailySettlementDigest(fingerprint:string,receipt:string,preimage:string):Promise<string>{
 return dailyFailedPayloadDigest(JSON.stringify(['issue296-historical-daily-settlement-v1',fingerprint,receipt,preimage]));
}

async function readHistoricalSettlement(env:IncidentEnv,e:FailedDailyIncidentEvidence,fingerprint:string,preimage:string|null,
 receiptPin:string|undefined,settlementPin:string|undefined){
 const db=env.DB;
 const row=await db.prepare('SELECT action,entity_key,reason,before_json,after_json FROM admin_audit WHERE id=?')
  .bind(historicalAuditId(e)).first<{action:string;entity_key:string;reason:string;before_json:string|null;after_json:string}>();
 if(!row)return e.projection_state==='IN_FLIGHT'?{historicalReceiptDigest:null,historicalSettlementDigest:null}:null;
 if(e.projection_state!=='VERIFIED'||!preimage||row.action!==historicalAuditAction||row.entity_key!==e.entity_id||
  row.reason!==historicalAuditReason||row.before_json!==null)return null;
 const values:unknown=JSON.parse(row.after_json);
 if(!Array.isArray(values)||values.length!==3)return null;
 const [receipt,approval,savedPreimage]=values;
 if(typeof receipt!=='string'||!hash.test(receipt)||typeof approval!=='string'||!hash.test(approval)||savedPreimage!==preimage||
  (receiptPin!==undefined&&receipt!==receiptPin)||(settlementPin!==undefined&&approval!==settlementPin)||
  await historicalDailySettlementDigest(fingerprint,receipt,preimage)!==approval)return null;
 return {historicalReceiptDigest:receipt,historicalSettlementDigest:approval};
}

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
 return {sql:`(${guard.sql} AND EXISTS(${storedPreimage} AND preimage_digest=?) AND NOT EXISTS(SELECT 1 FROM admin_audit WHERE id=?))`,
  args:[...guard.args,e.spreadsheet_id,e.entity_id,e.sheet_id,e.sheet_name,e.source_version,e.source_digest,e.before_columns,preimageDigest,historicalAuditId(e)]};
}

/** D1-only settlement of a previously dispatched projection. The claim, source, failed job
 * and sync job stay held. The immutable preimage and original one-way journal transition
 * commit together. An uncertain acknowledgment is reconciled using INSPECT. */
export async function operateExactDailySettlement(env:IncidentEnv,operation:Operation,expectedVersion:string){
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 const receiptPin=env.EXACT_DAILY_HISTORICAL_RECEIPT_SHA256;
 const probeOnly=receiptPin!==undefined;
 const settlementPin=env.EXACT_DAILY_HISTORICAL_SETTLEMENT_SHA256;
 const scope=()=>dailyIncidentScope(env);
 const initial=scope(),stable=()=>env.DB===db&&scope()===initial;
 let stage='CONFIG',dispatched=false;
 const held=()=>({ok:false,outcome:dispatched?'UNCERTAIN' as const:'HELD' as const,stage});
 if(!expectedVersion || env.CF_VERSION_METADATA?.id!==expectedVersion || !book ||
    (!probeOnly&&env.EXACT_DAILY_SETTLEMENT_ENABLED!=='true') || env.STABLE_PHASE1_ENABLED!=='true' ||
    env.STABLE_CANCELLATION_PREIMAGE_ENABLED!=='true' || env.STABLE_SHEETS_PACING_ENABLED!=='true' ||
    env.CONTINUOUS_DAILY_ENABLED!=='true' || !['true','false'].includes(env.STABLE_RECOVERY_GATE_ENABLED??'') ||
    ![env.CONTINUOUS_PUBLICATION_ENABLED,env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED,
      env.CONTINUOUS_CANARY_OPERATOR_ENABLED,env.CANARY_UNWRITTEN_RECOVERY_ENABLED].every(off))return held();
 try {
  const historical=operation.action==='PROBE'||operation.action==='SETTLE_HISTORICAL'?operation.historicalReceipt:undefined;
  if(probeOnly||historical){
   stage='HISTORICAL_RECEIPT';
   if(operation.action==='INSPECT_HISTORICAL'){
    if(env.EXACT_DAILY_SETTLEMENT_ENABLED!=='true'||!receiptPin||!hash.test(receiptPin))return held();
   }else if((operation.action!=='PROBE'&&operation.action!=='SETTLE_HISTORICAL')||
    !historical||!receiptPin||!hash.test(receiptPin)||historical.incidentFingerprint!==operation.fingerprint||
    await historicalDailyReceiptDigest(historical)!==receiptPin||!stable())return held();
  }
  stage='CONFIG';
  if((operation.action==='SETTLE'||operation.action==='SETTLE_HISTORICAL') && (env.STABLE_RECOVERY_GATE_ENABLED!=='true' ||
    !off(env.MONTHLY_REPORT_OPERATOR_ENABLED) || !off(env.CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED)))return held();
  if(operation.action==='SETTLE_HISTORICAL'){
   if(env.EXACT_DAILY_SETTLEMENT_ENABLED!=='true'||
    ![env.CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED,env.CONTINUOUS_REVIEW_CLOSE_ENABLED,
      env.CONTINUOUS_REVOKE_REVIEW_CLOSE_ENABLED,env.CONTINUOUS_NOTICE_DISPATCH_ENABLED].every(off))return held();
   stage='HISTORICAL_SETTLEMENT_APPROVAL';
   if(!historical||!receiptPin||!settlementPin||!hash.test(settlementPin)||
    await historicalDailySettlementDigest(operation.fingerprint,receiptPin,operation.preimageDigest)!==settlementPin||!stable())return held();
  }
  if(operation.action==='SETTLE_HISTORICAL'||operation.action==='INSPECT_HISTORICAL'){
   stage='HISTORICAL_AUDIT_GUARD';
   if(!await db.prepare(`SELECT 1 AS ok WHERE ${historicalAuditGuard}`).first()||!stable())return held();
  }
  stage='INCIDENT';
  const e=await readFailedDailyIncidentEvidence(env,operation.action==='INSPECT'?undefined:operation.fingerprint);
  if(!e||!stable())return held();
  const fingerprint=await failedDailyIncidentFingerprint(e);
  const args=[book,e.entity_id,e.sheet_id,e.sheet_name,e.source_version,e.source_digest,e.before_columns];
  const prior=await db.prepare(storedPreimage).bind(...args).first<{preimage_digest:string}>();
  if(!stable() || (e.projection_state==='VERIFIED'? !prior || !hash.test(prior.preimage_digest) : !!prior))return held();
  if(operation.action==='INSPECT'||operation.action==='INSPECT_HISTORICAL'){
   const preimageDigest=prior?.preimage_digest??null;
   const historicalResult=operation.action==='INSPECT_HISTORICAL'?await readHistoricalSettlement(env,e,fingerprint,preimageDigest,receiptPin,settlementPin):
    e.projection_state==='VERIFIED'&&await db.prepare('SELECT 1 FROM admin_audit WHERE id=?').bind(historicalAuditId(e)).first()?
     {proofKind:'HISTORICAL' as const}:{};
   const again=await readFailedDailyIncidentEvidence(env,fingerprint);
   if(!historicalResult||!again||JSON.stringify(e)!==JSON.stringify(again)||!stable())return held();
   return {ok:true,outcome:'INSPECTED' as const,fingerprint,projectionState:e.projection_state,preimageDigest,...historicalResult};
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
   stable,readSource,async()=>await notice()===style,true,next=>{stage=next},true,historical?{fingerprint,receipt:historical}:undefined);
  if(!proof||!stable())return held();
  stage='PREIMAGE';
  const row=proof.snapshot.formula[e.target_row-1];
  if(!row||row.length>e.before_columns)return held();
  const cells=Array.from({length:e.before_columns},(_,i)=>row[i]===undefined||row[i]===''?null:row[i]);
  const preimageDigest=await dailyFailedPayloadDigest(JSON.stringify(cells));
  const latest=await readFailedDailyIncidentEvidence(env,fingerprint);
  if(!latest || JSON.stringify(latest)!==JSON.stringify(e) || !stable())return held();
  if(operation.action==='PROBE')return {ok:true,outcome:'MATCHED' as const,fingerprint,preimageDigest,
   ...(historical?{historicalReceiptDigest:receiptPin}:{})};
  if(operation.preimageDigest!==preimageDigest)return held();

  stage='SETTLEMENT';
  const preimage=await stableExpensePreimageStatement(env,{book,entity:e.entity_id,projection:'DAILY',sheetId:e.sheet_id,
   sheetName:e.sheet_name,version:e.source_version,sourceDigest:e.source_digest,row,width:e.before_columns});
  if(!preimage||!stable())return held();
  const guard=exactEvidenceGuard(e);
  const audit=operation.action==='SETTLE_HISTORICAL'&&receiptPin&&settlementPin?
   historicalAuditArgs(e,receiptPin,settlementPin,preimageDigest):null;
  const update=db.prepare(`UPDATE stable_projection_writes SET state='VERIFIED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND projection='DAILY' AND entity_id=? AND operation_token=?
    AND state='IN_FLIGHT' AND ${guard.sql} AND NOT EXISTS(SELECT 1 FROM admin_audit WHERE id=?) ${audit?`AND ${historicalAuditGuard}`:''}
   RETURNING 1 AS changed`).bind(book,e.entity_id,e.claim_token,...guard.args,historicalAuditId(e));
  const history=audit?db.prepare(`INSERT INTO admin_audit(id,action,entity_key,reason,before_json,after_json,created_at)
   SELECT ?,?,?,?,NULL,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE changes()=1`).bind(...audit):null;
  // Fail the *transaction* if either CAS or immutable preimage did not land. Do not rely on
  // meta.changes (which can include trigger side effects) or on JavaScript after commit.
  const assertion=db.prepare(`SELECT CASE WHEN changes()=1 AND EXISTS(${storedPreimage} AND preimage_digest=?)
    ${audit?`AND ${historicalAuditGuard} AND EXISTS(${historicalAuditProof})`:''} THEN 1 ELSE json_extract('invalid-json','$') END AS ok`).bind(...args,preimageDigest,...(audit??[]));
  const statements=history?[update,preimage,history,assertion]:[update,preimage,assertion];
  dispatched=true;
  const result=await db.batch<{ok?:number;changed?:number}>(statements);
  if(!stable() || result.length!==statements.length || !result.every(x=>x.success===true) ||
    result[0]?.results?.length!==1 || result.at(-1)?.results?.[0]?.ok!==1)return held();
  stage='READBACK';
  const after=await readFailedDailyIncidentEvidence(env,fingerprint);
  const receipt=await db.prepare(storedPreimage).bind(...args).first<{preimage_digest:string}>();
  const recorded=audit?await db.prepare(`${historicalAuditProof} AND ${historicalAuditGuard}`).bind(...audit).first():true;
  if(!after||JSON.stringify({...after,projection_state:e.projection_state})!==JSON.stringify(e)||
     after.projection_state!=='VERIFIED'||receipt?.preimage_digest!==preimageDigest||!recorded||!stable())return held();
  return {ok:true,outcome:'SETTLED' as const,fingerprint,preimageDigest,
   ...(audit?{historicalReceiptDigest:receiptPin,historicalSettlementDigest:settlementPin}:{})};
 }catch{return held();}
}
