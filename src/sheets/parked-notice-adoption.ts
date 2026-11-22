import type {Env, SheetsSyncJob} from '../types';
import type {ReviewRequestBudget} from './review-request-budget';
import {stableNoticeStyleFingerprint} from './stable-edit-notice';
import {admitStableRecovery} from './stable-recovery-admission';

export const parkedAuditAction='ISSUE296_PAUSED_NOTICE_HANDOVER';
export type ParkedPilotEnv=Env & {CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED?:string;CONTINUOUS_CANARY_OPERATOR_ENABLED?:string};
export function parkedPilotEnabled(env:ParkedPilotEnv,version:string):boolean{
 const off=(flag:string|undefined)=>flag===undefined||flag==='false';
 return !!version&&env.CF_VERSION_METADATA?.id===version&&env.CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED==='true'&&
  env.CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED==='false'&&env.STABLE_RECOVERY_GATE_ENABLED==='true'&&
  env.STABLE_SHEETS_PACING_ENABLED==='true'&&env.STABLE_PHASE1_ENABLED==='true'&&env.STABLE_CANCELLATION_PREIMAGE_ENABLED==='true'&&
  env.SHEETS_SYNC_ENABLED==='true'&&env.CONTINUOUS_DAILY_ENABLED==='true'&&env.CONTINUOUS_DAILY_SHEET==='รายวันต่อเนื่อง_แบบร่าง'&&
  [env.MONTHLY_REPORT_OPERATOR_ENABLED,env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED,env.CONTINUOUS_PUBLICATION_ENABLED,
   env.CANARY_UNWRITTEN_RECOVERY_ENABLED,env.CONTINUOUS_CANARY_OPERATOR_ENABLED,env.UNWRITTEN_EXPENSE_AUTO_CANCEL_ENABLED].every(off);
}
export type PausedPilot={token:string;epoch:string;stamp:string;identity:string;style:string;version:string;revision:number;fingerprint:string};

// Match the parked transaction, original failed row, verified DAILY and its
// retained preimage even after the original claim has been replaced.
export const parkedSourceJoins=`
 JOIN sync_jobs old ON old.job_id=json_extract(a.before_json,'$.job') AND old.status='REVIEW' AND old.last_error='STABLE_SYNC_REVIEW' AND old.entity_type='EXPENSE' AND old.entity_version=1 AND old.lease_token IS NULL AND old.lease_until IS NULL
 JOIN failed_jobs f ON f.id=json_extract(a.before_json,'$.failed') AND f.trace_id=old.trace_id AND f.queue_name='malipang-jobs' AND f.attempt_count=1 AND f.created_at=f.updated_at AND NOT EXISTS(SELECT 1 FROM failed_jobs other WHERE other.status='OPEN' AND other.id<>f.id AND substr(other.job_key,1,length('EXPENSE:'||old.entity_key||':'))='EXPENSE:'||old.entity_key||':') AND f.job_key='EXPENSE:'||old.entity_key||':1' AND f.status='OPEN' AND f.resolved_at IS NULL AND f.error='Error: STABLE_JOB_HOLD_UNCERTAIN' AND f.updated_at=json_extract(a.before_json,'$.failedUpdated')
 JOIN stable_projection_writes w ON w.spreadsheet_id=json_extract(a.before_json,'$.book') AND w.entity_type='EXPENSE' AND w.entity_id=old.entity_key AND w.source_version=1 AND w.projection='DAILY' AND w.operation_token=json_extract(a.before_json,'$.oldToken') AND w.state='VERIFIED'
 JOIN stable_expense_projection_preimages i ON i.spreadsheet_id=w.spreadsheet_id AND i.entity_type=w.entity_type AND i.entity_id=w.entity_id AND i.projection=w.projection AND i.source_version=w.source_version AND i.source_digest=w.source_digest AND i.sheet_id=w.sheet_id AND i.sheet_name=w.sheet_name AND i.preimage_digest=json_extract(a.before_json,'$.preimage')
 JOIN stable_recovery_epochs ep ON ep.epoch_id=json_extract(a.after_json,'$.epoch') AND ep.spreadsheet_id=w.spreadsheet_id AND ep.target_type='EXPENSE' AND ep.target_version=1
 JOIN continuous_normal_recovery_admissions n ON n.epoch_id=ep.epoch_id AND n.spreadsheet_id=ep.spreadsheet_id AND n.expense_id=ep.target_key AND n.source_version=ep.target_version
 JOIN sync_jobs j ON j.job_id=a.entity_key AND j.entity_type=ep.target_type AND j.entity_key=ep.target_key AND j.entity_version=ep.target_version
`;
const adoptScope=`FROM admin_audit a ${parkedSourceJoins}
 JOIN stable_source_revision r ON r.singleton=1 AND r.revision=json_extract(a.before_json,'$.revision')
 JOIN expense_events e ON e.expense_id=j.entity_key AND e.status='CONFIRMED' AND e.version=j.entity_version
 WHERE a.action=? AND w.spreadsheet_id=? AND json_extract(a.after_json,'$.version')=? AND ep.state='ARMED'
 AND j.entity_key=? AND j.entity_version=? AND j.trace_id=? AND j.status='PROCESSING' AND j.attempt_count=1 AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND NOT EXISTS(SELECT 1 FROM failed_jobs other WHERE other.job_key='EXPENSE:'||j.entity_key||':1' AND other.status='OPEN')`;
const rowSelect=`SELECT json_extract(a.after_json,'$.token') token,ep.epoch_id epoch,json_extract(a.before_json,'$.stamp') stamp,
 json_extract(a.before_json,'$.identity') identity,json_extract(a.before_json,'$.style') style,json_extract(a.after_json,'$.version') version,
 r.revision revision,a.reason fingerprint `;
function adoptArgs(env:ParkedPilotEnv,job:SheetsSyncJob,lease:string){
 return [parkedAuditAction,env.GOOGLE_SPREADSHEET_ID,env.CF_VERSION_METADATA?.id,job.entityKey,job.entityVersion,job.traceId,lease];
}

/** A returned ticket is exclusively owned by this exact outbox lease. No
 * owner may retry an ambiguous uptake or release an inherited pause as unused. */
export async function takePausedPilot(env:ParkedPilotEnv,job:SheetsSyncJob,lease:string):Promise<PausedPilot|null>{
 const version=env.CF_VERSION_METADATA?.id??'';
 if(job.entityType!=='EXPENSE'||job.entityVersion!==1||!parkedPilotEnabled(env,version))return null;
 const db=env.DB,args=adoptArgs(env,job,lease);
 const row=await db.prepare(rowSelect+adoptScope+` AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=w.spreadsheet_id AND c.operation_token=json_extract(a.after_json,'$.token') AND c.state='HELD' AND c.phase='PILOT_RESERVED' AND c.notice_stamp IS NULL AND c.notice_identity IS NULL)`).bind(...args).first<PausedPilot>();
 if(!row){
  // If an exact live lease reached its reserved pilot but the original proof
  // or current source changed, surface an actionable hold instead of busy-looping.
  const held=await db.prepare(`UPDATE stable_workbook_claims AS c SET state='REVIEW',review_reason='PILOT_TAKE_PREIMAGE',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE c.spreadsheet_id=? AND c.phase='PILOT_RESERVED' AND c.state='HELD' AND EXISTS(
    SELECT 1 FROM admin_audit a JOIN stable_recovery_epochs ep ON ep.epoch_id=json_extract(a.after_json,'$.epoch') AND ep.spreadsheet_id=c.spreadsheet_id
    JOIN sync_jobs j ON j.job_id=a.entity_key AND j.entity_type='EXPENSE' AND j.entity_key=ep.target_key AND j.entity_version=ep.target_version
    WHERE a.action=? AND json_extract(a.after_json,'$.token')=c.operation_token AND json_extract(a.after_json,'$.version')=? AND j.entity_key=? AND j.entity_version=?
    AND j.trace_id=? AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   RETURNING 1 AS held`).bind(env.GOOGLE_SPREADSHEET_ID,parkedAuditAction,version,job.entityKey,job.entityVersion,job.traceId,lease).all();
  if(held.success!==true||!Array.isArray(held.results)||held.results.length)throw Error('PILOT_TAKE_PREIMAGE');
  return null;
 }
 const changed=await db.prepare(`UPDATE stable_workbook_claims SET phase='PILOT_TAKEN',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE spreadsheet_id=? AND operation_token=? AND state='HELD' AND phase='PILOT_RESERVED' AND notice_stamp IS NULL AND notice_identity IS NULL
 AND EXISTS(SELECT 1 ${adoptScope} AND json_extract(a.after_json,'$.token')=?) RETURNING 1 AS took`)
  .bind(env.GOOGLE_SPREADSHEET_ID,row.token,...args,row.token).all<{took:number}>();
 if(db!==env.DB||!parkedPilotEnabled(env,version)||changed.success!==true||!Array.isArray(changed.results))throw Error('PILOT_TAKE_UNCERTAIN');
 return changed.results.length===1&&changed.results[0]?.took===1?row:null;
}

/** Authenticate both notice cells and their original formatting around
 * admission. The existing paused notice is never posted a second time. */
export async function inheritPausedPilot(env:ParkedPilotEnv,job:SheetsSyncJob,lease:string,ticket:PausedPilot,budget?:ReviewRequestBudget):Promise<void>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 const valid=()=>db===env.DB&&book===env.GOOGLE_SPREADSHEET_ID&&parkedPilotEnabled(env,ticket.version);
 const snapshot=()=>stableNoticeStyleFingerprint(env,ticket.identity,'พักแก้ไฟล์',ticket.stamp,budget,true);
 if(!valid()||await snapshot()!==ticket.style||!valid()||!await admitStableRecovery(env,job,ticket.token))throw Error('PILOT_PAUSE_UNVERIFIED');
 if(await snapshot()!==ticket.style||!valid())throw Error('PILOT_PAUSE_UNVERIFIED');
 const result=await db.prepare(`UPDATE stable_workbook_claims SET notice_stamp=?,notice_identity=?,phase='PILOT_ADOPTED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE spreadsheet_id=? AND operation_token=? AND phase='PILOT_TAKEN' AND state='HELD' AND notice_identity IS NULL AND notice_stamp IS NULL
 AND EXISTS(SELECT 1 ${adoptScope} AND a.reason=? AND ep.epoch_id=? AND EXISTS(SELECT 1 FROM stable_recovery_operations o WHERE o.epoch_id=ep.epoch_id AND o.operation_token=? AND o.state='ADMITTED'))
 RETURNING 1 AS adopted`).bind(ticket.stamp,ticket.identity,book,ticket.token,...adoptArgs(env,job,lease),ticket.fingerprint,ticket.epoch,ticket.token).all<{adopted:number}>();
 if(!valid()||result.success!==true||result.results?.length!==1||result.results[0]?.adopted!==1)throw Error('PILOT_PAUSE_UNVERIFIED');
}

// An actual INSERT owns a unique marker and before-image evidence as well as
// its verified journal and saved row. Also use these joins for later inspection.
export const pilotWriteJoins=`
 JOIN atomic_daily_marker_reservations m ON m.spreadsheet_id=p.spreadsheet_id AND m.sheet_id=p.sheet_id AND m.entity_id=p.entity_id AND m.source_version=p.source_version AND m.operation_token=p.operation_token
 JOIN continuous_daily_write_evidence d ON d.spreadsheet_id=p.spreadsheet_id AND d.entity_id=p.entity_id AND d.sheet_id=p.sheet_id AND d.sheet_name=p.sheet_name AND d.source_version=p.source_version AND d.source_digest=p.source_digest AND d.operation_token=p.operation_token AND d.marker=m.marker
`;
export async function verifiedPilotStage(env:ParkedPilotEnv,ticket:PausedPilot):Promise<boolean>{
 if(!parkedPilotEnabled(env,ticket.version))return false;
 const row=await env.DB.prepare(`SELECT 1 AS verified FROM admin_audit a ${parkedSourceJoins}
 JOIN stable_source_revision r ON r.singleton=1 AND r.revision=json_extract(a.before_json,'$.revision')
 JOIN stable_workbook_claims c ON c.spreadsheet_id=w.spreadsheet_id AND c.operation_token=json_extract(a.after_json,'$.token') AND c.phase='PILOT_ADOPTED' AND c.state='HELD'
 JOIN stable_recovery_operations o ON o.epoch_id=ep.epoch_id AND o.operation_token=c.operation_token AND o.state='ADMITTED'
 JOIN stable_projection_writes p ON p.spreadsheet_id=c.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=j.entity_key AND p.source_version=j.entity_version AND p.projection='DAILY' AND p.operation_token=c.operation_token AND p.state='VERIFIED'
 ${pilotWriteJoins}
 JOIN stable_expense_projection_preimages pi ON pi.spreadsheet_id=p.spreadsheet_id AND pi.entity_type=p.entity_type AND pi.entity_id=p.entity_id AND pi.source_version=p.source_version AND pi.projection=p.projection AND pi.sheet_id=p.sheet_id AND pi.sheet_name=p.sheet_name AND pi.source_digest=p.source_digest
 WHERE a.action=? AND a.reason=? AND ep.epoch_id=? AND ep.state='ARMED' AND c.operation_token=? AND c.notice_stamp=? AND c.notice_identity=?
 AND j.status='PENDING' AND j.last_error='STABLE_STAGE_CONTINUE' AND j.lease_token IS NULL AND j.lease_until IS NULL`)
 .bind(parkedAuditAction,ticket.fingerprint,ticket.epoch,ticket.token,ticket.stamp,ticket.identity).first<{verified:number}>();
 return row?.verified===1&&parkedPilotEnabled(env,ticket.version);
}
