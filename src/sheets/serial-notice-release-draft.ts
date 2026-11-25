import {parkedPilotEnabled,pilotStageArgs,pilotStageSql,type ParkedPilotEnv,type PausedPilot} from './parked-notice-adoption';
import {stableSourceIntegrity} from './stable-source-cutover';
import {continuousDailyCutoverIntegrity} from './continuous-daily-cutover';

// Local mock experiment: no route enables this. A digest is only an observation;
// an authoritative external fence must remain in force until C is complete.
export async function releaseAttestedNoticeDraft(env:ParkedPilotEnv,ticket:PausedPilot,observation:{postimageDigest:string;observedAt:string},valid:()=>boolean):Promise<'RELEASED'|'RELEASE_RECORDED'|'UNVERIFIED'>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,version=env.CF_VERSION_METADATA?.id,{postimageDigest,observedAt}=observation;
 const stable=()=>valid()&&db===env.DB&&book===env.GOOGLE_SPREADSHEET_ID&&version===env.CF_VERSION_METADATA?.id&&env.SERIAL_ATTESTED_HANDOFF_ENABLED==='true'&&ticket.attestedMode&&parkedPilotEnabled(env,ticket.version);
 if(!book||!stable()||!/^[a-f0-9]{64}$/.test(postimageDigest)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt)||!Number.isFinite(Date.parse(observedAt))||new Date(observedAt).toISOString()!==observedAt)return 'UNVERIFIED';
 const prior=async()=>db.prepare(`SELECT 1 AS found FROM serial_pilot_notice_release_receipts r
  WHERE r.operation_token=? AND r.spreadsheet_id=? AND r.epoch_id=? AND r.worker_version=? AND r.source_revision=?
   AND r.notice_algorithm='SHA256_MALIPANG_NOTICE_POSTIMAGE_V1' AND r.notice_postimage_digest=? AND r.observed_at=?
   AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=r.spreadsheet_id AND c.operation_token=r.operation_token)`)
  .bind(ticket.token,book,ticket.epoch,ticket.version,ticket.revision,postimageDigest,observedAt).first<{found:number}>();
 try{
  if((await prior())?.found===1)return stable()?'RELEASE_RECORDED':'UNVERIFIED';
  const stageArgs=pilotStageArgs(ticket),ready="NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name IN ('serial_pilot_notice_release_not_ready','serial_continuation_session_not_ready','serial_continuation_permit_not_ready')) AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_pilot_notice_release_no_replace','serial_pilot_notice_release_no_update','serial_pilot_notice_release_no_delete'))=3 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_continuation_session_insert','serial_continuation_session_no_update','serial_continuation_session_no_delete','serial_continuation_permit_insert','serial_continuation_permit_no_update','serial_continuation_permit_no_delete','serial_continuation_claim_insert','serial_continuation_claim_conflict','serial_continuation_claim_identity','serial_continuation_claim_review','serial_continuation_claim_delete','serial_continuation_completion_guard','serial_continuation_completion_no_update','serial_continuation_completion_no_delete','serial_continuation_authorization_insert','serial_continuation_authorization_no_update','serial_continuation_authorization_no_delete','serial_continuation_claim_phase'))=18";
  const update=db.prepare(`UPDATE stable_recovery_operations SET state='VERIFIED',verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_token=? AND state='ADMITTED' AND ${ready} AND EXISTS(${pilotStageSql(true,'ADMITTED')})`).bind(ticket.token,...stageArgs);
  const insert=db.prepare(`INSERT INTO serial_pilot_notice_release_receipts(operation_token,spreadsheet_id,round_id,predecessor_job_id,successor_job_id,epoch_id,nonce,worker_version,source_revision,fence_digest,fence_generation,attestation_expires_at,notice_algorithm,notice_postimage_digest,observed_at,released_at)
   SELECT h.claim_token,h.spreadsheet_id,h.round_id,h.predecessor_job_id,h.successor_job_id,h.successor_epoch_id,h.nonce,h.worker_version,h.source_revision,h.fence_digest,h.fence_generation,h.expires_at,'SHA256_MALIPANG_NOTICE_POSTIMAGE_V1',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')
   FROM serial_pilot_attested_handoffs h WHERE h.claim_token=? AND h.spreadsheet_id=? AND h.successor_epoch_id=? AND h.issued_at<=? AND ?<h.expires_at AND ?<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ${ready} AND EXISTS(${pilotStageSql(true,'VERIFIED')})`).bind(postimageDigest,observedAt,ticket.token,book,ticket.epoch,observedAt,observedAt,observedAt,...stageArgs);
  const session=db.prepare(`INSERT INTO serial_pilot_continuation_sessions(epoch_id,spreadsheet_id,job_id,nonce,fence_digest,fence_generation,created_at) SELECT r.epoch_id,r.spreadsheet_id,r.successor_job_id,r.nonce,r.fence_digest,r.fence_generation,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM serial_pilot_notice_release_receipts r WHERE r.operation_token=? AND r.spreadsheet_id=? AND r.epoch_id=? AND r.notice_postimage_digest=?`).bind(ticket.token,book,ticket.epoch,postimageDigest);
  const remove=db.prepare(`DELETE FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD' AND phase='SERIAL_PILOT_ADOPTED' AND ${ready}
   AND EXISTS(SELECT 1 FROM serial_pilot_notice_release_receipts r WHERE r.operation_token=? AND r.spreadsheet_id=? AND r.epoch_id=? AND r.notice_postimage_digest=?)
   AND EXISTS(${pilotStageSql(true,'VERIFIED')})`).bind(book,ticket.token,ticket.token,book,ticket.epoch,postimageDigest,...stageArgs);
  const guard=db.prepare(`SELECT CASE WHEN changes()=1 AND EXISTS(SELECT 1 FROM serial_pilot_notice_release_receipts WHERE operation_token=? AND notice_postimage_digest=?) AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=?) THEN 1 ELSE json_extract('invalid','$') END AS ok`).bind(ticket.token,postimageDigest,book,ticket.token);
  if(!stable())return 'UNVERIFIED';
  const result=await db.batch([update,insert,session,remove,guard]);
  if(!stable()||!Array.isArray(result)||result.length!==5||result.some(x=>x.success!==true))return 'UNVERIFIED';
  return (await prior())?.found===1&&stable()?'RELEASED':'UNVERIFIED';
 }catch{try{return (await prior())?.found===1&&stable()?'RELEASE_RECORDED':'UNVERIFIED';}catch{return 'UNVERIFIED';}}
}

export const continuationIntegritySql=`NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name IN ('serial_continuation_session_not_ready','serial_continuation_permit_not_ready','serial_continuation_authorization_not_ready','serial_pilot_oracle_revoke_not_ready','serial_pilot_fence_not_ready','serial_pilot_hold_not_ready','serial_job_provenance_not_ready','serial_source_provenance_not_ready','serial_pilot_oracle_fence_not_ready','serial_pilot_attested_handoff_not_ready','serial_pilot_notice_release_not_ready','serial_ledger_stage_not_ready')) AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_continuation_session_insert','serial_continuation_session_no_update','serial_continuation_session_no_delete','serial_continuation_permit_insert','serial_continuation_permit_no_update','serial_continuation_permit_no_delete','serial_continuation_claim_insert','serial_continuation_claim_conflict','serial_continuation_claim_identity','serial_continuation_claim_review','serial_continuation_claim_delete','serial_continuation_completion_guard','serial_continuation_completion_no_update','serial_continuation_completion_no_delete','serial_continuation_authorization_insert','serial_continuation_authorization_no_update','serial_continuation_authorization_no_delete','serial_continuation_claim_phase'))=18 AND ${stableSourceIntegrity} AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_ledger_stage_no_replace','serial_ledger_stage_no_update','serial_ledger_stage_no_delete'))=3 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_pilot_notice_release_no_replace','serial_pilot_notice_release_no_update','serial_pilot_notice_release_no_delete'))=3 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_pilot_round_insert','serial_pilot_items_insert','serial_pilot_items_no_update','serial_pilot_items_no_delete','serial_pilot_round_no_delete','serial_pilot_round_transition','serial_pilot_bindings_insert','serial_pilot_bindings_no_update','serial_pilot_bindings_no_delete','serial_pilot_fence_reservation','serial_pilot_fence_audit_no_replace','serial_pilot_fence_audit_no_update','serial_pilot_fence_audit_no_delete','serial_pilot_snapshot_insert_guard','serial_pilot_snapshot_audit'))=15 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_source_provenance_no_update','serial_source_provenance_no_delete','serial_source_provenance_no_replace','serial_source_provenance_namespace_guard','serial_source_provenance_insert_guard','serial_source_provenance_update_guard','serial_source_provenance_delete_guard','serial_source_job_birth_guard','serial_job_provenance_insert_guard','serial_job_provenance_update_guard','serial_job_provenance_delete_guard','serial_job_provenance_activation_no_update','serial_job_provenance_activation_no_delete','serial_job_provenance_activation_no_replace','serial_job_provenance_source_gate','serial_pilot_hold_no_replace','serial_pilot_hold_no_update','serial_pilot_hold_no_delete','serial_pilot_oracle_fence_no_replace','serial_pilot_oracle_fence_no_update','serial_pilot_oracle_fence_no_delete','serial_pilot_attested_handoff_no_replace','serial_pilot_attested_handoff_no_update','serial_pilot_attested_handoff_no_delete'))=24 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_pilot_oracle_revoke_insert','serial_pilot_oracle_revoke_no_update','serial_pilot_oracle_revoke_no_delete'))=3`;

/** Local-only continuation claim experiment. A lost D1 acknowledgement is
 * intentionally uncertain: it never retries the batch or dispatches provider
 * work. The retained session/claim must be inspected before another attempt. */
export async function claimAttestedContinuationDraft(env:ParkedPilotEnv,job:{entityType:string;entityKey:string;entityVersion:number;traceId:string},lease:string,token:string,valid:()=>boolean):Promise<'CLAIMED'|'UNVERIFIED'>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,version=env.CF_VERSION_METADATA?.id;
 const stable=()=>valid()&&db===env.DB&&book===env.GOOGLE_SPREADSHEET_ID&&version===env.CF_VERSION_METADATA?.id&&env.SERIAL_ATTESTED_HANDOFF_ENABLED==='true'&&!!version&&parkedPilotEnabled(env,version);
 if(!book||!version||!lease||!token||job.entityType!=='EXPENSE'||!stable())return 'UNVERIFIED';
 try{
  const ready=continuationIntegritySql;
  const authorize=db.prepare(`INSERT INTO serial_pilot_continuation_authorizations(operation_token,epoch_id,job_id,lease_token,lease_generation,previous_operation_token,worker_version,created_at)
   SELECT ?,s.epoch_id,j.job_id,?,j.serial_lease_generation,COALESCE((SELECT p.operation_token FROM serial_pilot_continuation_permits p JOIN serial_pilot_ledger_stage_receipts r ON r.operation_token=p.operation_token AND r.epoch_id=p.epoch_id JOIN stable_recovery_operations o ON o.operation_token=p.operation_token AND o.epoch_id=p.epoch_id AND o.state='VERIFIED' WHERE p.epoch_id=s.epoch_id AND p.job_id=s.job_id AND p.lease_generation<j.serial_lease_generation ORDER BY p.lease_generation DESC LIMIT 1),(SELECT r.operation_token FROM serial_pilot_notice_release_receipts r JOIN stable_recovery_operations o ON o.operation_token=r.operation_token AND o.epoch_id=r.epoch_id AND o.state='VERIFIED' WHERE r.epoch_id=s.epoch_id AND r.nonce=s.nonce)),?,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM serial_pilot_continuation_sessions s JOIN sync_jobs j ON j.job_id=s.job_id
   WHERE s.spreadsheet_id=? AND j.entity_type=? AND j.entity_key=? AND j.entity_version=? AND j.trace_id=? AND j.status='PROCESSING' AND j.lease_token=? AND ${ready}
   AND NOT EXISTS(SELECT 1 FROM serial_pilot_continuation_completions x WHERE x.epoch_id=s.epoch_id)`)
   .bind(token,lease,version,book,job.entityType,job.entityKey,job.entityVersion,job.traceId,lease);
  const permit=db.prepare(`INSERT INTO serial_pilot_continuation_permits(operation_token,epoch_id,job_id,lease_token,lease_generation,worker_version,created_at)
   SELECT ?,s.epoch_id,j.job_id,?,j.serial_lease_generation,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM serial_pilot_continuation_sessions s JOIN sync_jobs j ON j.job_id=s.job_id
   WHERE s.spreadsheet_id=? AND j.entity_type=? AND j.entity_key=? AND j.entity_version=? AND j.trace_id=? AND j.status='PROCESSING' AND j.lease_token=? AND ${ready}
   AND NOT EXISTS(SELECT 1 FROM serial_pilot_continuation_completions x WHERE x.epoch_id=s.epoch_id)`)
   .bind(token,lease,version,book,job.entityType,job.entityKey,job.entityVersion,job.traceId,lease);
  const claim=db.prepare(`INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,phase,created_at,updated_at)
   SELECT ?,?,'HELD','SERIAL_CONTINUATION',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE changes()=1 AND ${ready}`)
   .bind(book,token);
  const guard=db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid','$') END AS ok");
  if(!stable())return 'UNVERIFIED';
  const result=await db.batch([authorize,permit,claim,guard]);
  return stable()&&Array.isArray(result)&&result.length===4&&result.every(x=>x.success===true)&&Array.isArray(result[3]?.results)&&result[3].results.length===1&&(result[3].results[0] as {ok?:unknown})?.ok===1?'CLAIMED':'UNVERIFIED';
 }catch{return 'UNVERIFIED';}
}

/** Diagnostic for an exact continuation claim. NO_SESSION is not evidence
 * that a job has no attested lineage and never grants write authority. */
export async function continuationFenceOwned(env:ParkedPilotEnv,token:string,valid:()=>boolean):Promise<'NO_SESSION'|'OWNED'|'UNVERIFIED'>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,version=env.CF_VERSION_METADATA?.id;
 const stable=()=>valid()&&db===env.DB&&book===env.GOOGLE_SPREADSHEET_ID&&version===env.CF_VERSION_METADATA?.id&&env.SERIAL_ATTESTED_HANDOFF_ENABLED==='true'&&!!version&&parkedPilotEnabled(env,version);
 if(!book||!token||!stable())return 'UNVERIFIED';
 try{
  const rows=await db.prepare(`SELECT s.job_id,CASE WHEN ${continuationIntegritySql} AND EXISTS(
   SELECT 1 FROM serial_pilot_continuation_permits p JOIN serial_pilot_continuation_authorizations auth ON auth.operation_token=p.operation_token AND auth.epoch_id=p.epoch_id AND auth.job_id=p.job_id AND auth.lease_token=p.lease_token AND auth.lease_generation=p.lease_generation AND auth.worker_version=p.worker_version JOIN sync_jobs j ON j.job_id=p.job_id AND j.serial_provenance_version=1 AND j.serial_lease_generation=p.lease_generation
   JOIN stable_recovery_epochs e ON e.epoch_id=s.epoch_id AND e.spreadsheet_id=s.spreadsheet_id AND e.target_type='EXPENSE' AND e.target_key=j.entity_key AND e.target_version=j.entity_version AND e.state='ARMED'
   JOIN stable_workbook_claims c ON c.spreadsheet_id=s.spreadsheet_id AND c.operation_token=p.operation_token AND c.state='HELD' AND c.phase='SERIAL_CONTINUATION'
   JOIN serial_pilot_attested_handoffs h ON h.nonce=s.nonce AND h.successor_epoch_id=s.epoch_id AND h.successor_job_id=s.job_id AND h.worker_version=p.worker_version
   JOIN serial_pilot_notice_release_receipts r ON r.nonce=h.nonce AND r.epoch_id=s.epoch_id AND r.successor_job_id=s.job_id AND r.spreadsheet_id=s.spreadsheet_id
   JOIN stable_source_revision rev ON rev.singleton=1 AND rev.revision=r.source_revision
   JOIN stable_recovery_operations prior ON prior.operation_token=r.operation_token AND prior.epoch_id=s.epoch_id AND prior.state='VERIFIED'
   JOIN stable_projection_writes daily ON daily.spreadsheet_id=s.spreadsheet_id AND daily.entity_type='EXPENSE' AND daily.entity_id=j.entity_key AND daily.source_version=j.entity_version AND daily.projection='DAILY' AND daily.operation_token=r.operation_token AND daily.state='VERIFIED'
   JOIN atomic_daily_marker_reservations marker ON marker.spreadsheet_id=daily.spreadsheet_id AND marker.sheet_id=daily.sheet_id AND marker.entity_id=daily.entity_id AND marker.source_version=daily.source_version AND marker.operation_token=daily.operation_token
   JOIN continuous_daily_write_evidence evidence ON evidence.spreadsheet_id=daily.spreadsheet_id AND evidence.entity_id=daily.entity_id AND evidence.sheet_id=daily.sheet_id AND evidence.sheet_name=daily.sheet_name AND evidence.source_version=daily.source_version AND evidence.source_digest=daily.source_digest AND evidence.operation_token=daily.operation_token AND evidence.marker=marker.marker
   JOIN stable_expense_projection_preimages preimage ON preimage.spreadsheet_id=daily.spreadsheet_id AND preimage.entity_type=daily.entity_type AND preimage.entity_id=daily.entity_id AND preimage.source_version=daily.source_version AND preimage.projection=daily.projection AND preimage.sheet_id=daily.sheet_id AND preimage.sheet_name=daily.sheet_name AND preimage.source_digest=daily.source_digest
   JOIN serial_pilot_oracle_fence f ON f.spreadsheet_id=s.spreadsheet_id AND f.fence_digest=s.fence_digest AND f.generation=s.fence_generation
   WHERE p.operation_token=? AND p.epoch_id=s.epoch_id AND p.job_id=s.job_id AND p.worker_version=?
    AND auth.lease_generation>1 AND auth.previous_operation_token=COALESCE((SELECT previous.operation_token FROM serial_pilot_continuation_permits previous JOIN serial_pilot_ledger_stage_receipts receipt ON receipt.operation_token=previous.operation_token AND receipt.epoch_id=previous.epoch_id JOIN stable_recovery_operations prior_stage ON prior_stage.operation_token=previous.operation_token AND prior_stage.epoch_id=previous.epoch_id AND prior_stage.state='VERIFIED' WHERE previous.epoch_id=s.epoch_id AND previous.job_id=s.job_id AND previous.lease_generation<auth.lease_generation ORDER BY previous.lease_generation DESC LIMIT 1),r.operation_token)
    AND ((j.status='PROCESSING' AND j.lease_token=p.lease_token AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) OR (j.status='PENDING' AND j.last_error='STABLE_STAGE_CONTINUE' AND j.lease_token IS NULL AND j.lease_until IS NULL))
    AND NOT EXISTS(SELECT 1 FROM serial_pilot_oracle_revocations v WHERE v.spreadsheet_id=f.spreadsheet_id AND v.fence_digest=f.fence_digest AND v.fence_generation=f.generation)
    AND NOT EXISTS(SELECT 1 FROM failed_jobs z WHERE z.queue_name='malipang-jobs' AND z.job_key='EXPENSE:'||j.entity_key||':'||j.entity_version AND z.status='OPEN')
   ) THEN 1 ELSE 0 END AS ok FROM serial_pilot_continuation_sessions s WHERE s.spreadsheet_id=? AND NOT EXISTS(SELECT 1 FROM serial_pilot_continuation_completions x WHERE x.epoch_id=s.epoch_id) LIMIT 2`)
   .bind(token,version,book).all<{job_id:string;ok:number}>();
  if(!stable()||rows.success!==true||!Array.isArray(rows.results)||rows.results.length>1)return 'UNVERIFIED';
  if(rows.results.length===0){
   const lineage=await db.prepare(`SELECT 1 AS found FROM serial_pilot_continuation_permits p WHERE p.operation_token=? UNION ALL SELECT 1 AS found FROM serial_pilot_attested_handoffs h JOIN serial_pilot_notice_release_receipts r ON r.nonce=h.nonce AND r.operation_token=h.claim_token WHERE h.claim_token=? LIMIT 1`).bind(token,token).all<{found:number}>();
   if(!stable()||lineage.success!==true||!Array.isArray(lineage.results))return 'UNVERIFIED';
   return lineage.results.length===0?'NO_SESSION':'UNVERIFIED';
  }
  return rows.results[0]?.ok===1?'OWNED':'UNVERIFIED';
 }catch{return 'UNVERIFIED';}
}

export function parseSerialLedgerSheetId(value:string|undefined):number|null{
 if(!value||!/^(0|[1-9]\d*)$/.test(value))return null;
 const n=Number(value);return Number.isSafeInteger(n)?n:null;
}

/** Record a verified RAW/DETAIL observation while retaining the claim. This
 * draft does not release the workbook or authorize a later stage. */
export async function recordAttestedLedgerStageDraft(env:ParkedPilotEnv,token:string,observation:{postimageDigest:string;observedAt:string},valid:()=>boolean):Promise<'RECORDED'|'RECEIPT_RECORDED'|'UNVERIFIED'>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,version=env.CF_VERSION_METADATA?.id,{postimageDigest,observedAt}=observation;
 const targetScope=()=>JSON.stringify([env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET]);
 const capturedScope=targetScope(),rawId=parseSerialLedgerSheetId(env.CONTINUOUS_RAW_SHEET_ID),detailId=parseSerialLedgerSheetId(env.CONTINUOUS_DETAIL_SHEET_ID),rawName=env.CONTINUOUS_RAW_SHEET,detailName=env.CONTINUOUS_DETAIL_SHEET;
 const stable=()=>valid()&&db===env.DB&&book===env.GOOGLE_SPREADSHEET_ID&&version===env.CF_VERSION_METADATA?.id&&targetScope()===capturedScope&&env.SERIAL_ATTESTED_HANDOFF_ENABLED==='true'&&!!version&&parkedPilotEnabled(env,version);
 if(!book||!token||rawId===null||detailId===null||!rawName||rawName!==rawName.trim()||!detailName||detailName!==detailName.trim()||!stable()||!/^[a-f0-9]{64}$/.test(postimageDigest)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt)||!Number.isFinite(Date.parse(observedAt))||new Date(observedAt).toISOString()!==observedAt)return 'UNVERIFIED';
 const prior=()=>db.prepare(`SELECT 1 AS found FROM serial_pilot_ledger_stage_receipts r JOIN stable_workbook_claims c ON c.spreadsheet_id=r.spreadsheet_id AND c.operation_token=r.operation_token AND c.state='HELD' WHERE r.operation_token=? AND r.spreadsheet_id=? AND r.worker_version=? AND r.notice_postimage_digest=? AND r.observed_at=?`).bind(token,book,version,postimageDigest,observedAt).first<{found:number}>();
 try{
  if((await prior())?.found===1)return stable()?'RECEIPT_RECORDED':'UNVERIFIED';
  const integrity=`${continuationIntegritySql} AND ${continuousDailyCutoverIntegrity} AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='serial_ledger_stage_not_ready') AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_ledger_stage_no_replace','serial_ledger_stage_no_update','serial_ledger_stage_no_delete','continuous_ledger_evidence_source','continuous_ledger_evidence_no_update','continuous_ledger_evidence_no_delete','continuous_ledger_evidence_no_replace','atomic_daily_marker_no_delete','atomic_daily_marker_no_update','atomic_daily_marker_no_replace','stable_expense_preimage_verified_source','stable_expense_preimage_no_update','stable_expense_preimage_no_delete','stable_expense_preimage_no_replace','continuous_report_attempt_insert','continuous_report_attempt_transition','continuous_report_attempt_no_delete','continuous_report_attempt_no_replace'))=18`;
  const insert=db.prepare(`INSERT INTO serial_pilot_ledger_stage_receipts(operation_token,epoch_id,spreadsheet_id,job_id,entity_id,projection,source_version,source_digest,source_revision,sheet_id,sheet_name,before_digest,payload_digest,ledger_marker,worker_version,nonce,notice_algorithm,notice_postimage_digest,observed_at,recorded_at)
   SELECT c.operation_token,s.epoch_id,s.spreadsheet_id,s.job_id,p.entity_id,p.projection,p.source_version,p.source_digest,rev.revision,p.sheet_id,p.sheet_name,le.before_digest,le.payload_digest,le.marker,h.worker_version,h.nonce,'SHA256_MALIPANG_NOTICE_POSTIMAGE_V1',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')
   FROM serial_pilot_continuation_sessions s JOIN serial_pilot_continuation_permits permit ON permit.epoch_id=s.epoch_id AND permit.job_id=s.job_id AND permit.operation_token=?
   JOIN stable_workbook_claims c ON c.spreadsheet_id=s.spreadsheet_id AND c.operation_token=permit.operation_token AND c.state='HELD'
   JOIN sync_jobs j ON j.job_id=s.job_id AND j.entity_type='EXPENSE' AND j.status='PENDING' AND j.last_error='STABLE_STAGE_CONTINUE' AND j.lease_token IS NULL AND j.lease_until IS NULL AND j.serial_provenance_version=1 AND j.serial_lease_generation=permit.lease_generation
   JOIN expense_events source ON source.expense_id=j.entity_key AND source.version=j.entity_version AND source.status='CONFIRMED'
   JOIN stable_recovery_epochs ep ON ep.epoch_id=s.epoch_id AND ep.spreadsheet_id=s.spreadsheet_id AND ep.target_type='EXPENSE' AND ep.target_key=j.entity_key AND ep.target_version=j.entity_version AND ep.state='ARMED'
   JOIN stable_recovery_operations o ON o.epoch_id=s.epoch_id AND o.operation_token=c.operation_token AND o.state='ADMITTED'
   JOIN serial_pilot_attested_handoffs h ON h.nonce=s.nonce AND h.successor_epoch_id=s.epoch_id AND h.successor_job_id=s.job_id AND h.worker_version=permit.worker_version
   JOIN serial_pilot_notice_release_receipts daily_receipt ON daily_receipt.nonce=s.nonce AND daily_receipt.epoch_id=s.epoch_id AND daily_receipt.successor_job_id=s.job_id AND daily_receipt.spreadsheet_id=s.spreadsheet_id
   JOIN stable_source_revision rev ON rev.singleton=1 AND rev.revision=daily_receipt.source_revision
   JOIN stable_projection_writes daily ON daily.spreadsheet_id=s.spreadsheet_id AND daily.entity_type='EXPENSE' AND daily.entity_id=j.entity_key AND daily.source_version=j.entity_version AND daily.projection='DAILY' AND daily.operation_token=daily_receipt.operation_token AND daily.state='VERIFIED'
   JOIN stable_projection_writes p ON p.spreadsheet_id=s.spreadsheet_id AND p.entity_type='EXPENSE' AND p.source_version=j.entity_version AND p.source_digest=daily.source_digest AND p.operation_token=c.operation_token AND p.state='VERIFIED'
   JOIN atomic_daily_marker_reservations m ON m.spreadsheet_id=p.spreadsheet_id AND m.sheet_id=p.sheet_id AND m.entity_id=p.entity_id AND m.source_version=p.source_version AND m.operation_token=p.operation_token
   JOIN continuous_ledger_write_evidence le ON le.spreadsheet_id=p.spreadsheet_id AND le.entity_id=p.entity_id AND le.projection=p.projection AND le.operation_kind='CONFIRM' AND le.sheet_id=p.sheet_id AND le.sheet_name=p.sheet_name AND le.source_version=p.source_version AND le.operation_token=p.operation_token
   JOIN stable_expense_projection_preimages pi ON pi.spreadsheet_id=p.spreadsheet_id AND pi.entity_type=p.entity_type AND pi.entity_id=p.entity_id AND pi.source_version=p.source_version AND pi.projection=p.projection AND pi.sheet_id=p.sheet_id AND pi.sheet_name=p.sheet_name AND pi.source_digest=p.source_digest
   JOIN serial_pilot_oracle_fence f ON f.spreadsheet_id=s.spreadsheet_id AND f.fence_digest=s.fence_digest AND f.generation=s.fence_generation
   JOIN continuous_daily_cutovers cutover ON cutover.spreadsheet_id=s.spreadsheet_id AND cutover.state='ACTIVE' AND cutover.raw_sheet_id=? AND cutover.raw_sheet_name=? AND cutover.detail_sheet_id=? AND cutover.detail_sheet_name=?
   WHERE s.spreadsheet_id=? AND h.worker_version=? AND o.admitted_at<=? AND ?<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ${integrity}
    AND ((p.projection='EXPENSE_RAW' AND p.sheet_id=cutover.raw_sheet_id AND p.sheet_name=cutover.raw_sheet_name) OR (p.projection='DETAIL' AND p.sheet_id=cutover.detail_sheet_id AND p.sheet_name=cutover.detail_sheet_name))
    AND NOT EXISTS(SELECT 1 FROM serial_pilot_continuation_completions x WHERE x.epoch_id=s.epoch_id)
    AND NOT EXISTS(SELECT 1 FROM serial_pilot_oracle_revocations v WHERE v.spreadsheet_id=f.spreadsheet_id AND v.fence_digest=f.fence_digest AND v.fence_generation=f.generation)
    AND NOT EXISTS(SELECT 1 FROM failed_jobs z WHERE z.queue_name='malipang-jobs' AND z.job_key='EXPENSE:'||j.entity_key||':'||j.entity_version AND z.status='OPEN')
    AND (SELECT count(*) FROM stable_projection_writes q WHERE q.spreadsheet_id=s.spreadsheet_id AND q.operation_token=c.operation_token)=1
    AND ((p.projection='EXPENSE_RAW' AND p.entity_id=j.entity_key AND NOT EXISTS(SELECT 1 FROM serial_pilot_ledger_stage_receipts x WHERE x.epoch_id=s.epoch_id))
      OR (p.projection='DETAIL' AND EXISTS(SELECT 1 FROM serial_pilot_ledger_stage_receipts x WHERE x.epoch_id=s.epoch_id AND x.projection='EXPENSE_RAW' AND x.entity_id=j.entity_key)
       AND EXISTS(SELECT 1 FROM expense_document_items item WHERE item.expense_id=j.entity_key AND p.entity_id=j.entity_key||'|'||item.item_id)
       AND NOT EXISTS(SELECT 1 FROM expense_document_items earlier JOIN expense_document_items current ON current.expense_id=j.entity_key AND p.entity_id=j.entity_key||'|'||current.item_id WHERE earlier.expense_id=j.entity_key AND (earlier.created_at<current.created_at OR (earlier.created_at=current.created_at AND earlier.item_id<current.item_id)) AND NOT EXISTS(SELECT 1 FROM serial_pilot_ledger_stage_receipts prev WHERE prev.epoch_id=s.epoch_id AND prev.projection='DETAIL' AND prev.entity_id=j.entity_key||'|'||earlier.item_id))))`)
   .bind(postimageDigest,observedAt,token,rawId,rawName,detailId,detailName,book,version,observedAt,observedAt);
  const guard=db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid','$') END AS ok");
  if(!stable())return 'UNVERIFIED';
  const result=await db.batch([insert,guard]);
  if(!stable()||!Array.isArray(result)||result.length!==2||result.some(x=>x.success!==true))return 'UNVERIFIED';
  return (await prior())?.found===1&&stable()?'RECORDED':'UNVERIFIED';
 }catch{try{return (await prior())?.found===1&&stable()?'RECEIPT_RECORDED':'UNVERIFIED';}catch{return 'UNVERIFIED';}}
}

/** Local-only release of a previously recorded RAW/DETAIL stage. A returned
 * RELEASE_RECORDED is history only; a later stage must independently acquire
 * its permit and validate current fence and all prior receipts. */
export async function releaseAttestedLedgerStageDraft(env:ParkedPilotEnv,token:string,observation:{postimageDigest:string;observedAt:string},valid:()=>boolean):Promise<'RELEASED'|'RELEASE_RECORDED'|'UNVERIFIED'>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,version=env.CF_VERSION_METADATA?.id,{postimageDigest,observedAt}=observation;
 const targetScope=()=>JSON.stringify([env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET]);
 const scope=targetScope(),rawId=parseSerialLedgerSheetId(env.CONTINUOUS_RAW_SHEET_ID),detailId=parseSerialLedgerSheetId(env.CONTINUOUS_DETAIL_SHEET_ID),rawName=env.CONTINUOUS_RAW_SHEET,detailName=env.CONTINUOUS_DETAIL_SHEET;
 const stable=()=>valid()&&db===env.DB&&book===env.GOOGLE_SPREADSHEET_ID&&version===env.CF_VERSION_METADATA?.id&&targetScope()===scope&&env.SERIAL_ATTESTED_HANDOFF_ENABLED==='true'&&!!version&&parkedPilotEnabled(env,version);
 if(!book||!token||rawId===null||detailId===null||!rawName||rawName!==rawName.trim()||!detailName||detailName!==detailName.trim()||!/^[a-f0-9]{64}$/.test(postimageDigest)||!stable())return 'UNVERIFIED';
 const prior=()=>db.prepare(`SELECT 1 AS found FROM serial_pilot_ledger_stage_receipts r JOIN stable_recovery_operations o ON o.operation_token=r.operation_token AND o.epoch_id=r.epoch_id AND o.state='VERIFIED' WHERE r.operation_token=? AND r.spreadsheet_id=? AND r.worker_version=? AND r.notice_postimage_digest=? AND r.observed_at=? AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=r.spreadsheet_id AND c.operation_token=r.operation_token)`).bind(token,book,version,postimageDigest,observedAt).first<{found:number}>();
 try{
  if((await prior())?.found===1)return stable()?'RELEASE_RECORDED':'UNVERIFIED';
  const integrity=`${continuationIntegritySql} AND ${continuousDailyCutoverIntegrity} AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='serial_ledger_stage_not_ready') AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_ledger_stage_no_replace','serial_ledger_stage_no_update','serial_ledger_stage_no_delete','continuous_ledger_evidence_source','continuous_ledger_evidence_no_update','continuous_ledger_evidence_no_delete','continuous_ledger_evidence_no_replace','atomic_daily_marker_no_delete','atomic_daily_marker_no_update','atomic_daily_marker_no_replace','stable_expense_preimage_verified_source','stable_expense_preimage_no_update','stable_expense_preimage_no_delete','stable_expense_preimage_no_replace','continuous_report_attempt_insert','continuous_report_attempt_transition','continuous_report_attempt_no_delete','continuous_report_attempt_no_replace'))=18`;
  const exact=`EXISTS(SELECT 1 FROM serial_pilot_ledger_stage_receipts r JOIN stable_workbook_claims c ON c.spreadsheet_id=r.spreadsheet_id AND c.operation_token=r.operation_token AND c.state='HELD' WHERE r.operation_token=? AND r.spreadsheet_id=? AND r.worker_version=? AND r.notice_postimage_digest=? AND r.observed_at=? AND ((r.projection='EXPENSE_RAW' AND r.sheet_id=? AND r.sheet_name=?) OR (r.projection='DETAIL' AND r.sheet_id=? AND r.sheet_name=?)))`;
  const args=[token,book,version,postimageDigest,observedAt,rawId,rawName,detailId,detailName];
  const update=db.prepare(`UPDATE stable_recovery_operations SET state='VERIFIED',verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_token=? AND state='ADMITTED' AND ${integrity} AND ${exact}`).bind(token,...args);
  const remove=db.prepare(`DELETE FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD' AND changes()=1 AND ${integrity} AND ${exact}`).bind(book,token,...args);
  const guard=db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid','$') END AS ok");
  if(!stable())return 'UNVERIFIED';
  const result=await db.batch([update,remove,guard]);
  if(!stable()||!Array.isArray(result)||result.length!==3||result.some(x=>x.success!==true))return 'UNVERIFIED';
  return (await prior())?.found===1&&stable()?'RELEASED':'UNVERIFIED';
 }catch{try{return (await prior())?.found===1&&stable()?'RELEASE_RECORDED':'UNVERIFIED';}catch{return 'UNVERIFIED';}}
}

/** Local final observation only. The caller-provided hashes are not authority;
 * a future trusted Worker must derive them from its own verified readback. */
async function finalEvidenceDraft(env:ParkedPilotEnv,token:string,observation:{providerDigest:string;noticeDigest:string;providerObservedAt:string;noticeObservedAt:string;sourceRevision?:number;sourceDigest?:string},valid:()=>boolean,checkOnly:boolean):Promise<'RECORDED'|'RECEIPT_RECORDED'|'PREFLIGHT_READY'|'UNVERIFIED'>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,version=env.CF_VERSION_METADATA?.id,{providerDigest,noticeDigest,providerObservedAt,noticeObservedAt}=observation;
 const targetScope=()=>JSON.stringify([env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET]);
 const scope=targetScope(),dailyId=parseSerialLedgerSheetId(env.CONTINUOUS_DAILY_SHEET_ID),rawId=parseSerialLedgerSheetId(env.CONTINUOUS_RAW_SHEET_ID),detailId=parseSerialLedgerSheetId(env.CONTINUOUS_DETAIL_SHEET_ID),dailyName=env.CONTINUOUS_DAILY_SHEET,rawName=env.CONTINUOUS_RAW_SHEET,detailName=env.CONTINUOUS_DETAIL_SHEET;
 const stable=()=>valid()&&db===env.DB&&book===env.GOOGLE_SPREADSHEET_ID&&version===env.CF_VERSION_METADATA?.id&&targetScope()===scope&&env.SERIAL_ATTESTED_HANDOFF_ENABLED==='true'&&!!version&&parkedPilotEnabled(env,version);
 if(!book||!token||dailyId===null||rawId===null||detailId===null||!dailyName||dailyName!==dailyName.trim()||!rawName||rawName!==rawName.trim()||!detailName||detailName!==detailName.trim()||!/^[a-f0-9]{64}$/.test(providerDigest)||!/^[a-f0-9]{64}$/.test(noticeDigest)||![providerObservedAt,noticeObservedAt].every(value=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value)||providerObservedAt>noticeObservedAt||!stable())return 'UNVERIFIED';
 const prior=()=>db.prepare(`SELECT 1 AS found FROM serial_pilot_final_receipts r JOIN stable_workbook_claims c ON c.spreadsheet_id=r.spreadsheet_id AND c.operation_token=r.operation_token AND c.state='HELD' WHERE r.operation_token=? AND r.spreadsheet_id=? AND r.worker_version=? AND r.provider_digest=? AND r.notice_digest=? AND r.provider_observed_at=? AND r.notice_observed_at=?`).bind(token,book,version,providerDigest,noticeDigest,providerObservedAt,noticeObservedAt).first<{found:number}>();
 try{
  if((await prior())?.found===1)return checkOnly?'UNVERIFIED':stable()?'RECEIPT_RECORDED':'UNVERIFIED';
  const preflightGuard=checkOnly?" AND rev.revision=? AND daily.source_digest=? AND NOT EXISTS(SELECT 1 FROM serial_pilot_final_receipts previous WHERE previous.operation_token=c.operation_token OR previous.epoch_id=s.epoch_id) AND NOT EXISTS(SELECT 1 FROM serial_pilot_final_completions previous WHERE previous.operation_token=c.operation_token OR previous.epoch_id=s.epoch_id) AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name IN ('serial_final_completion_not_ready','serial_continuation_completion_not_ready')) AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_final_completion_guard','serial_final_completion_integrity','serial_final_completion_apply','serial_final_completion_no_replace','serial_final_completion_no_update','serial_final_completion_no_delete','serial_final_release_delete'))=7":'';
  const integrity=`${continuationIntegritySql} AND ${continuousDailyCutoverIntegrity}${preflightGuard} AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='serial_final_receipt_not_ready') AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_final_receipt_no_replace','serial_final_receipt_no_update','serial_final_receipt_no_delete','serial_ledger_stage_no_replace','serial_ledger_stage_no_update','serial_ledger_stage_no_delete','continuous_ledger_evidence_source','continuous_ledger_evidence_no_update','continuous_ledger_evidence_no_delete','continuous_ledger_evidence_no_replace','atomic_daily_marker_no_delete','atomic_daily_marker_no_update','atomic_daily_marker_no_replace','stable_expense_preimage_verified_source','stable_expense_preimage_no_update','stable_expense_preimage_no_delete','stable_expense_preimage_no_replace','continuous_report_attempt_insert','continuous_report_attempt_transition','continuous_report_attempt_no_delete','continuous_report_attempt_no_replace','continuous_daily_evidence_source','continuous_daily_evidence_no_update','continuous_daily_evidence_no_delete','continuous_daily_evidence_no_replace'))=25`;
  const sql=`WITH target AS (
   SELECT s.epoch_id,s.spreadsheet_id,s.job_id,s.nonce,h.worker_version,j.entity_key,j.entity_version,rev.revision,daily.source_digest,o.admitted_at
   FROM serial_pilot_continuation_sessions s JOIN serial_pilot_continuation_permits permit ON permit.epoch_id=s.epoch_id AND permit.job_id=s.job_id AND permit.operation_token=?
   JOIN stable_workbook_claims c ON c.spreadsheet_id=s.spreadsheet_id AND c.operation_token=permit.operation_token AND c.state='HELD'
   JOIN sync_jobs j ON j.job_id=s.job_id AND j.entity_type='EXPENSE' AND j.status='COMPLETED' AND j.last_error IS NULL AND j.next_attempt_at IS NULL AND j.lease_token IS NULL AND j.lease_until IS NULL AND j.serial_provenance_version=1 AND j.serial_lease_generation=permit.lease_generation
   JOIN expense_events source ON source.expense_id=j.entity_key AND source.version=j.entity_version AND source.status='CONFIRMED'
   JOIN stable_recovery_epochs ep ON ep.epoch_id=s.epoch_id AND ep.spreadsheet_id=s.spreadsheet_id AND ep.target_type='EXPENSE' AND ep.target_key=j.entity_key AND ep.target_version=j.entity_version AND ep.state='ARMED'
   JOIN stable_recovery_operations o ON o.epoch_id=s.epoch_id AND o.operation_token=c.operation_token AND o.state='ADMITTED'
   JOIN serial_pilot_attested_handoffs h ON h.nonce=s.nonce AND h.successor_epoch_id=s.epoch_id AND h.successor_job_id=s.job_id AND h.worker_version=permit.worker_version
   JOIN serial_pilot_notice_release_receipts dr ON dr.nonce=s.nonce AND dr.epoch_id=s.epoch_id AND dr.successor_job_id=s.job_id AND dr.spreadsheet_id=s.spreadsheet_id
   JOIN stable_source_revision rev ON rev.singleton=1 AND rev.revision=dr.source_revision
   JOIN stable_recovery_operations dailyop ON dailyop.epoch_id=s.epoch_id AND dailyop.operation_token=dr.operation_token AND dailyop.state='VERIFIED'
   JOIN stable_projection_writes daily ON daily.spreadsheet_id=s.spreadsheet_id AND daily.entity_type='EXPENSE' AND daily.entity_id=j.entity_key AND daily.source_version=j.entity_version AND daily.projection='DAILY' AND daily.operation_token=dr.operation_token AND daily.state='VERIFIED' AND daily.sheet_id=? AND daily.sheet_name=?
   JOIN atomic_daily_marker_reservations dm ON dm.spreadsheet_id=daily.spreadsheet_id AND dm.sheet_id=daily.sheet_id AND dm.entity_id=daily.entity_id AND dm.source_version=daily.source_version AND dm.operation_token=daily.operation_token
   JOIN continuous_daily_write_evidence de ON de.spreadsheet_id=daily.spreadsheet_id AND de.entity_id=daily.entity_id AND de.sheet_id=daily.sheet_id AND de.sheet_name=daily.sheet_name AND de.source_version=daily.source_version AND de.source_digest=daily.source_digest AND de.operation_token=daily.operation_token AND de.marker=dm.marker
   JOIN stable_expense_projection_preimages dpi ON dpi.spreadsheet_id=daily.spreadsheet_id AND dpi.entity_type=daily.entity_type AND dpi.entity_id=daily.entity_id AND dpi.source_version=daily.source_version AND dpi.projection=daily.projection AND dpi.sheet_id=daily.sheet_id AND dpi.sheet_name=daily.sheet_name AND dpi.source_digest=daily.source_digest
   JOIN serial_pilot_oracle_fence f ON f.spreadsheet_id=s.spreadsheet_id AND f.fence_digest=s.fence_digest AND f.generation=s.fence_generation
   JOIN continuous_daily_cutovers cutover ON cutover.spreadsheet_id=s.spreadsheet_id AND cutover.state='ACTIVE' AND cutover.continuous_sheet_id=? AND cutover.continuous_sheet_name=? AND cutover.raw_sheet_id=? AND cutover.raw_sheet_name=? AND cutover.detail_sheet_id=? AND cutover.detail_sheet_name=?
   WHERE s.spreadsheet_id=? AND h.worker_version=? AND o.admitted_at<=? AND ?<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ${integrity}
    AND NOT EXISTS(SELECT 1 FROM serial_pilot_continuation_completions x WHERE x.epoch_id=s.epoch_id)
    AND NOT EXISTS(SELECT 1 FROM serial_pilot_oracle_revocations v WHERE v.spreadsheet_id=f.spreadsheet_id AND v.fence_digest=f.fence_digest AND v.fence_generation=f.generation)
    AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations u WHERE u.epoch_id=s.epoch_id AND u.operation_token<>c.operation_token AND u.state<>'VERIFIED')
    AND NOT EXISTS(SELECT 1 FROM failed_jobs z WHERE z.queue_name='malipang-jobs' AND z.job_key='EXPENSE:'||j.entity_key||':'||j.entity_version AND z.status='OPEN')
  ), expected AS (
   SELECT entity_key entity_id,'EXPENSE_RAW' projection FROM target
   UNION ALL SELECT t.entity_key||'|'||i.item_id,'DETAIL' FROM target t JOIN expense_document_items i ON i.expense_id=t.entity_key
  ), proven AS (
   SELECT p.entity_id,p.projection,p.operation_token FROM target t JOIN serial_pilot_ledger_stage_receipts r ON r.epoch_id=t.epoch_id AND r.spreadsheet_id=t.spreadsheet_id AND r.job_id=t.job_id AND r.source_version=t.entity_version AND r.source_digest=t.source_digest AND r.source_revision=t.revision AND r.nonce=t.nonce AND r.worker_version=t.worker_version
   JOIN stable_recovery_operations op ON op.epoch_id=t.epoch_id AND op.operation_token=r.operation_token AND op.state='VERIFIED' AND op.admitted_at<=r.observed_at AND r.observed_at<=r.recorded_at
   JOIN stable_projection_writes p ON p.spreadsheet_id=r.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=r.entity_id AND p.projection=r.projection AND p.sheet_id=r.sheet_id AND p.sheet_name=r.sheet_name AND p.source_version=r.source_version AND p.source_digest=r.source_digest AND p.operation_token=r.operation_token AND p.state='VERIFIED'
   JOIN atomic_daily_marker_reservations m ON m.spreadsheet_id=p.spreadsheet_id AND m.sheet_id=p.sheet_id AND m.entity_id=p.entity_id AND m.source_version=p.source_version AND m.operation_token=p.operation_token
   JOIN continuous_ledger_write_evidence le ON le.spreadsheet_id=p.spreadsheet_id AND le.entity_id=p.entity_id AND le.projection=p.projection AND le.operation_kind='CONFIRM' AND le.sheet_id=p.sheet_id AND le.sheet_name=p.sheet_name AND le.source_version=p.source_version AND le.operation_token=p.operation_token AND le.marker=r.ledger_marker AND le.before_digest=r.before_digest AND le.payload_digest=r.payload_digest
   JOIN stable_expense_projection_preimages pi ON pi.spreadsheet_id=p.spreadsheet_id AND pi.entity_type=p.entity_type AND pi.entity_id=p.entity_id AND pi.source_version=p.source_version AND pi.projection=p.projection AND pi.sheet_id=p.sheet_id AND pi.sheet_name=p.sheet_name AND pi.source_digest=p.source_digest
   WHERE (p.projection='EXPENSE_RAW' AND p.sheet_id=? AND p.sheet_name=?) OR (p.projection='DETAIL' AND p.sheet_id=? AND p.sheet_name=?)
  ) INSERT INTO serial_pilot_final_receipts(operation_token,epoch_id,spreadsheet_id,job_id,nonce,worker_version,source_revision,source_digest,provider_algorithm,provider_digest,notice_algorithm,notice_digest,provider_observed_at,notice_observed_at,recorded_at)
   SELECT ?,t.epoch_id,t.spreadsheet_id,t.job_id,t.nonce,?,t.revision,t.source_digest,'SHA256_MALIPANG_PROJECTION_SNAPSHOT_V1',?,'SHA256_MALIPANG_NOTICE_POSTIMAGE_V1',?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM target t
   WHERE (SELECT count(*) FROM target)=1 AND (SELECT count(*) FROM expected)=(SELECT count(*) FROM proven)
    AND NOT EXISTS(SELECT entity_id,projection FROM expected EXCEPT SELECT entity_id,projection FROM proven)
    AND NOT EXISTS(SELECT entity_id,projection FROM proven EXCEPT SELECT entity_id,projection FROM expected)
    AND NOT EXISTS(SELECT 1 FROM serial_pilot_ledger_stage_receipts extra WHERE extra.epoch_id=t.epoch_id AND NOT EXISTS(SELECT 1 FROM proven matched WHERE matched.entity_id=extra.entity_id AND matched.projection=extra.projection AND matched.operation_token=extra.operation_token))
    AND (SELECT count(*) FROM stable_projection_writes p WHERE p.spreadsheet_id=t.spreadsheet_id AND p.entity_type='EXPENSE' AND (p.entity_id=t.entity_key OR substr(p.entity_id,1,length(t.entity_key)+1)=t.entity_key||'|'))=1+(SELECT count(*) FROM expected)
    AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=t.spreadsheet_id AND p.entity_type='EXPENSE' AND (p.entity_id=t.entity_key OR substr(p.entity_id,1,length(t.entity_key)+1)=t.entity_key||'|') AND NOT ((p.projection='DAILY' AND p.entity_id=t.entity_key) OR EXISTS(SELECT 1 FROM expected e WHERE e.entity_id=p.entity_id AND e.projection=p.projection)))`;
  const header='INSERT INTO serial_pilot_final_receipts(operation_token,epoch_id,spreadsheet_id,job_id,nonce,worker_version,source_revision,source_digest,provider_algorithm,provider_digest,notice_algorithm,notice_digest,provider_observed_at,notice_observed_at,recorded_at)';
  if(!sql.includes(header))return 'UNVERIFIED';
  if(checkOnly&&(!Number.isSafeInteger(observation.sourceRevision)||Number(observation.sourceRevision)<0||typeof observation.sourceDigest!=='string'||!/^[a-f0-9]{64}$/.test(observation.sourceDigest)))return 'UNVERIFIED';
  const insert=db.prepare(checkOnly?sql.replace(header,''):sql).bind(token,dailyId,dailyName,dailyId,dailyName,rawId,rawName,detailId,detailName,book,version,providerObservedAt,noticeObservedAt,...(checkOnly?[observation.sourceRevision,observation.sourceDigest]:[]),rawId,rawName,detailId,detailName,token,version,providerDigest,noticeDigest,providerObservedAt,noticeObservedAt);
  if(checkOnly){if(!stable())return 'UNVERIFIED';const result=await insert.all();return stable()&&result.success===true&&Array.isArray(result.results)&&result.results.length===1?'PREFLIGHT_READY':'UNVERIFIED';}
  const guard=db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid','$') END AS ok");
  if(!stable())return 'UNVERIFIED';const result=await db.batch([insert,guard]);
  if(!stable()||!Array.isArray(result)||result.length!==2||result.some(x=>x.success!==true))return 'UNVERIFIED';
  return (await prior())?.found===1&&stable()?'RECORDED':'UNVERIFIED';
 }catch{try{return (await prior())?.found===1&&stable()?'RECEIPT_RECORDED':'UNVERIFIED';}catch{return 'UNVERIFIED';}}
}

export async function recordAttestedFinalDraft(env:ParkedPilotEnv,token:string,observation:{providerDigest:string;noticeDigest:string;providerObservedAt:string;noticeObservedAt:string},valid:()=>boolean):Promise<'RECORDED'|'RECEIPT_RECORDED'|'UNVERIFIED'>{
 const result=await finalEvidenceDraft(env,token,observation,valid,false);return result==='PREFLIGHT_READY'?'UNVERIFIED':result;
}
/** Read-only and non-authorizing; the eventual receipt and completion recheck. */
export async function preflightAttestedFinalDraft(env:ParkedPilotEnv,token:string,proof:{providerDigest:string;providerObservedAt:string;sourceRevision:number;sourceDigest:string},valid:()=>boolean):Promise<boolean>{
 return await finalEvidenceDraft(env,token,{...proof,noticeDigest:'0'.repeat(64),noticeObservedAt:new Date().toISOString()},valid,true)==='PREFLIGHT_READY';
}

/** Local-only final completion experiment. A recorded result is historical:
 * it does not assert that the workbook is currently free or authorize writes. */
export async function completeAttestedFinalDraft(env:ParkedPilotEnv,token:string,observation:{providerDigest:string;noticeDigest:string;providerObservedAt:string;noticeObservedAt:string},valid:()=>boolean):Promise<'COMPLETED'|'COMPLETION_RECORDED'|'UNVERIFIED'>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,version=env.CF_VERSION_METADATA?.id,{providerDigest,noticeDigest,providerObservedAt,noticeObservedAt}=observation;
 const targetScope=()=>JSON.stringify([env.APP_ENV,env.SERIAL_MOCK_FINAL_COMPLETION_ENABLED,env.SERIAL_MOCK_CONTINUATION_ENABLED,env.SERIAL_ATTESTED_HANDOFF_ENABLED,env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET]);
 const scope=targetScope(),dailyId=parseSerialLedgerSheetId(env.CONTINUOUS_DAILY_SHEET_ID),rawId=parseSerialLedgerSheetId(env.CONTINUOUS_RAW_SHEET_ID),detailId=parseSerialLedgerSheetId(env.CONTINUOUS_DETAIL_SHEET_ID),dailyName=env.CONTINUOUS_DAILY_SHEET,rawName=env.CONTINUOUS_RAW_SHEET,detailName=env.CONTINUOUS_DETAIL_SHEET;
 const stable=()=>valid()&&env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&env.CF_VERSION_METADATA?.id===version&&targetScope()===scope&&env.APP_ENV==='test'&&env.SERIAL_MOCK_FINAL_COMPLETION_ENABLED==='true'&&env.SERIAL_MOCK_CONTINUATION_ENABLED==='true'&&env.SERIAL_ATTESTED_HANDOFF_ENABLED==='true'&&!!version&&parkedPilotEnabled(env,version);
 if(!book||!token||!version||dailyId===null||rawId===null||detailId===null||!dailyName||dailyName!==dailyName.trim()||!rawName||rawName!==rawName.trim()||!detailName||detailName!==detailName.trim()||!/^[a-f0-9]{64}$/.test(providerDigest)||!/^[a-f0-9]{64}$/.test(noticeDigest)||![providerObservedAt,noticeObservedAt].every(value=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value)||providerObservedAt>noticeObservedAt||!stable())return 'UNVERIFIED';
 const prior=()=>db.prepare(`SELECT f.operation_token FROM serial_pilot_final_completions f
  JOIN serial_pilot_continuation_completions completion ON completion.epoch_id=f.epoch_id AND completion.completed_at=f.completed_at
  JOIN stable_recovery_operations op ON op.operation_token=f.operation_token AND op.epoch_id=f.epoch_id AND op.state='VERIFIED' AND op.verified_at=f.completed_at
  JOIN stable_recovery_epochs epoch ON epoch.epoch_id=f.epoch_id AND epoch.spreadsheet_id=f.spreadsheet_id AND epoch.state IN ('COMPLETE','CLOSED')
  JOIN serial_pilot_final_receipts receipt ON receipt.operation_token=f.operation_token AND receipt.epoch_id=f.epoch_id AND receipt.spreadsheet_id=f.spreadsheet_id AND receipt.job_id=f.job_id AND receipt.nonce=f.nonce AND receipt.worker_version=f.worker_version AND receipt.provider_digest=f.provider_digest AND receipt.notice_digest=f.notice_digest AND receipt.provider_observed_at=f.provider_observed_at AND receipt.notice_observed_at=f.notice_observed_at
  WHERE f.operation_token=? AND f.spreadsheet_id=? AND f.worker_version=? AND f.daily_id=? AND f.daily_name=? AND f.raw_id=? AND f.raw_name=? AND f.detail_id=? AND f.detail_name=? AND f.provider_digest=? AND f.notice_digest=? AND f.provider_observed_at=? AND f.notice_observed_at=? LIMIT 2`).bind(token,book,version,dailyId,dailyName,rawId,rawName,detailId,detailName,providerDigest,noticeDigest,providerObservedAt,noticeObservedAt).all<{operation_token:string}>();
 const hasPrior=async()=>{const result=await prior();return result.success===true&&Array.isArray(result.results)&&result.results.length===1&&result.results[0]?.operation_token===token;};
 try{
  if(await hasPrior())return stable()?'COMPLETION_RECORDED':'UNVERIFIED';
  const completedAt=new Date().toISOString();
  const statement=db.prepare(`INSERT INTO serial_pilot_final_completions(operation_token,epoch_id,spreadsheet_id,job_id,nonce,worker_version,daily_id,daily_name,raw_id,raw_name,detail_id,detail_name,provider_digest,notice_digest,provider_observed_at,notice_observed_at,completed_at)
   SELECT ?,r.epoch_id,r.spreadsheet_id,r.job_id,r.nonce,?,?,?,?,?,?,?,?,?,?,?,? FROM serial_pilot_final_receipts r WHERE r.operation_token=? AND r.spreadsheet_id=? AND r.worker_version=? AND r.provider_digest=? AND r.notice_digest=? AND r.provider_observed_at=? AND r.notice_observed_at=? RETURNING operation_token`).bind(token,version,dailyId,dailyName,rawId,rawName,detailId,detailName,providerDigest,noticeDigest,providerObservedAt,noticeObservedAt,completedAt,token,book,version,providerDigest,noticeDigest,providerObservedAt,noticeObservedAt);
  if(!stable())return 'UNVERIFIED';const result=await statement.all<{operation_token:string}>();
  if(!stable()||result.success!==true||!Array.isArray(result.results)||result.results.length!==1||result.results[0]?.operation_token!==token)return 'UNVERIFIED';
  return await hasPrior()&&stable()?'COMPLETED':'UNVERIFIED';
 }catch{try{return await hasPrior()&&stable()?'COMPLETION_RECORDED':'UNVERIFIED';}catch{return 'UNVERIFIED';}}
}
