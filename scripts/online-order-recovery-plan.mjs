import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {purchaseExpenseDraft} from '../dist/expense/document.js';
import {confirmReviewField,documentWithReviewState,purchaseReviewState,unresolvedReviewFields} from '../dist/expense/review-state.js';
import {normalizeOpenAIVisionResult} from '../dist/vision/openai.js';

const statement=(sql,params=[])=>({sql,params});
const requireFact=(condition,message)=>{if(!condition)throw new Error(message);};

/** Offline only: produces one snapshot-guarded D1 batch, never sends it. */
export function buildOnlineOrderRecoveryPlan(manifest,ids={}){
  const row=manifest?.document,approval=manifest?.approval;
  requireFact(row&&approval,'Document snapshot and owner approval are required');
  requireFact(row.document_type==='ONLINE_ORDER'&&row.status==='WAITING_REVIEW'&&row.expense_id==null,'Target must be an unlinked review-only Online Order');
  requireFact(row.final_paid_satang==null&&row.paid_amount_satang==null,'A known paid amount cannot be overwritten');
  requireFact(typeof row.document_id==='string'&&row.document_id.trim()&&typeof row.order_id==='string'&&row.order_id.trim(),'Exact document and order identity are required');
  requireFact(typeof row.normalized_json==='string'&&row.normalized_json.trim(),'Retained normalized document is required');
  requireFact(typeof approval.ownerEmployeeId==='string'&&approval.ownerEmployeeId.trim(),'An owner employee ID is required');
  requireFact(typeof approval.reason==='string'&&approval.reason.trim().length>=8,'A specific owner review reason is required');
  requireFact(approval.evidenceReviewed===true,'Owner must explicitly verify the original payment evidence');
  const amount=approval.finalPaidSatang;
  requireFact(Number.isSafeInteger(amount)&&amount>0,'Verified amount must be positive integer satang');
  const retained=JSON.parse(row.normalized_json);
  requireFact(retained.documentType==='ONLINE_ORDER'&&retained.orderId===row.order_id,'Retained order identity must match the snapshot');
  requireFact(row.currency==='THB'&&retained.currency==='THB'&&retained.paymentStatus==='PAID','Retained evidence must prove a paid THB order');
  requireFact(retained.paymentDate===row.payment_date,'Retained payment date must match the snapshot');
  requireFact(retained.finalPaidAmountBaht==null,'Retained final paid amount must be missing');
  if(retained.orderTotalBaht!=null)requireFact(Math.round(retained.orderTotalBaht*100)===amount,'Verified total conflicts with the retained accepted order total');
  const items=retained.items;
  requireFact(Array.isArray(items)&&items.length>0&&new Set(items.map(item=>item.sellerKey||retained.vendor)).size===1,'Recovery requires retained items from exactly one seller');

  const document=normalizeOpenAIVisionResult({kind:'ONLINE_ORDER',document:{...retained,
    orderTotalBaht:amount/100,orderTotalLabel:approval.orderTotalLabel,finalPaidAmountBaht:amount/100,
    sourceWalletCandidate:'',reviewReasons:(retained.reviewReasons||[]).filter(reason=>reason!=='Amount evidence conflicts: final paid amount does not match accepted order total')
  }},{}).document;
  requireFact(document?.documentType==='ONLINE_ORDER'&&document.finalPaidAmountBaht===amount/100,'Verified label and amount must pass the existing normalizer');
  const draft=purchaseExpenseDraft(document);
  requireFact(draft&&draft.transactionDate===row.payment_date&&draft.amountSatang===amount,'Retained payment date and verified total must form a valid draft');
  // Recovery never chooses a card, and requires a human review of the purchase.
  draft.paymentKey='unconfirmed';draft.sourceWallet='UNCONFIRMED';
  const baseState=purchaseReviewState(document,draft);
  const reviewState=confirmReviewField({requiredFields:[...new Set([...baseState.requiredFields,'amount','payment','description','category'])],confirmedFields:[]},'amount');
  const normalizedJson=JSON.stringify(documentWithReviewState(document,reviewState));
  const now=ids.now||new Date().toISOString(),uuid=()=>crypto.randomUUID();
  const expenseId=ids.expenseId||`exp_${uuid()}`,approvalId=ids.approvalId||`exp_audit_${uuid()}`;
  const draftAuditId=ids.draftAuditId||`exp_audit_${uuid()}`,linkId=ids.linkId||`doc_link_${uuid()}`;
  const traceId=ids.traceId||`order_recovery_${uuid()}`,documentId=row.document_id;
  const reason=approval.reason.trim(),owner=approval.ownerEmployeeId.trim();
  const guardedExpense=`EXISTS(SELECT 1 FROM expense_events e JOIN expense_audit_log a ON a.document_id=?
    WHERE e.expense_id=? AND a.audit_id=? AND a.action='REVIEW_APPROVE')`;
  const guardParams=[documentId,expenseId,approvalId];
  const batch=[
    statement(`INSERT INTO expense_audit_log(audit_id,actor_employee_id,action,document_id,branch_id,reason,before_json,after_json,created_at)
      SELECT ?,?,'REVIEW_APPROVE',d.document_id,d.branch_id,?,
        json_object('status',d.status,'finalPaidSatang',d.final_paid_satang,'reviewNote',d.review_note),
        json_object('status','WAITING_CONFIRM','finalPaidSatang',?,'expenseId',?),?
      FROM expense_documents d
      WHERE d.document_id=? AND d.document_type='ONLINE_ORDER' AND d.status='WAITING_REVIEW' AND d.expense_id IS NULL
        AND d.final_paid_satang IS NULL AND d.paid_amount_satang IS NULL AND d.currency='THB'
        AND d.order_id=? AND d.payment_date=? AND d.normalized_json=? AND d.updated_at IS ?
        AND EXISTS(SELECT 1 FROM employees o JOIN staff_roles r ON r.employee_id=o.employee_id
          WHERE o.employee_id=? AND o.status='ACTIVE' AND r.role='OWNER' AND r.scope='ORGANIZATION' AND r.status='ACTIVE')
        AND (SELECT COUNT(*) FROM expense_documents WHERE order_id=d.order_id)=1
        AND EXISTS(SELECT 1 FROM expense_online_order_claims c WHERE c.order_id=d.order_id AND c.document_id=d.document_id AND c.state='REVIEW_ONLY' AND c.expense_id IS NULL)
        AND EXISTS(SELECT 1 FROM expense_order_document_type_claims t WHERE t.order_id=d.order_id AND t.document_type='ONLINE_ORDER' AND t.document_id=d.document_id)
        AND NOT EXISTS(SELECT 1 FROM expense_events e WHERE e.message_id=d.message_id OR (e.line_user_id=d.line_user_id AND e.amount_satang=? AND e.transaction_date=d.payment_date AND e.status<>'CANCELLED'))
        AND NOT EXISTS(SELECT 1 FROM expense_document_links WHERE document_id=d.document_id)
        AND (SELECT COUNT(*) FROM expense_document_items WHERE document_id=d.document_id)=?
        AND NOT EXISTS(SELECT 1 FROM expense_document_items WHERE document_id=d.document_id AND expense_id IS NOT NULL)
        AND (SELECT COUNT(*) FROM expense_document_cases WHERE document_id=d.document_id)=1
        AND EXISTS(SELECT 1 FROM expense_document_cases WHERE document_id=d.document_id AND status='WAITING_REVIEW' AND expense_id IS NULL)`,
    [approvalId,owner,reason,amount,expenseId,now,documentId,row.order_id,row.payment_date,row.normalized_json,row.updated_at??null,owner,amount,items.length]),
    statement(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at,submitted_by_employee_id,branch_id)
      SELECT ?,d.message_id,d.line_user_id,?,?,'unconfirmed','UNCONFIRMED',?,?,'WAITING_CONFIRM',?,?,d.submitted_by_employee_id,d.branch_id
      FROM expense_documents d WHERE d.document_id=? AND d.status='WAITING_REVIEW' AND d.expense_id IS NULL
        AND EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=? AND document_id=d.document_id AND action='REVIEW_APPROVE')`,
    [expenseId,draft.description,amount,draft.category,draft.transactionDate,traceId,now,documentId,approvalId]),
    statement(`UPDATE expense_documents SET status='WAITING_CONFIRM',expense_id=?,final_paid_satang=?,paid_amount_satang=?,normalized_json=?,review_note=?,needs_review=1,updated_at=?
      WHERE document_id=? AND status='WAITING_REVIEW' AND expense_id IS NULL AND ${guardedExpense}`,
    [expenseId,amount,amount,normalizedJson,reason,now,documentId,...guardParams]),
    statement(`UPDATE expense_document_items SET expense_id=?,updated_at=? WHERE document_id=? AND expense_id IS NULL AND ${guardedExpense}`,
    [expenseId,now,documentId,...guardParams]),
    statement(`UPDATE expense_document_cases SET expense_id=?,final_paid_satang=?,status='WAITING_CONFIRM',updated_at=?
      WHERE document_id=? AND status='WAITING_REVIEW' AND expense_id IS NULL AND ${guardedExpense}`,
    [expenseId,amount,now,documentId,...guardParams]),
    statement(`UPDATE expense_online_order_claims SET state='EXPENSE_OWNED',expense_id=?,updated_at=?
      WHERE order_id=? AND document_id=? AND state='REVIEW_ONLY' AND expense_id IS NULL AND ${guardedExpense}`,
    [expenseId,now,row.order_id,documentId,...guardParams]),
    statement(`INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,linked_by_employee_id,reason,created_at)
      SELECT ?,?,?,'PRIMARY_PURCHASE_DOCUMENT','MANUAL',?,?,? WHERE ${guardedExpense}
        AND NOT EXISTS(SELECT 1 FROM expense_document_links WHERE document_id=?)`,
    [linkId,expenseId,documentId,owner,reason,now,...guardParams,documentId]),
    statement(`INSERT INTO expense_audit_log(audit_id,actor_employee_id,action,expense_id,document_id,branch_id,reason,before_json,after_json,created_at)
      SELECT ?,?,'CREATE_DRAFT',?,d.document_id,d.branch_id,?,json_object('status','WAITING_REVIEW'),
        json_object('status','WAITING_CONFIRM','finalPaidSatang',?,'payment','UNCONFIRMED'),?
      FROM expense_documents d WHERE d.document_id=? AND d.expense_id=? AND ${guardedExpense}
        AND NOT EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=?)`,
    [draftAuditId,owner,expenseId,reason,amount,now,documentId,expenseId,...guardParams,draftAuditId]),
    statement(`SELECT e.status,e.amount_satang,e.payment_key,e.source_wallet,
        (SELECT COUNT(*) FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=e.expense_id) AS sync_count
      FROM expense_events e JOIN expense_documents d ON d.expense_id=e.expense_id
      WHERE d.document_id=? AND e.expense_id=? AND d.status='WAITING_CONFIRM' AND ${guardedExpense}`,
    [documentId,expenseId,...guardParams])
  ];
  return {batch,summary:{document_count:1,final_paid_satang:amount,status:'WAITING_CONFIRM',unresolved_fields:unresolvedReviewFields(reviewState),auto_finalized:false,sheets_sync_created:false,next_action:'RESEND_ORIGINAL_IMAGE_TO_RESUME_CONFIRMATION'}};
}

async function main(){
  const [input,output,...extra]=process.argv.slice(2);
  requireFact(input&&output&&!extra.length,'Usage: node scripts/online-order-recovery-plan.mjs <private-manifest.json> <private-plan.json>');
  const plan=buildOnlineOrderRecoveryPlan(JSON.parse(await readFile(input,'utf8')));
  await writeFile(output,JSON.stringify(plan,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({...plan.summary,operation:'OFFLINE_PLAN_ONLY'}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  main().catch(()=>{console.error('Online Order recovery plan was not written; check the private input and output paths and validated approval facts.');process.exitCode=1;});
}
