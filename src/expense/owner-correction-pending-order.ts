import type {Env} from "../types";
import {randomId} from "../shared/ids";
import {activeOwnerSql,type OwnerReviewIdentity} from "./online-order-review-repository";
import {parseOwnerFacts} from "./online-order-review";
import type {OwnerCorrectionSnapshot} from "./owner-correction";

/** Preserve the original document link while proving any later re-attestation. */
export const pendingOrderApprovalLineage=`((json_extract(CASE WHEN json_valid(a.after_json) THEN a.after_json ELSE '{}' END,'$.correctionId') IS NULL AND l.linked_by_employee_id=a.actor_employee_id) OR EXISTS(
  SELECT 1 FROM expense_audit_log original JOIN expense_owner_corrections oc ON oc.correction_id=json_extract(CASE WHEN json_valid(a.after_json) THEN a.after_json ELSE '{}' END,'$.correctionId')
  WHERE original.audit_id=json_extract(CASE WHEN json_valid(a.after_json) THEN a.after_json ELSE '{}' END,'$.originalApprovalId')
    AND original.document_id=d.document_id AND original.action='REVIEW_APPROVE' AND original.actor_employee_id=l.linked_by_employee_id
    AND json_extract(CASE WHEN json_valid(original.after_json) THEN original.after_json ELSE '{}' END,'$.correctionId') IS NULL
    AND oc.status='APPLIED' AND oc.expense_id=e.expense_id AND oc.owner_employee_id=a.actor_employee_id
    AND json_extract(CASE WHEN json_valid(oc.before_json) THEN oc.before_json ELSE '{}' END,'$.status')='WAITING_CONFIRM'
    AND json_extract(CASE WHEN json_valid(oc.after_json) THEN oc.after_json ELSE '{}' END,'$.amountSatang')=json_extract(a.after_json,'$.amountSatang')
    AND json_extract(CASE WHEN json_valid(oc.after_json) THEN oc.after_json ELSE '{}' END,'$.transactionDate')=json_extract(a.after_json,'$.paymentDate')
    AND EXISTS(SELECT 1 FROM expense_audit_log edit WHERE edit.action='EDIT' AND edit.expense_id=e.expense_id AND edit.document_id=d.document_id AND edit.actor_employee_id=a.actor_employee_id
      AND json_extract(CASE WHEN json_valid(edit.after_json) THEN edit.after_json ELSE '{}' END,'$.correctionId')=oc.correction_id)
))`;

/** Re-attest only an intact, singly owned reviewed order; image evidence stays untouched. */
export async function commitPendingOrderCorrection(env:Env,owner:OwnerReviewIdentity,input:{id:string;field:"amountSatang"|"transactionDate";before:OwnerCorrectionSnapshot;after:OwnerCorrectionSnapshot;beforeJson:string;afterJson:string;nowMs:number}):Promise<"APPLIED"|"STALE"|"REVIEW">{
  const {id,field,before,after,beforeJson,afterJson,nowMs}=input,now=new Date(nowMs).toISOString(),next=before.version+1;
  const proof=await env.DB.prepare(`SELECT d.document_id,d.normalized_json,d.updated_at,d.ai_json,d.image_key,d.image_hash,d.final_paid_satang,d.paid_amount_satang,d.payment_date,d.payment_time,r.version AS review_version,r.owner_facts_json
    FROM expense_events e JOIN expense_documents d ON d.expense_id=e.expense_id AND d.document_type='ONLINE_ORDER' AND d.status='WAITING_CONFIRM'
    JOIN expense_document_reviews r ON r.document_id=d.document_id AND r.expense_id=e.expense_id AND r.phase='DRAFTED'
    JOIN expense_audit_log a ON a.audit_id=json_extract(CASE WHEN json_valid(d.normalized_json) THEN d.normalized_json ELSE '{}' END,'$.ownerPaymentReview.auditId') AND a.document_id=d.document_id AND a.action='REVIEW_APPROVE' AND a.actor_employee_id=r.updated_by_employee_id
    JOIN expense_document_links l ON l.document_id=d.document_id AND l.expense_id=e.expense_id AND l.relation_type='PRIMARY_PURCHASE_DOCUMENT' AND l.match_method='MANUAL'
    JOIN expense_online_order_claims claim ON claim.document_id=d.document_id AND claim.order_id=d.order_id AND claim.expense_id=e.expense_id AND claim.state='EXPENSE_OWNED'
    WHERE e.expense_id=? AND e.status='WAITING_CONFIRM' AND e.version=? AND d.message_id=e.message_id AND d.submitted_by_employee_id IS e.submitted_by_employee_id AND d.branch_id IS e.branch_id
      AND json_extract(CASE WHEN json_valid(d.normalized_json) THEN d.normalized_json ELSE '{}' END,'$.ownerPaymentReview.source')='OWNER_LINE_REVIEW'
      AND json_extract(CASE WHEN json_valid(a.after_json) THEN a.after_json ELSE '{}' END,'$.expenseId')=e.expense_id AND json_extract(a.after_json,'$.amountSatang')=e.amount_satang AND json_extract(a.after_json,'$.paymentDate')=e.transaction_date
      AND ${pendingOrderApprovalLineage}
      AND (SELECT COUNT(*) FROM expense_documents direct WHERE direct.expense_id=e.expense_id)=1
      AND (SELECT COUNT(*) FROM expense_document_cases k WHERE k.document_id=d.document_id AND k.expense_id=e.expense_id AND k.status='WAITING_CONFIRM' AND k.final_paid_satang=e.amount_satang)=1
      AND (SELECT COUNT(*) FROM expense_document_cases k WHERE k.document_id=d.document_id)=1 AND ${activeOwnerSql}`)
    .bind(before.expenseId,before.version,owner.employeeId,owner.lineUserId).first<Record<string,unknown>>();
  if(!proof)return "REVIEW";
  let document:Record<string,unknown>;try{const parsed=JSON.parse(String(proof.normalized_json));if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return "REVIEW";document=parsed;}catch{return "REVIEW";}
  const review=document.ownerPaymentReview;if(!review||typeof review!=="object"||Array.isArray(review))return "REVIEW";
  const previous=review as Record<string,unknown>,priorId=String(previous.auditId||""),originalId=String(previous.originalApprovalId||priorId),sources=previous.sources;
  if(previous.source!=="OWNER_LINE_REVIEW"||!priorId||!originalId||!sources||typeof sources!=="object"||Array.isArray(sources))return "REVIEW";
  let rawFacts:Record<string,unknown>;try{const parsed=JSON.parse(String(proof.owner_facts_json));if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return "REVIEW";rawFacts=parsed;}catch{return "REVIEW";}
  const facts=parseOwnerFacts(rawFacts);
  if(Object.keys(rawFacts).some(key=>!["amount","date","paymentStatus"].includes(key)||!(key in facts)))return "REVIEW";
  if(field==="amountSatang")facts.amount={value:after.amountSatang,source:"OWNER",actorEmployeeId:owner.employeeId,confirmedAt:now};
  else facts.date={value:after.transactionDate,source:"OWNER",actorEmployeeId:owner.employeeId,confirmedAt:now};
  const editId=randomId("exp_audit"),approvalId=randomId("exp_audit"),updatedSources={...(sources as Record<string,unknown>),[field==="amountSatang"?"amount":"date"]:"OWNER"};
  const nextDocument={...document,finalPaidAmountBaht:after.amountSatang/100,paymentDate:after.transactionDate,...(field==="transactionDate"?{paymentTime:""}:{}),ownerPaymentReview:{...previous,auditId:approvalId,originalApprovalId:originalId,ownerFacts:facts,sources:updatedSources,confirmedAt:now}};
  const approvalAfter=JSON.stringify({status:"WAITING_CONFIRM",amountSatang:after.amountSatang,paymentDate:after.transactionDate,sources:updatedSources,expenseId:before.expenseId,correctionId:id,originalApprovalId:originalId});
  const editAfter=JSON.stringify({...after,version:next,correctionId:id});
  const guard=`EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=?)`;
  const result=await env.DB.batch([
    env.DB.prepare(`INSERT INTO expense_audit_log(audit_id,actor_employee_id,action,expense_id,document_id,branch_id,reason,before_json,after_json,created_at)
      SELECT ?,?,'EDIT',e.expense_id,d.document_id,e.branch_id,?,?,?,? FROM expense_events e JOIN expense_owner_corrections c ON c.expense_id=e.expense_id
      JOIN expense_documents d ON d.document_id=? AND d.expense_id=e.expense_id JOIN expense_document_reviews r ON r.document_id=d.document_id
      JOIN expense_audit_log a ON a.audit_id=? AND a.document_id=d.document_id AND a.action='REVIEW_APPROVE' AND a.actor_employee_id=r.updated_by_employee_id
      JOIN expense_document_links l ON l.document_id=d.document_id AND l.expense_id=e.expense_id AND l.relation_type='PRIMARY_PURCHASE_DOCUMENT' AND l.match_method='MANUAL'
      JOIN expense_online_order_claims claim ON claim.document_id=d.document_id AND claim.order_id=d.order_id AND claim.expense_id=e.expense_id AND claim.state='EXPENSE_OWNED'
      WHERE c.correction_id=? AND c.owner_employee_id=? AND c.status='DRAFT' AND c.expires_at>? AND c.before_json=? AND c.after_json=?
        AND e.expense_id=? AND e.status='WAITING_CONFIRM' AND e.version=? AND e.updated_at IS ? AND e.description=? AND e.category=? AND e.amount_satang=? AND e.transaction_date=? AND e.payment_key=? AND e.source_wallet=?
        AND d.document_type='ONLINE_ORDER' AND d.status='WAITING_CONFIRM' AND d.normalized_json IS ? AND d.updated_at IS ? AND d.ai_json IS ? AND d.image_key IS ? AND d.image_hash IS ?
        AND d.final_paid_satang IS ? AND d.paid_amount_satang IS ? AND d.payment_date IS ? AND d.payment_time IS ? AND d.message_id=e.message_id AND d.submitted_by_employee_id IS e.submitted_by_employee_id AND d.branch_id IS e.branch_id
        AND r.expense_id=e.expense_id AND r.phase='DRAFTED' AND r.version=? AND r.owner_facts_json IS ? AND ${pendingOrderApprovalLineage}
        AND json_extract(CASE WHEN json_valid(a.after_json) THEN a.after_json ELSE '{}' END,'$.expenseId')=e.expense_id AND json_extract(a.after_json,'$.amountSatang')=e.amount_satang AND json_extract(a.after_json,'$.paymentDate')=e.transaction_date
        AND (SELECT COUNT(*) FROM expense_documents direct WHERE direct.expense_id=e.expense_id)=1
        AND (SELECT COUNT(*) FROM expense_document_cases k WHERE k.document_id=d.document_id)=1
        AND EXISTS(SELECT 1 FROM expense_document_cases k WHERE k.document_id=d.document_id AND k.expense_id=e.expense_id AND k.status='WAITING_CONFIRM' AND k.final_paid_satang=e.amount_satang)
        AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_key=e.expense_id AND j.entity_type IN ('EXPENSE','EXPENSE_CORRECTION') AND j.status<>'COMPLETED') AND ${activeOwnerSql}`)
      .bind(editId,owner.employeeId,`OWNER_PENDING_CORRECTION:${field}`,JSON.stringify(before),editAfter,now,String(proof.document_id),priorId,id,owner.employeeId,now,beforeJson,afterJson,before.expenseId,before.version,before.updatedAt,before.description,before.category,before.amountSatang,before.transactionDate,before.paymentKey,before.sourceWallet,proof.normalized_json,proof.updated_at??null,proof.ai_json??null,proof.image_key??null,proof.image_hash??null,proof.final_paid_satang??null,proof.paid_amount_satang??null,proof.payment_date??null,proof.payment_time??null,Number(proof.review_version),proof.owner_facts_json??null,owner.employeeId,owner.lineUserId),
    env.DB.prepare(`INSERT INTO expense_audit_log(audit_id,actor_employee_id,action,expense_id,document_id,branch_id,reason,before_json,after_json,created_at) SELECT ?,?,'REVIEW_APPROVE',e.expense_id,?,e.branch_id,'Owner re-confirmed changed payment facts',?,?,? FROM expense_events e WHERE e.expense_id=? AND ${guard}`)
      .bind(approvalId,owner.employeeId,String(proof.document_id),JSON.stringify({priorApprovalId:priorId,originalApprovalId:originalId}),approvalAfter,now,before.expenseId,editId),
    env.DB.prepare(`UPDATE expense_events SET description=?,category=?,amount_satang=?,transaction_date=?,payment_key=?,source_wallet=?,version=?,updated_at=? WHERE expense_id=? AND status='WAITING_CONFIRM' AND version=? AND ${guard}`)
      .bind(after.description,after.category,after.amountSatang,after.transactionDate,after.paymentKey,after.sourceWallet,next,now,before.expenseId,before.version,editId),
    env.DB.prepare(`UPDATE expense_documents SET normalized_json=?,final_paid_satang=?,paid_amount_satang=?,payment_date=?,payment_time=?,updated_at=? WHERE document_id=? AND expense_id=? AND status='WAITING_CONFIRM' AND ${guard}`)
      .bind(JSON.stringify(nextDocument),after.amountSatang,after.amountSatang,after.transactionDate,field==="transactionDate"?null:proof.payment_time??null,now,String(proof.document_id),before.expenseId,approvalId),
    env.DB.prepare(`UPDATE expense_document_reviews SET owner_facts_json=?,version=version+1,updated_by_employee_id=?,updated_at=? WHERE document_id=? AND expense_id=? AND phase='DRAFTED' AND version=? AND ${guard}`)
      .bind(JSON.stringify(facts),owner.employeeId,now,String(proof.document_id),before.expenseId,Number(proof.review_version),approvalId),
    env.DB.prepare(`UPDATE expense_document_cases SET final_paid_satang=?,updated_at=? WHERE document_id=? AND expense_id=? AND status='WAITING_CONFIRM' AND ${guard}`)
      .bind(after.amountSatang,now,String(proof.document_id),before.expenseId,approvalId),
    env.DB.prepare(`UPDATE expense_owner_corrections SET status='APPLIED',applied_at=? WHERE correction_id=? AND status='DRAFT' AND ${guard}`).bind(now,id,editId),
    env.DB.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=?) OR (EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=? AND action='REVIEW_APPROVE') AND EXISTS(SELECT 1 FROM expense_events WHERE expense_id=? AND status='WAITING_CONFIRM' AND version=? AND updated_at=?) AND EXISTS(SELECT 1 FROM expense_documents WHERE document_id=? AND normalized_json=? AND updated_at=?) AND EXISTS(SELECT 1 FROM expense_document_reviews WHERE document_id=? AND version=? AND updated_by_employee_id=?) AND EXISTS(SELECT 1 FROM expense_document_cases WHERE document_id=? AND expense_id=? AND final_paid_satang=? AND updated_at=?) AND EXISTS(SELECT 1 FROM expense_owner_corrections WHERE correction_id=? AND status='APPLIED' AND applied_at=?)) THEN 1 ELSE json('invalid pending order correction') END AS verified`)
      .bind(editId,approvalId,before.expenseId,next,now,String(proof.document_id),JSON.stringify(nextDocument),now,String(proof.document_id),Number(proof.review_version)+1,owner.employeeId,String(proof.document_id),before.expenseId,after.amountSatang,now,id,now)
  ]);
  if(Number(result[0]?.meta.changes||0)!==1)return "STALE";
  if(result.slice(0,7).some(part=>Number(part.meta.changes||0)!==1))throw new Error("OWNER_PENDING_ORDER_CORRECTION_INCOMPLETE");
  return "APPLIED";
}
