import type {Env,SheetsSyncJob} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,continuousSheetsReadPolicy,getSheetGridInfo} from './client';
import {decodePublicationCarrier,verifyPublicationColumn} from './continuous-publication-template';
import {resolvePublicationTarget} from './continuous-publication-route';
import {readExpiredRevokeSource} from './continuous-publication-reviewed-source';
import {stableNoticePaused} from './stable-edit-notice';
import {ReviewRequestBudget} from './review-request-budget';
import {stableSourceIntegrity} from './stable-source-cutover';
import {continuousDailyCutoverIntegrity} from './continuous-daily-cutover';

/** Positive-only phase repair. It sends no Sheets POST, does not rearm the
 * epoch, does not resume work, and cannot fence a noncooperating writer. */
export async function authorizeExpiredRevokeReviewPhase(env:Env,job:SheetsSyncJob,claim:string,transitionId:string,budget:ReviewRequestBudget):Promise<boolean>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 if(env.CONTINUOUS_EXPIRED_REVOKE_PHASE_ENABLED!=='true'||env.CONTINUOUS_REVOKE_REVIEW_CLOSE_ENABLED!=='true'||!(budget instanceof ReviewRequestBudget)||!book||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(job.entityKey)||!Number.isSafeInteger(job.entityVersion)||job.entityVersion<2||!claim||!transitionId)return false;
 const scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.CONTINUOUS_EXPIRED_REVOKE_PHASE_ENABLED,env.CONTINUOUS_REVOKE_REVIEW_CLOSE_ENABLED,env.CONTINUOUS_CANCEL_FINANCIAL_FINGERPRINT_ENABLED,env.CONTINUOUS_PUBLICATION_ENABLED,env.CONTINUOUS_PUBLICATION_SHEET,env.CONTINUOUS_PUBLICATION_SHEET_ID,env.CONTINUOUS_PUBLICATION_ROWS,job.kind,job.entityType,job.entityKey,job.entityVersion,claim,transitionId]);
 const initial=scope(),stable=()=>env.DB===db&&scope()===initial;
 const integrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_expired_revoke_phase_evidence' AND name IN ('continuous_expired_revoke_phase_evidence_insert','continuous_expired_revoke_phase_evidence_no_update','continuous_expired_revoke_phase_evidence_no_delete','continuous_expired_revoke_phase_evidence_no_replace'))=4";
 const retained=async()=>{const row=await db.prepare(`SELECT 1 AS ok FROM continuous_expired_revoke_phase_evidence p JOIN stable_workbook_claims c ON c.spreadsheet_id=p.spreadsheet_id AND c.operation_token=p.operation_token JOIN stable_recovery_epochs e ON e.epoch_id=p.epoch_id AND e.spreadsheet_id=p.spreadsheet_id JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id AND o.operation_token=c.operation_token JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=p.expense_id AND j.entity_version=p.source_version WHERE p.operation_token=? AND p.spreadsheet_id=? AND p.transition_id=? AND p.expense_id=? AND p.source_version=? AND c.state='REVIEW' AND c.phase='OPERATION' AND c.review_reason='CONTINUOUS_SYNC_LEASE_EXPIRED_UNCERTAIN' AND c.notice_stamp=p.notice_stamp AND c.notice_identity=p.notice_identity AND e.state IN ('REVIEW','ARMED') AND e.target_key=p.expense_id AND e.target_version=p.source_version AND o.state='ADMITTED' AND j.status='REVIEW' AND j.last_error='CONTINUOUS_SYNC_LEASE_EXPIRED_UNCERTAIN' AND ${integrity}`).bind(claim,book,transitionId,job.entityKey,job.entityVersion).first<{ok:number}>();return stable()&&row?.ok===1;};
 if(await retained())return true;
 const intent=await db.prepare(`SELECT i.sheet_id,i.sheet_name,i.row_number,i.after_value,e.epoch_id FROM continuous_publication_intents i JOIN stable_recovery_epochs e ON e.spreadsheet_id=i.spreadsheet_id AND e.target_type='EXPENSE' AND e.target_key=i.entity_id AND e.target_version=i.source_version AND e.state='REVIEW' WHERE i.transition_id=? AND i.spreadsheet_id=? AND i.entity_id=? AND i.source_version=? AND i.claim_token=? AND i.kind='REVOKE' AND i.state='IN_FLIGHT'`).bind(transitionId,book,job.entityKey,job.entityVersion,claim).first<{sheet_id:number;sheet_name:string;row_number:number;after_value:string;epoch_id:string}>();
 const marker=decodePublicationCarrier(intent?.after_value),target=await resolvePublicationTarget(env);
 if(!stable()||!intent||!marker||!target||intent.sheet_id!==target.sheetId||intent.sheet_name!==target.sheetName||intent.row_number<2||intent.row_number>target.rows||marker.expenseId!==job.entityKey||marker.version!==job.entityVersion||marker.state!=='REVOKED')return false;
 const loc={sheetId:intent.sheet_id,sheetName:intent.sheet_name,row:intent.row_number},source=await readExpiredRevokeSource(env,job,claim,transitionId,loc);
 if(!source||source.kind!=='REVOKE'||!stable())return false;
 const policy={...continuousSheetsReadPolicy,budget},grid=await getSheetGridInfo(env,target.sheetName,policy);if(!stable()||grid.sheetId!==target.sheetId||grid.rowCount!==target.rows||grid.columnCount<1||grid.columnCount>100)return false;
 const range=`'${target.sheetName.replace(/'/g,"''")}'!A1:A${target.rows}`,formula=await batchGetSheetFormulaValues(env,[range],policy),effective=await batchGetSheetEffectiveSerialValues(env,[range],policy),lastGrid=await getSheetGridInfo(env,target.sheetName,policy);
 if(!stable()||JSON.stringify(grid)!==JSON.stringify(lastGrid)||formula.length!==1||effective.length!==1||!verifyPublicationColumn(formula[0]!,effective[0]!,target.rows,marker,intent.row_number)||!await stableNoticePaused(env,source.noticeStamp,source.noticeIdentity,budget,undefined,true))return false;
 const again=await readExpiredRevokeSource(env,job,claim,transitionId,loc),targetAgain=await resolvePublicationTarget(env);
 if(!stable()||JSON.stringify(source)!==JSON.stringify(again)||JSON.stringify(target)!==JSON.stringify(targetAgain))return false;
 try{const result=await db.batch([
  db.prepare(`INSERT INTO continuous_expired_revoke_phase_evidence(operation_token,spreadsheet_id,epoch_id,transition_id,expense_id,source_version,source_revision,source_digest,notice_stamp,notice_identity,sheet_id,sheet_name,row_number,postimage,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${integrity}`).bind(claim,book,intent.epoch_id,transitionId,job.entityKey,job.entityVersion,source.revision,source.digest,source.noticeStamp,source.noticeIdentity,intent.sheet_id,intent.sheet_name,intent.row_number,intent.after_value),
  db.prepare(`UPDATE stable_workbook_claims SET phase='OPERATION',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='REVIEW' AND phase IS NULL AND review_reason='CONTINUOUS_SYNC_LEASE_EXPIRED_UNCERTAIN' AND notice_stamp=? AND notice_identity=? AND changes()=1 AND EXISTS(SELECT 1 FROM stable_source_revision WHERE singleton=1 AND revision=?) AND ${integrity}`).bind(book,claim,source.noticeStamp,source.noticeIdentity,source.revision),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);if(!stable()||result.length!==3||result.some(x=>x.success!==true)||result[0]!.meta?.changes!==1||result[1]!.meta?.changes!==1)return retained();}catch{return retained();}
 return retained();
}
