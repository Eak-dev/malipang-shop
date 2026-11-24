import type {ParkedPilotEnv} from '../sheets/parked-notice-adoption';
import {parkedAuditAction,serialAuditAction,parkedSourceJoins,pilotWriteJoins} from '../sheets/parked-notice-adoption';
import {stableSourceIntegrity} from '../sheets/stable-source-cutover';
import {dailyFailedPayloadDigest} from './exact-daily-proof-evidence';
import {verifyNormalPilotRow} from './normal-pilot-readback';
import {normalExpenseEpochStatements} from '../sheets/continuous-normal-recovery';

export type PilotIdentity={jobId:string;fingerprint:string};
export type AdvancePilot=PilotIdentity & {action:'ADVANCE_ONE';nextJobId:string;proof:string;ownerSupervising:true;externalWritersFenced:true};

/** Read one D1 snapshot. A verified first stage can coexist with a failed later
 * stage. Only FINAL closes both the job and its epoch; the runner then compares
 * the displayed DAILY row against D1 in a separate provider read. */
const observation=`WITH roots AS (
   SELECT * FROM admin_audit WHERE action=?
 ), audits AS (
   SELECT * FROM roots
   UNION ALL SELECT child.* FROM admin_audit child JOIN roots root
     ON root.reason=child.reason AND json_extract(root.before_json,'$.book')=json_extract(child.before_json,'$.book')
     AND json_extract(root.before_json,'$.oldToken')=json_extract(child.before_json,'$.oldToken')
     WHERE child.action=? AND child.id='issue296:serial:'||json_extract(child.before_json,'$.predecessorJobId')
 ), target AS (
   SELECT j.entity_key AS expense,j.status AS job,j.last_error,j.lease_token,j.lease_until,j.next_attempt_at,
          ep.epoch_id,ep.state AS epoch,w.spreadsheet_id AS book,a.id AS audit_id,
          CASE WHEN a.action=? THEN json_extract(a.after_json,'$.token') ELSE (
            SELECT p.operation_token FROM stable_projection_writes p
            JOIN stable_recovery_operations op ON op.epoch_id=ep.epoch_id AND op.operation_token=p.operation_token
            WHERE p.spreadsheet_id=ep.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=j.entity_key
              AND p.source_version=j.entity_version AND p.projection='DAILY' AND p.sheet_id=w.sheet_id AND p.sheet_name=w.sheet_name
          ) END AS token,
          rev.revision AS revision,json_array(e.expense_id,e.version,e.status,e.transaction_date,e.description,
            e.amount_satang,e.payment_key,e.source_wallet,e.category,e.branch_id,e.updated_at) AS source_fields
   FROM audits a ${parkedSourceJoins}
   JOIN expense_events e ON e.expense_id=j.entity_key AND e.version=1 AND e.status='CONFIRMED'
   JOIN stable_source_revision rev ON rev.singleton=1
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
 ), observed AS (
 SELECT (SELECT count(*) FROM roots) AS audit_count,t.audit_id,t.epoch_id,(SELECT count(*) FROM target) AS target_count,t.job,t.epoch,
   t.revision,${stableSourceIntegrity} AS revision_valid,
   json_array(t.book,t.epoch_id,t.token,t.source_fields,(SELECT min(source_digest) FROM written)) AS proof_inputs,
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
 FROM (SELECT 1) anchor LEFT JOIN target t ON 1=1 LIMIT 2)`;

type Observation={audit_count:number;target_count:number;job:string|null;epoch:string|null;unleased:number;leased:number;clean:number;
   claim:string|null;open_failure:number;unfinished:number;all_written:number;revision:number;revision_valid:number;proof_inputs:string;epoch_id:string};

function bindings(env:ParkedPilotEnv,id:PilotIdentity,version:string){
 return [parkedAuditAction,serialAuditAction,parkedAuditAction,id.jobId,id.fingerprint,env.GOOGLE_SPREADSHEET_ID,version,
  Number(env.CONTINUOUS_DAILY_SHEET_ID),env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET,Number(env.CONTINUOUS_DAILY_SHEET_ID),
  env.CONTINUOUS_RAW_SHEET,Number(env.CONTINUOUS_RAW_SHEET_ID),env.CONTINUOUS_DETAIL_SHEET,Number(env.CONTINUOUS_DETAIL_SHEET_ID)];
}
function completionProof(version:string,id:PilotIdentity,row:Observation){
 return dailyFailedPayloadDigest(JSON.stringify(['pilot-finish-v1',version,id.jobId,id.fingerprint,row.revision,row.proof_inputs]));
}
export async function finishStatus(env:ParkedPilotEnv,action:PilotIdentity,version:string){
 const result=await env.DB.prepare(observation+' SELECT * FROM observed').bind(...bindings(env,action,version)).all<Observation>();
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
  if(row.epoch==='COMPLETE'&&row.claim===null&&row.unfinished===0){
   if(row.revision_valid!==1||!Number.isSafeInteger(row.revision)||row.revision<0)return 'UNVERIFIED';
   const proof=await completionProof(version,action,row);
   return {ok:true,outcome:'JOB_COMPLETE',proof};
  }
  if(row.claim==='HELD'&&(row.epoch==='ARMED'||row.epoch==='COMPLETE'&&row.unfinished===0))return 'IN_PROGRESS';
 }
 return 'UNVERIFIED';
}

// The returned fields are compared again inside the same transaction that opens
// the successor epoch. Only an exact, completed observation can win this CAS.
const complete=`audit_count=1 AND target_count=1 AND job='COMPLETED' AND epoch='COMPLETE'
 AND unleased=1 AND clean=1 AND all_written=1 AND claim IS NULL AND open_failure=0 AND unfinished=0
 AND revision_valid=1`;

export async function advancePilot(env:ParkedPilotEnv,action:AdvancePilot,version:string,valid:()=>boolean){
 const held=()=>({ok:false,outcome:'HELD'}), db=env.DB;
 let submitted=false;
 try{
  if(!valid())return held();
  const first=await finishStatus(env,action,version);
  if(typeof first==='string'||first.proof!==action.proof||!valid())return held();
  if(!await verifyNormalPilotRow(env,action)||!valid())return held();
  const result=await db.prepare(observation+' SELECT * FROM observed WHERE '+complete).bind(...bindings(env,action,version)).all<Observation>();
  const row=result.results?.[0];
  if(result.success!==true||result.results?.length!==1||!row||!row.epoch_id||
     await completionProof(version,action,row)!==action.proof||!valid())return held();
  const epoch='normal_pilot296_'+crypto.randomUUID(),now=new Date().toISOString();
  // One unique child per predecessor, even on concurrent calls, ACK loss or
  // replay after the child completes. Keep A, B, their epochs and audit intact.
  const audit=db.prepare(observation+`
   INSERT INTO admin_audit(id,action,entity_key,reason,before_json,after_json,created_at)
   SELECT ?,?,?,?,json_set(a.before_json,'$.predecessorJobId',?,'$.proof',?),json_object('epoch',?,'version',?),?
   FROM observed t JOIN admin_audit a ON a.id=t.audit_id
   WHERE ${complete} AND t.epoch_id=? AND t.revision=? AND t.proof_inputs=?
     AND NOT EXISTS(SELECT 1 FROM admin_audit child WHERE child.id=?)
     AND NOT EXISTS(SELECT 1 FROM admin_audit existing WHERE existing.action IN (?,?) AND existing.entity_key=?)`);
  const auditId='issue296:serial:'+action.jobId;
  const insert=audit.bind(...bindings(env,action,version),auditId,serialAuditAction,action.nextJobId,action.fingerprint,
   action.jobId,action.proof,epoch,version,now,row.epoch_id,row.revision,row.proof_inputs,auditId,parkedAuditAction,serialAuditAction,action.nextJobId);
  const [arm,admit]=normalExpenseEpochStatements(env,epoch,now,action.nextJobId,row.epoch_id);
  const changed=db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid','$') END AS ok");
  if(!arm||!admit||!valid())return held();
  submitted=true;
  const writes=await db.batch([insert,changed,arm,changed,admit,changed]);
  if(!valid()||writes.length!==6||writes.some(r=>r.success!==true))return {ok:false,outcome:'UNCERTAIN'};
  return {ok:true,outcome:'RESERVED'};
 }catch{return submitted?{ok:false,outcome:'UNCERTAIN'}:held();}
}
