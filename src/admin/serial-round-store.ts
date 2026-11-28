import type {Env} from '../types';

// Bookkeeping only: callers must independently prove every outcome. These
// records never grant permission to write Sheets or reserve a successor.
type Category='VERIFIED'|'PARKED'|'RECONCILE'|'NOT_STARTED';
export type RoundResult={jobId:string;category:Category;evidence:string;successorJobId:string|null};
type Round={round_id:string;recovery_of:string|null;selected_count:number;state:string;created_at:string;closed_at:string|null;reason:string|null};
type Item={job_id:string;ordinal:number};
type StoredResult={job_id:string;category:Category;evidence:string;successor_job_id:string|null};
type RoundBinding={spreadsheetId:string;fingerprint:string};
const id=/^[A-Za-z0-9_-]{1,128}$/;
const code=/^[A-Z][A-Z0-9_]{0,127}$/;
// Keep transactions bounded. This is a local safety limit, not a promise that
// a provider batch will finish before its deadline under every load.
const maxItems=100;
const categories=new Set(['VERIFIED','PARKED','RECONCILE','NOT_STARTED']);
const guard=(db:Env['DB'])=>db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid','$') END AS ok");
/** Guard the exact ordered candidate set at the transaction boundary. */
export function serialSelectionGuard(db:Env['DB'],book:string,jobs:string[]){
 return db.prepare(`SELECT CASE WHEN (SELECT json_group_array(job_id) FROM (
  SELECT j.job_id FROM sync_jobs j JOIN expense_events e ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version
  JOIN continuous_daily_post_cutover_expenses p ON p.expense_id=e.expense_id AND p.spreadsheet_id=?
  JOIN continuous_daily_cutovers c ON c.spreadsheet_id=p.spreadsheet_id AND c.state='ACTIVE'
  WHERE j.status='PENDING' AND j.attempt_count=0 AND j.lease_token IS NULL AND j.lease_until IS NULL
   AND (j.next_attempt_at IS NULL OR j.next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   AND e.status='CONFIRMED' AND e.version=1 AND substr(e.transaction_date,1,7)=strftime('%Y-%m','now','+7 hours')
   AND length(e.transaction_date)=10 AND date(e.transaction_date,'+0 days')=e.transaction_date
  ORDER BY j.updated_at,j.entity_key))=? THEN 1 ELSE json_extract('invalid','$') END AS ok`).bind(book,JSON.stringify(jobs));
}
async function snapshot(db:Env['DB'],roundId:string){
 const [r,i,o,b,v]=await Promise.all([
  db.prepare('SELECT * FROM serial_pilot_rounds WHERE round_id=?').bind(roundId).all<Round>(),
  db.prepare('SELECT job_id,ordinal FROM serial_pilot_round_items WHERE round_id=? ORDER BY ordinal').bind(roundId).all<Item>(),
  db.prepare('SELECT job_id,category,evidence,successor_job_id FROM serial_pilot_round_results WHERE round_id=? ORDER BY job_id').bind(roundId).all<StoredResult>(),
  db.prepare('SELECT spreadsheet_id,fingerprint FROM serial_pilot_round_bindings WHERE round_id=?').bind(roundId).all<{spreadsheet_id:string;fingerprint:string}>(),
  db.prepare('SELECT job_id,proof,worker_version,audit_id,epoch_id,source_revision,verified_at,proof_algorithm FROM serial_pilot_verified_evidence WHERE round_id=? ORDER BY job_id').bind(roundId).all<{job_id:string;proof:string;worker_version:string;audit_id:string;epoch_id:string;source_revision:number;verified_at:string;proof_algorithm:string}>()
 ]);
 if(r.success!==true||i.success!==true||o.success!==true||b.success!==true||v.success!==true||r.results?.length!==1||!i.results||!o.results||!b.results||!v.results||b.results.length>1)return null;
 return {round:r.results[0]!,items:i.results,results:o.results,binding:b.results[0]??null,verifiedEvidence:v.results};
}

/** Find unfinished rounds without relying on the terminated runner's memory.
 * The caller must reconcile evidence before closing or continuing a round. */
export async function findOpenSerialRounds(db:Env['DB'],book?:string):Promise<{roundId:string;createdAt:string;selectedCount:number}[]|null>{
 const sql=book?"SELECT r.round_id,r.created_at,r.selected_count FROM serial_pilot_rounds r JOIN serial_pilot_round_bindings b ON b.round_id=r.round_id WHERE r.state='OPEN' AND b.spreadsheet_id=? ORDER BY r.created_at,r.round_id LIMIT 101":"SELECT round_id,created_at,selected_count FROM serial_pilot_rounds WHERE state='OPEN' ORDER BY created_at,round_id LIMIT 101";
 const statement=db.prepare(sql);
 const result=await (book?statement.bind(book):statement).all<{round_id:string;created_at:string;selected_count:number}>();
 if(result.success!==true||!result.results||result.results.length>100)return null;
 return result.results.map(x=>({roundId:x.round_id,createdAt:x.created_at,selectedCount:x.selected_count}));
}

/** Include recently closed rounds so a new process can locate a committed
 * close even if its predecessor died before receiving the response. */
export async function findRecentSerialRounds(db:Env['DB'],book:string){
 if(!book)return null;
 const result=await db.prepare("SELECT r.round_id,r.state,r.selected_count FROM serial_pilot_rounds r JOIN serial_pilot_round_bindings b ON b.round_id=r.round_id WHERE b.spreadsheet_id=? AND r.state IN ('OPEN','CLOSED') ORDER BY r.created_at DESC,r.round_id DESC LIMIT 20").bind(book)
  .all<{round_id:string;state:string;selected_count:number}>();
 if(result.success!==true||!result.results)return null;
 return result.results.map(x=>({roundId:x.round_id,state:x.state,selectedCount:x.selected_count}));
}

export async function readSerialRound(db:Env['DB'],roundId:string){
 if(!id.test(roundId))return null;
 return snapshot(db,roundId);
}

type ReservationAudit={
 audit_id:string;job_id:string;action:string;old_token:string|null;predecessor:string|null;proof:string|null;
 nonce:string|null;token:string|null;version:string;epoch:string;bound:number
};
type ReservationChain={status:'OBSERVED';jobIds:string[];workerVersion:string|null}|{status:'UNKNOWN'};

/** Observe committed reservations. A missing audit never rules out an in-flight
 * handover. The recorded version belongs to the writer, not the reader. */
export async function readRoundReservations(db:Env['DB'],roundId:string,snap:NonNullable<Awaited<ReturnType<typeof readSerialRound>>>):Promise<ReservationChain>{
 const unknown={status:'UNKNOWN'} as const;
 if(!snap.binding||snap.items.length!==snap.round.selected_count||snap.items.some((item,n)=>item.ordinal!==n))return unknown;
 const edges=await db.prepare(`SELECT a.id audit_id,a.action,a.entity_key job_id,json_extract(a.before_json,'$.oldToken') old_token,
   json_extract(a.before_json,'$.predecessorJobId') predecessor,json_extract(a.before_json,'$.proof') proof,
   json_extract(a.after_json,'$.attestationNonce') nonce,json_extract(a.after_json,'$.token') token,
   json_extract(a.after_json,'$.version') version,ep.epoch_id epoch,
   (a.reason=b.fingerprint AND json_extract(a.before_json,'$.book')=b.spreadsheet_id AND ad.epoch_id IS NOT NULL AND saved.audit_id IS NOT NULL) bound
  FROM admin_audit a JOIN serial_pilot_round_bindings b ON b.round_id=json_extract(a.after_json,'$.roundId')
  LEFT JOIN serial_pilot_round_items i ON i.round_id=b.round_id AND i.job_id=a.entity_key
  LEFT JOIN sync_jobs j ON j.job_id=i.job_id AND j.entity_type='EXPENSE' AND j.entity_version=1
  LEFT JOIN stable_recovery_epochs ep ON ep.epoch_id=json_extract(a.after_json,'$.epoch') AND ep.spreadsheet_id=b.spreadsheet_id
   AND ep.target_type=j.entity_type AND ep.target_key=j.entity_key AND ep.target_version=j.entity_version
  LEFT JOIN continuous_normal_recovery_admissions ad ON ad.epoch_id=ep.epoch_id AND ad.spreadsheet_id=b.spreadsheet_id
   AND ad.expense_id=ep.target_key AND ad.source_version=ep.target_version
  LEFT JOIN serial_pilot_reservation_snapshots saved ON saved.audit_id=a.id AND saved.round_id=b.round_id
   AND saved.job_id=i.job_id AND saved.epoch_id=ep.epoch_id AND saved.spreadsheet_id=b.spreadsheet_id
   AND saved.worker_version=json_extract(a.after_json,'$.version')
  WHERE b.round_id=? AND b.spreadsheet_id=? AND a.action IN ('ISSUE296_PAUSED_NOTICE_HANDOVER','ISSUE296_SERIAL_EXPENSE_HANDOVER')
  ORDER BY i.ordinal,a.id LIMIT 101`).bind(roundId,snap.binding.spreadsheet_id).all<ReservationAudit>();
 if(edges.success!==true||!edges.results||edges.results.length>snap.items.length)return unknown;
 const rows=edges.results,first=rows[0];
 const versionId=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
 for(const [n,edge] of rows.entries()){
  if(edge.bound!==1||edge.job_id!==snap.items[n]?.job_id||!first||!versionId.test(edge.version)||edge.version!==first.version||
   !edge.epoch?.startsWith('normal_pilot296_')||!edge.old_token||edge.old_token!==first.old_token)return unknown;
  if(n===0){
   if(edge.action!=='ISSUE296_PAUSED_NOTICE_HANDOVER'||edge.audit_id!=='issue296:parked:'+edge.old_token||edge.predecessor!==null||edge.nonce!==null)return unknown;
   continue;
  }
  const prior=rows[n-1]!;
  if(edge.action!=='ISSUE296_SERIAL_EXPENSE_HANDOVER'||edge.audit_id!=='issue296:serial:'+prior.job_id||
    edge.predecessor!==prior.job_id||!edge.proof||!/^[a-f0-9]{64}$/.test(edge.proof))return unknown;
  if(edge.nonce===null){
   const receipt=snap.verifiedEvidence.find(r=>r.job_id===prior.job_id);
   if(!receipt||receipt.proof_algorithm!=='pilot-finish-v2'||receipt.proof!==edge.proof||receipt.worker_version!==edge.version||
     receipt.audit_id!==prior.audit_id||receipt.epoch_id!==prior.epoch)return unknown;
  }else{
   // A parked predecessor uses a retained handoff instead of a completion receipt.
   const handoff=await db.prepare(`SELECT 1 matched FROM serial_pilot_attested_handoffs WHERE round_id=? AND spreadsheet_id=?
    AND predecessor_job_id=? AND successor_job_id=? AND predecessor_epoch_id=? AND successor_epoch_id=?
    AND worker_version=? AND nonce=? AND payload_digest=? AND claim_token=?`)
    .bind(roundId,snap.binding.spreadsheet_id,prior.job_id,edge.job_id,prior.epoch,edge.epoch,edge.version,edge.nonce,edge.proof,edge.token).first();
   if(!handoff)return unknown;
  }
 }
 return {status:'OBSERVED',jobIds:rows.map(x=>x.job_id),workerVersion:first?.version??null};
}

/** Read current D1 observations without converting them to a success proof. */
export async function observeSerialRound(db:Env['DB'],roundId:string){
 if(!id.test(roundId))return null;
 const result=await db.prepare(`SELECT i.job_id,j.status AS job_state,CASE WHEN j.last_error IN ('SERIAL_PILOT_B_REVIEW','SERIAL_EXPIRED_PROVIDER_UNCERTAIN') THEN j.last_error ELSE NULL END AS hold_reason,j.serial_provenance_version AS provenance_version,j.serial_lease_generation AS lease_generation,
   (SELECT count(*) FROM admin_audit a WHERE a.action IN ('ISSUE296_PAUSED_NOTICE_HANDOVER','ISSUE296_SERIAL_EXPENSE_HANDOVER') AND a.entity_key=i.job_id AND json_extract(a.after_json,'$.roundId')=i.round_id) AS reservations,
   (SELECT ep.state FROM admin_audit a JOIN stable_recovery_epochs ep ON ep.epoch_id=json_extract(a.after_json,'$.epoch') AND ep.spreadsheet_id=(SELECT spreadsheet_id FROM serial_pilot_round_bindings WHERE round_id=i.round_id) AND ep.target_type=j.entity_type AND ep.target_key=j.entity_key AND ep.target_version=j.entity_version WHERE a.action IN ('ISSUE296_PAUSED_NOTICE_HANDOVER','ISSUE296_SERIAL_EXPENSE_HANDOVER') AND a.entity_key=i.job_id AND json_extract(a.before_json,'$.book')=ep.spreadsheet_id AND json_extract(a.after_json,'$.roundId')=i.round_id LIMIT 1) AS epoch_state,
   (SELECT count(*) FROM admin_audit a JOIN stable_recovery_operations o ON o.epoch_id=json_extract(a.after_json,'$.epoch') JOIN stable_recovery_epochs ep ON ep.epoch_id=o.epoch_id AND ep.spreadsheet_id=(SELECT spreadsheet_id FROM serial_pilot_round_bindings WHERE round_id=i.round_id) AND ep.target_type=j.entity_type AND ep.target_key=j.entity_key AND ep.target_version=j.entity_version WHERE a.action IN ('ISSUE296_PAUSED_NOTICE_HANDOVER','ISSUE296_SERIAL_EXPENSE_HANDOVER') AND a.entity_key=i.job_id AND json_extract(a.before_json,'$.book')=ep.spreadsheet_id AND json_extract(a.after_json,'$.roundId')=i.round_id AND o.state='ADMITTED') AS admitted_operations,
   CASE WHEN NOT EXISTS(SELECT 1 FROM serial_pilot_round_bindings b JOIN stable_workbook_claims c ON c.spreadsheet_id=b.spreadsheet_id WHERE b.round_id=i.round_id) THEN 'NO_CLAIM'
    WHEN EXISTS(SELECT 1 FROM serial_pilot_round_bindings b JOIN stable_workbook_claims c ON c.spreadsheet_id=b.spreadsheet_id JOIN stable_recovery_operations o ON o.operation_token=c.operation_token JOIN admin_audit a ON o.epoch_id=json_extract(a.after_json,'$.epoch') JOIN stable_recovery_epochs ep ON ep.epoch_id=o.epoch_id AND ep.spreadsheet_id=b.spreadsheet_id AND ep.target_type=j.entity_type AND ep.target_key=j.entity_key AND ep.target_version=j.entity_version WHERE b.round_id=i.round_id AND a.entity_key=i.job_id AND json_extract(a.before_json,'$.book')=b.spreadsheet_id AND json_extract(a.after_json,'$.roundId')=i.round_id AND a.action IN ('ISSUE296_PAUSED_NOTICE_HANDOVER','ISSUE296_SERIAL_EXPENSE_HANDOVER')) THEN 'EXACT_EPOCH_OPERATION'
    ELSE 'UNKNOWN' END AS claim_relationship,
   (SELECT count(*) FROM stable_projection_writes p WHERE p.spreadsheet_id=(SELECT spreadsheet_id FROM serial_pilot_round_bindings WHERE round_id=i.round_id) AND p.entity_type='EXPENSE' AND p.source_version=j.entity_version AND EXISTS(SELECT 1 FROM admin_audit scope_a JOIN stable_recovery_operations scope_o ON scope_o.epoch_id=json_extract(scope_a.after_json,'$.epoch') AND scope_o.operation_token=p.operation_token WHERE scope_a.entity_key=i.job_id AND scope_a.action IN ('ISSUE296_PAUSED_NOTICE_HANDOVER','ISSUE296_SERIAL_EXPENSE_HANDOVER') AND json_extract(scope_a.after_json,'$.roundId')=i.round_id) AND (p.entity_id=j.entity_key OR substr(p.entity_id,1,length(j.entity_key)+1)=j.entity_key||'|') AND p.state='VERIFIED') AS verified_stages,
   (SELECT count(*) FROM stable_projection_writes p WHERE p.spreadsheet_id=(SELECT spreadsheet_id FROM serial_pilot_round_bindings WHERE round_id=i.round_id) AND p.entity_type='EXPENSE' AND p.source_version=j.entity_version AND EXISTS(SELECT 1 FROM admin_audit scope_a JOIN stable_recovery_operations scope_o ON scope_o.epoch_id=json_extract(scope_a.after_json,'$.epoch') AND scope_o.operation_token=p.operation_token WHERE scope_a.entity_key=i.job_id AND scope_a.action IN ('ISSUE296_PAUSED_NOTICE_HANDOVER','ISSUE296_SERIAL_EXPENSE_HANDOVER') AND json_extract(scope_a.after_json,'$.roundId')=i.round_id) AND (p.entity_id=j.entity_key OR substr(p.entity_id,1,length(j.entity_key)+1)=j.entity_key||'|') AND p.state<>'VERIFIED') AS unresolved_stages,
   (SELECT max(p.updated_at) FROM stable_projection_writes p WHERE p.spreadsheet_id=(SELECT spreadsheet_id FROM serial_pilot_round_bindings WHERE round_id=i.round_id) AND p.entity_type='EXPENSE' AND p.source_version=j.entity_version AND EXISTS(SELECT 1 FROM admin_audit scope_a JOIN stable_recovery_operations scope_o ON scope_o.epoch_id=json_extract(scope_a.after_json,'$.epoch') AND scope_o.operation_token=p.operation_token WHERE scope_a.entity_key=i.job_id AND scope_a.action IN ('ISSUE296_PAUSED_NOTICE_HANDOVER','ISSUE296_SERIAL_EXPENSE_HANDOVER') AND json_extract(scope_a.after_json,'$.roundId')=i.round_id) AND (p.entity_id=j.entity_key OR substr(p.entity_id,1,length(j.entity_key)+1)=j.entity_key||'|') AND p.state='VERIFIED') AS last_verified_at,
   (SELECT p.projection FROM stable_projection_writes p WHERE p.spreadsheet_id=(SELECT spreadsheet_id FROM serial_pilot_round_bindings WHERE round_id=i.round_id) AND p.entity_type='EXPENSE' AND p.source_version=j.entity_version AND EXISTS(SELECT 1 FROM admin_audit scope_a JOIN stable_recovery_operations scope_o ON scope_o.epoch_id=json_extract(scope_a.after_json,'$.epoch') AND scope_o.operation_token=p.operation_token WHERE scope_a.entity_key=i.job_id AND scope_a.action IN ('ISSUE296_PAUSED_NOTICE_HANDOVER','ISSUE296_SERIAL_EXPENSE_HANDOVER') AND json_extract(scope_a.after_json,'$.roundId')=i.round_id) AND (p.entity_id=j.entity_key OR substr(p.entity_id,1,length(j.entity_key)+1)=j.entity_key||'|') AND p.state='VERIFIED' ORDER BY p.updated_at DESC,p.projection,p.entity_id LIMIT 1) AS last_verified_stage,
   (SELECT c.state FROM serial_pilot_round_bindings b JOIN stable_workbook_claims c ON c.spreadsheet_id=b.spreadsheet_id WHERE b.round_id=i.round_id LIMIT 1) AS workbook_claim,
   (SELECT CASE WHEN c.phase IN ('PILOT_RESERVED','PILOT_TAKEN','SERIAL_PILOT_ADOPTED','SERIAL_CONTINUATION','SERIAL_FINAL_RELEASE') THEN c.phase ELSE 'UNKNOWN' END FROM serial_pilot_round_bindings b JOIN stable_workbook_claims c ON c.spreadsheet_id=b.spreadsheet_id WHERE b.round_id=i.round_id LIMIT 1) AS workbook_claim_phase,
   (SELECT CASE WHEN substr(c.review_reason,1,length('SHEETS_MUTATION_OUTCOME_UNKNOWN:'))='SHEETS_MUTATION_OUTCOME_UNKNOWN:' THEN 'SHEETS_MUTATION_OUTCOME_UNKNOWN' WHEN c.review_reason IN ('SERIAL_FINAL_COMPLETION_NOT_READY','SERIAL_CONTINUATION_UNVERIFIED','SERIAL_CONTINUATION_FENCE_UNVERIFIED','ATTESTED_PILOT_RELEASE_UNVERIFIED','PILOT_TAKE_PREIMAGE','PILOT_TAKE_UNCERTAIN') THEN c.review_reason ELSE 'UNKNOWN' END FROM serial_pilot_round_bindings b JOIN stable_workbook_claims c ON c.spreadsheet_id=b.spreadsheet_id WHERE b.round_id=i.round_id LIMIT 1) AS workbook_claim_reason
  FROM serial_pilot_round_items i LEFT JOIN sync_jobs j ON j.job_id=i.job_id WHERE i.round_id=? ORDER BY i.ordinal`).bind(roundId)
  .all<{job_id:string;job_state:string|null;hold_reason:'SERIAL_PILOT_B_REVIEW'|'SERIAL_EXPIRED_PROVIDER_UNCERTAIN'|null;provenance_version:number|null;lease_generation:number|null;reservations:number;epoch_state:string|null;admitted_operations:number;claim_relationship:'NO_CLAIM'|'EXACT_EPOCH_OPERATION'|'UNKNOWN';verified_stages:number;unresolved_stages:number;last_verified_at:string|null;last_verified_stage:string|null;workbook_claim:string|null;workbook_claim_phase:string|null;workbook_claim_reason:string|null}>();
 if(result.success!==true||!result.results||result.results.some(x=>x.reservations>1))return null;
 return result.results;
}

/** Close only as unresolved, retaining every claim. A successor is read from
 * the durable audit; the D1 trigger rechecks it within the closing batch. This
 * is an observation, never a finding that a job succeeded or is safe to skip. */
export async function closeUnverifiedSerialRound(db:Env['DB'],roundId:string,closedAt:string,book?:string,stable:()=>boolean=()=>true):Promise<boolean>{
 if(!id.test(roundId)||!closedAt)return false;
 const existing=await snapshot(db,roundId);
 if(!existing||!stable()||book!==undefined&&existing.binding?.spreadsheet_id!==book)return false;
 const reason=existing.round.selected_count===0?'EMPTY_SELECTION':'EVIDENCE_REQUIRED';
 if(existing.round.state==='CLOSED')return existing.round.reason===reason&&existing.results.length===existing.round.selected_count&&
  existing.results.every(x=>x.category==='RECONCILE'&&x.evidence==='UNVERIFIED');
 if(existing.round.state!=='OPEN')return false;
 const observed=await db.prepare(`SELECT i.job_id,
   (SELECT count(*) FROM admin_audit a WHERE a.action='ISSUE296_SERIAL_EXPENSE_HANDOVER' AND json_extract(a.after_json,'$.roundId')=i.round_id AND json_extract(a.before_json,'$.predecessorJobId')=i.job_id) AS successors,
   (SELECT a.entity_key FROM admin_audit a WHERE a.action='ISSUE296_SERIAL_EXPENSE_HANDOVER' AND json_extract(a.after_json,'$.roundId')=i.round_id AND json_extract(a.before_json,'$.predecessorJobId')=i.job_id LIMIT 1) AS successor
   FROM serial_pilot_round_items i JOIN serial_pilot_rounds r ON r.round_id=i.round_id
   WHERE i.round_id=? AND r.state='OPEN' AND EXISTS(SELECT 1 FROM serial_pilot_round_fence_activation WHERE singleton=1) ORDER BY i.ordinal`)
  .bind(roundId).all<{job_id:string;successors:number;successor:string|null}>();
 if(observed.success!==true||!observed.results||observed.results.some(x=>x.successors>1))return false;
 const round=await snapshot(db,roundId);
 if(!round||round.round.state!=='OPEN'||round.round.selected_count!==observed.results.length)return false;
 const results:RoundResult[]=observed.results.map(x=>({jobId:x.job_id,category:'RECONCILE',evidence:'UNVERIFIED',successorJobId:x.successor}));
 if(!stable())return false;
 if(await closeSerialRound(db,roundId,closedAt,reason,results,book,stable))return stable();
 const after=await snapshot(db,roundId);
 return stable()&&!!after&&after.round.state==='CLOSED'&&after.round.reason===reason&&after.results.length===after.round.selected_count&&
  after.results.every(x=>x.category==='RECONCILE'&&x.evidence==='UNVERIFIED');
}

/** Open the exact member snapshot in one transaction. A lost response is
 * reconciled against the committed snapshot, never by inventing a new round. */
export async function openSerialRound(db:Env['DB'],roundId:string,recoveryOf:string|null,createdAt:string,jobs:string[],binding?:RoundBinding,stable:()=>boolean=()=>true,preconditions:D1PreparedStatement[]=[]):Promise<boolean>{
 if(!id.test(roundId)||recoveryOf!==null&&!id.test(recoveryOf)||!createdAt||jobs.length>maxItems||jobs.some(j=>!id.test(j))||new Set(jobs).size!==jobs.length||binding&&(!binding.spreadsheetId||binding.spreadsheetId.length>256||!/^[a-f0-9]{64}$/.test(binding.fingerprint)))return false;
 try{
  const statements=[...preconditions,db.prepare("INSERT INTO serial_pilot_rounds VALUES(?,?,?,'PREPARING',?,NULL,NULL)").bind(roundId,recoveryOf,jobs.length,createdAt)];
  if(binding)statements.push(db.prepare('INSERT INTO serial_pilot_round_bindings VALUES(?,?,?)').bind(roundId,binding.spreadsheetId,binding.fingerprint));
  for(const [ordinal,job] of jobs.entries())statements.push(db.prepare('INSERT INTO serial_pilot_round_items VALUES(?,?,?)').bind(roundId,ordinal,job));
  statements.push(db.prepare("UPDATE serial_pilot_rounds SET state='OPEN' WHERE round_id=? AND state='PREPARING'").bind(roundId),guard(db));
  if(!stable())return false;
  await db.batch(statements);
 }catch{/* Read back: batch may have committed despite a lost acknowledgement. */}
 const found=await snapshot(db,roundId);
 return stable()&&!!found&&found.round.state==='OPEN'&&found.round.recovery_of===recoveryOf&&found.round.created_at===createdAt&&
  found.round.selected_count===jobs.length&&found.items.length===jobs.length&&found.items.every((v,n)=>v.ordinal===n&&v.job_id===jobs[n])&&
  (binding?found.binding?.spreadsheet_id===binding.spreadsheetId&&found.binding.fingerprint===binding.fingerprint:found.binding===null);
}

/** Atomically attach exactly one caller-supplied evidence summary per member
 * and close the round. This function does not validate provider evidence. */
export async function closeSerialRound(db:Env['DB'],roundId:string,closedAt:string,reason:string,results:RoundResult[],book?:string,stable:()=>boolean=()=>true):Promise<boolean>{
 if(!id.test(roundId)||!closedAt||!code.test(reason)||results.length>maxItems||
  results.some(x=>!id.test(x.jobId)||!categories.has(x.category)||!code.test(x.evidence)||x.successorJobId!==null&&!id.test(x.successorJobId))||
  new Set(results.map(x=>x.jobId)).size!==results.length)return false;
 try{
  const statements=results.map(x=>db.prepare('INSERT INTO serial_pilot_round_results VALUES(?,?,?,?,?)').bind(roundId,x.jobId,x.category,x.evidence,x.successorJobId));
  const sql="UPDATE serial_pilot_rounds SET state='CLOSED',closed_at=?,reason=? WHERE round_id=? AND state='OPEN'"+(book===undefined?'':" AND EXISTS(SELECT 1 FROM serial_pilot_round_bindings b WHERE b.round_id=serial_pilot_rounds.round_id AND b.spreadsheet_id=?)");
  statements.push(db.prepare(sql).bind(closedAt,reason,roundId,...(book===undefined?[]:[book])),guard(db));
  if(!stable())return false;
  await db.batch(statements);
 }catch{/* Read back after a possible committed batch. */}
 const found=await snapshot(db,roundId),expected=results.map(x=>({job_id:x.jobId,category:x.category,evidence:x.evidence,successor_job_id:x.successorJobId})).sort((a,b)=>a.job_id<b.job_id?-1:a.job_id>b.job_id?1:0);
 return !!found&&found.round.state==='CLOSED'&&found.round.closed_at===closedAt&&found.round.reason===reason&&found.round.selected_count===results.length&&
  JSON.stringify(found.results)===JSON.stringify(expected);
}
