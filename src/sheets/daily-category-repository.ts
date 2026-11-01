import type {Env} from "../types";
import {expenseCategories} from "../expense/document";
import {randomId} from "../shared/ids";
import {activeOwnerSql,type OwnerReviewIdentity} from "../expense/online-order-review-repository";

export interface VerifiedCategoryRow {
  expenseId:string; rowNumber:number; metadataId:number; fingerprint:string; category:string; expenseVersion:number;
}

/** Caller proves the metadata ID targets the matching raw or primary-item row. */
export async function registerDailyCategoryProjectionTarget(env:Env,input:{expenseId:string;targetType:"RAW"|"ITEM";itemId:string;metadataId:number;expenseVersion:number}):Promise<boolean>{
  if(!input.expenseId||!Number.isSafeInteger(input.metadataId)||input.metadataId<1||!Number.isSafeInteger(input.expenseVersion)||input.expenseVersion<1||!(input.targetType==="RAW"&&input.itemId===""||input.targetType==="ITEM"&&input.itemId!==""))return false;
  const result=await env.DB.prepare(`INSERT INTO daily_category_projection_targets(expense_id,target_type,item_id,metadata_id)
    SELECT e.expense_id,?,?,? FROM expense_events e WHERE e.expense_id=? AND e.status='CONFIRMED' AND e.version=?
      AND (?='RAW' OR EXISTS(SELECT 1 FROM expense_document_items i JOIN expense_document_links l ON l.document_id=i.document_id AND l.expense_id=i.expense_id
        WHERE i.expense_id=e.expense_id AND i.item_id=? AND l.relation_type='PRIMARY_PURCHASE_DOCUMENT'))
      AND NOT EXISTS(SELECT 1 FROM daily_category_requests r WHERE r.expense_id=e.expense_id AND r.status='PENDING')
    ON CONFLICT DO NOTHING`).bind(input.targetType,input.itemId,input.metadataId,input.expenseId,input.expenseVersion,input.targetType,input.itemId).run();
  return Number(result.meta.changes||0)===1;
}

/** Caller must first prove the row matches exactly one current expense. */
export async function seedDailyCategoryBaseline(env:Env,row:VerifiedCategoryRow):Promise<boolean>{
  if(!row.expenseId||!row.fingerprint||!Number.isSafeInteger(row.rowNumber)||row.rowNumber<1||!Number.isSafeInteger(row.metadataId)||row.metadataId<1||!expenseCategories.has(row.category)||!Number.isSafeInteger(row.expenseVersion)||row.expenseVersion<1)return false;
  const now=new Date().toISOString();
  const result=await env.DB.prepare(`INSERT INTO daily_category_baselines(expense_id,row_number,metadata_id,category,expense_version,fingerprint,updated_at)
    SELECT expense_id,?,?,?,?,?,? FROM expense_events WHERE expense_id=? AND status='CONFIRMED' AND category=? AND version=?
    ON CONFLICT DO NOTHING`).bind(row.rowNumber,row.metadataId,row.category,row.expenseVersion,row.fingerprint,now,row.expenseId,row.category,row.expenseVersion).run();
  return Number(result.meta.changes||0)===1;
}

/** Accept a moved row only after metadata and the complete identity were reverified. */
export async function refreshDailyCategoryBaselineRow(env:Env,row:VerifiedCategoryRow):Promise<boolean>{
  if(!row.expenseId||!row.fingerprint||!Number.isSafeInteger(row.rowNumber)||row.rowNumber<1||!Number.isSafeInteger(row.metadataId)||row.metadataId<1||!expenseCategories.has(row.category)||!Number.isSafeInteger(row.expenseVersion)||row.expenseVersion<1)return false;
  const result=await env.DB.prepare(`UPDATE daily_category_baselines SET row_number=?,updated_at=?
    WHERE expense_id=? AND metadata_id=? AND fingerprint=? AND category=? AND expense_version=?
      AND EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=daily_category_baselines.expense_id AND e.status='CONFIRMED' AND e.category=? AND e.version=?)
      AND NOT EXISTS(SELECT 1 FROM daily_category_requests r WHERE r.expense_id=daily_category_baselines.expense_id AND r.status='PENDING')`)
    .bind(row.rowNumber,new Date().toISOString(),row.expenseId,row.metadataId,row.fingerprint,row.category,row.expenseVersion,row.category,row.expenseVersion).run();
  return Number(result.meta.changes||0)===1;
}

/** A requested value is persisted for owner review; this does not change an expense. */
export async function requestDailyCategoryChange(env:Env,row:VerifiedCategoryRow,toCategory:string):Promise<string|null>{
  const to=toCategory.trim();
  if(!row.expenseId||!row.fingerprint||!Number.isSafeInteger(row.rowNumber)||row.rowNumber<1||!Number.isSafeInteger(row.metadataId)||row.metadataId<1||!expenseCategories.has(row.category)||!expenseCategories.has(to)||to===row.category||!Number.isSafeInteger(row.expenseVersion)||row.expenseVersion<1)return null;
  const now=new Date().toISOString(),id=randomId("category_request");
  const result=await env.DB.prepare(`INSERT INTO daily_category_requests(request_id,expense_id,row_number,metadata_id,from_category,to_category,expense_version,fingerprint,status,created_at,updated_at)
    SELECT ?,e.expense_id,?,?,?,?,e.version,?,'PENDING',?,? FROM expense_events e
      JOIN daily_category_baselines b ON b.expense_id=e.expense_id
    WHERE e.expense_id=? AND e.status='CONFIRMED' AND e.category=? AND e.version=?
      AND b.category=e.category AND b.expense_version=e.version AND b.row_number=? AND b.metadata_id=? AND b.fingerprint=?
      AND NOT EXISTS(SELECT 1 FROM daily_category_rejections x WHERE x.expense_id=e.expense_id AND x.expense_version=e.version AND x.rejected_category=?)
    ON CONFLICT DO NOTHING`).bind(id,row.rowNumber,row.metadataId,row.category,to,row.fingerprint,now,now,row.expenseId,row.category,row.expenseVersion,row.rowNumber,row.metadataId,row.fingerprint,to).run();
  return Number(result.meta.changes||0)===1?id:null;
}

/** Clear rejection suppression only after the verified sheet returns to baseline. */
export async function clearDailyCategoryRejection(env:Env,row:VerifiedCategoryRow):Promise<void>{
  await env.DB.prepare(`DELETE FROM daily_category_rejections WHERE expense_id=? AND expense_version=? AND EXISTS(SELECT 1 FROM daily_category_baselines b
    JOIN expense_events e ON e.expense_id=b.expense_id WHERE b.expense_id=daily_category_rejections.expense_id AND b.row_number=? AND b.metadata_id=? AND b.fingerprint=?
      AND b.category=? AND b.expense_version=? AND e.category=b.category AND e.version=b.expense_version AND e.status='CONFIRMED')`)
    .bind(row.expenseId,row.expenseVersion,row.rowNumber,row.metadataId,row.fingerprint,row.category,row.expenseVersion).run();
}

export async function rejectDailyCategoryChange(env:Env,input:{requestId:string;row:VerifiedCategoryRow;toCategory:string;owner:OwnerReviewIdentity}):Promise<boolean>{
  const {row,owner}=input,to=input.toCategory.trim();if(!input.requestId||!row.expenseId||!row.fingerprint||!owner.employeeId||!owner.lineUserId||!expenseCategories.has(row.category)||!expenseCategories.has(to)||to===row.category)return false;
  const now=new Date().toISOString(),auditId=randomId("category_reject");
  const statements=[
    env.DB.prepare(`INSERT INTO expense_audit_log(audit_id,actor_employee_id,action,expense_id,branch_id,reason,before_json,after_json,created_at)
      SELECT ?,?,'REVIEW_REJECT',e.expense_id,e.branch_id,'Owner rejected Sheet category request',json_object('category',r.from_category,'version',r.expense_version,'requestId',r.request_id),json_object('requestedCategory',r.to_category,'status','REJECTED'),?
      FROM daily_category_requests r JOIN expense_events e ON e.expense_id=r.expense_id JOIN daily_category_baselines b ON b.expense_id=e.expense_id
      WHERE r.request_id=? AND r.expense_id=? AND r.status='PENDING' AND r.row_number=? AND r.metadata_id=? AND r.fingerprint=? AND r.from_category=? AND r.to_category=? AND r.expense_version=?
        AND e.status='CONFIRMED' AND e.category=r.from_category AND e.version=r.expense_version
        AND b.row_number=r.row_number AND b.metadata_id=r.metadata_id AND b.fingerprint=r.fingerprint AND b.category=e.category AND b.expense_version=e.version
        AND ${activeOwnerSql}`).bind(auditId,owner.employeeId,now,input.requestId,row.expenseId,row.rowNumber,row.metadataId,row.fingerprint,row.category,to,row.expenseVersion,owner.employeeId,owner.lineUserId),
    env.DB.prepare(`UPDATE daily_category_requests SET status='REJECTED',reviewed_by_employee_id=?,reviewed_at=?,updated_at=? WHERE request_id=? AND status='PENDING'
      AND EXISTS(SELECT 1 FROM expense_audit_log a WHERE a.audit_id=? AND a.expense_id=daily_category_requests.expense_id AND a.actor_employee_id=?)`).bind(owner.employeeId,now,now,input.requestId,auditId,owner.employeeId),
    env.DB.prepare(`INSERT INTO daily_category_rejections(expense_id,rejected_category,expense_version,request_id,created_at)
      SELECT expense_id,to_category,expense_version,request_id,? FROM daily_category_requests r WHERE request_id=? AND status='REJECTED'
        AND EXISTS(SELECT 1 FROM expense_audit_log a WHERE a.audit_id=? AND a.expense_id=r.expense_id)
      ON CONFLICT(expense_id) DO UPDATE SET rejected_category=excluded.rejected_category,expense_version=excluded.expense_version,request_id=excluded.request_id,created_at=excluded.created_at`).bind(now,input.requestId,auditId)
  ];
  const result=await env.DB.batch(statements);return Number(result[1]?.meta.changes||0)===1;
}

/**
 * Apply exactly the version the owner reviewed. The caller must re-read the
 * entire relevant Sheet and prove identity, fingerprint and selected category
 * immediately before calling this function. The audit and durable projection
 * outbox commit with the business change; no LINE message or Sheet write is
 * sent by this transaction.
 */
export async function approveDailyCategoryChange(env:Env,input:{requestId:string;row:VerifiedCategoryRow;observedCategory:string;owner:OwnerReviewIdentity;traceId:string}):Promise<number|null>{
  const {row,owner}=input,to=input.observedCategory.trim();
  if(env.SHEETS_SYNC_ENABLED!=="true"||!input.requestId||!row.expenseId||!row.fingerprint||!owner.employeeId||!owner.lineUserId||!input.traceId||!expenseCategories.has(to)||!expenseCategories.has(row.category)||to===row.category||!Number.isSafeInteger(row.rowNumber)||row.rowNumber<1||!Number.isSafeInteger(row.metadataId)||row.metadataId<1||!Number.isSafeInteger(row.expenseVersion)||row.expenseVersion<1)return null;
  const now=new Date().toISOString(),auditId=randomId("category_audit"),jobId=randomId("category_sync");
  const statements=[
    env.DB.prepare(`INSERT INTO expense_audit_log(audit_id,actor_employee_id,action,expense_id,branch_id,reason,before_json,after_json,created_at)
      SELECT ?,?,'EDIT',e.expense_id,e.branch_id,'Owner approved Sheet category request',
        json_object('category',e.category,'version',e.version,'requestId',r.request_id),
        json_object('category',r.to_category,'version',MAX(e.version,COALESCE((SELECT MAX(entity_version) FROM sync_jobs WHERE entity_key=e.expense_id AND entity_type IN ('EXPENSE','EXPENSE_CATEGORY')),0))+1,'requestId',r.request_id),?
      FROM daily_category_requests r JOIN expense_events e ON e.expense_id=r.expense_id
        JOIN daily_category_baselines b ON b.expense_id=e.expense_id
      WHERE r.request_id=? AND r.status='PENDING' AND r.expense_id=? AND r.row_number=? AND r.metadata_id=? AND r.fingerprint=?
        AND r.from_category=? AND r.to_category=? AND r.expense_version=?
        AND e.status='CONFIRMED' AND e.category=r.from_category AND e.version=r.expense_version
        AND b.row_number=r.row_number AND b.metadata_id=r.metadata_id AND b.fingerprint=r.fingerprint AND b.category=e.category AND b.expense_version=e.version
        AND EXISTS(SELECT 1 FROM daily_category_projection_targets t WHERE t.expense_id=e.expense_id AND t.target_type='RAW' AND t.item_id='')
        AND NOT EXISTS(SELECT 1 FROM expense_document_items i WHERE i.expense_id=e.expense_id AND i.document_id=(SELECT d.document_id FROM expense_document_links l JOIN expense_documents d ON d.document_id=l.document_id WHERE l.expense_id=e.expense_id AND l.relation_type='PRIMARY_PURCHASE_DOCUMENT' ORDER BY l.created_at LIMIT 1)
          AND NOT EXISTS(SELECT 1 FROM daily_category_projection_targets t WHERE t.expense_id=e.expense_id AND t.target_type='ITEM' AND t.item_id=i.item_id))
        AND NOT EXISTS(SELECT 1 FROM daily_category_projection_targets t WHERE t.expense_id=e.expense_id AND t.target_type='ITEM'
          AND NOT EXISTS(SELECT 1 FROM expense_document_items i WHERE i.expense_id=e.expense_id AND i.item_id=t.item_id AND i.document_id=(SELECT d.document_id FROM expense_document_links l JOIN expense_documents d ON d.document_id=l.document_id WHERE l.expense_id=e.expense_id AND l.relation_type='PRIMARY_PURCHASE_DOCUMENT' ORDER BY l.created_at LIMIT 1)))
        AND e.version BETWEEN 1 AND 9007199254740990
        AND NOT EXISTS(SELECT 1 FROM sync_jobs s WHERE s.entity_key=e.expense_id AND s.entity_type IN ('EXPENSE','EXPENSE_CATEGORY') AND s.status<>'COMPLETED')
        AND NOT EXISTS(SELECT 1 FROM sync_jobs s WHERE s.entity_key=e.expense_id AND s.entity_type IN ('EXPENSE','EXPENSE_CATEGORY') AND s.entity_version>=9007199254740990)
        AND ${activeOwnerSql}`).bind(auditId,owner.employeeId,now,input.requestId,row.expenseId,row.rowNumber,row.metadataId,row.fingerprint,row.category,to,row.expenseVersion,owner.employeeId,owner.lineUserId),
    env.DB.prepare(`UPDATE expense_events SET category=?,version=(SELECT json_extract(after_json,'$.version') FROM expense_audit_log WHERE audit_id=?),updated_at=?
      WHERE expense_id=? AND category=? AND version=? AND status='CONFIRMED'
        AND EXISTS(SELECT 1 FROM expense_audit_log a WHERE a.audit_id=? AND a.expense_id=expense_events.expense_id AND a.actor_employee_id=?)`)
      .bind(to,auditId,now,row.expenseId,row.category,row.expenseVersion,auditId,owner.employeeId),
    env.DB.prepare(`UPDATE daily_category_requests SET status='APPROVED',reviewed_by_employee_id=?,reviewed_at=?,updated_at=?
      WHERE request_id=? AND status='PENDING' AND EXISTS(SELECT 1 FROM expense_events e JOIN expense_audit_log a ON a.expense_id=e.expense_id
        WHERE a.audit_id=? AND e.expense_id=daily_category_requests.expense_id AND e.version=json_extract(a.after_json,'$.version') AND e.category=?)`)
      .bind(owner.employeeId,now,now,input.requestId,auditId,to),
    env.DB.prepare(`UPDATE daily_category_baselines SET category=?,expense_version=(SELECT json_extract(after_json,'$.version') FROM expense_audit_log WHERE audit_id=?),updated_at=?
      WHERE expense_id=? AND EXISTS(SELECT 1 FROM daily_category_requests r JOIN expense_audit_log a ON a.expense_id=r.expense_id
        WHERE r.request_id=? AND r.expense_id=daily_category_baselines.expense_id AND r.status='APPROVED' AND a.audit_id=?)`)
      .bind(to,auditId,now,row.expenseId,input.requestId,auditId),
    env.DB.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token)
      SELECT ?,'EXPENSE_CATEGORY',e.expense_id,e.version,?,'PENDING',0,?,?,NULL,NULL FROM expense_events e
      JOIN daily_category_requests r ON r.expense_id=e.expense_id JOIN expense_audit_log a ON a.expense_id=e.expense_id
      WHERE r.request_id=? AND r.status='APPROVED' AND a.audit_id=? AND e.version=json_extract(a.after_json,'$.version') AND e.category=?`)
      .bind(jobId,input.traceId,now,now,input.requestId,auditId,to),
    env.DB.prepare(`SELECT e.version FROM expense_events e JOIN expense_audit_log a ON a.expense_id=e.expense_id
      JOIN daily_category_requests r ON r.expense_id=e.expense_id WHERE a.audit_id=? AND r.request_id=? AND r.status='APPROVED'
      AND e.version=json_extract(a.after_json,'$.version') AND e.category=?`).bind(auditId,input.requestId,to)
  ];
  const result=await env.DB.batch<{version:number}>(statements);
  if(Number(result[1]?.meta.changes||0)!==1)return null;
  const version=Number(result[5]?.results?.[0]?.version);
  if(!Number.isSafeInteger(version)||version<2||Number(result[4]?.meta.changes||0)!==1)throw new Error("CATEGORY_APPROVAL_OUTBOX_INCOMPLETE");
  return version;
}
