import type {Env,SheetsSyncJob} from "../types";
import {enqueueSheetSync} from "../db/repositories";
import {inspectOwnerCorrectionTargets} from "../sheets/owner-correction-inspection";
import {classifyCorrectionPatchOutcome} from "../sheets/owner-correction-recovery";
import {serializeCorrectionSyncPlan,type CorrectionSyncPlan} from "../sheets/owner-correction-sync-plan";

interface RecoveryPorts{inspect:typeof inspectOwnerCorrectionTargets;enqueue:typeof enqueueSheetSync;now:()=>number}
const defaults:RecoveryPorts={inspect:inspectOwnerCorrectionTargets,enqueue:enqueueSheetSync,now:()=>Date.now()};
type RecoveryResult="ENQUEUED"|"WAIT"|"REVIEW"|"NOT_REVIEW";

/**
 * Resume read-only reconciliation after independently observing the complete
 * approved result twice. This operation never dispatches a Sheets write and
 * cannot resolve a BEFORE, mixed, moved or ambiguous state by guessing.
 */
export async function recoverVerifiedOwnerCorrection(env:Env,correctionId:string,reason:string,ports:RecoveryPorts=defaults):Promise<RecoveryResult>{
  const nowMs=ports.now(),why=reason.trim();
  if(env.OWNER_EXPENSE_CORRECTION_ENABLED!=="true"||env.SHEETS_SYNC_ENABLED!=="true"||!/^owner_correction_[A-Za-z0-9_-]{8,128}$/.test(correctionId)||why.length<4||why.length>500||!Number.isFinite(nowMs))return "NOT_REVIEW";
  const row=await env.DB.prepare(`SELECT s.expense_id,s.expense_version,s.plan_json,s.not_before,j.trace_id FROM expense_owner_correction_sync s
    JOIN expense_owner_corrections c ON c.correction_id=s.correction_id AND c.status='APPLIED'
    JOIN sync_jobs j ON j.entity_type='EXPENSE_CORRECTION' AND j.entity_key=s.expense_id AND j.entity_version=s.expense_version AND j.status='REVIEW'
    JOIN expense_events e ON e.expense_id=s.expense_id AND e.status='CONFIRMED' AND e.version=s.expense_version
    WHERE s.correction_id=? AND s.phase='REVIEW'`).bind(correctionId).first<{expense_id:string;expense_version:number;plan_json:string;not_before:string|null;trace_id:string}>();
  if(!row)return "NOT_REVIEW";
  if(row.not_before){const deadline=Date.parse(row.not_before);if(!Number.isFinite(deadline))return "REVIEW";if(nowMs<deadline)return "WAIT";}
  let plan:CorrectionSyncPlan;try{plan=JSON.parse(row.plan_json) as CorrectionSyncPlan;}catch{return "REVIEW";}
  if(plan.rebind||serializeCorrectionSyncPlan(plan,row.expense_id,correctionId)!==row.plan_json)return "REVIEW";
  const original=new Map(plan.originalRows.map(item=>[item.metadataId,item.values]));
  const first=await ports.inspect(env,plan),second=await ports.inspect(env,plan);
  const ordered=(rows:Map<number,unknown[]>)=>JSON.stringify(plan.patches.map(patch=>[patch.metadataId,rows.get(patch.metadataId)]));
  if(!first.identitiesVerified||!second.identitiesVerified||ordered(first.rows)!==ordered(second.rows)||classifyCorrectionPatchOutcome(plan.patches,original,first.rows)!=="AFTER"||classifyCorrectionPatchOutcome(plan.patches,original,second.rows)!=="AFTER")return "REVIEW";
  const now=new Date(nowMs).toISOString(),resumeId=crypto.randomUUID(),auditId=crypto.randomUUID(),marker=`RECOVERY:${resumeId}`;
  const result=await env.DB.batch([
    env.DB.prepare(`UPDATE expense_owner_correction_sync SET phase='IDENTITY_VERIFIED',last_error=?,updated_at=? WHERE correction_id=? AND expense_id=? AND expense_version=? AND phase='REVIEW' AND plan_json=? AND (not_before IS NULL OR not_before<=?)
      AND EXISTS(SELECT 1 FROM expense_owner_corrections c JOIN expense_events e ON e.expense_id=c.expense_id JOIN sync_jobs j ON j.entity_type='EXPENSE_CORRECTION' AND j.entity_key=e.expense_id AND j.entity_version=e.version
        WHERE c.correction_id=? AND c.status='APPLIED' AND e.expense_id=? AND e.status='CONFIRMED' AND e.version=? AND j.status='REVIEW'
          AND e.description=json_extract(c.after_json,'$.description') AND e.category=json_extract(c.after_json,'$.category') AND e.amount_satang=json_extract(c.after_json,'$.amountSatang')
          AND e.transaction_date=json_extract(c.after_json,'$.transactionDate') AND e.payment_key=json_extract(c.after_json,'$.paymentKey') AND e.source_wallet=json_extract(c.after_json,'$.sourceWallet'))
      AND NOT EXISTS(SELECT 1 FROM sync_jobs old WHERE old.entity_type='EXPENSE' AND old.entity_key=? AND old.status<>'COMPLETED')`)
      .bind(marker,now,correctionId,row.expense_id,row.expense_version,row.plan_json,now,correctionId,row.expense_id,row.expense_version,row.expense_id),
    env.DB.prepare(`UPDATE sync_jobs SET status='PENDING',last_error=NULL,updated_at=?,next_attempt_at=?,lease_until=NULL,lease_token=NULL WHERE entity_type='EXPENSE_CORRECTION' AND entity_key=? AND entity_version=? AND status='REVIEW'
      AND EXISTS(SELECT 1 FROM expense_owner_correction_sync WHERE correction_id=? AND phase='IDENTITY_VERIFIED' AND last_error=?)`).bind(now,now,row.expense_id,row.expense_version,correctionId,marker),
    env.DB.prepare(`INSERT INTO admin_audit(id,action,entity_key,reason,before_json,after_json,created_at)
      SELECT ?,'OWNER_CORRECTION_RESUME',?,?,?, ?,? WHERE EXISTS(SELECT 1 FROM expense_owner_correction_sync WHERE correction_id=? AND phase='IDENTITY_VERIFIED' AND last_error=?)
      AND EXISTS(SELECT 1 FROM sync_jobs WHERE entity_type='EXPENSE_CORRECTION' AND entity_key=? AND entity_version=? AND status='PENDING')`)
      .bind(auditId,correctionId,why,JSON.stringify({phase:"REVIEW"}),JSON.stringify({phase:"IDENTITY_VERIFIED",mode:"READ_ONLY_RECONCILIATION"}),now,correctionId,marker,row.expense_id,row.expense_version),
    env.DB.prepare(`UPDATE expense_owner_correction_sync SET last_error=NULL WHERE correction_id=? AND phase='IDENTITY_VERIFIED' AND last_error=? AND EXISTS(SELECT 1 FROM admin_audit WHERE id=?)`).bind(correctionId,marker,auditId),
    env.DB.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM admin_audit WHERE id=?) AND NOT EXISTS(SELECT 1 FROM expense_owner_correction_sync WHERE correction_id=? AND last_error=?) THEN 1
      WHEN EXISTS(SELECT 1 FROM admin_audit WHERE id=?) AND EXISTS(SELECT 1 FROM expense_owner_correction_sync WHERE correction_id=? AND phase='IDENTITY_VERIFIED' AND last_error IS NULL)
        AND EXISTS(SELECT 1 FROM sync_jobs WHERE entity_type='EXPENSE_CORRECTION' AND entity_key=? AND entity_version=? AND status='PENDING') THEN 1 ELSE json('invalid owner correction recovery') END AS verified`)
      .bind(auditId,correctionId,marker,auditId,correctionId,row.expense_id,row.expense_version)
  ]);
  if(Number(result[0]?.meta.changes||0)!==1)return "NOT_REVIEW";
  if(result.slice(0,4).some(item=>Number(item.meta.changes||0)!==1))throw new Error("OWNER_CORRECTION_RECOVERY_INCOMPLETE");
  const job:SheetsSyncJob={kind:"SHEETS_SYNC",entityType:"EXPENSE_CORRECTION",entityKey:row.expense_id,entityVersion:Number(row.expense_version),traceId:row.trace_id};
  try{await ports.enqueue(env,job);}catch{/* the durable outbox remains available to scheduled recovery */}
  return "ENQUEUED";
}
