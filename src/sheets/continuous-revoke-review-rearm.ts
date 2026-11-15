import type {Env,SheetsSyncJob} from '../types';
import {ReviewRequestBudget} from './review-request-budget';
import {verifyPublicationHandoff} from './continuous-publication-handoff';

/** Positive-only rearm after the exact REVOKE provider postimage has been
 * recovered. This neither sends a Sheets mutation nor requeues work; caller
 * must close the notice using the ordinary guarded REVIEW lifecycle. */
export async function rearmReviewedRevokeEpoch(env:Env,job:SheetsSyncJob,claim:string,transitionId:string,budget:ReviewRequestBudget):Promise<boolean>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 if(env.CONTINUOUS_REVOKE_REVIEW_CLOSE_ENABLED!=='true'||!(budget instanceof ReviewRequestBudget)||!book||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(job.entityKey)||!Number.isSafeInteger(job.entityVersion)||job.entityVersion<2||!claim||!transitionId)return false;
 const scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.CONTINUOUS_CANCEL_FINANCIAL_FINGERPRINT_ENABLED,env.CONTINUOUS_REVOKE_REVIEW_CLOSE_ENABLED,env.CONTINUOUS_PUBLICATION_ENABLED,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID,job.kind,job.entityType,job.entityKey,job.entityVersion,claim,transitionId]),initial=scope(),stable=()=>env.DB===db&&scope()===initial;
 const query=()=>db.prepare(`SELECT e.epoch_id,e.state,i.source_digest,r.revision FROM stable_recovery_epochs e JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id AND o.operation_token=? AND o.state='ADMITTED' JOIN stable_workbook_claims c ON c.spreadsheet_id=e.spreadsheet_id AND c.operation_token=o.operation_token AND c.state='REVIEW' AND c.phase='OPERATION' JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.target_key AND j.entity_version=e.target_version AND j.status='REVIEW' AND (j.lease_token IS NULL AND j.lease_until IS NULL OR j.lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) JOIN continuous_publication_intents i ON i.transition_id=? AND i.spreadsheet_id=e.spreadsheet_id AND i.entity_id=e.target_key AND i.source_version=e.target_version AND i.claim_token=o.operation_token AND i.kind='REVOKE' AND i.state='VERIFIED' JOIN stable_source_revision r ON r.singleton=1 WHERE e.spreadsheet_id=? AND e.target_type='EXPENSE' AND e.target_key=? AND e.target_version=? AND e.state IN ('REVIEW','ARMED')`).bind(claim,transitionId,book,job.entityKey,job.entityVersion).first<{epoch_id:string;state:string;source_digest:string;revision:number}>();
 const first=await query();if(!first||!stable()||!Number.isSafeInteger(first.revision)||first.revision<0)return false;
 const retained=async()=>{const x=await db.prepare(`SELECT 1 AS ok FROM continuous_revoke_review_epoch_rearm p JOIN stable_recovery_epochs e ON e.epoch_id=p.epoch_id AND e.spreadsheet_id=p.spreadsheet_id JOIN stable_workbook_claims c ON c.spreadsheet_id=e.spreadsheet_id AND c.operation_token=p.operation_token WHERE p.epoch_id=? AND p.spreadsheet_id=? AND p.operation_token=? AND p.transition_id=? AND p.source_digest=? AND e.state='ARMED' AND e.target_key=? AND e.target_version=? AND c.state='REVIEW' AND c.phase='OPERATION'`).bind(first.epoch_id,book,claim,transitionId,first.source_digest,job.entityKey,job.entityVersion).first<{ok:number}>();return stable()&&x?.ok===1;};
 if(first.state==='ARMED')return retained();
 if(!await verifyPublicationHandoff(env,job,claim,transitionId,'PAUSED',{kind:'continuous-expense',budget},'REVIEW')||!stable())return false;
 const latest=await query();if(!latest||JSON.stringify(first)!==JSON.stringify(latest)||!stable())return false;
 try{
  const result=await db.batch([
   db.prepare(`INSERT INTO continuous_revoke_review_epoch_rearm(epoch_id,spreadsheet_id,operation_token,transition_id,source_revision,source_digest,created_at) VALUES(?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).bind(first.epoch_id,book,claim,transitionId,first.revision,first.source_digest),
   db.prepare(`UPDATE stable_recovery_epochs SET state='ARMED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE epoch_id=? AND spreadsheet_id=? AND state='REVIEW' AND changes()=1 AND EXISTS(SELECT 1 FROM stable_source_revision WHERE singleton=1 AND revision=?)`).bind(first.epoch_id,book,first.revision),
   db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
  ]);
  if(!stable()||result.length!==3||result.some(x=>x.success!==true)||result[0]!.meta?.changes!==1||result[1]!.meta?.changes!==1)return retained();
 }catch{return retained();}
 return retained();
}
