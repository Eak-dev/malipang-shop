import type {SheetsSyncJob} from '../types';
import {readFailedDailyIncidentEvidence,dailyFailedPayloadDigest} from './exact-daily-proof-evidence';
import {dailyIncidentScope,verifiedHeldDailyGuard} from './exact-daily-settlement';
import {normalExpenseEpochStatements} from '../sheets/continuous-normal-recovery';
import {parkedAuditAction,parkedPilotEnabled,parkedSourceJoins,pilotWriteJoins,type ParkedPilotEnv} from '../sheets/parked-notice-adoption';
import {stableNoticeStyleFingerprint} from '../sheets/stable-edit-notice';
import {ReviewRequestBudget} from '../sheets/review-request-budget';
import {assertContinuousDailyActivated} from '../sheets/continuous-daily-route';
import {readObservedDailyIncidentSource} from '../sheets/stable-expense-source';
import {proveDailyProviderPostimage} from '../sheets/exact-daily-provider-proof';

const digest=/^[0-9a-f]{64}$/;
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
type Select={jobId:string;fingerprint:string};
type Action=Select & ({action:'INSPECT_HANDOVER'}|{action:'FINISH_STATUS'}|{action:'HANDOVER_ONE';preimageDigest:string;ownerSupervising:true;externalWritersFenced:true});
export function parseParkedPilot(value:unknown):Action|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const v=value as Record<string,unknown>,n=Object.keys(v).length;
 if(typeof v.jobId!=='string'||!uuid.test(v.jobId)||typeof v.fingerprint!=='string'||!digest.test(v.fingerprint))return null;
 const select={jobId:v.jobId,fingerprint:v.fingerprint};
 if((v.action==='INSPECT_HANDOVER'||v.action==='FINISH_STATUS')&&n===3)return {...select,action:v.action};
 if(v.action==='HANDOVER_ONE'&&n===6&&typeof v.preimageDigest==='string'&&digest.test(v.preimageDigest)&&v.externalWritersFenced===true&&v.ownerSupervising===true)
  return {...select,action:v.action,preimageDigest:v.preimageDigest,externalWritersFenced:true,ownerSupervising:true};
 return null;
}

async function inspect(env:ParkedPilotEnv,action:Select){
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,args=[parkedAuditAction,action.jobId,action.fingerprint,book];
 const any=await db.prepare("SELECT count(*) n FROM admin_audit WHERE action=? AND entity_key=? AND reason=? AND json_extract(before_json,'$.book')=?").bind(...args).first<{n:number}>();
 if(any?.n===0)return 'ABSENT';
 if(any?.n!==1)return 'HELD';
 const row=await db.prepare(`SELECT c.phase,c.state AS claim_state,o.state AS operation,ep.state epoch,j.status job,
 CASE WHEN j.lease_token IS NOT NULL AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 1 ELSE 0 END leased,
 CASE WHEN j.attempt_count=0 AND j.lease_token IS NULL AND j.lease_until IS NULL THEN 1 ELSE 0 END untouched,

 EXISTS(SELECT 1 FROM stable_projection_writes p ${pilotWriteJoins} JOIN stable_expense_projection_preimages pi ON pi.spreadsheet_id=p.spreadsheet_id AND pi.entity_type=p.entity_type AND pi.entity_id=p.entity_id AND pi.projection=p.projection AND pi.source_version=p.source_version AND pi.source_digest=p.source_digest AND pi.sheet_id=p.sheet_id AND pi.sheet_name=p.sheet_name
 WHERE p.spreadsheet_id=w.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=j.entity_key AND p.source_version=j.entity_version AND p.projection='DAILY' AND p.operation_token=json_extract(a.after_json,'$.token') AND p.state='VERIFIED') daily
 FROM admin_audit a ${parkedSourceJoins}
 LEFT JOIN stable_workbook_claims c ON c.spreadsheet_id=ep.spreadsheet_id AND c.operation_token=json_extract(a.after_json,'$.token')
 LEFT JOIN stable_recovery_operations o ON o.epoch_id=ep.epoch_id AND o.operation_token=json_extract(a.after_json,'$.token')
 WHERE a.action=? AND a.entity_key=? AND a.reason=? AND w.spreadsheet_id=?`).bind(...args).first<{phase:string|null;claim_state:string|null;operation:string|null;daily:number;epoch:string;job:string;leased:number;untouched:number}>();
 if(row?.operation==='VERIFIED'&&row.daily===1&&row.claim_state===null)return 'STAGE_VERIFIED';
 if(row?.claim_state==='HELD'&&row.phase==='PILOT_RESERVED'&&row.operation===null&&row.epoch==='ARMED'&&(row.job==='PENDING'&&row.untouched===1||row.job==='PROCESSING'&&row.leased===1))return 'RESERVED';
 if(row?.claim_state==='HELD'&&row.phase==='PILOT_ADOPTED'&&row.operation==='ADMITTED'&&row.epoch==='ARMED'&&row.job==='PROCESSING'&&row.leased===1)return 'ADOPTED';
 return 'HELD';
}

/** Read one D1 snapshot. A verified first stage can coexist with a failed later
 * stage. Only FINAL closes both the job and its epoch; the runner then compares
 * the displayed DAILY row against D1 in a separate provider read. */
async function finishStatus(env:ParkedPilotEnv,action:Select,version:string){
 const result=await env.DB.prepare(`WITH audits AS (
   SELECT * FROM admin_audit WHERE action=?
 ), target AS (
   SELECT j.entity_key AS expense,j.status AS job,j.last_error,j.lease_token,j.lease_until,j.next_attempt_at,
          ep.epoch_id,ep.state AS epoch,w.spreadsheet_id AS book,json_extract(a.after_json,'$.token') AS token
   FROM audits a ${parkedSourceJoins}
   JOIN expense_events e ON e.expense_id=j.entity_key AND e.version=1 AND e.status='CONFIRMED'
   WHERE a.entity_key=? AND a.reason=? AND w.spreadsheet_id=? AND json_extract(a.after_json,'$.version')=?
     AND ep.epoch_id GLOB 'normal_pilot296_*' AND w.sheet_id=? AND w.sheet_name=?
 ), expected AS (
   SELECT expense AS entity_id,'DAILY' AS projection,? AS sheet_name,? AS sheet_id FROM target
   UNION ALL SELECT expense,'EXPENSE_RAW',?,? FROM target
   UNION ALL SELECT t.expense||'|'||item.item_id,'DETAIL',?,?
     FROM target t JOIN expense_document_items item ON item.expense_id=t.expense
 ), written AS (
   SELECT p.* FROM target t JOIN stable_projection_writes p ON p.spreadsheet_id=t.book AND p.entity_type='EXPENSE'
     AND (p.entity_id=t.expense OR substr(p.entity_id,1,length(t.expense)+1)=t.expense||'|')
 ), verified AS (
   SELECT p.entity_id,p.projection FROM target t JOIN written p ON p.source_version=1 AND p.state='VERIFIED'
   JOIN expected e ON e.projection=p.projection AND e.entity_id=p.entity_id
     AND e.sheet_name=p.sheet_name AND p.sheet_id=e.sheet_id
   JOIN stable_recovery_operations o ON o.epoch_id=t.epoch_id AND o.operation_token=p.operation_token AND o.state='VERIFIED'
   JOIN stable_expense_projection_preimages pi ON pi.spreadsheet_id=p.spreadsheet_id AND pi.entity_type=p.entity_type
     AND pi.entity_id=p.entity_id AND pi.projection=p.projection AND pi.sheet_id=p.sheet_id AND pi.sheet_name=p.sheet_name
     AND pi.source_version=p.source_version AND pi.source_digest=p.source_digest
   WHERE p.projection<>'DAILY' OR (p.operation_token=t.token AND EXISTS (
     SELECT 1 FROM (SELECT 1) marker_evidence ${pilotWriteJoins}))
 )
 SELECT (SELECT count(*) FROM audits) AS audit_count,(SELECT count(*) FROM target) AS target_count,t.job,t.epoch,
   t.lease_token IS NULL AND t.lease_until IS NULL AS unleased,
   t.lease_token IS NOT NULL AND t.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AS leased,
   t.last_error IS NULL AND t.next_attempt_at IS NULL AS clean,
   (SELECT state FROM stable_workbook_claims c WHERE c.spreadsheet_id=t.book AND
     (c.operation_token=t.token OR c.operation_token IN (SELECT operation_token FROM stable_recovery_operations WHERE epoch_id=t.epoch_id))) AS claim,
   EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.status='OPEN'
     AND f.job_key='EXPENSE:'||t.expense||':1') AS open_failure,
   EXISTS(SELECT 1 FROM stable_recovery_operations o WHERE o.epoch_id=t.epoch_id AND o.state<>'VERIFIED') AS unfinished,
   (SELECT count(*) FROM written)=(SELECT count(*) FROM expected)
     AND (SELECT count(DISTINCT source_digest) FROM written)=1
     AND NOT EXISTS(SELECT entity_id,projection FROM expected EXCEPT SELECT entity_id,projection FROM verified) AS all_written
 FROM (SELECT 1) anchor LEFT JOIN target t ON 1=1 LIMIT 2`)
  .bind(parkedAuditAction,action.jobId,action.fingerprint,env.GOOGLE_SPREADSHEET_ID,version,
   Number(env.CONTINUOUS_DAILY_SHEET_ID),env.CONTINUOUS_DAILY_SHEET,
   env.CONTINUOUS_DAILY_SHEET,Number(env.CONTINUOUS_DAILY_SHEET_ID),env.CONTINUOUS_RAW_SHEET,Number(env.CONTINUOUS_RAW_SHEET_ID),
   env.CONTINUOUS_DETAIL_SHEET,Number(env.CONTINUOUS_DETAIL_SHEET_ID))
  .all<{audit_count:number;target_count:number;job:string|null;epoch:string|null;unleased:number;leased:number;clean:number;
   claim:string|null;open_failure:number;unfinished:number;all_written:number}>();
 const row=result.results?.[0];
 if(result.success!==true||result.results?.length!==1||!row)return 'UNVERIFIED';
 if(row.audit_count===0&&row.target_count===0)return 'NOT_STARTED';
 if(row.audit_count!==1||row.target_count!==1)return 'UNVERIFIED';
 if(row.job==='FAILED')return 'JOB_FAILED';
 if(row.job==='REVIEW'||row.epoch==='REVIEW'||row.claim==='REVIEW')return 'JOB_REVIEW';
 if(row.open_failure!==0)return 'UNVERIFIED';
 if(row.epoch==='ARMED'&&((row.job==='PENDING'&&row.unleased===1)||(row.job==='PROCESSING'&&row.leased===1)))return 'IN_PROGRESS';
 // FINAL commits the job, verifies the operation, closes the epoch and releases
 // the claim in separate steps. A reader may observe an orderly close in between.
 if(row.job==='COMPLETED'&&row.unleased===1&&row.clean===1&&row.all_written===1){
  if(row.epoch==='COMPLETE'&&row.claim===null&&row.unfinished===0)return 'JOB_COMPLETE';
  if(row.claim==='HELD'&&(row.epoch==='ARMED'||row.epoch==='COMPLETE'&&row.unfinished===0))return 'IN_PROGRESS';
 }
 return 'UNVERIFIED';
}

export async function operateParkedPilot(env:ParkedPilotEnv,action:Action,version:string){
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 const prior=dailyIncidentScope(env);
 const valid=()=>env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&dailyIncidentScope(env)===prior&&parkedPilotEnabled(env,version);
 if(action.action==='FINISH_STATUS'){
  try{
   const outcome=valid()?await finishStatus(env,action,version):'UNVERIFIED';
   if(valid()&&outcome!=='UNVERIFIED')return {ok:true,outcome};
  }catch{/* Lack of D1 proof ends this read-only observation. */}
  return {ok:false,outcome:'UNVERIFIED'};
 }
 const held=()=>({ok:false,outcome:'HELD'});let submitted=false;
 if(!valid()||!book)return held();
 try{
  if(action.action==='INSPECT_HANDOVER'){const outcome=await inspect(env,action);return valid()?{ok:true,outcome}:held();}
  const e=await readFailedDailyIncidentEvidence(env,action.fingerprint);
  if(!e||e.projection_state!=='VERIFIED'||!valid())return held();
  const guard=verifiedHeldDailyGuard(e,action.preimageDigest);
  const job:SheetsSyncJob={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:e.entity_id,entityVersion:e.source_version,traceId:e.trace_id};
  const readSource=()=>readObservedDailyIncidentSource(env,job,e.claim_token,e.source_digest,e.marker,'VERIFIED');
  const source=await readSource(),target=await assertContinuousDailyActivated(env);
  if(!source||source.revision!==e.source_revision||!target||target.sheetId!==e.sheet_id||target.sheet!==e.sheet_name||!valid())return held();
  const budget=new ReviewRequestBudget(48,'invocation'),notice=()=>stableNoticeStyleFingerprint(env,e.notice_identity,'พักแก้ไฟล์',e.notice_stamp,budget,true);
  const style=await notice();
  if(!style||!valid())return held();
  const proof=await proveDailyProviderPostimage(env,job,e.claim_token,{...e,operation_token:e.claim_token},source,target,{kind:'continuous-expense',budget},
   valid,readSource,async()=>await notice()===style,true,()=>{},true);
  const row=proof?.snapshot.formula[e.target_row-1];
  if(!row||row.length>e.before_columns||await dailyFailedPayloadDigest(JSON.stringify(Array.from({length:e.before_columns},(_,i)=>row[i]===''||row[i]===undefined?null:row[i])))!==action.preimageDigest||!valid())return held();

  const now=new Date().toISOString(),epoch='normal_pilot296_'+crypto.randomUUID(),token=crypto.randomUUID();
  const before=JSON.stringify({book,oldToken:e.claim_token,job:e.job_id,failed:e.failed_id,failedUpdated:e.failed_updated,
   stamp:e.notice_stamp,identity:e.notice_identity,style,revision:e.source_revision,preimage:action.preimageDigest});
  const auditId='issue296:parked:'+e.claim_token,after=JSON.stringify({version,epoch,token});
  const advance=db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid','$') END AS ok");
  const [arm,admit]=normalExpenseEpochStatements(env,epoch,now,action.jobId);
  if(!arm||!admit||!valid())return held();
  // Each step is required. A zero-row delete, admission or reservation aborts
  // the entire D1 batch; a provider call is never made by this transaction.
  submitted=true;
  const result=await db.batch([
   db.prepare(`INSERT INTO admin_audit(id,action,entity_key,reason,before_json,after_json,created_at) SELECT ?,?,?,?,?,?,? WHERE ${guard.sql}
    AND NOT EXISTS(SELECT 1 FROM admin_audit WHERE action=?)`).bind(auditId,parkedAuditAction,action.jobId,action.fingerprint,before,after,now,...guard.args,parkedAuditAction),advance,
   db.prepare("DELETE FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='REVIEW' AND phase='OPERATION' AND review_reason='INSERT_DAILY_SNAPSHOT_UNVERIFIED'").bind(book,e.claim_token),advance,
   arm,advance,admit,advance,
   db.prepare("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,phase,created_at,updated_at) VALUES(?,?,'HELD','PILOT_RESERVED',?,?)").bind(book,token,now,now),advance
  ]);
  if(result.length!==10||result.some(x=>x.success!==true)||!valid())return {ok:false,outcome:'UNCERTAIN'};
  return {ok:true,outcome:'RESERVED'};
 }catch{return submitted?{ok:false,outcome:'UNCERTAIN'}:held();}
}
