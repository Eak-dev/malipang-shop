import type {ParkedPilotEnv} from '../sheets/parked-notice-adoption';
import {parkedAuditAction,serialAuditAction,parkedSourceJoins,pilotWriteJoins} from '../sheets/parked-notice-adoption';
import {stableSourceIntegrity} from '../sheets/stable-source-cutover';
import {dailyFailedPayloadDigest} from './exact-daily-proof-evidence';
import {verifyNormalPilotRow} from './normal-pilot-readback';
import {normalExpenseEpochStatements} from '../sheets/continuous-normal-recovery';
import {readSerialRound} from './serial-round-store';
import {notStartedClassificationPredicate} from './serial-classification-predicates';

export type PilotIdentity={jobId:string;fingerprint:string;roundId?:string};
export type AdvancePilot=PilotIdentity & {action:'ADVANCE_ONE';nextJobId:string;proof:string;ownerSupervising:true;externalWritersFenced:true};
export type RecordVerifiedPilot=PilotIdentity & {action:'RECORD_VERIFIED';roundId:string;proof:string;ownerSupervising:true;externalWritersFenced:true};

/** Read one D1 snapshot. A verified first stage can coexist with a failed later
 * stage. Only FINAL closes both the job and its epoch; the runner then compares
 * the displayed DAILY row against D1 in a separate provider read. */
const observation=`WITH roots AS MATERIALIZED (
   SELECT * FROM admin_audit WHERE action=?
 ), audits AS MATERIALIZED (
   SELECT * FROM roots
   UNION ALL SELECT child.* FROM admin_audit child JOIN roots root
     ON root.reason=child.reason AND json_extract(root.before_json,'$.book')=json_extract(child.before_json,'$.book')
     AND json_extract(root.before_json,'$.oldToken')=json_extract(child.before_json,'$.oldToken')
     WHERE child.action=? AND child.id='issue296:serial:'||json_extract(child.before_json,'$.predecessorJobId')
 ), target AS MATERIALIZED (
   SELECT j.entity_key AS expense,j.status AS job,j.last_error,j.lease_token,j.lease_until,j.next_attempt_at,
          ep.epoch_id,ep.state AS epoch,w.spreadsheet_id AS book,a.id AS audit_id,a.action AS audit_action,
          json_extract(a.after_json,'$.roundId') AS round_id,(SELECT ordinal FROM serial_pilot_round_items ri WHERE ri.round_id=json_extract(a.after_json,'$.roundId') AND ri.job_id=j.job_id) AS ordinal,
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
 ), expected AS MATERIALIZED (
   SELECT expense AS entity_id,'DAILY' AS projection,? AS sheet_name,? AS sheet_id FROM target
   UNION ALL SELECT expense,'EXPENSE_RAW',?,? FROM target
   UNION ALL SELECT t.expense||'|'||item.item_id,'DETAIL',?,?
     FROM target t JOIN expense_document_items item ON item.expense_id=t.expense
 ), written AS MATERIALIZED (
   SELECT p.* FROM target t JOIN stable_projection_writes p ON p.spreadsheet_id=t.book AND p.entity_type='EXPENSE'
     AND (p.entity_id=t.expense OR substr(p.entity_id,1,length(t.expense)+1)=t.expense||'|')
 ), verified AS MATERIALIZED (
   SELECT p.entity_id,p.projection,p.updated_at,p.source_digest,p.operation_token,pi.preimage_digest,pi.preimage_width FROM target t JOIN written p ON p.source_version=1 AND p.state='VERIFIED'
   JOIN expected e ON e.projection=p.projection AND e.entity_id=p.entity_id
     AND e.sheet_name=p.sheet_name AND p.sheet_id=e.sheet_id
   JOIN stable_recovery_operations o ON o.epoch_id=t.epoch_id AND o.operation_token=p.operation_token AND o.state='VERIFIED'
   JOIN stable_expense_projection_preimages pi ON pi.spreadsheet_id=p.spreadsheet_id AND pi.entity_type=p.entity_type
     AND pi.entity_id=p.entity_id AND pi.projection=p.projection AND pi.sheet_id=p.sheet_id AND pi.sheet_name=p.sheet_name
     AND pi.source_version=p.source_version AND pi.source_digest=p.source_digest
   WHERE p.projection<>'DAILY' OR (p.operation_token=t.token AND EXISTS (
     SELECT 1 FROM (SELECT 1) marker_evidence ${pilotWriteJoins}))
 ), canonical AS MATERIALIZED (
   SELECT v.entity_id,v.projection,p.sheet_id,p.sheet_name,p.source_version,v.source_digest,v.operation_token,v.preimage_width,v.preimage_digest,
    marker.marker AS reservation_marker,COALESCE(daily.marker,ledger.marker) AS write_marker,
    COALESCE(daily.before_digest,ledger.before_digest) AS before_digest,COALESCE(daily.payload_digest,ledger.payload_digest) AS payload_digest
   FROM target t JOIN verified v JOIN written p ON p.entity_id=v.entity_id AND p.projection=v.projection AND p.operation_token=v.operation_token
   JOIN atomic_daily_marker_reservations marker ON marker.spreadsheet_id=p.spreadsheet_id AND marker.sheet_id=p.sheet_id AND marker.entity_id=p.entity_id AND marker.source_version=p.source_version AND marker.operation_token=p.operation_token
   LEFT JOIN continuous_daily_write_evidence daily ON p.projection='DAILY' AND daily.spreadsheet_id=p.spreadsheet_id AND daily.sheet_id=p.sheet_id AND daily.sheet_name=p.sheet_name AND daily.entity_id=p.entity_id AND daily.source_version=p.source_version AND daily.source_digest=p.source_digest AND daily.operation_token=p.operation_token AND daily.marker=marker.marker
   LEFT JOIN continuous_ledger_write_evidence ledger ON p.projection IN ('EXPENSE_RAW','DETAIL') AND ledger.operation_kind='CONFIRM' AND ledger.spreadsheet_id=p.spreadsheet_id AND ledger.sheet_id=p.sheet_id AND ledger.sheet_name=p.sheet_name AND ledger.entity_id=p.entity_id AND ledger.source_version=p.source_version AND ledger.operation_token=p.operation_token
   WHERE p.projection='DAILY' AND daily.marker IS NOT NULL OR p.projection IN ('EXPENSE_RAW','DETAIL') AND ledger.marker IS NOT NULL
 ), observed AS (
 SELECT (SELECT count(*) FROM roots) AS audit_count,t.audit_id,t.epoch_id,(SELECT count(*) FROM target) AS target_count,t.job,t.epoch,
   t.revision,${stableSourceIntegrity} AS revision_valid,
   json_array(t.book,t.epoch_id,t.token,t.source_fields,(SELECT min(source_digest) FROM written),t.audit_id,t.audit_action,t.round_id,t.ordinal,
    (SELECT json_group_array(json_array(entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,preimage_width,preimage_digest,reservation_marker,write_marker,before_digest,payload_digest)) FROM (SELECT * FROM canonical ORDER BY entity_id,projection))) AS proof_inputs,
   t.lease_token IS NULL AND t.lease_until IS NULL AS unleased,
   t.lease_token IS NOT NULL AND t.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AS leased,
   t.last_error IS NULL AND t.next_attempt_at IS NULL AS clean,
   (SELECT state FROM stable_workbook_claims c WHERE c.spreadsheet_id=t.book AND
     (c.operation_token=t.token OR c.operation_token IN (SELECT operation_token FROM stable_recovery_operations WHERE epoch_id=t.epoch_id))) AS claim,
   EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.status='OPEN'
     AND f.job_key='EXPENSE:'||t.expense||':1') AS open_failure,
   EXISTS(SELECT 1 FROM stable_recovery_operations o WHERE o.epoch_id=t.epoch_id AND o.state<>'VERIFIED') AS unfinished,
   (SELECT count(*) FROM verified) AS verified_count,(SELECT max(updated_at) FROM verified) AS last_verified_at,
   (SELECT count(DISTINCT source_digest) FROM verified) AS verified_digests,
   (SELECT count(*) FROM (SELECT entity_id,projection FROM verified GROUP BY entity_id,projection)) AS verified_unique,
   (SELECT json_group_array(json_array(entity_id,projection,source_digest,operation_token,preimage_digest)) FROM (SELECT * FROM verified ORDER BY entity_id,projection)) AS verified_snapshot,
   (SELECT count(*) FROM written)=(SELECT count(*) FROM expected)
     AND (SELECT count(DISTINCT source_digest) FROM written)=1
     AND (SELECT count(*) FROM canonical)=(SELECT count(*) FROM expected)
     AND (SELECT count(*) FROM (SELECT entity_id,projection FROM canonical GROUP BY entity_id,projection))=(SELECT count(*) FROM expected)
     AND NOT EXISTS(SELECT entity_id,projection FROM expected EXCEPT SELECT entity_id,projection FROM verified) AS all_written
 FROM (SELECT 1) anchor LEFT JOIN target t ON 1=1 LIMIT 2)`;

type Observation={audit_count:number;target_count:number;job:string|null;epoch:string|null;unleased:number;leased:number;clean:number;
   claim:string|null;open_failure:number;unfinished:number;all_written:number;revision:number;revision_valid:number;proof_inputs:string;epoch_id:string;audit_id:string;verified_count:number;last_verified_at:string|null;verified_digests:number;verified_unique:number;verified_snapshot:string};

function bindings(env:ParkedPilotEnv,id:PilotIdentity,version:string){
 return [parkedAuditAction,serialAuditAction,parkedAuditAction,id.jobId,id.fingerprint,env.GOOGLE_SPREADSHEET_ID,version,
  Number(env.CONTINUOUS_DAILY_SHEET_ID),env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET,Number(env.CONTINUOUS_DAILY_SHEET_ID),
  env.CONTINUOUS_RAW_SHEET,Number(env.CONTINUOUS_RAW_SHEET_ID),env.CONTINUOUS_DETAIL_SHEET,Number(env.CONTINUOUS_DETAIL_SHEET_ID)];
}
function completionProof(version:string,id:PilotIdentity,row:Observation){
 return dailyFailedPayloadDigest(JSON.stringify(['pilot-finish-v2',version,id.jobId,id.fingerprint,row.revision,row.proof_inputs]));
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

/** Progress is diagnostic only. It grants no right to release or reserve. */
export async function finishProgress(env:ParkedPilotEnv,action:PilotIdentity,version:string){
 const result=await env.DB.prepare(observation+' SELECT * FROM observed').bind(...bindings(env,action,version)).all<Observation>();
 const row=result.results?.[0];
 const progressing=!!row&&(row.epoch==='ARMED'&&(row.job==='PENDING'&&row.unleased===1||row.job==='PROCESSING'&&row.leased===1)||
  row.job==='COMPLETED'&&row.unleased===1&&row.clean===1&&row.all_written===1&&row.claim==='HELD'&&
   (row.epoch==='ARMED'||row.epoch==='COMPLETE'&&row.unfinished===0));
 if(result.success!==true||result.results?.length!==1||!row||row.audit_count!==1||row.target_count!==1||
  !progressing||row.claim==='REVIEW'||row.open_failure!==0||row.revision_valid!==1||!row.epoch_id||!Number.isSafeInteger(row.revision)||row.revision<0||!Number.isSafeInteger(row.verified_count)||row.verified_count<0||row.verified_count>1000||row.verified_unique!==row.verified_count||
  row.verified_digests!==(row.verified_count===0?0:1)||(row.verified_count>0&&row.last_verified_at===null)||
  row.last_verified_at!==null&&(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(row.last_verified_at)))return null;
 let evidence:unknown;try{evidence=JSON.parse(row.verified_snapshot);}catch{return null;}
 if(!Array.isArray(evidence)||evidence.length!==row.verified_count||evidence.some(x=>!Array.isArray(x)||x.length!==5||x.some(y=>typeof y!=='string')||!x[0]||!['DAILY','EXPENSE_RAW','DETAIL'].includes(x[1])||!/^[0-9a-f]{64}$/.test(x[2])||!x[3]||!/^[0-9a-f]{64}$/.test(x[4])))return null;
 const stageProofs=await Promise.all(evidence.map(x=>dailyFailedPayloadDigest(JSON.stringify(x))));
 if(new Set(stageProofs).size!==stageProofs.length)return null;
 const scopeProof=await dailyFailedPayloadDigest(JSON.stringify([version,action.jobId,action.fingerprint,row.epoch_id,row.revision]));
 return {ok:true,outcome:'PROGRESS' as const,verifiedStages:row.verified_count,lastVerifiedAt:row.last_verified_at,stageProofs,scopeProof};
}

// The returned fields are compared again inside the same transaction that opens
// the successor epoch. Only an exact, completed observation can win this CAS.
const complete=`audit_count=1 AND target_count=1 AND job='COMPLETED' AND epoch='COMPLETE'
 AND unleased=1 AND clean=1 AND all_written=1 AND claim IS NULL AND open_failure=0 AND unfinished=0
 AND revision_valid=1`;

/** Persist proof of one completion; this never reserves the next job. */
export async function recordVerifiedPilot(env:ParkedPilotEnv,action:RecordVerifiedPilot,version:string,valid:()=>boolean){
 const db=env.DB,held=()=>({ok:false,outcome:'HELD'});let submitted=false;
 const prior=async()=>db.prepare(`SELECT v.proof,v.worker_version,v.proof_algorithm FROM serial_pilot_verified_evidence v
  JOIN serial_pilot_round_bindings b ON b.round_id=v.round_id AND b.spreadsheet_id=? AND b.fingerprint=?
  WHERE v.round_id=? AND v.job_id=?`).bind(env.GOOGLE_SPREADSHEET_ID,action.fingerprint,action.roundId,action.jobId).all<{proof:string;worker_version:string;proof_algorithm:string}>();
 try{
  if(!valid())return held();
  const previous=await prior();
  if(previous.success!==true||!previous.results||previous.results.length>1||!valid())return held();
  if(previous.results.length===1)return previous.results[0]?.proof===action.proof&&previous.results[0]?.worker_version===version&&previous.results[0]?.proof_algorithm==='pilot-finish-v2'?{ok:true,outcome:'RECORDED'}:held();
  const first=await finishStatus(env,action,version);
  if(typeof first==='string'||first.proof!==action.proof||!valid()||!await verifyNormalPilotRow(env,action)||!valid())return held();
  const second=await finishStatus(env,action,version);
  if(typeof second==='string'||second.proof!==action.proof||!valid())return held();
  const observed=await db.prepare(observation+' SELECT * FROM observed WHERE '+complete).bind(...bindings(env,action,version)).all<Observation>();
  const row=observed.results?.[0];
  if(observed.success!==true||observed.results?.length!==1||!row||!row.audit_id||!row.epoch_id||await completionProof(version,action,row)!==action.proof||!valid())return held();
  const now=new Date().toISOString();
  const insert=db.prepare(observation+` INSERT INTO serial_pilot_verified_evidence(round_id,job_id,audit_id,epoch_id,worker_version,proof,source_revision,verified_at,proof_algorithm,proof_inputs)
   SELECT ?,?,t.audit_id,t.epoch_id,?,?,t.revision,?,'pilot-finish-v2',t.proof_inputs FROM observed t JOIN admin_audit a ON a.id=t.audit_id
   JOIN serial_pilot_rounds r ON r.round_id=? AND r.state='OPEN'
   JOIN serial_pilot_round_bindings b ON b.round_id=r.round_id AND b.spreadsheet_id=? AND b.fingerprint=?
   JOIN serial_pilot_round_items i ON i.round_id=r.round_id AND i.job_id=?
   WHERE ${complete} AND t.audit_id=? AND t.epoch_id=? AND t.revision=? AND t.proof_inputs=?
    AND json_extract(a.after_json,'$.roundId')=r.round_id`).bind(...bindings(env,action,version),action.roundId,action.jobId,version,action.proof,now,
    action.roundId,env.GOOGLE_SPREADSHEET_ID,action.fingerprint,action.jobId,row.audit_id,row.epoch_id,row.revision,row.proof_inputs);
  const changed=db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid','$') END AS ok");
  if(!valid())return held();submitted=true;
  const result=await db.batch([insert,changed]);
  if(!valid()||result.length!==2||result.some(x=>x.success!==true))return {ok:false,outcome:'UNCERTAIN'};
  return {ok:true,outcome:'RECORDED'};
 }catch{
  if(!submitted)return held();
  try{const result=await prior();if(valid()&&result.success===true&&result.results?.length===1&&result.results[0]?.proof===action.proof&&result.results[0]?.worker_version===version&&result.results[0]?.proof_algorithm==='pilot-finish-v2')return {ok:true,outcome:'RECORDED'};}catch{/* Keep unresolved. */}
  return {ok:false,outcome:'UNCERTAIN'};
 }
}

/** Close only an entirely verified chain. Trusted D1 writers and the external
 * writer fence are prerequisites: receipts prove a prior readback, not the
 * current provider row. This action never sends a provider mutation. */
export async function closeAllVerifiedRound(env:ParkedPilotEnv,roundId:string,version:string,valid:()=>boolean){
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,held=()=>({ok:false,outcome:'HELD'});let submitted=false;
 const read=()=>readSerialRound(db,roundId);
 const finished=async(s:Awaited<ReturnType<typeof readSerialRound>>)=>{
  if(!s||s.round.state!=='CLOSED'||s.round.reason!=='ALL_VERIFIED'||s.round.selected_count<1||s.items.length!==s.round.selected_count||s.results.length!==s.round.selected_count||s.verifiedEvidence.length!==s.round.selected_count)return false;
  const outcomes=new Map(s.results.map(x=>[x.job_id,x])),receipts=new Map(s.verifiedEvidence.map(x=>[x.job_id,x]));
  if(!(outcomes.size===s.items.length&&receipts.size===s.items.length&&s.items.every((item,index)=>{
   const outcome=outcomes.get(item.job_id),receipt=receipts.get(item.job_id);
   return item.ordinal===index&&outcome?.category==='VERIFIED'&&outcome.evidence==='VERIFIED_RECEIPT'&&outcome.successor_job_id===(s.items[index+1]?.job_id??null)&&!!receipt&&receipt.proof_algorithm==='pilot-finish-v2'&&/^[0-9a-f]{64}$/.test(receipt.proof)&&!!receipt.audit_id&&!!receipt.epoch_id;
  })))return false;
  // A terminal label alone is not evidence of the original durable edge.
  // Do not reclassify current provider state here: this only reconciles an
  // acknowledgement lost after the immutable closed result was committed.
  const edges=await db.prepare(`SELECT id,action,entity_key,reason,before_json,after_json FROM admin_audit
   WHERE action IN (?,?) AND json_extract(after_json,'$.roundId')=?`).bind(parkedAuditAction,serialAuditAction,roundId)
   .all<{id:string;action:string;entity_key:string;reason:string;before_json:string;after_json:string}>();
  if(edges.success!==true||!edges.results||edges.results.length!==s.items.length)return false;
  return s.items.every((item,index)=>{
   const receipt=receipts.get(item.job_id)!, matches=edges.results!.filter(x=>x.id===receipt.audit_id);
   if(matches.length!==1||receipt.worker_version!==version)return false;
   const edge=matches[0]!;let before:Record<string,unknown>,after:Record<string,unknown>;
   try{before=JSON.parse(edge.before_json);after=JSON.parse(edge.after_json);}catch{return false;}
   const previous=index?s.items[index-1]!:null, prior=previous?receipts.get(previous.job_id):null;
   return edge.entity_key===item.job_id&&edge.reason===s.binding?.fingerprint&&before.book===book&&after.roundId===roundId&&
    after.version===receipt.worker_version&&after.epoch===receipt.epoch_id&&edge.action===(previous?serialAuditAction:parkedAuditAction)&&
    (!previous||(edge.id==='issue296:serial:'+previous.job_id&&before.predecessorJobId===previous.job_id&&before.proof===prior?.proof));
  });
 };
 try{
  if(!valid()||!book)return held();
  const snap=await read();
  if(!snap||!valid()||snap.binding?.spreadsheet_id!==book)return held();
  if(await finished(snap))return valid()?{ok:true,outcome:'CLOSED'}:held();
  if(snap.round.state!=='OPEN'||snap.round.selected_count<1||snap.items.length!==snap.round.selected_count||snap.results.length!==0||snap.verifiedEvidence.length!==snap.items.length)return held();
  const receipts=new Map(snap.verifiedEvidence.map(x=>[x.job_id,x]));
  if(receipts.size!==snap.items.length)return held();
  const fingerprint=snap.binding.fingerprint,observed:Observation[]=[];
  for(const item of snap.items){
   const receipt=receipts.get(item.job_id),identity={jobId:item.job_id,fingerprint};
   if(!receipt||receipt.worker_version!==version||receipt.proof_algorithm!=='pilot-finish-v2'||!valid())return held();
   const result=await db.prepare(observation+' SELECT * FROM observed WHERE '+complete).bind(...bindings(env,identity,version)).all<Observation>();
   const row=result.results?.[0];
   if(result.success!==true||result.results?.length!==1||!row||row.audit_id!==receipt.audit_id||row.epoch_id!==receipt.epoch_id||row.revision!==receipt.source_revision||await completionProof(version,identity,row)!==receipt.proof||!valid())return held();
   observed.push(row);
  }
  const statements:D1PreparedStatement[]=[];
  for(const [index,item] of snap.items.entries()){
   const receipt=receipts.get(item.job_id)!,row=observed[index]!,previous=index?snap.items[index-1]!:null,previousReceipt=previous?receipts.get(previous.job_id)!:null;
   const chain=db.prepare(`SELECT CASE WHEN (SELECT count(*) FROM admin_audit a WHERE a.action IN (?,?) AND json_extract(a.after_json,'$.roundId')=?)=? AND EXISTS(
    SELECT 1 FROM admin_audit a WHERE a.id=? AND a.entity_key=? AND a.reason=? AND a.action=?
     AND json_extract(a.before_json,'$.book')=? AND json_extract(a.after_json,'$.roundId')=? AND json_extract(a.after_json,'$.version')=?
     AND (? IS NULL OR (a.id='issue296:serial:'||? AND json_extract(a.before_json,'$.predecessorJobId')=? AND json_extract(a.before_json,'$.proof')=?)))
    THEN 1 ELSE json_extract('invalid','$') END AS ok`).bind(parkedAuditAction,serialAuditAction,roundId,snap.items.length,receipt.audit_id,item.job_id,fingerprint,
     previous?serialAuditAction:parkedAuditAction,book,roundId,version,previous?.job_id??null,previous?.job_id??null,previous?.job_id??null,previousReceipt?.proof??null);
   statements.push(chain);
   const identity={jobId:item.job_id,fingerprint};
   const insert=db.prepare(observation+` INSERT INTO serial_pilot_round_results(round_id,job_id,category,evidence,successor_job_id)
    SELECT ?,?,'VERIFIED','VERIFIED_RECEIPT',(SELECT a.entity_key FROM admin_audit a WHERE a.action=? AND json_extract(a.after_json,'$.roundId')=? AND json_extract(a.before_json,'$.predecessorJobId')=?)
    FROM observed t JOIN serial_pilot_verified_evidence v ON v.round_id=? AND v.job_id=?
    WHERE ${complete} AND t.audit_id=? AND t.epoch_id=? AND t.revision=? AND t.proof_inputs=?
     AND v.audit_id=t.audit_id AND v.epoch_id=t.epoch_id AND v.source_revision=t.revision AND v.worker_version=? AND v.proof=?
     AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=?)`)
    .bind(...bindings(env,identity,version),roundId,item.job_id,serialAuditAction,roundId,item.job_id,roundId,item.job_id,row.audit_id,row.epoch_id,row.revision,row.proof_inputs,version,receipt.proof,book);
   statements.push(insert,db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid','$') END AS ok"));
  }
  statements.push(db.prepare("UPDATE serial_pilot_rounds SET state='CLOSED',closed_at=?,reason='ALL_VERIFIED' WHERE round_id=? AND state='OPEN' AND EXISTS(SELECT 1 FROM serial_pilot_round_bindings b WHERE b.round_id=serial_pilot_rounds.round_id AND b.spreadsheet_id=? AND b.fingerprint=?) AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=?)").bind(new Date().toISOString(),roundId,book,fingerprint,book),
   db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid','$') END AS ok"));
  if(!valid())return held();submitted=true;
  const result=await db.batch(statements);
  if(!valid()||result.length!==statements.length||result.some(x=>x.success!==true))return {ok:false,outcome:'UNCERTAIN'};
  return {ok:true,outcome:'CLOSED'};
 }catch{
  if(!submitted)return held();
  try{if(valid()&&await finished(await read())&&valid())return {ok:true,outcome:'CLOSED'};}catch{/* Keep unresolved. */}
  return {ok:false,outcome:'UNCERTAIN'};
 }
}

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
   SELECT ?,?,?,?,json_set(a.before_json,'$.predecessorJobId',?,'$.proof',?),${action.roundId?"json_object('epoch',?,'version',?,'roundId',?)":"json_object('epoch',?,'version',?)"},?
   FROM observed t JOIN admin_audit a ON a.id=t.audit_id
   WHERE ${complete} AND t.epoch_id=? AND t.revision=? AND t.proof_inputs=?
     AND NOT EXISTS(SELECT 1 FROM admin_audit child WHERE child.id=?)
     AND NOT EXISTS(SELECT 1 FROM admin_audit existing WHERE existing.action IN (?,?) AND existing.entity_key=?)`);
  const auditId='issue296:serial:'+action.jobId;
  const insert=audit.bind(...bindings(env,action,version),auditId,serialAuditAction,action.nextJobId,action.fingerprint,
   action.jobId,action.proof,epoch,version,...(action.roundId?[action.roundId]:[]),now,row.epoch_id,row.revision,row.proof_inputs,auditId,parkedAuditAction,serialAuditAction,action.nextJobId);
  const [arm,admit]=normalExpenseEpochStatements(env,epoch,now,action.nextJobId,row.epoch_id);
  const changed=db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid','$') END AS ok");
  if(!arm||!admit||!valid())return held();
  submitted=true;
  const writes=await db.batch([insert,changed,arm,changed,admit,changed]);
  if(!valid()||writes.length!==6||writes.some(r=>r.success!==true))return {ok:false,outcome:'UNCERTAIN'};
  return {ok:true,outcome:'RESERVED'};
 }catch{return submitted?{ok:false,outcome:'UNCERTAIN'}:held();}
}

/** Local-only mixed close. Positive outcomes use current D1 checks; provider
 * observations and the mock fence never grant write authority. */
export async function closeMockParkedRound(env:ParkedPilotEnv,roundId:string,version:string,valid:()=>boolean){
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,held=()=>({ok:false,outcome:'HELD'});let submitted=false;
 type Transfer={round_id:string;job_id:string;successor_job_id:string;source_namespace:string;source_revision:number;fence_digest:string;fence_generation:number;nonce:string;worker_version:string};
 const historical=async()=>{
  const snap=await readSerialRound(db,roundId);
  if(!snap||snap.binding?.spreadsheet_id!==book||snap.round.state!=='CLOSED'||snap.round.reason!=='MOCK_CLASSIFIED'||snap.items.length!==snap.round.selected_count||snap.items.length>100||snap.results.length!==snap.items.length)return false;
  const evidence=await db.prepare("SELECT round_id,job_id,category,evidence,successor_job_id FROM serial_pilot_classification_evidence WHERE round_id=?").bind(roundId).all<{round_id:string;job_id:string;category:string;evidence:string;successor_job_id:string|null}>();
  if(evidence.success!==true||!evidence.results)return false;
  const parked=evidence.results.filter(x=>x.category==='PARKED'),e=parked[0];
  if(parked.length!==1||!e||new Set(evidence.results.map(x=>x.job_id)).size!==evidence.results.length||evidence.results.length!==snap.results.filter(x=>x.category==='PARKED'||x.category==='NOT_STARTED').length||evidence.results.some(x=>!snap.items.some(i=>i.job_id===x.job_id)))return false;
  const edges=await db.prepare("SELECT id,entity_key successor,reason,before_json,after_json FROM admin_audit WHERE action=? AND json_extract(after_json,'$.roundId')=?").bind(serialAuditAction,roundId).all<{id:string;successor:string;reason:string;before_json:string;after_json:string}>();
  if(edges.success!==true||!edges.results)return false;
  const parsed:{id:string;predecessor:string;successor:string;proof:string;epoch:string;version:string;nonce:string|null}[]=[];
  for(const edge of edges.results){
   let before:Record<string,unknown>,after:Record<string,unknown>;
   try{before=JSON.parse(edge.before_json);after=JSON.parse(edge.after_json);}catch{return false;}
   if(typeof before.predecessorJobId!=='string'||typeof before.proof!=='string'||!/^[0-9a-f]{64}$/.test(before.proof)||before.book!==book||edge.reason!==snap.binding.fingerprint||edge.id!=='issue296:serial:'+before.predecessorJobId||after.roundId!==roundId||typeof after.epoch!=='string'||!after.epoch||typeof after.version!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(after.version))return false;
   const index=snap.items.findIndex(i=>i.job_id===before.predecessorJobId);
   if(index<0||snap.items[index+1]?.job_id!==edge.successor)return false;
   parsed.push({id:edge.id,predecessor:before.predecessorJobId,successor:edge.successor,proof:before.proof,epoch:after.epoch,version:after.version,nonce:typeof after.attestationNonce==='string'?after.attestationNonce:null});
  }
  if(new Set(parsed.map(x=>x.predecessor)).size!==parsed.length)return false;
  const handoff=await db.prepare('SELECT predecessor_job_id,successor_job_id,successor_epoch_id,worker_version,payload_digest,nonce FROM serial_pilot_attested_handoffs WHERE round_id=? AND spreadsheet_id=?').bind(roundId,book).all<{predecessor_job_id:string;successor_job_id:string;successor_epoch_id:string;worker_version:string;payload_digest:string;nonce:string}>();
  if(handoff.success!==true||handoff.results?.length!==1)return false;
  const h=handoff.results[0]!,link=parsed.find(x=>x.predecessor===e.job_id);
  if(h.predecessor_job_id!==e.job_id||h.successor_job_id!==e.successor_job_id||!link||link.successor!==h.successor_job_id||link.epoch!==h.successor_epoch_id||link.version!==h.worker_version||link.proof!==h.payload_digest||link.nonce!==h.nonce)return false;
  return e.category==='PARKED'&&e.evidence==='MOCK_ATTESTED_HANDOFF'&&snap.items.some((x,i)=>x.ordinal===i&&x.job_id===e.job_id&&snap.items[i+1]?.job_id===e.successor_job_id)&&snap.items.every((x,i)=>x.ordinal===i)&&snap.results.every(r=>{
   const edge=parsed.find(x=>x.predecessor===r.job_id);
   const proof=evidence.results!.find(x=>x.job_id===r.job_id),receipt=snap.verifiedEvidence.find(x=>x.job_id===r.job_id);
   const verified=!!receipt&&receipt.proof_algorithm==='pilot-finish-v2'&&r.job_id===h.successor_job_id&&!!parsed.find(x=>x.id===receipt.audit_id&&x.successor===r.job_id&&x.epoch===receipt.epoch_id&&x.version===receipt.worker_version)&&/^[0-9a-f]{64}$/.test(receipt.proof);
   return r.successor_job_id===(edge?.successor??null)&&(r.job_id===e.job_id?r.category==='PARKED'&&r.evidence===e.evidence&&r.successor_job_id===e.successor_job_id:proof?r.category==='NOT_STARTED'&&r.evidence==='MOCK_NEVER_STARTED'&&proof.category===r.category&&proof.evidence===r.evidence&&proof.successor_job_id===null:r.category==='VERIFIED'?r.evidence==='VERIFIED_RECEIPT'&&verified:r.category==='RECONCILE'&&r.evidence==='UNVERIFIED');
  });
 };
 try{
  if(!book||!valid())return held();
  const snap=await readSerialRound(db,roundId);
  if(!snap||!valid()||snap.binding?.spreadsheet_id!==book)return held();
  if(snap.round.state==='CLOSED')return await historical()&&valid()?{ok:true,outcome:'CLOSED'}:held();
  if(snap.round.state!=='OPEN'||snap.items.length<2||snap.items.length>100||snap.items.length!==snap.round.selected_count||snap.results.length!==0)return held();
  const transfers=await db.prepare(`SELECT h.round_id,h.predecessor_job_id AS job_id,h.successor_job_id,hold.source_namespace,h.source_revision,h.fence_digest,h.fence_generation,h.nonce,h.worker_version
   FROM serial_pilot_attested_handoffs h JOIN serial_pilot_hold_evidence hold ON hold.round_id=h.round_id AND hold.job_id=h.predecessor_job_id
   WHERE h.round_id=? AND h.spreadsheet_id=?`).bind(roundId,book).all<Transfer>();
  const previous=await db.prepare('SELECT count(*) n FROM serial_pilot_classification_evidence WHERE round_id=?').bind(roundId).first<{n:number}>();
  if(!valid()||transfers.success!==true||transfers.results?.length!==1||previous?.n!==0)return held();
  const t=transfers.results[0]!;
  if(t.worker_version!==version||!snap.items.some((x,i)=>x.job_id===t.job_id&&snap.items[i+1]?.job_id===t.successor_job_id))return held();
  let verified:{row:Observation;proof:string}|null=null;
  const matches=snap.verifiedEvidence.filter(x=>x.job_id===t.successor_job_id);
  if(matches.length===1&&matches[0]!.worker_version===version&&matches[0]!.proof_algorithm==='pilot-finish-v2'){
   const receipt=matches[0]!,identity={jobId:t.successor_job_id,fingerprint:snap.binding.fingerprint};
   const rows=await db.prepare(observation+' SELECT * FROM observed WHERE '+complete).bind(...bindings(env,identity,version)).all<Observation>(),row=rows.results?.[0];
   if(rows.success!==true||!rows.results||rows.results.length>1||!valid())return held();
   if(row&&row.audit_id===receipt.audit_id&&row.epoch_id===receipt.epoch_id&&row.revision===receipt.source_revision&&await completionProof(version,identity,row)===receipt.proof)verified={row,proof:receipt.proof};
  }
  const statements:D1PreparedStatement[]=[db.prepare(`INSERT INTO serial_pilot_classification_evidence VALUES(?,?,'PARKED','MOCK_ATTESTED_HANDOFF',?,?,?,?,?,?,?)`).bind(roundId,t.job_id,t.successor_job_id,t.source_namespace,t.source_revision,t.fence_digest,t.fence_generation,t.nonce,t.worker_version),db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid','$') END")];
  for(const item of snap.items.filter(x=>x.job_id!==t.job_id&&!(verified&&x.job_id===t.successor_job_id))){
   const fields:Record<string,string|number|null>={round_id:roundId,job_id:item.job_id,category:'NOT_STARTED',evidence:'MOCK_NEVER_STARTED',successor_job_id:null,source_namespace:t.source_namespace,source_revision:t.source_revision,fence_digest:t.fence_digest,fence_generation:t.fence_generation,attestation_nonce:t.nonce,worker_version:t.worker_version};
   const args:(string|number|null)[]=[];
   const predicate=notStartedClassificationPredicate.replace(/__FIELD_([a-z_]+)__/g,(_match,key:string)=>{if(!(key in fields))throw Error('unknown classification field');args.push(fields[key]!);return '?';});
   if(predicate.includes('__FIELD_'))return held();
   statements.push(db.prepare(`INSERT INTO serial_pilot_classification_evidence SELECT ?,?,'NOT_STARTED','MOCK_NEVER_STARTED',NULL,?,?,?,?,?,? WHERE EXISTS(${predicate})`).bind(roundId,item.job_id,t.source_namespace,t.source_revision,t.fence_digest,t.fence_generation,t.nonce,t.worker_version,...args));
  }
  for(const item of snap.items){
   const identity={jobId:item.job_id,fingerprint:snap.binding.fingerprint};
   statements.push(item.job_id===t.job_id?db.prepare("INSERT INTO serial_pilot_round_results VALUES(?,?,'PARKED','MOCK_ATTESTED_HANDOFF',?)").bind(roundId,item.job_id,t.successor_job_id):verified&&item.job_id===t.successor_job_id?db.prepare(observation+` INSERT INTO serial_pilot_round_results SELECT ?,?,'VERIFIED','VERIFIED_RECEIPT',NULL FROM observed t JOIN serial_pilot_verified_evidence v ON v.round_id=? AND v.job_id=? WHERE ${complete} AND t.audit_id=? AND t.epoch_id=? AND t.revision=? AND t.proof_inputs=? AND v.audit_id=t.audit_id AND v.epoch_id=t.epoch_id AND v.source_revision=t.revision AND v.worker_version=? AND v.proof=? AND v.proof_algorithm='pilot-finish-v2' AND v.proof_inputs IS t.proof_inputs AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=?)`).bind(...bindings(env,identity,version),roundId,item.job_id,roundId,item.job_id,verified.row.audit_id,verified.row.epoch_id,verified.row.revision,verified.row.proof_inputs,version,verified.proof,book):db.prepare(`INSERT INTO serial_pilot_round_results SELECT ?,?,CASE WHEN e.job_id IS NULL THEN 'RECONCILE' ELSE 'NOT_STARTED' END,CASE WHEN e.job_id IS NULL THEN 'UNVERIFIED' ELSE 'MOCK_NEVER_STARTED' END,(SELECT a.entity_key FROM admin_audit a WHERE a.action=? AND json_extract(a.after_json,'$.roundId')=? AND json_extract(a.before_json,'$.predecessorJobId')=?) FROM (SELECT 1) anchor LEFT JOIN serial_pilot_classification_evidence e ON e.round_id=? AND e.job_id=? AND e.category='NOT_STARTED'`).bind(roundId,item.job_id,serialAuditAction,roundId,item.job_id,roundId,item.job_id));
   statements.push(db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid','$') END"));
  }
  statements.push(db.prepare("UPDATE serial_pilot_rounds SET state='CLOSED',closed_at=?,reason='MOCK_CLASSIFIED' WHERE round_id=? AND state='OPEN' AND EXISTS(SELECT 1 FROM serial_pilot_round_bindings b WHERE b.round_id=serial_pilot_rounds.round_id AND b.spreadsheet_id=? AND b.fingerprint=?)").bind(new Date().toISOString(),roundId,book,snap.binding.fingerprint),db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid','$') END"));
  if(!valid())return held();submitted=true;
  const result=await db.batch(statements);
  if(!valid()||result.length!==statements.length||result.some(x=>x.success!==true))return {ok:false,outcome:'UNCERTAIN'};
  return {ok:true,outcome:'CLOSED'};
 }catch{
  if(!submitted)return held();
  try{if(valid()&&await historical()&&valid())return {ok:true,outcome:'CLOSED'};}catch{/* Retain the unresolved record. */}
  return {ok:false,outcome:'UNCERTAIN'};
 }
}
