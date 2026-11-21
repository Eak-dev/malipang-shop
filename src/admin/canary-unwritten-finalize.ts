import type {Env} from '../types';
import {CANARY_UNWRITTEN_EVIDENCE_SQL,readCanaryUnwrittenEvidence} from './canary-unwritten-evidence';
import {inspectCanaryUnwrittenProvider} from './canary-unwritten-provider-proof';
import {canaryUnwrittenScope} from './canary-unwritten-scope';
import {ReviewRequestBudget} from '../sheets/review-request-budget';

type RecoveryEnv=Env & {CONTINUOUS_CANARY_OPERATOR_ENABLED?:string;CANARY_UNWRITTEN_RECOVERY_ENABLED?:string};
type Intent={operation_token:string;epoch_id:string;expense_id:string;source_version:number;source_revision:number;paused_stamp:string;notice_identity:string;next_stamp:string;ready_status:string;provider_digest:string;style_digest:string;state:string};
const integrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='canary_unwritten_recovery' AND name IN ('canary_unwritten_recovery_insert','canary_unwritten_recovery_transition','canary_unwritten_recovery_no_delete','canary_unwritten_recovery_no_replace'))=4";

/** Final database transition only, deliberately not routed. This does not
 * dispatch a provider request and does not claim an uncertain request was
 * acknowledged. A separate one-shot dispatcher must durably record a
 * positive provider reply before STATUS_ACKED can be reached. */
export async function finalizeCanaryUnwrittenRecovery(env:RecoveryEnv):Promise<'DISABLED'|'HELD'|'RESUMED'|'ALREADY_COMMITTED'>{
 if(env.CANARY_UNWRITTEN_RECOVERY_ENABLED!=='true')return 'DISABLED';
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 const scope=()=>canaryUnwrittenScope(env);
 const initial=scope(),stable=()=>env.DB===db&&scope()===initial;
 if(!book||!stable())return 'HELD';
 try{
  const existing=await db.prepare(`SELECT 1 AS ok FROM canary_unwritten_recovery r JOIN stable_recovery_operations o ON o.operation_token=r.operation_token AND o.epoch_id=r.epoch_id AND o.state='VERIFIED' WHERE r.spreadsheet_id=? AND r.state='COMPLETE' AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=r.spreadsheet_id AND c.operation_token=r.operation_token) AND ${integrity}`).bind(book).first<{ok:number}>();
  if(!stable())return 'HELD';if(existing?.ok===1)return 'ALREADY_COMMITTED';
  const intent=await db.prepare("SELECT operation_token,epoch_id,expense_id,source_version,source_revision,paused_stamp,notice_identity,next_stamp,ready_status,provider_digest,style_digest,state FROM canary_unwritten_recovery WHERE spreadsheet_id=? AND state='STATUS_ACKED'").bind(book).first<Intent>();
  const evidence=await readCanaryUnwrittenEvidence(env);
  if(!intent||!evidence||!stable()||intent.expense_id!==evidence.expense_id||intent.source_version!==1||intent.source_revision!==evidence.source_revision||intent.operation_token!==evidence.claim_token||intent.epoch_id!==evidence.epoch_id||intent.paused_stamp!==evidence.notice_stamp||intent.notice_identity!==evidence.notice_identity)return 'HELD';
  const provider=await inspectCanaryUnwrittenProvider(env,{status:intent.ready_status,stamp:intent.next_stamp},new ReviewRequestBudget(40));
  if(!provider||provider.fingerprint!==intent.provider_digest||provider.styleDigest!==intent.style_digest||!stable())return 'HELD';
  const readyGuard=`((r.ready_status='พร้อมแก้ไข' AND NOT EXISTS(SELECT 1 FROM sync_jobs other WHERE other.status='REVIEW' AND NOT (other.entity_type='EXPENSE' AND other.entity_key=r.expense_id AND other.entity_version=1))) OR (r.ready_status='พร้อมแก้ไข • มีรายการรอตรวจ' AND EXISTS(SELECT 1 FROM sync_jobs other WHERE other.status='REVIEW' AND NOT (other.entity_type='EXPENSE' AND other.entity_key=r.expense_id AND other.entity_version=1))))`;
  let result:D1Result[];
  try{result=await db.batch([
   db.prepare(`UPDATE stable_recovery_operations SET state='VERIFIED',verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_token=? AND epoch_id=? AND state='ADMITTED' AND ${integrity}
    AND EXISTS(SELECT 1 FROM canary_unwritten_recovery r JOIN (${CANARY_UNWRITTEN_EVIDENCE_SQL}) proof ON proof.expense_id=r.expense_id AND proof.claim_token=r.operation_token AND proof.epoch_id=r.epoch_id AND proof.source_revision=r.source_revision AND proof.notice_stamp=r.paused_stamp AND proof.notice_identity=r.notice_identity WHERE r.spreadsheet_id=? AND r.operation_token=stable_recovery_operations.operation_token AND r.state='STATUS_ACKED' AND r.provider_digest=? AND r.style_digest=? AND ${readyGuard})`)
    .bind(intent.operation_token,intent.epoch_id,book,book,intent.provider_digest,intent.style_digest),
   db.prepare("UPDATE sync_jobs SET status='PENDING',last_error='STABLE_RECOVERY_VERIFIED_CONTINUE',next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=1 AND status='REVIEW' AND last_error='STABLE_SYNC_REVIEW' AND lease_token IS NULL AND lease_until IS NULL AND changes()=1").bind(intent.expense_id),
   db.prepare("DELETE FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='REVIEW' AND phase='OPERATION' AND review_reason='INSERT_DAILY_PREFLIGHT_REPORT_HEALTH_FORMULA' AND notice_stamp=? AND notice_identity=? AND changes()=1").bind(book,intent.operation_token,intent.paused_stamp,intent.notice_identity),
   db.prepare(`UPDATE canary_unwritten_recovery SET state='COMPLETE',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='STATUS_ACKED' AND changes()=1 AND ${integrity}`).bind(book,intent.operation_token),
   db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
  ]);}catch{return 'HELD';}
  if(!stable()||result.length!==5||result.some(x=>x.success!==true)||result.slice(0,4).some(x=>Number(x.meta?.changes)!==1))return 'HELD';
  return 'RESUMED';
 }catch{return 'HELD';}
}
