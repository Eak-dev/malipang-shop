import type {ParkedPilotEnv} from '../sheets/parked-notice-adoption';
import {parkedAuditAction,parkedSourceJoins} from '../sheets/parked-notice-adoption';

/** Local draft containment only: this never releases the workbook or grants C.
 * Even a recorded hold does not prove an inherited provider request finished. */
export async function holdReservedPilot(env:ParkedPilotEnv,roundId:string,jobId:string,fingerprint:string,version:string,valid:()=>boolean){
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,held=()=>({ok:false,outcome:'HELD'});let submitted=false;
 const read=()=>db.prepare(`SELECT 1 AS held FROM serial_pilot_hold_evidence h
  JOIN serial_pilot_rounds r ON r.round_id=h.round_id AND r.state='OPEN'
  JOIN serial_pilot_round_bindings b ON b.round_id=h.round_id AND b.spreadsheet_id=h.spreadsheet_id AND b.fingerprint=h.fingerprint
  JOIN sync_jobs j ON j.job_id=h.job_id AND j.status='REVIEW' AND j.last_error='SERIAL_PILOT_B_REVIEW' AND j.lease_token IS NULL AND j.lease_until IS NULL AND j.serial_provenance_version=1 AND j.serial_lease_generation=0
  JOIN expense_events e ON e.expense_id=j.entity_key AND e.version=j.entity_version AND e.serial_source_namespace=h.source_namespace
  JOIN serial_source_provenance_activation sp ON sp.singleton=1 AND sp.spreadsheet_id=h.spreadsheet_id AND sp.namespace=h.source_namespace
  JOIN admin_audit a ON a.id=h.audit_id AND a.action=? AND a.entity_key=j.job_id AND a.reason=h.fingerprint AND json_extract(a.after_json,'$.roundId')=h.round_id AND json_extract(a.after_json,'$.epoch')=h.epoch_id AND json_extract(a.after_json,'$.version')=?
  JOIN stable_workbook_claims c ON c.spreadsheet_id=h.spreadsheet_id AND c.operation_token=json_extract(a.after_json,'$.token') AND c.state='HELD' AND c.phase='PILOT_RESERVED'
  JOIN stable_recovery_epochs ep ON ep.epoch_id=h.epoch_id AND ep.spreadsheet_id=h.spreadsheet_id AND ep.state='ARMED' AND ep.target_type=j.entity_type AND ep.target_key=j.entity_key AND ep.target_version=j.entity_version
  WHERE h.round_id=? AND h.job_id=? AND h.spreadsheet_id=? AND h.fingerprint=?`).bind(parkedAuditAction,version,roundId,jobId,book,fingerprint).all<{held:number}>();
 try{
  if(!book||!valid())return held();
  const prior=await read();
  if(!valid()||prior.success!==true||!prior.results||prior.results.length>1)return held();
  if(prior.results.length===1)return {ok:true,outcome:'RECONCILIATION_REQUIRED'};
  const insert=db.prepare(`INSERT INTO serial_pilot_hold_evidence(round_id,job_id,audit_id,spreadsheet_id,fingerprint,epoch_id,source_namespace,observed_at)
   SELECT ?,j.job_id,a.id,w.spreadsheet_id,a.reason,ep.epoch_id,e.serial_source_namespace,strftime('%Y-%m-%dT%H:%M:%fZ','now')
   FROM admin_audit a ${parkedSourceJoins}
   JOIN serial_pilot_rounds r ON r.round_id=? AND r.state='OPEN'
   JOIN serial_pilot_round_items ri ON ri.round_id=r.round_id AND ri.job_id=j.job_id
   JOIN serial_pilot_round_bindings b ON b.round_id=r.round_id AND b.spreadsheet_id=w.spreadsheet_id AND b.fingerprint=a.reason
   JOIN expense_events e ON e.expense_id=j.entity_key AND e.version=j.entity_version AND e.status='CONFIRMED'
   JOIN serial_source_provenance_activation sp ON sp.singleton=1 AND sp.spreadsheet_id=w.spreadsheet_id AND sp.namespace=e.serial_source_namespace
   JOIN serial_job_provenance_activation jp ON jp.singleton=1 AND jp.spreadsheet_id=w.spreadsheet_id
   JOIN stable_workbook_claims c ON c.spreadsheet_id=w.spreadsheet_id AND c.operation_token=json_extract(a.after_json,'$.token') AND c.state='HELD' AND c.phase='PILOT_RESERVED' AND c.notice_identity IS NULL AND c.notice_stamp IS NULL
   JOIN stable_source_revision rev ON rev.singleton=1 AND rev.revision=json_extract(a.before_json,'$.revision')
   WHERE a.action=? AND a.entity_key=? AND a.reason=? AND w.spreadsheet_id=? AND json_extract(a.after_json,'$.version')=? AND json_extract(a.after_json,'$.roundId')=?
    AND ep.state='ARMED' AND j.status='PENDING' AND j.attempt_count=0 AND j.lease_token IS NULL AND j.lease_until IS NULL AND j.serial_provenance_version=1 AND j.serial_lease_generation=0
    AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name IN ('serial_pilot_hold_not_ready','serial_source_provenance_not_ready','serial_job_provenance_not_ready','serial_pilot_fence_not_ready'))
    AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_source_provenance_no_update','serial_source_provenance_no_delete','serial_source_provenance_no_replace','serial_source_provenance_namespace_guard','serial_source_provenance_insert_guard','serial_source_provenance_update_guard','serial_source_provenance_delete_guard','serial_source_job_birth_guard','serial_job_provenance_insert_guard','serial_job_provenance_update_guard','serial_job_provenance_delete_guard','serial_job_provenance_activation_no_update','serial_job_provenance_activation_no_delete','serial_job_provenance_activation_no_replace','serial_job_provenance_source_gate','serial_pilot_hold_no_replace','serial_pilot_hold_no_update','serial_pilot_hold_no_delete'))=18
    AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations o WHERE o.epoch_id=ep.epoch_id)
    AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=j.entity_key OR substr(p.entity_id,1,length(j.entity_key)+1)=j.entity_key||'|'))
    AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes x WHERE x.entity_type='EXPENSE' AND (x.entity_id=j.entity_key OR substr(x.entity_id,1,length(j.entity_key)+1)=j.entity_key||'|'))
    AND NOT EXISTS(SELECT 1 FROM sheet_row_index x WHERE x.entity_key=j.entity_key OR substr(x.entity_key,1,length(j.entity_key)+1)=j.entity_key||'|')
    AND NOT EXISTS(SELECT 1 FROM continuous_publication_intents x WHERE x.entity_id=j.entity_key)
    AND NOT EXISTS(SELECT 1 FROM continuous_normal_notice_handoffs x WHERE x.expense_id=j.entity_key)
    AND NOT EXISTS(SELECT 1 FROM continuous_notice_dispatches x WHERE x.expense_id=j.entity_key)
    AND NOT EXISTS(SELECT 1 FROM failed_jobs x WHERE x.job_key='EXPENSE:'||j.entity_key||':1')`)
   .bind(roundId,roundId,parkedAuditAction,jobId,fingerprint,book,version,roundId);
  const change=db.prepare("UPDATE sync_jobs SET status='REVIEW',last_error='SERIAL_PILOT_B_REVIEW',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL WHERE job_id=? AND status='PENDING' AND attempt_count=0 AND lease_token IS NULL AND lease_until IS NULL AND serial_provenance_version=1 AND serial_lease_generation=0 AND changes()=1").bind(jobId);
  const guard=db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid','$') END AS ok");
  if(!valid())return held();submitted=true;
  const results=await db.batch([insert,change,guard]);
  if(!valid()||results.length!==3||results.some(x=>x.success!==true))return {ok:false,outcome:'UNCERTAIN'};
  return {ok:true,outcome:'RECONCILIATION_REQUIRED'};
 }catch{
  if(submitted)try{const result=await read();if(valid()&&result.success===true&&result.results?.length===1)return {ok:true,outcome:'RECONCILIATION_REQUIRED'};}catch{/* Keep claim and unresolved state. */}
  return submitted?{ok:false,outcome:'UNCERTAIN'}:held();
 }
}
