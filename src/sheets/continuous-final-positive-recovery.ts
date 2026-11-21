import type {Env,SheetsSyncJob} from '../types';
import type {ContinuousSheetsReadPolicy} from './client';
import {readFinalHandoffExpenseSource} from './stable-expense-source';
import {readCancelledExpenseSource} from './cancelled-expense-source';
import {verifyStableExpenseProjections} from './stable-expense-final-check';
import {verifyStableCancellationFinal,indexCancellationJournal,type CancelProjection,type CancelWrite} from './stable-cancellation-final-check';
import {reviewedNoticeMatches,type ReviewedNoticeMode} from './continuous-reviewed-notice';
import {resolvePublicationTarget} from './continuous-publication-route';
import {decodePublicationCarrier} from './continuous-publication-template';
import {readPublicationAccountingEvidence} from './publication-accounting-evidence';
import {planPublicationSnapshot} from './publication-snapshot-plan';
import {capturePublicationBatchSnapshot} from './publication-batch-snapshot';
import {getSpreadsheetSheetProperties} from './client';
import {ReviewRequestBudget} from './review-request-budget';

type Projection=CancelProjection&{operation_token:string};
type Proof={operation_kind:'CONFIRM'|'CANCEL';source_digest:string;journal_manifest:string;notice_stamp:string;notice_identity:string};
/** Re-read every FINAL source, journal, projection and report; no write and
 * no absence-based proof. Caller must perform its final guarded D1 commit. */
export async function verifyFinalHandoff(env:Env,job:SheetsSyncJob,token:string,noticeMode:ReviewedNoticeMode,policy:ContinuousSheetsReadPolicy):Promise<boolean>{
 // Until the publication writer, cancellation lifecycle and external fence are
 // proven, do not allow this prototype to authorize runtime notice closure.
 if(env.CONTINUOUS_PUBLICATION_ENABLED!==undefined&&env.CONTINUOUS_PUBLICATION_ENABLED!=='false')return false;
 return verifyFinalHandoffCandidate(env,job,token,noticeMode,policy);
}

/** Read-only candidate: never install as lifecycle authority before all
 * publication and provider-fence preconditions have been independently verified. */
export async function verifyFinalHandoffCandidate(env:Env,job:SheetsSyncJob,token:string,noticeMode:ReviewedNoticeMode,policy:ContinuousSheetsReadPolicy):Promise<boolean>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;if(!book||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!token)return false;
 // The provider snapshots and journal proof must all describe the same
 // publication mode, targets and job. In particular, switching the mode to
 // false while an async source read is in flight must not let FINAL finish
 // without validating the PUBLISHED/REVOKED marker.
 const publicationMode=env.CONTINUOUS_PUBLICATION_ENABLED,budget=policy.budget,oauthLease=policy.oauthLease,policyKind=policy.kind;
 if(publicationMode!==undefined&&publicationMode!=='false'&&publicationMode!=='true')return false;
 const scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.CONTINUOUS_PUBLICATION_ENABLED,env.CONTINUOUS_PUBLICATION_SHEET,env.CONTINUOUS_PUBLICATION_SHEET_ID,env.CONTINUOUS_PUBLICATION_ROWS,env.CONTINUOUS_DAILY_ENABLED,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID,env.SHEET_EXPENSE_DAILY,env.SHEET_EXPENSE_RAW,env.SHEET_PURCHASE_DETAILS,env.STABLE_PHASE1_ENABLED,env.APP_ENV,env.RUNTIME_MODE,job.kind,job.entityType,job.entityKey,job.entityVersion,token,noticeMode]);
 const initialScope=scope(),stable=()=>env.DB===db&&scope()===initialScope&&policy.budget===budget&&policy.oauthLease===oauthLease&&policy.kind===policyKind;
 const proof=await db.prepare(`SELECT z.operation_kind,z.source_digest,z.journal_manifest,c.notice_stamp,c.notice_identity FROM continuous_final_notice_evidence z JOIN continuous_normal_notice_handoffs h ON h.spreadsheet_id=z.spreadsheet_id AND h.operation_token=z.operation_token JOIN stable_workbook_claims c ON c.spreadsheet_id=h.spreadsheet_id AND c.operation_token=h.operation_token JOIN stable_recovery_epochs e ON e.epoch_id=z.epoch_id AND e.spreadsheet_id=z.spreadsheet_id JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id AND o.operation_token=z.operation_token JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=z.expense_id AND j.entity_version=z.source_version WHERE z.spreadsheet_id=? AND z.operation_token=? AND z.expense_id=? AND z.source_version=? AND h.projection='FINAL' AND h.expense_id=z.expense_id AND h.source_version=z.source_version AND h.operation_kind=z.operation_kind AND c.state='HELD' AND c.phase='END_NOTICE_PENDING' AND j.status='PENDING' AND j.lease_token IS NULL AND j.lease_until IS NULL AND e.state='ARMED' AND e.target_type='EXPENSE' AND e.target_key=z.expense_id AND e.target_version=z.source_version AND o.state='ADMITTED' AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_final_notice_evidence' AND name IN ('continuous_final_notice_evidence_insert','continuous_final_notice_evidence_no_update','continuous_final_notice_evidence_no_delete','continuous_final_notice_evidence_no_replace'))=4 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_normal_notice_handoffs' AND name IN ('continuous_normal_notice_handoff_insert','continuous_normal_notice_handoff_no_update','continuous_normal_notice_handoff_no_delete','continuous_normal_notice_handoff_no_replace'))=4`).bind(book,token,job.entityKey,job.entityVersion).first<Proof>();
 if(!proof||!proof.notice_stamp||!proof.notice_identity||!['CONFIRM','CANCEL'].includes(proof.operation_kind)||!/^[0-9a-f]{64}$/.test(proof.source_digest)||!stable())return false;
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
  const publication=publicationMode==='true'?await finalPublicationSnapshot(env,job,proof,policy):null;
  if(!stable()||publicationMode==='true'&&!publication)return false;
  let sourceStillMatches:()=>Promise<boolean>;
  if(proof.operation_kind==='CONFIRM'){
   const source=await readFinalHandoffExpenseSource(env,job,token);if(!source||source.digest!==proof.source_digest)return false;
   await verifyStableExpenseProjections(env,job,source,journals.projections,publication?{...publication.evidence,phase:'PUBLISHED'}:undefined,policy,publication?.snapshot);
   sourceStillMatches=async()=>{const latest=await readFinalHandoffExpenseSource(env,job,token);return !!latest&&latest.digest===source.digest&&latest.revision===source.revision&&latest.fingerprint===source.fingerprint;};
   if(!await sourceStillMatches())return false;
  }else{
   const source=await readCancelledExpenseSource(env,job,token,undefined,'HANDOFF');if(!source||source.digest!==proof.source_digest)return false;
   const row=await db.prepare("SELECT updated_at FROM expense_events WHERE expense_id=? AND version=? AND status='CANCELLED'").bind(job.entityKey,job.entityVersion).first<{updated_at:string}>();if(!row||typeof row.updated_at!=='string')return false;
   const after=publication?await capturePublicationBatchSnapshot(env,publication.specs,policy.budget!):undefined;
   if(publication&&JSON.stringify(publication.snapshot)!==JSON.stringify(after))return false;
   await verifyStableCancellationFinal(env,job,journals.projections,journals.writes,row.updated_at,token,publication?.evidence,policy,publication&&after?{before:publication.snapshot,after}:undefined);
   sourceStillMatches=async()=>{const latest=await readCancelledExpenseSource(env,job,token,undefined,'HANDOFF');return !!latest&&latest.digest===source.digest&&latest.revision===source.revision;};
   if(!await sourceStillMatches())return false;
  }
  if(publication){const after=await capturePublicationBatchSnapshot(env,publication.specs,policy.budget!);if(JSON.stringify(publication.snapshot)!==JSON.stringify(after)||!await finalPublicationSnapshot(env,job,proof,policy,after))return false;}
  if(!stable()||!await readJournals()||publication&&!await sourceStillMatches()||!await reviewedNoticeMatches(env,token,proof.notice_stamp,proof.notice_identity,noticeMode,policy,'HANDOFF'))return false;
  return stable();
 }catch(error){throw error;}
}

/** Verify the exact PUBLISHED/REVOKED marker as well as workbook images for
 * FINAL handoff; read-only and insufficient to fence external writers. */
async function finalPublicationSnapshot(env:Env,job:SheetsSyncJob,proof:Proof,policy:ContinuousSheetsReadPolicy,snapshot?:Awaited<ReturnType<typeof capturePublicationBatchSnapshot>>){
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,budget=policy.budget;if(!book||!(budget instanceof ReviewRequestBudget))return null;
 const target=await resolvePublicationTarget(env);if(!target)return null;
 const row=await db.prepare("SELECT m.marker,m.row_number FROM continuous_publication_markers m JOIN continuous_publication_intents i ON i.transition_id=m.transition_id AND i.spreadsheet_id=m.spreadsheet_id AND i.entity_id=m.entity_id AND i.source_version=m.version AND i.after_value=m.marker AND i.state='VERIFIED' WHERE m.spreadsheet_id=? AND m.entity_id=? AND m.sheet_id=? AND m.sheet_name=? AND m.version=? AND m.state=? AND i.kind=? AND i.source_digest=?").bind(book,job.entityKey,target.sheetId,target.sheetName,job.entityVersion,proof.operation_kind==='CONFIRM'?'PUBLISHED':'REVOKED',proof.operation_kind==='CONFIRM'?'PUBLISH':'REVOKE',proof.source_digest).first<{marker:string;row_number:number}>();
 const marker=decodePublicationCarrier(row?.marker);if(!row||!marker||marker.expenseId!==job.entityKey||marker.version!==job.entityVersion||marker.state!==(proof.operation_kind==='CONFIRM'?'PUBLISHED':'REVOKED')||env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book)return null;
 const metadata=snapshot?.metadata??await getSpreadsheetSheetProperties(env,policy),specs=await planPublicationSnapshot(env,metadata,target),image=snapshot??await capturePublicationBatchSnapshot(env,specs,budget);
 const evidence=await readPublicationAccountingEvidence(env,{sheet:target.sheetName,sheetId:target.sheetId,rows:target.rows,row:row.row_number,expected:marker,sourceDigest:proof.source_digest},policy,image);
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book)return null;return{snapshot:image,specs,evidence};
}
