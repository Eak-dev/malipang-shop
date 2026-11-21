import type { Env,PurchaseDocument,PurchaseVisionAttempt } from "../types";
import { randomId } from "../shared/ids";
import { expenseCategories } from "./document";
import { documentWithReviewState } from "./review-state";
import { parseAttempts,parseOwnerFacts,resolveOrderFacts,retainedOrder,type OwnerOrderFacts,type OrderReviewView,type ReviewReason } from "./online-order-review";
import type { ReviewQueueSummary } from "./online-order-review-flex";

export type ReviewRow=Record<string,unknown>;
export interface OwnerReviewIdentity{employeeId:string;lineUserId:string;}
export const activeOwnerSql=`EXISTS(SELECT 1 FROM employees owner
  JOIN staff_roles role ON role.employee_id=owner.employee_id
  JOIN line_identity_bindings identity ON identity.employee_id=owner.employee_id
  WHERE owner.employee_id=? AND owner.status='ACTIVE' AND owner.can_submit_expense=1
    AND role.role='OWNER' AND role.scope='ORGANIZATION' AND role.status='ACTIVE'
    AND identity.provider='LINE' AND identity.external_user_id=? AND identity.status='VERIFIED')`;
const ownerParams=(owner:OwnerReviewIdentity)=>[owner.employeeId,owner.lineUserId];
const columns=(owner?:OwnerReviewIdentity)=>`d.*,r.version review_version,r.phase review_phase,r.owner_facts_json,r.extraction_attempts_json,r.reason_codes_json,
 r.expense_id review_expense_id,
 (SELECT line_user_id FROM expense_events WHERE expense_id=COALESCE(d.expense_id,r.expense_id)) AS draft_line_user_id,
 (SELECT state FROM expense_online_order_claims WHERE order_id=d.order_id) AS claim_state,
 (SELECT document_id FROM expense_online_order_claims WHERE order_id=d.order_id) AS claim_document_id,
 (SELECT document_id FROM expense_order_document_type_claims WHERE order_id=d.order_id AND document_type='ONLINE_ORDER') AS type_claim_document_id,
 (SELECT COUNT(*) FROM expense_documents WHERE order_id=d.order_id) AS order_document_count,
 (SELECT COUNT(*) FROM expense_document_links WHERE document_id=d.document_id) AS link_count,
 (SELECT COUNT(*) FROM expense_document_items WHERE document_id=d.document_id) AS item_count,
 (SELECT COUNT(*) FROM expense_document_items WHERE document_id=d.document_id AND expense_id IS NOT NULL) AS linked_item_count,
 (SELECT COUNT(*) FROM expense_document_cases WHERE document_id=d.document_id) AS case_count,
 (SELECT COUNT(*) FROM expense_document_cases WHERE document_id=d.document_id AND status='WAITING_REVIEW' AND expense_id IS NULL) AS pending_case_count,
 (SELECT COUNT(*) FROM expense_events e WHERE e.status<>'CANCELLED'
   AND e.amount_satang=COALESCE(json_extract(CASE WHEN json_valid(r.owner_facts_json) THEN r.owner_facts_json ELSE '{}' END,'$.amount.value'),
     ROUND(json_extract(CASE WHEN json_valid(d.normalized_json) THEN d.normalized_json ELSE '{}' END,'$.orderTotalBaht')*100))
   AND e.transaction_date=COALESCE(json_extract(CASE WHEN json_valid(r.owner_facts_json) THEN r.owner_facts_json ELSE '{}' END,'$.date.value'),
     json_extract(CASE WHEN json_valid(d.normalized_json) THEN d.normalized_json ELSE '{}' END,'$.paymentDate'))
   AND (e.line_user_id=d.line_user_id OR e.submitted_by_employee_id=d.submitted_by_employee_id ${owner?"OR e.line_user_id=? OR e.submitted_by_employee_id=?":""})) AS possible_duplicate_count`;
const duplicateOwnerParams=(owner?:OwnerReviewIdentity)=>owner?[owner.lineUserId,owner.employeeId]:[];
const from=`FROM expense_documents d LEFT JOIN expense_document_reviews r ON r.document_id=d.document_id`;

export function onlineOrderReviewInsert(env:Env,id:string,document:PurchaseDocument,expenseId:string|null,now:string,attempts:PurchaseVisionAttempt[]=[]){
  return env.DB.prepare(`INSERT INTO expense_document_reviews(document_id,phase,owner_facts_json,extraction_attempts_json,reason_codes_json,expense_id,created_at,updated_at)
    VALUES(?,?,'{}',?,?,?,?,?) ON CONFLICT(document_id) DO NOTHING`).bind(id,expenseId?"DRAFTED":"HELD",JSON.stringify(attempts),JSON.stringify(resolveOrderFacts(document).reasons),expenseId,now,now);
}
export async function seedOwnerReview(env:Env,id:string,owner:OwnerReviewIdentity):Promise<void>{
  const now=new Date().toISOString();
  await env.DB.prepare(`INSERT INTO expense_document_reviews(document_id,phase,created_at,updated_at)
    SELECT document_id,'HELD',?,? FROM expense_documents d WHERE document_id=? AND document_type='ONLINE_ORDER' AND status='WAITING_REVIEW' AND ${activeOwnerSql}
    ON CONFLICT(document_id) DO NOTHING`).bind(now,now,id,...ownerParams(owner)).run();
}
export async function loadOwnerReview(env:Env,id:string,owner:OwnerReviewIdentity):Promise<ReviewRow|null>{
  return env.DB.prepare(`SELECT ${columns(owner)} ${from} WHERE d.document_id=? AND d.document_type='ONLINE_ORDER' AND ${activeOwnerSql}`).bind(...duplicateOwnerParams(owner),id,...ownerParams(owner)).first<ReviewRow>();
}
export function viewFromReviewRow(row:ReviewRow,lineUserId=""):OrderReviewView{
  const document=retainedOrder(row.normalized_json),facts=parseOwnerFacts(row.owner_facts_json),resolved=resolveOrderFacts(document,facts),blocked:ReviewReason[]=[];
  const orderId=String(row.order_id||"").trim(),phase=row.expense_id||row.review_expense_id?"DRAFTED":"HELD";
  if(phase==="HELD"){
    if(!orderId)blocked.push("ORDER_ID_MISSING");
    if(!document||document.currency!=="THB"||document.orderId!==orderId||Number(row.item_count)<1)blocked.push("EVIDENCE_INCOMPLETE");
    const sellers=new Set(document?.items.map(i=>i.sellerKey||document.vendor));
    if(sellers.size>1||Number(row.case_count)>1)blocked.push("MULTIPLE_SELLERS");
    if(row.claim_state==="EXPENSE_OWNED"||Number(row.link_count)>0)blocked.push("ORDER_ALREADY_OWNED");
    else if(orderId&&(row.claim_state!=="REVIEW_ONLY"||row.claim_document_id!==row.document_id||row.type_claim_document_id!==row.document_id||Number(row.order_document_count)!==1))blocked.push("ORDER_IDENTITY_CONFLICT");
    if(Number(row.linked_item_count)>0||Number(row.case_count)!==1||Number(row.pending_case_count)!==1)blocked.push("EVIDENCE_INCOMPLETE");
    if(resolved.amountSatang!=null&&resolved.paymentDate&&Number(row.possible_duplicate_count)>0)blocked.push("POSSIBLE_DUPLICATE");
  }
  return{...resolved,documentId:String(row.document_id),version:Number(row.review_version||0),vendor:String(row.vendor_name||document?.vendor||"").slice(0,120),
    description:String(row.suggested_description||document?.suggestedDescription||document?.items[0]?.description||"").slice(0,200),createdAt:String(row.created_at),
    blocked:[...new Set(blocked)],phase,expenseId:row.expense_id||row.review_expense_id?String(row.expense_id||row.review_expense_id):null,
    reviewerOwnsDraft:Boolean(lineUserId&&row.draft_line_user_id===lineUserId)};
}
export async function listOwnerReviews(env:Env,owner:OwnerReviewIdentity,after=""):Promise<{views:OrderReviewView[];nextCursor:string|null}>{
  const result=await env.DB.prepare(`SELECT ${columns(owner)} ${from} WHERE d.document_type='ONLINE_ORDER' AND d.status='WAITING_REVIEW' AND ${activeOwnerSql}
    AND (?='' OR (d.created_at,d.document_id)>(SELECT created_at,document_id FROM expense_documents WHERE document_id=?))
    ORDER BY d.created_at,d.document_id LIMIT 9`).bind(...duplicateOwnerParams(owner),...ownerParams(owner),after,after).all<ReviewRow>();
  const rows=result.results||[],selected=rows.slice(0,8);
  return{views:selected.map(r=>viewFromReviewRow(r,owner.lineUserId)),nextCursor:rows.length>8?String(selected.at(-1)!.document_id):null};
}
export async function onlineOrderReviewSummary(env:Env,owner?:OwnerReviewIdentity,now=Date.now()):Promise<ReviewQueueSummary&{extraction:{attempts:number;casesWithRetry:number;casesWithStatusDisagreement:number}}>{
  const summary:ReviewQueueSummary={total:0,actionable:0,blocked:0,oldestAgeHours:0,reasons:{}};
  const extraction={attempts:0,casesWithRetry:0,casesWithStatusDisagreement:0};let after="";
  for(;;){
    const result=await env.DB.prepare(`SELECT ${columns(owner)} ${from} WHERE d.document_type='ONLINE_ORDER' AND d.status='WAITING_REVIEW' AND d.document_id>?
      ${owner?`AND ${activeOwnerSql}`:""} ORDER BY d.document_id LIMIT 200`).bind(...duplicateOwnerParams(owner),after,...(owner?ownerParams(owner):[])).all<ReviewRow>();
    const rows=result.results||[];
    for(const row of rows){
      const view=viewFromReviewRow(row);summary.total++;if(view.blocked.length)summary.blocked++;else summary.actionable++;
      summary.oldestAgeHours=Math.max(summary.oldestAgeHours,Math.max(0,(now-Date.parse(view.createdAt))/3_600_000)||0);
      for(const reason of new Set([...view.reasons,...view.blocked]))summary.reasons[reason]=(summary.reasons[reason]||0)+1;
      const attempts=parseAttempts(row.extraction_attempts_json);extraction.attempts+=attempts.length;
      if(attempts.length>1)extraction.casesWithRetry++;
      if(new Set(attempts.map(a=>a.rawPaymentStatus)).size>1)extraction.casesWithStatusDisagreement++;
    }
    if(rows.length<200)break;after=String(rows.at(-1)!.document_id);
  }
  summary.oldestAgeHours=Math.round(summary.oldestAgeHours*10)/10;
  return{...summary,extraction};
}

function editAudit(env:Env,row:ReviewRow,owner:OwnerReviewIdentity,auditId:string,reason:string,after:unknown,now:string,extraSql="",extraParams:unknown[]=[]){
  return env.DB.prepare(`INSERT INTO expense_audit_log(audit_id,actor_employee_id,action,document_id,branch_id,reason,before_json,after_json,created_at)
    SELECT ?,?,'EDIT',d.document_id,d.branch_id,?,r.owner_facts_json,?,? ${from}
    WHERE d.document_id=? AND d.status='WAITING_REVIEW' AND d.expense_id IS NULL AND r.phase='HELD' AND r.version=?
      AND r.owner_facts_json=? AND d.updated_at IS ? AND d.normalized_json IS ? AND ${activeOwnerSql} ${extraSql}`).bind(
      auditId,owner.employeeId,reason,JSON.stringify(after),now,String(row.document_id),Number(row.review_version),String(row.owner_facts_json),row.updated_at??null,row.normalized_json??null,...ownerParams(owner),...extraParams);
}
export async function startOwnerReviewInput(env:Env,row:ReviewRow,owner:OwnerReviewIdentity,field:"amount"|"date"):Promise<boolean>{
  const now=new Date().toISOString(),expires=new Date(Date.now()+15*60_000).toISOString(),id=randomId("exp_audit");
  const results=await env.DB.batch([
    editAudit(env,row,owner,id,`OWNER_REVIEW_INPUT_REQUESTED:${field}`,{field,expiresAt:expires},now),
    env.DB.prepare(`DELETE FROM expense_pending_edits WHERE line_user_id=? AND EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=?)`).bind(owner.lineUserId,id),
    env.DB.prepare(`INSERT INTO expense_document_review_inputs(owner_employee_id,document_id,field,review_version,created_at,expires_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=?)
      ON CONFLICT(owner_employee_id) DO UPDATE SET document_id=excluded.document_id,field=excluded.field,review_version=excluded.review_version,created_at=excluded.created_at,expires_at=excluded.expires_at`).bind(owner.employeeId,String(row.document_id),field,Number(row.review_version),now,expires,id)
  ]);
  return Number(results[0]?.meta.changes||0)===1;
}
export async function saveOwnerOrderFacts(env:Env,row:ReviewRow,owner:OwnerReviewIdentity,facts:OwnerOrderFacts,input?:ReviewRow):Promise<boolean>{
  const now=new Date().toISOString(),id=randomId("exp_audit"),document=retainedOrder(row.normalized_json);
  const sessionGuard=input?`AND EXISTS(SELECT 1 FROM expense_document_review_inputs WHERE owner_employee_id=? AND document_id=d.document_id AND field=? AND review_version=r.version AND created_at=? AND expires_at>=?)`:"";
  const sessionParams=input?[owner.employeeId,String(input.field),String(input.created_at),now]:[];
  const results=await env.DB.batch([
    editAudit(env,row,owner,id,"OWNER_CONFIRMED_PAYMENT_FACT",facts,now,sessionGuard,sessionParams),
    env.DB.prepare(`UPDATE expense_document_reviews SET owner_facts_json=?,reason_codes_json=?,version=version+1,updated_by_employee_id=?,updated_at=?
      WHERE document_id=? AND version=? AND EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=?)`).bind(JSON.stringify(facts),JSON.stringify(resolveOrderFacts(document,facts).reasons),owner.employeeId,now,String(row.document_id),Number(row.review_version),id),
    env.DB.prepare(`UPDATE expense_documents SET needs_review=1,review_note='Owner payment review is in progress',updated_at=? WHERE document_id=? AND status='WAITING_REVIEW' AND EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=?)`).bind(now,String(row.document_id),id),
    env.DB.prepare(`DELETE FROM expense_document_review_inputs WHERE owner_employee_id=? AND document_id=? AND EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=?)`).bind(owner.employeeId,String(row.document_id),id)
  ]);
  return Number(results[0]?.meta.changes||0)===1;
}
export async function findOwnerReviewInput(env:Env,owner:OwnerReviewIdentity):Promise<ReviewRow|null>{
  return env.DB.prepare(`SELECT * FROM expense_document_review_inputs WHERE owner_employee_id=? AND ${activeOwnerSql}`).bind(owner.employeeId,...ownerParams(owner)).first<ReviewRow>();
}
export async function clearOwnerReviewInput(env:Env,owner:OwnerReviewIdentity,createdAt?:string):Promise<void>{
  await env.DB.prepare(`DELETE FROM expense_document_review_inputs WHERE owner_employee_id=? ${createdAt?"AND created_at=?":""} AND ${activeOwnerSql}`).bind(owner.employeeId,...(createdAt?[createdAt]:[]),...ownerParams(owner)).run();
}

export async function promoteOwnerReviewedOrder(env:Env,row:ReviewRow,owner:OwnerReviewIdentity):Promise<{expenseId:string|null;reason:ReviewReason|null}>{
  const view=viewFromReviewRow(row,owner.lineUserId),document=retainedOrder(row.normalized_json),facts=parseOwnerFacts(row.owner_facts_json);
  if(view.phase==="DRAFTED")return{expenseId:view.reviewerOwnsDraft?view.expenseId:null,reason:null};
  if(!document||view.blocked.length||view.missing.length||view.amountSatang==null)return{expenseId:null,reason:view.blocked[0]||"EVIDENCE_INCOMPLETE"};
  const duplicate=await env.DB.prepare(`SELECT expense_id FROM expense_events WHERE status<>'CANCELLED' AND amount_satang=? AND transaction_date=?
    AND (line_user_id IN (?,?) OR submitted_by_employee_id IN (?,?)) LIMIT 1`).bind(view.amountSatang,view.paymentDate,row.line_user_id,owner.lineUserId,row.submitted_by_employee_id??null,owner.employeeId).first();
  if(duplicate)return{expenseId:null,reason:"POSSIBLE_DUPLICATE"};
  const [items,cases]=await Promise.all([
    env.DB.prepare(`SELECT * FROM expense_document_items WHERE document_id=? ORDER BY item_id`).bind(view.documentId).all<ReviewRow>(),
    env.DB.prepare(`SELECT * FROM expense_document_cases WHERE document_id=? ORDER BY case_id`).bind(view.documentId).all<ReviewRow>()
  ]);
  const now=new Date().toISOString(),expenseId=randomId("exp"),approvalId=randomId("exp_audit"),draftAuditId=randomId("exp_audit");
  const reviewState={requiredFields:["amount","date","payment","description","category"] as const,confirmedFields:["amount","date"] as const};
  const resolved={...document,finalPaidAmountBaht:view.amountSatang/100,paymentStatus:"PAID" as const,paymentDate:view.paymentDate,paymentTime:facts.date?"":document.paymentTime,
    paymentDateLabel:document.paymentDateLabel||"",sourceWalletCandidate:"",needsReview:true,
    reviewReasons:["Owner reviewed payment facts; payment source, description and category require confirmation"],
    ownerPaymentReview:{source:"OWNER_LINE_REVIEW",auditId:approvalId,ownerFacts:facts,sources:view.sources,confirmedAt:now},
    imagePaymentEvidence:{finalPaidAmountBaht:document.finalPaidAmountBaht,orderTotalBaht:document.orderTotalBaht??null,paymentStatus:document.paymentStatus??"UNKNOWN",paymentDate:document.paymentDate,paymentDateLabel:document.paymentDateLabel??"",paymentDatePurpose:document.paymentDatePurpose??"UNKNOWN",paymentTime:document.paymentTime}};
  const normalized=JSON.stringify(documentWithReviewState(resolved,{requiredFields:[...reviewState.requiredFields],confirmedFields:[...reviewState.confirmedFields]}));
  const description=(document.suggestedDescription||document.items[0]?.description||document.vendor||"Online order").trim().slice(0,200),category=expenseCategories.has(document.suggestedCategory)?document.suggestedCategory:"general";
  const approvalGuard=`EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=? AND document_id=? AND action='REVIEW_APPROVE')`;
  const approvalParams=[approvalId,view.documentId];
  const expenseGuard=`${approvalGuard} AND EXISTS(SELECT 1 FROM expense_events WHERE expense_id=? AND message_id=? AND status='WAITING_CONFIRM')`;
  const expenseParams=[...approvalParams,expenseId,row.message_id];
  const itemSnapshot=JSON.stringify(items.results||[]),caseSnapshot=JSON.stringify(cases.results||[]);
  const itemColumns=["description","quantity","unit","unit_price_satang","discount_satang","line_total_satang","vat_satang","product_code","seller_key","updated_at","expense_id"];
  const caseColumns=["status","expense_id","final_paid_satang","gross_satang","updated_at"];
  const itemMatch=itemColumns.map(c=>`i.${c} IS json_extract(s.value,'$.${c}')`).join(" AND ");
  const caseMatch=caseColumns.map(c=>`k.${c} IS json_extract(s.value,'$.${c}')`).join(" AND ");
  const reason="Owner completed missing payment facts through LINE; original image evidence retained; normal expense confirmation required";
  const statements=[
    env.DB.prepare(`INSERT INTO expense_audit_log(audit_id,actor_employee_id,action,document_id,branch_id,reason,before_json,after_json,created_at)
      SELECT ?,?,'REVIEW_APPROVE',d.document_id,d.branch_id,?,json_object('status',d.status,'ownerFacts',r.owner_facts_json),?,? ${from}
      WHERE d.document_id=? AND d.document_type='ONLINE_ORDER' AND d.status='WAITING_REVIEW' AND d.expense_id IS NULL AND d.currency='THB'
        AND d.normalized_json IS ? AND d.updated_at IS ? AND d.ai_json IS ? AND d.image_key IS ? AND d.image_hash IS ?
        AND d.message_id IS ? AND d.line_user_id IS ? AND d.submitted_by_employee_id IS ? AND d.branch_id IS ? AND r.version=? AND r.phase='HELD' AND r.owner_facts_json=?
        AND d.order_id=? AND (SELECT COUNT(*) FROM expense_documents WHERE order_id=d.order_id)=1
        AND EXISTS(SELECT 1 FROM expense_online_order_claims c WHERE c.order_id=d.order_id AND c.document_id=d.document_id AND c.state='REVIEW_ONLY' AND c.expense_id IS NULL)
        AND EXISTS(SELECT 1 FROM expense_order_document_type_claims c WHERE c.order_id=d.order_id AND c.document_type='ONLINE_ORDER' AND c.document_id=d.document_id)
        AND NOT EXISTS(SELECT 1 FROM expense_document_links WHERE document_id=d.document_id)
        AND NOT EXISTS(SELECT 1 FROM expense_events WHERE message_id=d.message_id OR (status<>'CANCELLED' AND amount_satang=? AND transaction_date=? AND (line_user_id IN (d.line_user_id,?) OR submitted_by_employee_id IN (d.submitted_by_employee_id,?))))
        AND (SELECT COUNT(*) FROM expense_document_items WHERE document_id=d.document_id)=?
        AND (SELECT COUNT(*) FROM expense_document_items i JOIN json_each(?) s ON i.item_id=json_extract(s.value,'$.item_id') WHERE i.document_id=d.document_id AND i.expense_id IS NULL AND ${itemMatch})=?
        AND (SELECT COUNT(*) FROM expense_document_cases WHERE document_id=d.document_id)=1
        AND EXISTS(SELECT 1 FROM expense_document_cases k JOIN json_each(?) s ON k.case_id=json_extract(s.value,'$.case_id') WHERE k.document_id=d.document_id AND k.status='WAITING_REVIEW' AND k.expense_id IS NULL AND ${caseMatch})
        AND ${activeOwnerSql}`).bind(approvalId,owner.employeeId,reason,JSON.stringify({status:"WAITING_CONFIRM",amountSatang:view.amountSatang,paymentDate:view.paymentDate,sources:view.sources,expenseId}),now,
          view.documentId,row.normalized_json??null,row.updated_at??null,row.ai_json??null,row.image_key??null,row.image_hash??null,row.message_id??null,row.line_user_id??null,row.submitted_by_employee_id??null,row.branch_id??null,view.version,String(row.owner_facts_json),document.orderId,view.amountSatang,view.paymentDate,owner.lineUserId,owner.employeeId,
          items.results?.length||0,itemSnapshot,items.results?.length||0,caseSnapshot,...ownerParams(owner)),
    env.DB.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at,submitted_by_employee_id,branch_id)
      SELECT ?,d.message_id,?,?,?,'unconfirmed','UNCONFIRMED',?,?,'WAITING_CONFIRM',?,?,d.submitted_by_employee_id,d.branch_id FROM expense_documents d
      WHERE d.document_id=? AND d.status='WAITING_REVIEW' AND d.expense_id IS NULL AND ${approvalGuard}`).bind(expenseId,owner.lineUserId,description,view.amountSatang,category,view.paymentDate,`owner_review_${expenseId}`,now,view.documentId,...approvalParams),
    env.DB.prepare(`UPDATE expense_documents SET status='WAITING_CONFIRM',expense_id=?,final_paid_satang=?,paid_amount_satang=?,payment_date=?,payment_time=?,normalized_json=?,needs_review=1,review_note=?,updated_at=?
      WHERE document_id=? AND status='WAITING_REVIEW' AND expense_id IS NULL AND ${expenseGuard}`).bind(expenseId,view.amountSatang,view.amountSatang,view.paymentDate,resolved.paymentTime||null,normalized,"เจ้าของตรวจยอดและวันชำระแล้ว กรุณาตรวจรายการ หมวดหมู่ และแหล่งเงิน",now,view.documentId,...expenseParams),
    env.DB.prepare(`UPDATE expense_document_items SET expense_id=?,updated_at=? WHERE document_id=? AND expense_id IS NULL AND ${expenseGuard}`).bind(expenseId,now,view.documentId,...expenseParams),
    env.DB.prepare(`UPDATE expense_document_cases SET expense_id=?,final_paid_satang=?,status='WAITING_CONFIRM',updated_at=? WHERE document_id=? AND status='WAITING_REVIEW' AND expense_id IS NULL AND ${expenseGuard}`).bind(expenseId,view.amountSatang,now,view.documentId,...expenseParams),
    env.DB.prepare(`UPDATE expense_online_order_claims SET expense_id=?,state='EXPENSE_OWNED',updated_at=? WHERE order_id=? AND document_id=? AND state='REVIEW_ONLY' AND expense_id IS NULL AND ${expenseGuard}`).bind(expenseId,now,document.orderId,view.documentId,...expenseParams),
    env.DB.prepare(`INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,linked_by_employee_id,reason,created_at)
      SELECT ?,?,?,'PRIMARY_PURCHASE_DOCUMENT','MANUAL',?,?,? WHERE ${expenseGuard} AND NOT EXISTS(SELECT 1 FROM expense_document_links WHERE document_id=?)`).bind(randomId("doc_link"),expenseId,view.documentId,owner.employeeId,reason,now,...expenseParams,view.documentId),
    env.DB.prepare(`UPDATE expense_document_reviews SET phase='DRAFTED',expense_id=?,version=version+1,updated_by_employee_id=?,updated_at=?,reason_codes_json='[]'
      WHERE document_id=? AND phase='HELD' AND version=? AND ${expenseGuard}`).bind(expenseId,owner.employeeId,now,view.documentId,view.version,...expenseParams),
    env.DB.prepare(`INSERT INTO expense_audit_log(audit_id,actor_employee_id,action,expense_id,document_id,branch_id,reason,before_json,after_json,created_at)
      SELECT ?,?,'CREATE_DRAFT',?,d.document_id,d.branch_id,?,'{}',?,? FROM expense_documents d WHERE document_id=? AND expense_id=? AND ${expenseGuard}`).bind(draftAuditId,owner.employeeId,expenseId,reason,JSON.stringify({status:"WAITING_CONFIRM",requiredFields:reviewState.requiredFields,confirmedFields:reviewState.confirmedFields}),now,view.documentId,expenseId,...expenseParams),
    env.DB.prepare(`DELETE FROM expense_document_review_inputs WHERE document_id=? AND ${expenseGuard}`).bind(view.documentId,...expenseParams)
  ];
  await env.DB.batch(statements);
  const current=await loadOwnerReview(env,view.documentId,owner),currentView=current?viewFromReviewRow(current,owner.lineUserId):null;
  return{expenseId:currentView?.phase==="DRAFTED"&&currentView.reviewerOwnsDraft?currentView.expenseId:null,reason:null};
}
