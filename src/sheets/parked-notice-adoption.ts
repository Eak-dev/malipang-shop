import type {Env, SheetsSyncJob} from '../types';
import type {ReviewRequestBudget} from './review-request-budget';
import {stableNoticeStyleFingerprint} from './stable-edit-notice';
import {admitStableRecovery} from './stable-recovery-admission';
import {stableSourceIntegrity} from './stable-source-cutover';

export const parkedAuditAction='ISSUE296_PAUSED_NOTICE_HANDOVER';
export const serialAuditAction='ISSUE296_SERIAL_EXPENSE_HANDOVER';
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
export type PausedPilot={token:string;epoch:string;stamp:string;identity:string;style:string;version:string;revision:number;fingerprint:string;attestedMode:boolean};

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
const and=(parts:readonly string[]):string=>parts.length===1?parts[0]!: `(${and(parts.slice(0,Math.floor(parts.length/2)))} AND ${and(parts.slice(Math.floor(parts.length/2)))})`;
const attestedEdge=`a.action='ISSUE296_SERIAL_EXPENSE_HANDOVER' AND EXISTS(
 SELECT 1 FROM serial_pilot_attested_handoffs handoff
 JOIN serial_pilot_hold_evidence hold ON hold.round_id=handoff.round_id AND hold.job_id=handoff.predecessor_job_id AND hold.epoch_id=handoff.predecessor_epoch_id
 JOIN sync_jobs prior ON prior.job_id=handoff.predecessor_job_id AND prior.status='REVIEW' AND prior.last_error='SERIAL_PILOT_B_REVIEW' AND prior.lease_token IS NULL AND prior.lease_until IS NULL AND prior.serial_provenance_version=1 AND prior.serial_lease_generation=0
 JOIN stable_recovery_epochs old_ep ON old_ep.epoch_id=handoff.predecessor_epoch_id AND old_ep.spreadsheet_id=handoff.spreadsheet_id AND old_ep.state='CLOSED'
 JOIN serial_pilot_oracle_fence fence ON fence.spreadsheet_id=handoff.spreadsheet_id AND fence.fence_digest=handoff.fence_digest AND fence.generation=handoff.fence_generation
 WHERE ${and([
  "handoff.successor_job_id=j.job_id", "handoff.successor_epoch_id=ep.epoch_id", "handoff.spreadsheet_id=w.spreadsheet_id",
  "handoff.round_id=json_extract(a.after_json,'$.roundId')", "handoff.nonce=json_extract(a.after_json,'$.attestationNonce')", "handoff.claim_token=json_extract(a.after_json,'$.token')",
  "handoff.predecessor_job_id=json_extract(a.before_json,'$.predecessorJobId')", "handoff.payload_digest=json_extract(a.before_json,'$.proof')",
  "handoff.worker_version=json_extract(a.after_json,'$.version')", "handoff.source_revision=r.revision", "strftime('%Y-%m-%dT%H:%M:%fZ','now')<handoff.expires_at",
  "j.serial_provenance_version=1", "j.serial_lease_generation=1",
  "NOT EXISTS(SELECT 1 FROM serial_pilot_oracle_revocations v WHERE v.spreadsheet_id=fence.spreadsheet_id AND v.fence_digest=fence.fence_digest AND v.fence_generation=fence.generation)",
  "NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='serial_pilot_oracle_revoke_not_ready')",
  "(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_pilot_oracle_revoke_insert','serial_pilot_oracle_revoke_no_update','serial_pilot_oracle_revoke_no_delete'))=3",
  "NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name IN ('serial_pilot_fence_not_ready','serial_pilot_hold_not_ready','serial_job_provenance_not_ready','serial_source_provenance_not_ready','serial_pilot_oracle_fence_not_ready','serial_pilot_attested_handoff_not_ready'))",
  stableSourceIntegrity,
  "(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_pilot_round_insert','serial_pilot_items_insert','serial_pilot_items_no_update','serial_pilot_items_no_delete','serial_pilot_round_no_delete','serial_pilot_round_transition','serial_pilot_bindings_insert','serial_pilot_bindings_no_update','serial_pilot_bindings_no_delete','serial_pilot_fence_reservation','serial_pilot_fence_audit_no_replace','serial_pilot_fence_audit_no_update','serial_pilot_fence_audit_no_delete','serial_pilot_snapshot_insert_guard','serial_pilot_snapshot_audit'))=15",
  "(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_source_provenance_no_update','serial_source_provenance_no_delete','serial_source_provenance_no_replace','serial_source_provenance_namespace_guard','serial_source_provenance_insert_guard','serial_source_provenance_update_guard','serial_source_provenance_delete_guard','serial_source_job_birth_guard','serial_job_provenance_insert_guard','serial_job_provenance_update_guard','serial_job_provenance_delete_guard','serial_job_provenance_activation_no_update','serial_job_provenance_activation_no_delete','serial_job_provenance_activation_no_replace','serial_job_provenance_source_gate','serial_pilot_hold_no_replace','serial_pilot_hold_no_update','serial_pilot_hold_no_delete','serial_pilot_oracle_fence_no_replace','serial_pilot_oracle_fence_no_update','serial_pilot_oracle_fence_no_delete','serial_pilot_attested_handoff_no_replace','serial_pilot_attested_handoff_no_update','serial_pilot_attested_handoff_no_delete'))=24"
 ])})`;
const adoptScope=(attested:boolean)=>`FROM admin_audit a ${parkedSourceJoins}
 JOIN stable_source_revision r ON r.singleton=1 AND r.revision=json_extract(a.before_json,'$.revision')
 JOIN expense_events e ON e.expense_id=j.entity_key AND e.status='CONFIRMED' AND e.version=j.entity_version
 WHERE ${and([
  `(a.action=? ${attested?`OR (${attestedEdge})`:''})`, "w.spreadsheet_id=?", "json_extract(a.after_json,'$.version')=?", "ep.state='ARMED'",
  "j.entity_key=?", "j.entity_version=?", "j.trace_id=?", "j.status='PROCESSING'", "j.attempt_count=1", "j.lease_token=?", "j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')",
  "NOT EXISTS(SELECT 1 FROM failed_jobs other WHERE other.job_key='EXPENSE:'||j.entity_key||':1' AND other.status='OPEN')"
 ])}`;
const rowSelect=`SELECT json_extract(a.after_json,'$.token') token,ep.epoch_id epoch,json_extract(a.before_json,'$.stamp') stamp,
 json_extract(a.before_json,'$.identity') identity,json_extract(a.before_json,'$.style') style,json_extract(a.after_json,'$.version') version,
 r.revision revision,a.reason fingerprint `;
function adoptArgs(env:ParkedPilotEnv,job:SheetsSyncJob,lease:string){
 return [parkedAuditAction,env.GOOGLE_SPREADSHEET_ID,env.CF_VERSION_METADATA?.id,job.entityKey,job.entityVersion,job.traceId,lease];
}

/** A returned ticket is exclusively owned by this exact outbox lease. No
 * owner may retry an ambiguous uptake or release an inherited pause as unused. */
export async function takePausedPilot(env:ParkedPilotEnv,job:SheetsSyncJob,lease:string,valid:()=>boolean=()=>true):Promise<PausedPilot|null>{
 const version=env.CF_VERSION_METADATA?.id??'';
 if(!valid())throw Error('PILOT_TAKE_UNCERTAIN');
 if(job.entityType!=='EXPENSE'||job.entityVersion!==1||!parkedPilotEnabled(env,version))return null;
 const db=env.DB,args=adoptArgs(env,job,lease),attestedMode=env.SERIAL_ATTESTED_HANDOFF_ENABLED==='true';
 const rows=await db.prepare(rowSelect+adoptScope(attestedMode)+` AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=w.spreadsheet_id AND c.operation_token=json_extract(a.after_json,'$.token') AND c.state='HELD' AND c.phase='PILOT_RESERVED' AND c.notice_stamp IS NULL AND c.notice_identity IS NULL) LIMIT 2`).bind(...args).all<Omit<PausedPilot,'attestedMode'>>().catch(()=>{throw Error('PILOT_TAKE_UNCERTAIN');});
 if(!valid()||db!==env.DB||(env.SERIAL_ATTESTED_HANDOFF_ENABLED==='true')!==attestedMode||rows.success!==true||!Array.isArray(rows.results)||rows.results.length>1)throw Error('PILOT_TAKE_UNCERTAIN');
 const row=rows.results[0];
 if(!row){
  // If an exact live lease reached its reserved pilot but the original proof
  // or current source changed, surface an actionable hold instead of busy-looping.
  if(!valid())throw Error('PILOT_TAKE_UNCERTAIN');
  const held=await db.prepare(`UPDATE stable_workbook_claims AS c SET state='REVIEW',review_reason='PILOT_TAKE_PREIMAGE',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE c.spreadsheet_id=? AND c.phase='PILOT_RESERVED' AND c.state='HELD' AND EXISTS(
    SELECT 1 FROM admin_audit a JOIN stable_recovery_epochs ep ON ep.epoch_id=json_extract(a.after_json,'$.epoch') AND ep.spreadsheet_id=c.spreadsheet_id
    JOIN sync_jobs j ON j.job_id=a.entity_key AND j.entity_type='EXPENSE' AND j.entity_key=ep.target_key AND j.entity_version=ep.target_version
    WHERE (a.action=? ${attestedMode?`OR (a.action='ISSUE296_SERIAL_EXPENSE_HANDOVER' AND a.id='issue296:serial:'||json_extract(a.before_json,'$.predecessorJobId') AND json_extract(a.after_json,'$.attestationNonce') IS NOT NULL)` : ''}) AND json_extract(a.after_json,'$.token')=c.operation_token AND json_extract(a.after_json,'$.version')=? AND j.entity_key=? AND j.entity_version=?
    AND j.trace_id=? AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   RETURNING 1 AS held`).bind(env.GOOGLE_SPREADSHEET_ID,parkedAuditAction,version,job.entityKey,job.entityVersion,job.traceId,lease).all().catch(()=>{throw Error('PILOT_TAKE_UNCERTAIN');});
  if(!valid()||db!==env.DB)throw Error('PILOT_TAKE_UNCERTAIN');
  if(held.success!==true||!Array.isArray(held.results)||held.results.length)throw Error('PILOT_TAKE_PREIMAGE');
  return null;
 }
 if(!valid())throw Error('PILOT_TAKE_UNCERTAIN');
 const changed=await db.prepare(`UPDATE stable_workbook_claims SET phase='PILOT_TAKEN',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE spreadsheet_id=? AND operation_token=? AND state='HELD' AND phase='PILOT_RESERVED' AND notice_stamp IS NULL AND notice_identity IS NULL
 AND EXISTS(SELECT 1 ${adoptScope(attestedMode)} AND json_extract(a.after_json,'$.token')=?) RETURNING 1 AS took`)
  .bind(env.GOOGLE_SPREADSHEET_ID,row.token,...args,row.token).all<{took:number}>().catch(()=>{throw Error('PILOT_TAKE_UNCERTAIN');});
 if(!valid()||db!==env.DB||(env.SERIAL_ATTESTED_HANDOFF_ENABLED==='true')!==attestedMode||!parkedPilotEnabled(env,version)||changed.success!==true||!Array.isArray(changed.results))throw Error('PILOT_TAKE_UNCERTAIN');
 return changed.results.length===1&&changed.results[0]?.took===1?{...row,attestedMode}:null;
}

/** Authenticate both notice cells and their original formatting around
 * admission. The existing paused notice is never posted a second time. */
export async function inheritPausedPilot(env:ParkedPilotEnv,job:SheetsSyncJob,lease:string,ticket:PausedPilot,budget?:ReviewRequestBudget):Promise<void>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 const valid=()=>db===env.DB&&book===env.GOOGLE_SPREADSHEET_ID&&(env.SERIAL_ATTESTED_HANDOFF_ENABLED==='true')===ticket.attestedMode&&parkedPilotEnabled(env,ticket.version);
 const snapshot=()=>stableNoticeStyleFingerprint(env,ticket.identity,'พักแก้ไฟล์',ticket.stamp,budget,true);
 if(!valid()||await snapshot()!==ticket.style||!valid()||!await admitStableRecovery(env,job,ticket.token))throw Error('PILOT_PAUSE_UNVERIFIED');
 if(await snapshot()!==ticket.style||!valid())throw Error('PILOT_PAUSE_UNVERIFIED');
 const result=await db.prepare(`UPDATE stable_workbook_claims SET notice_stamp=?,notice_identity=?,phase=${ticket.attestedMode?"'SERIAL_PILOT_ADOPTED'":"'PILOT_ADOPTED'"},updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE spreadsheet_id=? AND operation_token=? AND phase='PILOT_TAKEN' AND state='HELD' AND notice_identity IS NULL AND notice_stamp IS NULL
 AND EXISTS(SELECT 1 ${adoptScope(ticket.attestedMode)} AND a.reason=? AND ep.epoch_id=? AND EXISTS(SELECT 1 FROM stable_recovery_operations o WHERE o.epoch_id=ep.epoch_id AND o.operation_token=? AND o.state='ADMITTED'))
 RETURNING 1 AS adopted`).bind(ticket.stamp,ticket.identity,book,ticket.token,...adoptArgs(env,job,lease),ticket.fingerprint,ticket.epoch,ticket.token).all<{adopted:number}>();
 if(!valid()||result.success!==true||result.results?.length!==1||result.results[0]?.adopted!==1)throw Error('PILOT_PAUSE_UNVERIFIED');
}

// An actual INSERT owns a unique marker and before-image evidence as well as
// its verified journal and saved row. Also use these joins for later inspection.
export const pilotWriteJoins=`
 JOIN atomic_daily_marker_reservations m ON m.spreadsheet_id=p.spreadsheet_id AND m.sheet_id=p.sheet_id AND m.entity_id=p.entity_id AND m.source_version=p.source_version AND m.operation_token=p.operation_token
 JOIN continuous_daily_write_evidence d ON d.spreadsheet_id=p.spreadsheet_id AND d.entity_id=p.entity_id AND d.sheet_id=p.sheet_id AND d.sheet_name=p.sheet_name AND d.source_version=p.source_version AND d.source_digest=p.source_digest AND d.operation_token=p.operation_token AND d.marker=m.marker
`;
export const pilotStageSql=(attested:boolean,operationState:'ADMITTED'|'VERIFIED')=>`SELECT 1 AS verified FROM admin_audit a ${parkedSourceJoins}
 JOIN stable_source_revision r ON r.singleton=1 AND r.revision=json_extract(a.before_json,'$.revision')
 JOIN stable_workbook_claims c ON c.spreadsheet_id=w.spreadsheet_id AND c.operation_token=json_extract(a.after_json,'$.token') AND c.phase=${attested?"'SERIAL_PILOT_ADOPTED'":"'PILOT_ADOPTED'"} AND c.state='HELD'
 JOIN stable_recovery_operations o ON o.epoch_id=ep.epoch_id AND o.operation_token=c.operation_token AND o.state='${operationState}'
 JOIN stable_projection_writes p ON p.spreadsheet_id=c.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=j.entity_key AND p.source_version=j.entity_version AND p.projection='DAILY' AND p.operation_token=c.operation_token AND p.state='VERIFIED'
 ${pilotWriteJoins}
 JOIN stable_expense_projection_preimages pi ON pi.spreadsheet_id=p.spreadsheet_id AND pi.entity_type=p.entity_type AND pi.entity_id=p.entity_id AND pi.source_version=p.source_version AND pi.projection=p.projection AND pi.sheet_id=p.sheet_id AND pi.sheet_name=p.sheet_name AND pi.source_digest=p.source_digest
 WHERE (a.action=? ${attested?`OR (${attestedEdge})`:''}) AND a.reason=? AND ep.epoch_id=? AND ep.state='ARMED' AND c.operation_token=? AND c.notice_stamp=? AND c.notice_identity=?
 AND j.status='PENDING' AND j.last_error='STABLE_STAGE_CONTINUE' AND j.lease_token IS NULL AND j.lease_until IS NULL
 AND NOT EXISTS(SELECT 1 FROM failed_jobs x WHERE x.queue_name='malipang-jobs' AND x.job_key='EXPENSE:'||j.entity_key||':'||j.entity_version AND x.status='OPEN')`;
export const pilotStageArgs=(ticket:PausedPilot)=>[parkedAuditAction,ticket.fingerprint,ticket.epoch,ticket.token,ticket.stamp,ticket.identity];
export async function verifiedPilotStage(env:ParkedPilotEnv,ticket:PausedPilot):Promise<boolean>{
 if((env.SERIAL_ATTESTED_HANDOFF_ENABLED==='true')!==ticket.attestedMode||!parkedPilotEnabled(env,ticket.version))return false;
 const row=await env.DB.prepare(pilotStageSql(ticket.attestedMode,'ADMITTED')).bind(...pilotStageArgs(ticket)).first<{verified:number}>();
 return row?.verified===1&&(env.SERIAL_ATTESTED_HANDOFF_ENABLED==='true')===ticket.attestedMode&&parkedPilotEnabled(env,ticket.version);
}

/** Local mock pre-dispatch guard for the exact adopted C lease. It does not
 * assert that the external provider is quiescent or provide release authority. */
export async function attestedPilotOwned(env:ParkedPilotEnv,job:SheetsSyncJob,lease:string,ticket:PausedPilot):Promise<boolean>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 if(!ticket.attestedMode||env.SERIAL_ATTESTED_HANDOFF_ENABLED!=='true'||!book||!parkedPilotEnabled(env,ticket.version))return false;
 try{
  const rows=await db.prepare(`SELECT 1 AS ok ${adoptScope(true)} AND a.reason=? AND ep.epoch_id=? AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=w.spreadsheet_id AND c.operation_token=? AND c.state='HELD' AND c.phase='SERIAL_PILOT_ADOPTED' AND c.notice_stamp=? AND c.notice_identity=?) LIMIT 2`)
   .bind(...adoptArgs(env,job,lease),ticket.fingerprint,ticket.epoch,ticket.token,ticket.stamp,ticket.identity).all<{ok:number}>();
  return env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&env.SERIAL_ATTESTED_HANDOFF_ENABLED==='true'&&parkedPilotEnabled(env,ticket.version)&&rows.success===true&&rows.results?.length===1&&rows.results[0]?.ok===1;
 }catch{return false;}
}
