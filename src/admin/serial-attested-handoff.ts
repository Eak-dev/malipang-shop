import type {ParkedPilotEnv} from '../sheets/parked-notice-adoption';
import {parkedAuditAction,parkedSourceJoins} from '../sheets/parked-notice-adoption';
import {quiescencePayload,verifyQuiescenceAttestation,type QuiescenceAttestation,type QuiescenceContext} from './serial-quiescence-attestation';
import {stableSourceIntegrity} from '../sheets/stable-source-cutover';

// Local oracle experiment only: the context reader is read-only, while the
// separate CAS below can reserve C only when all draft barriers are removed in
// a synthetic fixture. Neither function proves external provider quiescence.
// Never return the raw snapshot: it contains claim/operation tokens.
// B-side absence predicates that holdReservedPilot enforced at hold time (two
// NOT EXISTS blocks of <=4 compound arms: D1 caps compound SELECT terms and
// SQLite caps expression depth at 100, which the guarded INSERT nears). They are repeated here (pre-read and guarded INSERT, alias j = held predecessor B)
// so later rows or an attempt cannot be handed to C. Local mock only; no barrier,
// lease/generation, claim or fence rule is changed by this fragment.
const heldPredecessorUntouched=`NOT EXISTS(
    SELECT 1 WHERE j.attempt_count<>0
    UNION ALL SELECT 1 FROM stable_projection_writes bp WHERE bp.entity_type='EXPENSE' AND (bp.entity_id=j.entity_key OR substr(bp.entity_id,1,length(j.entity_key)+1)=j.entity_key||'|')
    UNION ALL SELECT 1 FROM stable_expense_cancellation_writes bx WHERE bx.entity_type='EXPENSE' AND (bx.entity_id=j.entity_key OR substr(bx.entity_id,1,length(j.entity_key)+1)=j.entity_key||'|')
    UNION ALL SELECT 1 FROM sheet_row_index brx WHERE brx.entity_key=j.entity_key OR substr(brx.entity_key,1,length(j.entity_key)+1)=j.entity_key||'|')
    AND NOT EXISTS(
    SELECT 1 FROM continuous_publication_intents bn WHERE bn.entity_id=j.entity_key
    UNION ALL SELECT 1 FROM continuous_normal_notice_handoffs bh WHERE bh.expense_id=j.entity_key
    UNION ALL SELECT 1 FROM continuous_notice_dispatches bd WHERE bd.expense_id=j.entity_key
    UNION ALL SELECT 1 FROM failed_jobs bf WHERE bf.job_key='EXPENSE:'||j.entity_key||':1')`;
type Raw={book:string;old_token:string;claim_token:string;preimage:string;audit_id:string;before_json:string;after_json:string;
 round_id:string;b_job:string;b_epoch:string;b_namespace:string;fingerprint:string;held_at:string;b_ordinal:number;c_job:string;c_ordinal:number;
 b_source:string;c_source:string;c_date:string;c_version:number;revision:number;fence_digest:string;fence_generation:number};
async function digest(value:string):Promise<string>{const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function digestBytes(value:Uint8Array):Promise<string>{const bytes=await crypto.subtle.digest('SHA-256',value);return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function readAttestedHandoffContext(env:ParkedPilotEnv,roundId:string,predecessorId:string,successorId:string,version:string,valid:()=>boolean):Promise<{context:QuiescenceContext;raw:Raw}|null>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 if(!book||!valid())return null;
 try{
  const query=db.prepare(`SELECT w.spreadsheet_id book,json_extract(a.before_json,'$.oldToken') old_token,c.operation_token claim_token,json_extract(a.before_json,'$.preimage') preimage,
   a.id audit_id,a.before_json,a.after_json,h.round_id,h.job_id b_job,h.epoch_id b_epoch,h.source_namespace b_namespace,h.fingerprint,h.observed_at held_at,
   bi.ordinal b_ordinal,ci.job_id c_job,ci.ordinal c_ordinal,
   json_array(be.expense_id,be.version,be.status,be.transaction_date,be.description,be.amount_satang,be.payment_key,be.source_wallet,be.category,be.branch_id,be.updated_at,be.serial_source_namespace) b_source,
   json_array(ce.expense_id,ce.version,ce.status,ce.transaction_date,ce.description,ce.amount_satang,ce.payment_key,ce.source_wallet,ce.category,ce.branch_id,ce.updated_at,ce.serial_source_namespace) c_source,
   ce.transaction_date c_date,ce.version c_version,rev.revision,oracle.fence_digest,oracle.generation fence_generation
   FROM admin_audit a ${parkedSourceJoins}
   JOIN serial_pilot_hold_evidence h ON h.audit_id=a.id AND h.job_id=j.job_id AND h.epoch_id=ep.epoch_id AND h.spreadsheet_id=w.spreadsheet_id AND h.fingerprint=a.reason
   JOIN serial_pilot_rounds r ON r.round_id=h.round_id AND r.state='OPEN'
   JOIN serial_pilot_round_bindings rb ON rb.round_id=r.round_id AND rb.spreadsheet_id=w.spreadsheet_id AND rb.fingerprint=a.reason
   JOIN serial_pilot_round_items bi ON bi.round_id=r.round_id AND bi.job_id=j.job_id
   JOIN serial_pilot_round_items ci ON ci.round_id=r.round_id AND ci.ordinal=bi.ordinal+1
   JOIN sync_jobs next ON next.job_id=ci.job_id AND next.entity_type='EXPENSE' AND next.entity_version=1 AND next.status='PENDING' AND next.attempt_count=0 AND next.lease_token IS NULL AND next.lease_until IS NULL AND next.serial_provenance_version=1 AND next.serial_lease_generation=0
   JOIN expense_events be ON be.expense_id=j.entity_key AND be.version=j.entity_version AND be.status='CONFIRMED' AND be.serial_source_namespace=h.source_namespace
   JOIN expense_events ce ON ce.expense_id=next.entity_key AND ce.version=next.entity_version AND ce.status='CONFIRMED'
   JOIN serial_source_provenance_activation sp ON sp.singleton=1 AND sp.spreadsheet_id=w.spreadsheet_id AND sp.namespace=be.serial_source_namespace AND sp.namespace=ce.serial_source_namespace
   JOIN serial_job_provenance_activation jp ON jp.singleton=1 AND jp.spreadsheet_id=w.spreadsheet_id
   JOIN stable_workbook_claims c ON c.spreadsheet_id=w.spreadsheet_id AND c.operation_token=json_extract(a.after_json,'$.token') AND c.state='HELD' AND c.phase='PILOT_RESERVED'
   JOIN stable_source_revision rev ON rev.singleton=1 AND rev.revision=json_extract(a.before_json,'$.revision')
   JOIN serial_pilot_oracle_fence oracle ON oracle.spreadsheet_id=w.spreadsheet_id
   WHERE a.action=? AND a.entity_key=? AND json_extract(a.after_json,'$.roundId')=? AND json_extract(a.after_json,'$.version')=? AND w.spreadsheet_id=?
    AND ci.job_id=? AND ep.state='ARMED' AND j.status='REVIEW' AND j.last_error='SERIAL_PILOT_B_REVIEW' AND j.lease_token IS NULL AND j.lease_until IS NULL AND j.serial_provenance_version=1 AND j.serial_lease_generation=0 AND ${stableSourceIntegrity}
    AND ${heldPredecessorUntouched}
    AND NOT EXISTS(SELECT 1 FROM serial_pilot_oracle_revocations v WHERE v.spreadsheet_id=oracle.spreadsheet_id AND v.fence_digest=oracle.fence_digest AND v.fence_generation=oracle.generation)
    AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='serial_pilot_oracle_revoke_not_ready')
    AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_pilot_oracle_revoke_insert','serial_pilot_oracle_revoke_no_update','serial_pilot_oracle_revoke_no_delete'))=3
    AND length(ce.transaction_date)=10 AND date(ce.transaction_date,'+0 days')=ce.transaction_date AND substr(ce.transaction_date,1,7)=strftime('%Y-%m','now','+7 hours')
    AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name IN ('serial_pilot_fence_not_ready','serial_pilot_hold_not_ready','serial_job_provenance_not_ready','serial_source_provenance_not_ready','serial_pilot_oracle_fence_not_ready','serial_pilot_attested_handoff_not_ready'))
    AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations o WHERE o.epoch_id=ep.epoch_id)
    AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=next.entity_key OR substr(p.entity_id,1,length(next.entity_key)+1)=next.entity_key||'|'))
    AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=next.entity_key OR substr(p.entity_id,1,length(next.entity_key)+1)=next.entity_key||'|'))
    AND NOT EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.entity_key=next.entity_key OR substr(i.entity_key,1,length(next.entity_key)+1)=next.entity_key||'|')
    AND NOT EXISTS(SELECT 1 FROM continuous_publication_intents i WHERE i.entity_id=next.entity_key)
    AND NOT EXISTS(SELECT 1 FROM continuous_normal_notice_handoffs i WHERE i.expense_id=next.entity_key)
    AND NOT EXISTS(SELECT 1 FROM continuous_notice_dispatches i WHERE i.expense_id=next.entity_key)
    AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.job_key IN ('EXPENSE:'||next.entity_key||':1','EXPENSE:'||next.entity_key||':2'))
    AND NOT EXISTS(SELECT 1 FROM serial_pilot_attested_handoffs x WHERE x.predecessor_job_id=j.job_id OR x.successor_job_id=next.job_id)`)
   .bind(parkedAuditAction,predecessorId,roundId,version,book,successorId);
  const result=await query.all<Raw>();if(!valid()||result.success!==true||result.results?.length!==1)return null;
  const raw=result.results[0]!;
  if(!/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(raw.c_date)||!Number.isSafeInteger(raw.revision)||!Number.isSafeInteger(raw.fence_generation))return null;
  const [bookDigest,originalOperationDigest,predecessorAuditDigest,holdEvidenceDigest,predecessorSourceDigest,successorSourceDigest,claimDigest]=await Promise.all([
   digest(raw.book),digest(raw.old_token),digest(JSON.stringify([raw.audit_id,raw.before_json,raw.after_json])),
   digest(JSON.stringify([raw.round_id,raw.b_job,raw.audit_id,raw.book,raw.fingerprint,raw.b_epoch,raw.b_namespace,raw.held_at])),
   digest(raw.b_source),digest(raw.c_source),digest(raw.claim_token)
  ]);
  if(!valid())return null;
  return {raw,context:{bookDigest,originalOperationDigest,originalProofDigest:raw.preimage,predecessorAuditDigest,holdEvidenceDigest,
   roundId:raw.round_id,predecessorJobId:raw.b_job,predecessorEpochId:raw.b_epoch,predecessorSourceDigest,predecessorGeneration:0,claimDigest,
   successorJobId:raw.c_job,successorSourceDigest,successorVersion:raw.c_version,successorMonth:raw.c_date.slice(0,7),predecessorOrdinal:raw.b_ordinal,successorOrdinal:raw.c_ordinal,
   sourceRevision:raw.revision,workerVersion:version,fenceDigest:raw.fence_digest,fenceGeneration:raw.fence_generation}};
 }catch{return null;}
}

/** Experimental local oracle transaction. The supplied verifier key is NOT a
 * configured production authority. A matching immutable fence is an explicit
 * simulation assumption, not proof of an external provider's quiescence. */
export async function advanceAttestedHeldPilot(env:ParkedPilotEnv,att:QuiescenceAttestation,key:Uint8Array,valid:()=>boolean){
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,held=()=>({ok:false,outcome:'HELD'});let submitted=false,prior:(()=>Promise<D1Result<{found:number}>>)|undefined;
 try{
  if(!book||env.CF_VERSION_METADATA?.id!==att.workerVersion||!valid())return held();
  const [payloadDigest,signatureDigest,signerDigest]=await Promise.all([digestBytes(quiescencePayload(att)),digest(att.signature),digestBytes(key)]);
  const readPrior=async()=>db.prepare(`SELECT 1 AS found FROM serial_pilot_attested_handoffs h JOIN admin_audit a ON a.id='issue296:serial:'||h.predecessor_job_id AND a.entity_key=h.successor_job_id AND json_extract(a.after_json,'$.attestationNonce')=h.nonce AND json_extract(a.after_json,'$.epoch')=h.successor_epoch_id
   WHERE h.nonce=? AND h.round_id=? AND h.predecessor_job_id=? AND h.successor_job_id=? AND h.spreadsheet_id=? AND h.payload_digest=? AND h.signature_digest=? AND h.signer_digest=?`).bind(att.nonce,att.roundId,att.predecessorJobId,att.successorJobId,book,payloadDigest,signatureDigest,signerDigest).all<{found:number}>();
  prior=readPrior;const seen=await readPrior();if(!valid()||seen.success!==true||!seen.results||seen.results.length>1)return held();
  if(seen.results.length===1)return {ok:true,outcome:'RESERVATION_RECORDED'};
  const snapshot=await readAttestedHandoffContext(env,att.roundId,att.predecessorJobId,att.successorJobId,att.workerVersion,valid);
  if(!snapshot||!await verifyQuiescenceAttestation(att,snapshot.context,key,Date.now())||!valid())return held();
  const r=snapshot.raw,epoch='normal_pilot296_'+crypto.randomUUID(),now=new Date().toISOString();
  // Each checked value below is bound from the same read used for signature
  // verification. The guarded insert starts an atomic D1 batch; a final time
  // and fence check rolls back if either changed before commit.
  const insert=db.prepare(`INSERT INTO serial_pilot_attested_handoffs(nonce,round_id,predecessor_job_id,successor_job_id,spreadsheet_id,predecessor_epoch_id,successor_epoch_id,claim_token,worker_version,source_revision,fence_digest,fence_generation,issued_at,expires_at,payload_digest,signer_digest,signature_digest,created_at)
   SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ?<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND strftime('%Y-%m-%dT%H:%M:%fZ','now')<?
    AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name IN ('serial_pilot_fence_not_ready','serial_pilot_hold_not_ready','serial_job_provenance_not_ready','serial_source_provenance_not_ready','serial_pilot_oracle_fence_not_ready','serial_pilot_attested_handoff_not_ready'))
    AND ${stableSourceIntegrity}
    AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='serial_pilot_oracle_revoke_not_ready')
    AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_pilot_oracle_revoke_insert','serial_pilot_oracle_revoke_no_update','serial_pilot_oracle_revoke_no_delete'))=3
    AND NOT EXISTS(SELECT 1 FROM serial_pilot_oracle_revocations v WHERE v.spreadsheet_id=? AND v.fence_digest=? AND v.fence_generation=?)
    AND EXISTS(SELECT 1 FROM serial_pilot_round_fence_activation WHERE singleton=1)
    AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_pilot_round_insert','serial_pilot_items_insert','serial_pilot_items_no_update','serial_pilot_items_no_delete','serial_pilot_round_no_delete','serial_pilot_round_transition','serial_pilot_bindings_insert','serial_pilot_bindings_no_update','serial_pilot_bindings_no_delete','serial_pilot_fence_reservation','serial_pilot_fence_audit_no_replace','serial_pilot_fence_audit_no_update','serial_pilot_fence_audit_no_delete','serial_pilot_snapshot_insert_guard','serial_pilot_snapshot_audit'))=15
    AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_source_provenance_no_update','serial_source_provenance_no_delete','serial_source_provenance_no_replace','serial_source_provenance_namespace_guard','serial_source_provenance_insert_guard','serial_source_provenance_update_guard','serial_source_provenance_delete_guard','serial_source_job_birth_guard','serial_job_provenance_insert_guard','serial_job_provenance_update_guard','serial_job_provenance_delete_guard','serial_job_provenance_activation_no_update','serial_job_provenance_activation_no_delete','serial_job_provenance_activation_no_replace','serial_job_provenance_source_gate','serial_pilot_hold_no_replace','serial_pilot_hold_no_update','serial_pilot_hold_no_delete','serial_pilot_oracle_fence_no_replace','serial_pilot_oracle_fence_no_update','serial_pilot_oracle_fence_no_delete','serial_pilot_attested_handoff_no_replace','serial_pilot_attested_handoff_no_update','serial_pilot_attested_handoff_no_delete'))=24
    AND EXISTS(SELECT 1 FROM admin_audit a ${parkedSourceJoins}
      JOIN serial_pilot_hold_evidence h ON h.audit_id=a.id AND h.job_id=j.job_id AND h.epoch_id=ep.epoch_id AND h.round_id=? AND h.observed_at=? AND h.source_namespace=?
      JOIN serial_pilot_rounds round ON round.round_id=h.round_id AND round.state='OPEN'
      JOIN serial_pilot_round_bindings binding ON binding.round_id=round.round_id AND binding.spreadsheet_id=w.spreadsheet_id AND binding.fingerprint=a.reason
      JOIN serial_pilot_round_items bi ON bi.round_id=round.round_id AND bi.job_id=j.job_id AND bi.ordinal=?
      JOIN serial_pilot_round_items ci ON ci.round_id=round.round_id AND ci.job_id=? AND ci.ordinal=bi.ordinal+1
      JOIN sync_jobs next ON next.job_id=ci.job_id AND next.entity_type='EXPENSE' AND next.entity_version=1 AND next.status='PENDING' AND next.attempt_count=0 AND next.lease_token IS NULL AND next.lease_until IS NULL AND next.serial_provenance_version=1 AND next.serial_lease_generation=0
      JOIN expense_events be ON be.expense_id=j.entity_key AND be.version=j.entity_version AND be.status='CONFIRMED'
      JOIN expense_events ce ON ce.expense_id=next.entity_key AND ce.version=next.entity_version AND ce.status='CONFIRMED'
      JOIN serial_source_provenance_activation sp ON sp.singleton=1 AND sp.spreadsheet_id=w.spreadsheet_id AND sp.namespace=be.serial_source_namespace AND sp.namespace=ce.serial_source_namespace
      JOIN stable_workbook_claims c ON c.spreadsheet_id=w.spreadsheet_id AND c.operation_token=? AND c.state='HELD' AND c.phase='PILOT_RESERVED'
      JOIN stable_source_revision rev ON rev.singleton=1 AND rev.revision=?
      JOIN serial_pilot_oracle_fence fence ON fence.spreadsheet_id=w.spreadsheet_id AND fence.fence_digest=? AND fence.generation=?
      WHERE a.id=? AND a.action=? AND a.entity_key=? AND a.before_json=? AND a.after_json=? AND a.reason=? AND w.spreadsheet_id=? AND ep.epoch_id=? AND ep.state='ARMED'
       AND j.status='REVIEW' AND j.last_error='SERIAL_PILOT_B_REVIEW' AND j.lease_token IS NULL AND j.lease_until IS NULL AND j.serial_provenance_version=1 AND j.serial_lease_generation=0
       AND json_array(be.expense_id,be.version,be.status,be.transaction_date,be.description,be.amount_satang,be.payment_key,be.source_wallet,be.category,be.branch_id,be.updated_at,be.serial_source_namespace)=?
       AND json_array(ce.expense_id,ce.version,ce.status,ce.transaction_date,ce.description,ce.amount_satang,ce.payment_key,ce.source_wallet,ce.category,ce.branch_id,ce.updated_at,ce.serial_source_namespace)=?
       AND length(ce.transaction_date)=10 AND date(ce.transaction_date,'+0 days')=ce.transaction_date AND substr(ce.transaction_date,1,7)=strftime('%Y-%m','now','+7 hours')
       AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations op WHERE op.epoch_id=ep.epoch_id)
       AND ${heldPredecessorUntouched}
       AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=next.entity_key OR substr(p.entity_id,1,length(next.entity_key)+1)=next.entity_key||'|'))
       AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=next.entity_key OR substr(p.entity_id,1,length(next.entity_key)+1)=next.entity_key||'|'))
       AND NOT EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.entity_key=next.entity_key OR substr(i.entity_key,1,length(next.entity_key)+1)=next.entity_key||'|')
       AND NOT EXISTS(SELECT 1 FROM continuous_publication_intents i WHERE i.entity_id=next.entity_key)
       AND NOT EXISTS(SELECT 1 FROM continuous_normal_notice_handoffs i WHERE i.expense_id=next.entity_key)
       AND NOT EXISTS(SELECT 1 FROM continuous_notice_dispatches i WHERE i.expense_id=next.entity_key)
       AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.job_key IN ('EXPENSE:'||next.entity_key||':1','EXPENSE:'||next.entity_key||':2'))
       AND NOT EXISTS(SELECT 1 FROM sync_jobs other WHERE other.entity_type='EXPENSE' AND other.entity_key=next.entity_key AND other.entity_version<>next.entity_version)
       AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs old WHERE old.spreadsheet_id=w.spreadsheet_id AND old.target_type='EXPENSE' AND old.target_key=next.entity_key AND old.target_version=next.entity_version))`)
   .bind(att.nonce,r.round_id,r.b_job,r.c_job,r.book,r.b_epoch,epoch,r.claim_token,att.workerVersion,r.revision,r.fence_digest,r.fence_generation,att.issuedAt,att.expiresAt,payloadDigest,signerDigest,signatureDigest,now,att.issuedAt,att.expiresAt,r.book,r.fence_digest,r.fence_generation,
    r.round_id,r.held_at,r.b_namespace,r.b_ordinal,r.c_job,r.claim_token,r.revision,r.fence_digest,r.fence_generation,r.audit_id,parkedAuditAction,r.b_job,r.before_json,r.after_json,r.fingerprint,r.book,r.b_epoch,r.b_source,r.c_source);
  const guard=db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid','$') END AS ok");
  const review=db.prepare("UPDATE stable_recovery_epochs SET state='REVIEW',updated_at=? WHERE epoch_id=? AND spreadsheet_id=? AND state='ARMED' AND changes()=1").bind(now,r.b_epoch,book);
  const close=db.prepare("UPDATE stable_recovery_epochs SET state='CLOSED',updated_at=? WHERE epoch_id=? AND spreadsheet_id=? AND state='REVIEW' AND changes()=1").bind(now,r.b_epoch,book);
  const arm=db.prepare("INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) SELECT ?,?,'ARMED','EXPENSE',j.entity_key,1,?,? FROM sync_jobs j WHERE j.job_id=? AND j.status='PENDING' AND j.lease_token IS NULL AND j.lease_until IS NULL AND changes()=1").bind(epoch,book,now,now,r.c_job);
  const admit=db.prepare("INSERT INTO continuous_normal_recovery_admissions(epoch_id,spreadsheet_id,expense_id,source_version,created_at) SELECT epoch_id,spreadsheet_id,target_key,target_version,? FROM stable_recovery_epochs WHERE epoch_id=? AND state='ARMED' AND changes()=1").bind(now,epoch);
  const audit=db.prepare(`INSERT INTO admin_audit(id,action,entity_key,reason,before_json,after_json,created_at)
   SELECT ?,?,?,?,json_set(a.before_json,'$.predecessorJobId',?,'$.proof',?),json_object('epoch',?,'version',?,'roundId',?,'token',?,'attestationNonce',?),?
   FROM admin_audit a WHERE a.id=? AND a.before_json=? AND a.after_json=? AND changes()=1`)
   .bind('issue296:serial:'+r.b_job,'ISSUE296_SERIAL_EXPENSE_HANDOVER',r.c_job,r.fingerprint,r.b_job,payloadDigest,epoch,att.workerVersion,r.round_id,r.claim_token,att.nonce,now,r.audit_id,r.before_json,r.after_json);
  const final=db.prepare("SELECT CASE WHEN strftime('%Y-%m-%dT%H:%M:%fZ','now')<? AND EXISTS(SELECT 1 FROM serial_pilot_oracle_fence f JOIN stable_workbook_claims c ON c.spreadsheet_id=f.spreadsheet_id WHERE f.spreadsheet_id=? AND f.fence_digest=? AND f.generation=? AND c.operation_token=? AND c.state='HELD' AND c.phase='PILOT_RESERVED' AND NOT EXISTS(SELECT 1 FROM serial_pilot_oracle_revocations v WHERE v.spreadsheet_id=f.spreadsheet_id AND v.fence_digest=f.fence_digest AND v.fence_generation=f.generation)) THEN 1 ELSE json_extract('invalid','$') END AS ok").bind(att.expiresAt,book,r.fence_digest,r.fence_generation,r.claim_token);
  if(!valid())return held();submitted=true;
  const result=await db.batch([insert,review,guard,close,guard,arm,guard,admit,guard,audit,guard,final]);
  if(!valid()||result.length!==12||result.some(x=>x.success!==true))return {ok:false,outcome:'UNCERTAIN'};
  return {ok:true,outcome:'RESERVED'};
 }catch{
  if(submitted&&prior)try{const result=await prior();if(valid()&&result.success===true&&result.results?.length===1)return {ok:true,outcome:'RESERVATION_RECORDED'};}catch{/* Keep uncertain; never resubmit here. */}
  return submitted?{ok:false,outcome:'UNCERTAIN'}:held();
 }
}
