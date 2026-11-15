import type {Env,SheetsSyncJob} from '../types';
import {stableSourceIntegrity} from './stable-source-cutover';
import {reviewedClaimState,reviewedJobState,type NormalNoticeAuthority} from './normal-notice-authority';
import {cancelledFinancialFingerprint,cancelledJournalRevisionSnapshot,cancelledPriorMarker,cancelledPriorMarkerSnapshot,cancelledProjectionSnapshot} from './cancelled-financial-fingerprint';

/** Read-only source evidence for one exact publication intent in REVIEW.
 * It does not admit a job, verify the notice, change a claim or permit a
 * Sheets POST. The caller must recheck the full result and live provider
 * postimage before committing the immutable intent. */
export async function readReviewedPublicationSource(env:Env,job:SheetsSyncJob,claim:string,transitionId:string,target:{sheetId:number;sheetName:string;row:number},authority:NormalNoticeAuthority='REVIEW'):Promise<{revision:number;digest:string;kind:'STAGE'|'PUBLISH'|'REVOKE';noticeStamp:string;noticeIdentity:string}|null>{
 return readPublicationSource(env,job,claim,transitionId,target,authority,false);
}
/** Read-only, exact expired REVOKE candidate; this is not write authority. */
export async function readExpiredRevokeSource(env:Env,job:SheetsSyncJob,claim:string,transitionId:string,target:{sheetId:number;sheetName:string;row:number}):Promise<{revision:number;digest:string;kind:'STAGE'|'PUBLISH'|'REVOKE';noticeStamp:string;noticeIdentity:string}|null>{
 if(env.CONTINUOUS_EXPIRED_REVOKE_PHASE_ENABLED!=='true')return null;
 return readPublicationSource(env,job,claim,transitionId,target,'REVIEW',true);
}
async function readPublicationSource(env:Env,job:SheetsSyncJob,claim:string,transitionId:string,target:{sheetId:number;sheetName:string;row:number},authority:NormalNoticeAuthority,expired:boolean):Promise<{revision:number;digest:string;kind:'STAGE'|'PUBLISH'|'REVOKE';noticeStamp:string;noticeIdentity:string}|null>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 if(!book||!claim||!transitionId||!['REVIEW','HANDOFF'].includes(authority)||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(job.entityKey)||!Number.isSafeInteger(job.entityVersion)||job.entityVersion<1||!Number.isSafeInteger(target.sheetId)||target.sheetId<0||!target.sheetName||!Number.isSafeInteger(target.row)||target.row<2||target.row>5000)return null;
 const docs="SELECT d.document_id FROM expense_documents d WHERE d.expense_id=? OR d.document_id IN (SELECT l.document_id FROM expense_document_links l WHERE l.expense_id=?)";
 try{
  const meta=await db.prepare(`SELECT i.kind FROM continuous_publication_intents i WHERE i.transition_id=? AND i.spreadsheet_id=? AND i.entity_id=? AND i.source_version=? AND i.claim_token=? AND i.sheet_id=? AND i.sheet_name=? AND i.row_number=? AND i.state IN ('IN_FLIGHT','VERIFIED')`).bind(transitionId,book,job.entityKey,job.entityVersion,claim,target.sheetId,target.sheetName,target.row).first<{kind:string}>();
  if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||!meta||!['STAGE','PUBLISH','REVOKE'].includes(meta.kind)||expired&&meta.kind!=='REVOKE')return null;
  const cancel=meta.kind==='REVOKE';
  const claimGuard=expired?"c.state='REVIEW' AND c.phase IS NULL AND c.review_reason='CONTINUOUS_SYNC_LEASE_EXPIRED_UNCERTAIN'":reviewedClaimState('c',authority);
  const jobGuard=expired?"j.status='REVIEW' AND j.last_error='CONTINUOUS_SYNC_LEASE_EXPIRED_UNCERTAIN' AND j.lease_token=i.lease_token AND j.lease_until IS NOT NULL AND j.lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND epoch.state='REVIEW'":reviewedJobState('j',authority);
  const financial=cancel&&env.CONTINUOUS_CANCEL_FINANCIAL_FINGERPRINT_ENABLED==='true';
  const expenseStatement=db.prepare(`SELECT e.*,r.revision AS __stable_revision,i.source_digest AS __intent_digest,c.notice_stamp AS __notice_stamp,c.notice_identity AS __notice_identity FROM expense_events e CROSS JOIN stable_source_revision r JOIN continuous_publication_intents i ON i.entity_id=e.expense_id AND i.source_version=e.version JOIN stable_workbook_claims c ON c.spreadsheet_id=i.spreadsheet_id AND c.operation_token=i.claim_token JOIN stable_recovery_epochs epoch ON epoch.spreadsheet_id=c.spreadsheet_id AND epoch.target_type='EXPENSE' AND epoch.target_key=e.expense_id AND epoch.target_version=e.version AND epoch.state IN ('ARMED','REVIEW') JOIN stable_recovery_operations op ON op.epoch_id=epoch.epoch_id AND op.operation_token=c.operation_token AND op.state='ADMITTED' JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version WHERE r.singleton=1 AND ${stableSourceIntegrity} AND e.expense_id=? AND e.version=? AND e.status=? AND i.transition_id=? AND i.spreadsheet_id=? AND i.claim_token=? AND i.sheet_id=? AND i.sheet_name=? AND i.row_number=? AND i.kind=? AND i.state IN ('IN_FLIGHT','VERIFIED') AND ${claimGuard} AND ${jobGuard} AND length(c.notice_stamp)>0 AND length(c.notice_identity)>0 ${authority==='HANDOFF'?"AND i.state='VERIFIED' AND EXISTS(SELECT 1 FROM continuous_normal_notice_handoffs h WHERE h.spreadsheet_id=i.spreadsheet_id AND h.operation_token=i.claim_token AND h.expense_id=i.entity_id AND h.source_version=i.source_version AND h.projection='PUBLICATION' AND h.journal_entity=i.transition_id AND h.operation_kind=CASE i.kind WHEN 'REVOKE' THEN 'CANCEL' ELSE 'CONFIRM' END)":''}`).bind(job.entityKey,job.entityVersion,cancel?'CANCELLED':'CONFIRMED',transitionId,book,claim,target.sheetId,target.sheetName,target.row,meta.kind);
  const statements=financial?[expenseStatement,cancelledProjectionSnapshot(env,job),cancelledPriorMarkerSnapshot(env,job),cancelledJournalRevisionSnapshot(env)]:[
   expenseStatement,
   db.prepare('SELECT * FROM expense_document_links WHERE expense_id=? ORDER BY link_id').bind(job.entityKey),
   db.prepare(`SELECT * FROM expense_documents WHERE ${cancel?`document_id IN (${docs})`:'expense_id=? OR document_id IN (SELECT document_id FROM expense_document_links WHERE expense_id=?)'} ORDER BY document_id`).bind(job.entityKey,job.entityKey),
   cancel?db.prepare(`SELECT * FROM expense_document_items WHERE expense_id=? OR document_id IN (${docs}) ORDER BY item_id`).bind(job.entityKey,job.entityKey,job.entityKey):db.prepare('SELECT * FROM expense_document_items WHERE expense_id=? ORDER BY created_at,item_id').bind(job.entityKey)
  ];
  const result=await db.batch(statements);
  if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||result.length!==4||result.some(r=>r.success!==true||!Array.isArray(r.results))||result[0]!.results!.length!==1)return null;
  const {__stable_revision:revision,__intent_digest:intentDigest,__notice_stamp:noticeStamp,__notice_identity:noticeIdentity,...expense}=result[0]!.results![0] as Record<string,unknown>;
  if(financial){const priorRows=result[2]!.results!,revisions=result[3]!.results!,prior=priorRows.length===1?cancelledPriorMarker(job,priorRows[0] as Record<string,unknown>):null,journalRevision=(revisions[0] as {revision?:unknown}|undefined)?.revision;if(!prior||revisions.length!==1||!Number.isSafeInteger(revision)||Number(revision)<0||!Number.isSafeInteger(journalRevision)||Number(journalRevision)<0||typeof intentDigest!=='string'||typeof noticeStamp!=='string'||!noticeStamp||typeof noticeIdentity!=='string'||!noticeIdentity||env.CONTINUOUS_CANCEL_FINANCIAL_FINGERPRINT_ENABLED!=='true')return null;const digest=await cancelledFinancialFingerprint(job,expense,result[1]!.results as Record<string,unknown>[],prior);return digest===intentDigest?{revision:Number(revision),digest,kind:'REVOKE',noticeStamp,noticeIdentity}:null;}
  const links=result[1]!.results!,documents=result[2]!.results!,items=result[3]!.results!;
  if(!Number.isSafeInteger(revision)||Number(revision)<0||typeof intentDigest!=='string'||typeof noticeStamp!=='string'||!noticeStamp||typeof noticeIdentity!=='string'||!noticeIdentity||links.length>500||documents.length>500||items.length>500)return null;
  const bytes=new TextEncoder().encode(JSON.stringify({expense,links,documents,items}));if(bytes.byteLength>256000)return null;
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
  if(digest!==intentDigest)return null;
  return{revision:Number(revision),digest,kind:meta.kind as 'STAGE'|'PUBLISH'|'REVOKE',noticeStamp,noticeIdentity};
 }catch(error){if(authority==='HANDOFF')throw error;return null;}
}
