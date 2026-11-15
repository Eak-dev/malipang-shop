import type {Env,SheetsSyncJob} from '../types';
import type {ContinuousSheetsReadPolicy} from './client';
import {readFinalHandoffExpenseSource} from './stable-expense-source';
import {readCancelledExpenseSource} from './cancelled-expense-source';
import {verifyStableExpenseProjections} from './stable-expense-final-check';
import {verifyStableCancellationFinal,indexCancellationJournal,type CancelProjection,type CancelWrite} from './stable-cancellation-final-check';
import {reviewedNoticeMatches,type ReviewedNoticeMode} from './continuous-reviewed-notice';

type Projection=CancelProjection&{operation_token:string};
type Proof={operation_kind:'CONFIRM'|'CANCEL';source_digest:string;journal_manifest:string;notice_stamp:string;notice_identity:string};
/** Re-read every FINAL source, journal, projection and report; no write and
 * no absence-based proof. Caller must perform its final guarded D1 commit. */
export async function verifyFinalHandoff(env:Env,job:SheetsSyncJob,token:string,noticeMode:ReviewedNoticeMode,policy:ContinuousSheetsReadPolicy):Promise<boolean>{
 if(env.CONTINUOUS_PUBLICATION_ENABLED==='true')return false; // FINAL publication proof is not implemented.
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;if(!book||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!token)return false;
 const proof=await db.prepare(`SELECT z.operation_kind,z.source_digest,z.journal_manifest,c.notice_stamp,c.notice_identity FROM continuous_final_notice_evidence z JOIN continuous_normal_notice_handoffs h ON h.spreadsheet_id=z.spreadsheet_id AND h.operation_token=z.operation_token JOIN stable_workbook_claims c ON c.spreadsheet_id=h.spreadsheet_id AND c.operation_token=h.operation_token JOIN stable_recovery_epochs e ON e.epoch_id=z.epoch_id AND e.spreadsheet_id=z.spreadsheet_id JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id AND o.operation_token=z.operation_token JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=z.expense_id AND j.entity_version=z.source_version WHERE z.spreadsheet_id=? AND z.operation_token=? AND z.expense_id=? AND z.source_version=? AND h.projection='FINAL' AND h.expense_id=z.expense_id AND h.source_version=z.source_version AND h.operation_kind=z.operation_kind AND c.state='HELD' AND c.phase='END_NOTICE_PENDING' AND j.status='PENDING' AND j.lease_token IS NULL AND j.lease_until IS NULL AND e.state='ARMED' AND e.target_type='EXPENSE' AND e.target_key=z.expense_id AND e.target_version=z.source_version AND o.state='ADMITTED' AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_final_notice_evidence' AND name IN ('continuous_final_notice_evidence_insert','continuous_final_notice_evidence_no_update','continuous_final_notice_evidence_no_delete','continuous_final_notice_evidence_no_replace'))=4 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_normal_notice_handoffs' AND name IN ('continuous_normal_notice_handoff_insert','continuous_normal_notice_handoff_no_update','continuous_normal_notice_handoff_no_delete','continuous_normal_notice_handoff_no_replace'))=4`).bind(book,token,job.entityKey,job.entityVersion).first<Proof>();
 if(!proof||!proof.notice_stamp||!proof.notice_identity||!['CONFIRM','CANCEL'].includes(proof.operation_kind)||!/^[0-9a-f]{64}$/.test(proof.source_digest)||env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book)return false;
 const readJournals=async()=>{
  const results=await db.batch([
   db.prepare("SELECT entity_id,projection,sheet_id,sheet_name,source_version,source_digest,state,operation_token FROM stable_projection_writes WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND (entity_id=? OR substr(entity_id,1,length(?)+1)=?||'|')").bind(book,job.entityKey,job.entityKey,job.entityKey),
   db.prepare("SELECT entity_id,projection,cancellation_version,previous_version,preimage_digest,operation_token,state FROM stable_expense_cancellation_writes WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND (entity_id=? OR substr(entity_id,1,length(?)+1)=?||'|')").bind(book,job.entityKey,job.entityKey,job.entityKey)
  ]);
  if(results.length!==2||results.some(r=>r.success!==true||!Array.isArray(r.results)))return null;
  const projections=results[0]!.results as Projection[],writes=results[1]!.results as CancelWrite[];
  if(!projections.length||projections.length>502||writes.length>502)return null;
  const writeIndex=proof.operation_kind==='CANCEL'?indexCancellationJournal(projections,writes):null;if(proof.operation_kind==='CANCEL'&&!writeIndex)throw Error('FINAL_HANDOFF_JOURNAL');
  const manifest=projections.map(p=>{const w=writeIndex?.get(JSON.stringify([p.entity_id,p.projection]));if(proof.operation_kind==='CANCEL'&&!w)throw Error('FINAL_HANDOFF_JOURNAL');return {entity_id:p.entity_id,projection:p.projection,sheet_id:p.sheet_id,sheet_name:p.sheet_name,source_version:p.source_version,source_digest:p.source_digest,operation_token:p.operation_token,...(w?{cancel_operation_token:w.operation_token,cancel_preimage_digest:w.preimage_digest}:{})};}).sort((a,b)=>a.projection.localeCompare(b.projection)||a.entity_id.localeCompare(b.entity_id));
  if(JSON.stringify(manifest)!==proof.journal_manifest||proof.operation_kind==='CONFIRM'&&writes.length||proof.operation_kind==='CANCEL'&&writes.length!==projections.length)return null;
  return {projections,writes};
 };
 try{
  const journals=await readJournals();if(!journals||!await reviewedNoticeMatches(env,token,proof.notice_stamp,proof.notice_identity,noticeMode,policy,'HANDOFF'))return false;
  if(proof.operation_kind==='CONFIRM'){
   const source=await readFinalHandoffExpenseSource(env,job,token);if(!source||source.digest!==proof.source_digest)return false;
   await verifyStableExpenseProjections(env,job,source,journals.projections,undefined,policy);
   const latest=await readFinalHandoffExpenseSource(env,job,token);if(!latest||latest.digest!==source.digest||latest.revision!==source.revision||latest.fingerprint!==source.fingerprint)return false;
  }else{
   const source=await readCancelledExpenseSource(env,job,token,undefined,'HANDOFF');if(!source||source.digest!==proof.source_digest)return false;
   const row=await db.prepare("SELECT updated_at FROM expense_events WHERE expense_id=? AND version=? AND status='CANCELLED'").bind(job.entityKey,job.entityVersion).first<{updated_at:string}>();if(!row||typeof row.updated_at!=='string')return false;
   await verifyStableCancellationFinal(env,job,journals.projections,journals.writes,row.updated_at,token,undefined,policy);
   const latest=await readCancelledExpenseSource(env,job,token,undefined,'HANDOFF');if(!latest||latest.digest!==source.digest||latest.revision!==source.revision)return false;
  }
  return env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&!!await readJournals()&&await reviewedNoticeMatches(env,token,proof.notice_stamp,proof.notice_identity,noticeMode,policy,'HANDOFF');
 }catch(error){throw error;}
}
