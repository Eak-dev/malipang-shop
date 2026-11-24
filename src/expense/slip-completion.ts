import {randomId} from "../shared/ids";
import type {BankSlipDocument,Env} from "../types";
import {bankSlipExpenseDraft,bankSlipReferenceKey,validateBankSlip} from "./bank-slip";
import {bankSlipReviewState,documentWithReviewState} from "./review-state";

type ReviewedSlip=BankSlipDocument & {slipCurrencyEvidence?:"read"|"user"};
const prompts = {
  currency: ["สกุลเงิน", "กรอก THB หรือ บาท เฉพาะเมื่อสลิปแสดงว่าจ่ายเป็นบาท"],
  paidAmountBaht: ["ยอดจ่ายจริง", "จำนวนบาท เช่น 120.50"],
  paymentDate: ["วันที่ชำระ", "วันที่ ค.ศ. เช่น 2026-11-23"],
  paymentTime: ["เวลาชำระ", "เวลา เช่น 09:15"],
  referenceId: ["เลขอ้างอิง", "เลขอ้างอิงที่แสดงบนสลิป"],
  recipient: ["ผู้รับเงิน", "ชื่อผู้รับเงินหรือร้านค้าบนสลิป"],
} as const;
type Field = keyof typeof prompts;
const fieldsByIssue: Record<string,Field> = {
  "paid amount":"paidAmountBaht", "valid paid amount":"paidAmountBaht", "payment date":"paymentDate",
  "payment time":"paymentTime", "reference ID":"referenceId", "recipient or merchant":"recipient",
};

function validationForSlip(document:BankSlipDocument){
  return validateBankSlip({kind:"BANK_SLIP",document});
}

export function missingSlipFields(document:BankSlipDocument):Field[]{
  const {missing}=validationForSlip(document);
  if(missing.some(reason=>!Object.hasOwn(fieldsByIssue,reason)))return [];
  return [...new Set(missing.map(reason=>fieldsByIssue[reason]!))];
}

export function heldSlipFields(doc:ReviewedSlip):Field[]{
  const missing=missingSlipFields(doc);
  // Older readers substituted THB for an empty currency. Ask for evidence before promoting their held rows.
  if(missing.length&&doc.slipCurrencyEvidence!=="read"&&doc.slipCurrencyEvidence!=="user")return ["currency"];
  return missing;
}

export function slipAnswerPrefix(id:string,field:Field){
  return "/เติมสลิป "+id+" "+prompts[field][0]+" ";
}

export function slipInputCard(id:string,fields:Field[],hint?:string){
  const title="กรอกข้อมูลสลิปให้ครบ";
  return {type:"flex",altText:title,contents:{type:"bubble",body:{type:"box",layout:"vertical",spacing:"md",contents:[
    {type:"text",text:title,weight:"bold"},
    ...(hint?[{type:"text",text:hint,wrap:true}]:[]),
    {type:"text",text:"เลือกช่องที่ต้องการกรอก แล้วพิมพ์คำตอบต่อท้ายข้อความที่เตรียมไว้",wrap:true},
    ...fields.map(field=>({type:"button",action:{type:"postback",label:prompts[field][0],data:"a=slip_input&id="+id+"&field="+field,
      inputOption:"openKeyboard",fillInText:slipAnswerPrefix(id,field)}})),
  ]}}};
}

export function parseSlipAnswer(text:string){
  const match=/^\/เติมสลิป\s+(doc_[\w-]+)\s+(\S+)\s+([^\r\n]+)$/u.exec(text.trim());
  if(!match)return null;
  const field=(Object.keys(prompts) as Field[]).find(key=>prompts[key][0]===match[2]);
  return field?{id:match[1]!,field,value:match[3]!.trim()}:null;
}

interface SlipRecord {
  document_id:string; status:string; expense_id:string|null; ai_json:string; normalized_json:string|null;
}
export async function readSlip(env:Env,id:string,user:string){
  return env.DB.prepare(`SELECT document_id,status,expense_id,ai_json,normalized_json FROM expense_documents
    WHERE document_id=? AND line_user_id=? AND document_type='BANK_SLIP'`).bind(id,user).first<SlipRecord>();
}

export function slipDocument(row:SlipRecord):ReviewedSlip|null {
  try{
    const doc=JSON.parse(row.normalized_json||row.ai_json);
    if(doc?.documentType!=="BANK_SLIP"||!["BANK","G_WALLET"].includes(doc.channel)||
       !["note","referenceId","recipient","merchant","institution","currency","paymentDate","paymentTime","suggestedDescription","suggestedCategory"]
         .every(key=>typeof doc[key]==="string"))return null;
    return doc;
  }catch{return null;}
}

export async function applySlipAnswer(env:Env,row:SlipRecord,user:string,answer:NonNullable<ReturnType<typeof parseSlipAnswer>>,
  actor:{employeeId:string|null;branchId:string|null},traceId:string):Promise<string|null>{
  const doc=slipDocument(row);
  if(row.status!=="WAITING_REVIEW"||row.expense_id||!doc||!heldSlipFields(doc).includes(answer.field))return null;
  const field=answer.field;
  if(field==="currency"){
    if(!["THB","บาท","฿"].includes(answer.value.toUpperCase()))return prompts.currency[1];
    doc.slipCurrencyEvidence="user";
  }else if(field==="paidAmountBaht"){
    if(!/^\d{1,12}(?:\.\d{1,2})?$/.test(answer.value))return prompts[field][1];
    doc.paidAmountBaht=Number(answer.value);
  }else{
    if(!answer.value||answer.value.length>200||/[\x00-\x1f]/.test(answer.value))return prompts[field][1];
    doc[field]=answer.value;
  }
  const check=validationForSlip(doc),remaining=missingSlipFields(doc);
  if(!check.ok&&(!remaining.length||remaining.includes(field)))return "กรุณาตรวจ"+prompts[field][0]+"อีกครั้ง "+prompts[field][1];

  const id=row.document_id,now=new Date().toISOString(),edit=randomId("exp_audit");
  const db=env.DB,guard="EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=?)";
  // A unique audit row claims this exact snapshot. All following writes share its transaction.
  const batch=[db.prepare(`INSERT INTO expense_audit_log(audit_id,actor_employee_id,branch_id,action,document_id,reason,after_json,created_at)
    SELECT ?,?,?,'EDIT',document_id,?,?,? FROM expense_documents WHERE document_id=? AND line_user_id=? AND document_type='BANK_SLIP'
    AND status='WAITING_REVIEW' AND expense_id IS NULL AND normalized_json IS ? AND ai_json IS ?`)
    .bind(edit,actor.employeeId,actor.branchId,"User supplied slip field",JSON.stringify({field}),now,id,user,row.normalized_json,row.ai_json)];
  const expenseId=check.ok?randomId("exp"):null;
  let normalized=JSON.stringify(doc);
  if(expenseId){
    const draft=bankSlipExpenseDraft(doc),state=bankSlipReviewState(doc,draft,check.review);
    normalized=JSON.stringify(documentWithReviewState({...doc},state));
    batch.push(db.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at,submitted_by_employee_id,branch_id)
      SELECT ?,message_id,line_user_id,?,?,?,?,?,?,'WAITING_CONFIRM',?,?,?,? FROM expense_documents WHERE document_id=? AND ${guard}`)
      .bind(expenseId,draft.description,draft.amountSatang,draft.paymentKey,draft.sourceWallet,draft.category,draft.transactionDate,traceId,now,actor.employeeId,actor.branchId,id,edit),
      db.prepare(`INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,linked_by_employee_id,reason,created_at)
        SELECT ?,?,?,'PAYMENT_EVIDENCE','EXACT_IDENTIFIER',?,'Bank or wallet payment evidence',? WHERE ${guard}`)
        .bind(randomId("doc_link"),expenseId,id,actor.employeeId,now,edit),
      db.prepare(`INSERT INTO expense_audit_log(audit_id,actor_employee_id,branch_id,action,expense_id,document_id,reason,created_at)
        SELECT ?,?,?,'CREATE_DRAFT',?,?,'Slip fields completed',? WHERE ${guard}`)
        .bind(randomId("exp_audit"),actor.employeeId,actor.branchId,expenseId,id,now,edit));
  }
  const paid=doc.paidAmountBaht==null?null:Math.round(doc.paidAmountBaht*100);
  batch.push(db.prepare(`UPDATE expense_documents SET normalized_json=?,payment_date=?,payment_time=?,reference_id=?,reference_key=?,recipient=?,
    paid_amount_satang=?,final_paid_satang=?,currency=?,status=?,expense_id=?,review_note=?,needs_review=?,submitted_by_employee_id=?,branch_id=?,updated_at=?
    WHERE document_id=? AND ${guard}`).bind(normalized,doc.paymentDate,doc.paymentTime,doc.referenceId,bankSlipReferenceKey(doc),doc.recipient,
    paid,paid,doc.currency,expenseId?"WAITING_CONFIRM":"WAITING_REVIEW",expenseId,check.note,Number(check.review),actor.employeeId,actor.branchId,now,id,edit));
  try{await db.batch(batch);}catch(error){
    if(String(error).includes("UNIQUE constraint failed: expense_documents.reference_key"))return "เลขอ้างอิงนี้อยู่ในสลิปเดิมแล้ว กรุณาตรวจเลขอีกครั้ง";
    throw error;
  }
  return null;
}
