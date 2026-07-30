import { enqueueSheetSync } from "../db/repositories";
import { respondFlexToLineEvent,respondTextToLineEvent } from "../line/event-response";
import { randomId } from "../shared/ids";
import { addDays,isIsoDate,isoDateInBangkok } from "../shared/time";
import type { Employee,Env,LineEvent,VisionResult } from "../types";
import {
  buildExpenseCategoryFlex,buildExpenseDateFlex,buildExpensePaymentFlex,buildExpenseSavedFlex,
  buildExpenseSourceFlex,buildExpenseSummaryFlex,paymentForWallet,paymentWallet,type ExpenseFlexRecord
} from "./flex";
import { bankSlipExpenseDraft,bankSlipReferenceKey,validateBankSlip } from "./bank-slip";
import { documentItemStatements,expenseCategories,expensePayments,expenseWallets,purchaseExpenseDraft,sellerDocumentCases,toSatang } from "./document";
import { exactDocumentMatch,relationForIncomingDocument,type ExistingExpenseDocument } from "./linking";
import { parseExpenseText } from "./text-parser";
import type { StaffActor } from "../access/repository";
import type { BankSlipDocument,PurchaseDocument } from "../types";

type ExpenseRow=Record<string,unknown>;
export type ExpenseTextOutcome="CONFIRMED"|"WAITING_CONFIRM"|"REJECTED";
const allowedPayments=expensePayments;
const allowedSources=expenseWallets;
const allowedCategories=expenseCategories;
type ExpenseActor=Pick<StaffActor,"employeeId">&{branchId?:string|null};
function respondText(env:Env,event:LineEvent,text:string,traceId:string):Promise<unknown>{
  return respondTextToLineEvent(env,event,text,{traceId,purpose:"EXPENSE_RESPONSE"});
}
function respondFlex(env:Env,event:LineEvent,message:unknown,traceId:string):Promise<unknown>{
  return respondFlexToLineEvent(env,event,message,{traceId,purpose:"EXPENSE_RESPONSE"});
}

function recordFromRow(row:ExpenseRow):ExpenseFlexRecord{return{
  expenseId:String(row.expense_id),description:String(row.description),amountSatang:Number(row.amount_satang),
  paymentKey:String(row.payment_key),sourceWallet:String(row.source_wallet),category:String(row.category),
  transactionDate:String(row.transaction_date),status:String(row.status),
  ...(row.document_type?{documentType:String(row.document_type)}:{}),...(row.channel?{channel:String(row.channel)}:{}),
  ...(row.institution?{institution:String(row.institution)}:{}),...(row.reference_id?{referenceId:String(row.reference_id)}:{}),
  ...(row.document_type?{grossAmountSatang:row.gross_amount_satang==null?null:Number(row.gross_amount_satang),discountAmountSatang:row.discount_amount_satang==null?null:Number(row.discount_amount_satang)}:{}),
  ...(row.review_note?{reviewNote:String(row.review_note)}:{})
};}
async function findExpense(env:Env,id:string,to:string):Promise<ExpenseFlexRecord|null>{
  const row=await env.DB.prepare(`SELECT * FROM expense_events WHERE expense_id=? AND line_user_id=? LIMIT 1`).bind(id,to).first<ExpenseRow>();
  if(!row)return null;
  const document=await env.DB.prepare(`SELECT document_type,channel,institution,reference_id,gross_amount_satang,discount_amount_satang,review_note FROM expense_documents WHERE expense_id=? LIMIT 1`).bind(id).first<ExpenseRow>();
  return recordFromRow(document?{...row,...document}:row);
}
async function findExpenseByMessage(env:Env,messageId:string,to:string):Promise<ExpenseFlexRecord|null>{
  const row=await env.DB.prepare(`SELECT * FROM expense_events WHERE message_id=? AND line_user_id=? LIMIT 1`).bind(messageId,to).first<ExpenseRow>();return row?recordFromRow(row):null;
}
async function showCurrent(env:Env,event:LineEvent,expense:ExpenseFlexRecord,traceId:string):Promise<void>{
  if(expense.status==="WAITING_CONFIRM")await respondFlex(env,event,buildExpenseSummaryFlex(expense),traceId);
  else if(expense.status==="CONFIRMED")await respondFlex(env,event,buildExpenseSavedFlex(expense),traceId);
  else await respondText(env,event,"This item was cancelled.",traceId);
}

function actorValues(actor?:ExpenseActor|undefined):{employeeId:string|null;branchId:string|null}{return{employeeId:actor?.employeeId||null,branchId:actor?.branchId||null};}
function expenseAudit(env:Env,input:{actor?:ExpenseActor|undefined;action:string;expenseId?:string|null;documentId?:string|null;before?:unknown;after?:unknown;reason?:string}){
  const actor=actorValues(input.actor),now=new Date().toISOString();
  return env.DB.prepare(`INSERT INTO expense_audit_log(audit_id,actor_employee_id,action,expense_id,document_id,branch_id,reason,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(randomId("exp_audit"),actor.employeeId,input.action,input.expenseId??null,input.documentId??null,actor.branchId,input.reason??"",input.before===undefined?null:JSON.stringify(input.before),input.after===undefined?null:JSON.stringify(input.after),now);
}

export async function handleExpenseText(env:Env,event:LineEvent,traceId:string,actor?:ExpenseActor):Promise<ExpenseTextOutcome>{
  const to=event.source.userId||"",messageId=event.message?.id||"",parsed=parseExpenseText(event.message?.text||"");
  if(!parsed){await respondText(env,event,["Invalid expense format. ❌","","Examples:","• Egg change 375","• Electricity transfer 1200","• Boxes kbank 350","• 28/01 Egg change 375"].join("\n"),traceId);return"REJECTED";}
  const id=randomId("exp"),status=parsed.quickSave?"CONFIRMED":"WAITING_CONFIRM",now=new Date().toISOString();
  const ownership=actorValues(actor);
  const inserted=await env.DB.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at,submitted_by_employee_id,branch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO NOTHING`).bind(id,messageId,to,parsed.description,parsed.amountSatang,parsed.paymentKey,parsed.sourceWallet,parsed.category,parsed.transactionDate,status,traceId,now,ownership.employeeId,ownership.branchId).run();
  let expense:ExpenseFlexRecord={expenseId:id,description:parsed.description,amountSatang:parsed.amountSatang,paymentKey:parsed.paymentKey,sourceWallet:parsed.sourceWallet,category:parsed.category,transactionDate:parsed.transactionDate,status};
  if(Number(inserted.meta.changes||0)===0){const existing=await findExpenseByMessage(env,messageId,to);if(!existing)throw new Error("Expense message conflict without an existing row");expense=existing;}
  if(Number(inserted.meta.changes||0)===1)await expenseAudit(env,{actor,action:"CREATE_DRAFT",expenseId:id,after:{source:"TEXT",status}}).run();
  if(expense.status==="CONFIRMED")await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"EXPENSE",entityKey:expense.expenseId,entityVersion:1,traceId});
  await showCurrent(env,event,expense,traceId);
  return expense.status==="CONFIRMED"?"CONFIRMED":expense.status==="WAITING_CONFIRM"?"WAITING_CONFIRM":"REJECTED";
}

function satangOrNull(value:number|null|undefined):number|null{return value==null||!Number.isFinite(value)?null:Math.round(value*100);}
function documentInsert(env:Env,args:unknown[]){return env.DB.prepare(`INSERT INTO expense_documents(
  document_id,message_id,line_user_id,document_type,image_key,status,ai_json,trace_id,created_at,
  channel,institution,transaction_type,transaction_status,payment_date,payment_time,reference_id,reference_key,
  sender,sender_account_masked,recipient,recipient_account_masked,merchant,gross_amount_satang,discount_amount_satang,
  paid_amount_satang,suggested_description,suggested_category,confidence,needs_review,review_note,image_hash,expense_id
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...args);}
async function findDuplicateDocument(env:Env,referenceKey:string,imageHash:string):Promise<ExpenseRow|null>{
  if(referenceKey)return env.DB.prepare(`SELECT document_id,expense_id,status FROM expense_documents WHERE reference_key=? OR image_hash=? LIMIT 1`).bind(referenceKey,imageHash).first<ExpenseRow>();
  return env.DB.prepare(`SELECT document_id,expense_id,status FROM expense_documents WHERE image_hash=? LIMIT 1`).bind(imageHash).first<ExpenseRow>();
}
async function pushDuplicateDocument(env:Env,event:LineEvent,duplicate:ExpenseRow|null,traceId:string):Promise<void>{
  const existing=duplicate?.document_id?`\nExisting review ID: ${String(duplicate.document_id)}`:"";
  await respondText(env,event,`Duplicate receipt not saved. ❌\nReason: This receipt reference or image is already in the system.${existing}\nAction: Do not submit the same receipt again.\nCode: BANK_SLIP_DUPLICATE`,traceId);
}
async function resumeDuplicateConfirmation(env:Env,event:LineEvent,duplicate:ExpenseRow|null,traceId:string):Promise<boolean>{
  const to=event.source.userId||"";
  if(String(duplicate?.status||"")!=="WAITING_CONFIRM"||!duplicate?.expense_id)return false;
  const expense=await findExpense(env,String(duplicate.expense_id),to);
  if(!expense||expense.status!=="WAITING_CONFIRM")return false;
  await respondFlex(env,event,buildExpenseSummaryFlex(expense),traceId);
  return true;
}

function isPurchaseDocument(document:VisionResult["document"]):document is PurchaseDocument{return!!document&&document.documentType!=="BANK_SLIP";}
async function findPurchaseDuplicate(env:Env,document:PurchaseDocument,imageHash:string):Promise<ExpenseRow|null>{
  const byImage=await findDuplicateDocument(env,"",imageHash);if(byImage)return byImage;
  const vendor=(document.legalVendorName||document.vendor).trim(),number=document.documentNumber.trim();
  if(vendor&&number){const duplicate=await env.DB.prepare(`SELECT document_id,expense_id,status FROM expense_documents WHERE legal_vendor_name=? AND document_number=? LIMIT 1`).bind(vendor,number).first<ExpenseRow>();if(duplicate)return duplicate;}
  return null;
}
async function findExactLinkedExpenseDocument(env:Env,document:PurchaseDocument):Promise<ExistingExpenseDocument|null>{
  const orderId=document.orderId.trim(),number=document.documentNumber.trim(),vendor=(document.legalVendorName||document.vendor).trim();
  let row:ExpenseRow|null=null;
  if(orderId)row=await env.DB.prepare(`SELECT document_id,expense_id,document_type,legal_vendor_name,document_number,order_id FROM expense_documents WHERE order_id=? ORDER BY created_at DESC LIMIT 1`).bind(orderId).first<ExpenseRow>();
  if(!row&&vendor&&number)row=await env.DB.prepare(`SELECT document_id,expense_id,document_type,legal_vendor_name,document_number,order_id FROM expense_documents WHERE legal_vendor_name=? AND document_number=? ORDER BY created_at DESC LIMIT 1`).bind(vendor,number).first<ExpenseRow>();
  if(!row)return null;
  const existing={documentId:String(row.document_id),expenseId:row.expense_id==null?null:String(row.expense_id),documentType:String(row.document_type),legalVendorName:String(row.legal_vendor_name||""),documentNumber:String(row.document_number||""),orderId:String(row.order_id||"")};
  return exactDocumentMatch(document,existing).matched?existing:null;
}
function purchaseDocumentUpdate(env:Env,documentId:string,document:PurchaseDocument,expenseId:string|null,actor?:ExpenseActor){
  const ownership=actorValues(actor);
  return env.DB.prepare(`UPDATE expense_documents SET vendor_name=?,legal_vendor_name=?,document_number=?,order_id=?,document_date=?,payment_date=?,payment_time=?,currency=?,subtotal_satang=?,shipping_satang=?,discount_amount_satang=?,subsidy_satang=?,vat_satang=?,gross_amount_satang=?,final_paid_satang=?,paid_amount_satang=?,suggested_description=?,suggested_category=?,confidence=?,needs_review=?,review_note=?,normalized_json=?,submitted_by_employee_id=?,branch_id=?,expense_id=?,updated_at=? WHERE document_id=?`).bind(
    document.vendor,document.legalVendorName,document.documentNumber,document.orderId,document.documentDate,document.paymentDate,document.paymentTime,document.currency,
    toSatang(document.subtotalBaht),toSatang(document.shippingBaht),toSatang(document.discountBaht),toSatang(document.subsidyBaht),toSatang(document.vatBaht),toSatang(document.grossAmountBaht),toSatang(document.finalPaidAmountBaht),toSatang(document.finalPaidAmountBaht),document.suggestedDescription,document.suggestedCategory,document.confidence,document.needsReview?1:0,document.reviewReasons.join("; "),JSON.stringify(document),ownership.employeeId,ownership.branchId,expenseId,new Date().toISOString(),documentId
  );
}
function itemInsert(env:Env,item:ReturnType<typeof documentItemStatements>[number]){return env.DB.prepare(`INSERT INTO expense_document_items(item_id,document_id,expense_id,seller_key,product_code,description,quantity,unit,unit_price_satang,discount_satang,line_total_satang,vat_satang,confidence,needs_review,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(item.itemId,item.documentId,item.expenseId,item.sellerKey,item.productCode,item.description,item.quantity,item.unit,item.unitPriceSatang,item.discountSatang,item.lineTotalSatang,item.vatSatang,item.confidence,item.needsReview,item.now,item.now);}
function sellerCaseInsert(env:Env,input:{documentId:string;sellerKey:string;vendorName:string;grossSatang:number|null;finalSatang:number|null;status:string;expenseId:string|null;now:string}){return env.DB.prepare(`INSERT INTO expense_document_cases(case_id,document_id,seller_key,vendor_name,gross_satang,final_paid_satang,status,expense_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(randomId("seller_case"),input.documentId,input.sellerKey,input.vendorName,input.grossSatang,input.finalSatang,input.status,input.expenseId,input.now,input.now);}
async function handlePurchaseImage(env:Env,event:LineEvent,document:PurchaseDocument,imageKey:string,traceId:string,imageHash:string,actor?:ExpenseActor):Promise<void>{
  const duplicate=await findPurchaseDuplicate(env,document,imageHash);if(duplicate){if(await resumeDuplicateConfirmation(env,event,duplicate,traceId))return;await pushDuplicateDocument(env,event,duplicate,traceId);return;}
  const to=event.source.userId||"",messageId=event.message?.id||"",documentId=randomId("doc"),now=new Date().toISOString(),sellerCases=sellerDocumentCases(document),multiSeller=sellerCases.length>1,draft=multiSeller?null:purchaseExpenseDraft(document),ownership=actorValues(actor);
  const exactMatch=await findExactLinkedExpenseDocument(env,document);
  if(exactMatch&&exactMatch.documentType!==document.documentType&&exactMatch.expenseId){
    const reviewReason=`Linked to an existing expense by ${document.orderId.trim()?"exact order ID":"exact vendor and document number"}.`;
    const base=[documentId,messageId,to,document.documentType,imageKey,"WAITING_REVIEW",JSON.stringify(document),traceId,now,null,null,null,null,document.paymentDate,document.paymentTime,null,null,null,null,null,null,document.vendor,null,null,toSatang(document.finalPaidAmountBaht),document.suggestedDescription,document.suggestedCategory,document.confidence,1,reviewReason,imageHash,null];
    await env.DB.batch([
      documentInsert(env,base),purchaseDocumentUpdate(env,documentId,document,null,actor),
      ...documentItemStatements(documentId,null,document.items,now,randomId).map(item=>itemInsert(env,item)),
      ...sellerCases.map(item=>sellerCaseInsert(env,{documentId,sellerKey:item.sellerKey,vendorName:item.vendorName,grossSatang:item.lineTotalSatang,finalSatang:item.lineTotalSatang,status:"WAITING_REVIEW",expenseId:null,now})),
      env.DB.prepare(`INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,linked_by_employee_id,reason,created_at) VALUES(?,?,?,?,'EXACT_IDENTIFIER',?,?,?)`).bind(randomId("doc_link"),exactMatch.expenseId,documentId,relationForIncomingDocument(document),ownership.employeeId,reviewReason,now),
      expenseAudit(env,{actor,action:"DOCUMENT_LINK",expenseId:exactMatch.expenseId,documentId,after:{relation:relationForIncomingDocument(document)},reason:reviewReason})
    ]);
    await respondText(env,event,`${document.documentType.replaceAll("_"," ")} received. ✅\nIt was linked to the existing purchase using a printed exact identifier. No second expense was created.`,traceId);return;
  }
  const reviewOnly=!draft,documentStatus=reviewOnly?"WAITING_REVIEW":"WAITING_CONFIRM",reviewReason=multiSeller?"Multiple sellers were detected. Each seller is kept as a separate review case; confirm the seller allocations before final posting.":reviewOnly?(document.documentType==="DELIVERY_ORDER"?"Delivery Order is supporting evidence; add payment evidence before finalizing.":"Missing final paid amount or payment date."):(draft.reviewReasons.join("; ")||"Please review visible document facts before saving.");
  const expenseId=draft?randomId("exp"):null;
  const base=[documentId,messageId,to,document.documentType,imageKey,documentStatus,JSON.stringify(document),traceId,now,null,null,null,null,document.paymentDate,document.paymentTime,null,null,null,null,null,null,document.vendor,null,null,toSatang(document.finalPaidAmountBaht),document.suggestedDescription,document.suggestedCategory,document.confidence,draft?.needsReview||document.needsReview?1:0,reviewReason,imageHash,expenseId];
  try{
    const statements=[documentInsert(env,base),purchaseDocumentUpdate(env,documentId,document,expenseId,actor),...documentItemStatements(documentId,expenseId,document.items,now,randomId).map(item=>itemInsert(env,item)),...sellerCases.map(item=>sellerCaseInsert(env,{documentId,sellerKey:item.sellerKey,vendorName:item.vendorName,grossSatang:item.lineTotalSatang,finalSatang:item.lineTotalSatang,status:draft?"WAITING_CONFIRM":"WAITING_REVIEW",expenseId,now}))];
    if(draft&&expenseId){
      statements.push(env.DB.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at,submitted_by_employee_id,branch_id) VALUES(?,?,?,?,?,?,?,?,?,'WAITING_CONFIRM',?,?,?,?,?)`).bind(expenseId,messageId,to,draft.description,draft.amountSatang,draft.paymentKey,draft.sourceWallet,draft.category,draft.transactionDate,traceId,now,ownership.employeeId,ownership.branchId));
      statements.push(env.DB.prepare(`INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,linked_by_employee_id,reason,created_at) VALUES(?,?,?,'PRIMARY_PURCHASE_DOCUMENT','EXACT_IDENTIFIER',?,?,?)`).bind(randomId("doc_link"),expenseId,documentId,ownership.employeeId,"Document creates draft",now));
      statements.push(expenseAudit(env,{actor,action:"CREATE_DRAFT",expenseId,documentId,after:{documentType:document.documentType,status:"WAITING_CONFIRM"},reason:reviewReason}));
    }else statements.push(expenseAudit(env,{actor,action:"EXTRACT",documentId,after:{documentType:document.documentType,status:"WAITING_REVIEW"},reason:reviewReason}));
    await env.DB.batch(statements);
  }catch(error){if(String(error).includes("UNIQUE")){const existing=await findPurchaseDuplicate(env,document,imageHash);if(await resumeDuplicateConfirmation(env,event,existing,traceId))return;await pushDuplicateDocument(env,event,existing,traceId);return;}throw error;}
  if(!draft){await respondText(env,event,`${document.documentType.replaceAll("_"," ")} received. ✅\nThis is supporting or incomplete evidence and has not been posted.\nReason: ${reviewReason}`,traceId);return;}
  await respondFlex(env,event,buildExpenseSummaryFlex({expenseId:expenseId!,...draft,status:"WAITING_CONFIRM",documentType:document.documentType,grossAmountSatang:toSatang(document.grossAmountBaht),discountAmountSatang:toSatang(document.discountBaht),reviewNote:reviewReason}),traceId);
}

export async function handleExpenseImage(env:Env,event:LineEvent,reading:VisionResult,imageKey:string,traceId:string,imageHash:string,actor?:ExpenseActor):Promise<void>{
  if(isPurchaseDocument(reading.document))return handlePurchaseImage(env,event,reading.document,imageKey,traceId,imageHash,actor);
  const to=event.source.userId||"",messageId=event.message?.id||"",document=reading.kind==="BANK_SLIP"?reading.document:null,referenceKey=document?bankSlipReferenceKey(document as BankSlipDocument):"",duplicate=await findDuplicateDocument(env,referenceKey,imageHash);
  if(duplicate){if(await resumeDuplicateConfirmation(env,event,duplicate,traceId))return;await pushDuplicateDocument(env,event,duplicate,traceId);return;}
  const documentId=randomId("doc"),now=new Date().toISOString();
  if(!document){
    try{await documentInsert(env,[documentId,messageId,to,reading.kind,imageKey,"WAITING_REVIEW",JSON.stringify(reading.raw),traceId,now,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,reading.confidence,1,reading.note||"Detailed receipt accounting is not enabled for this document type.",imageHash,null]).run();}
    catch(error){if(String(error).includes("UNIQUE")){await pushDuplicateDocument(env,event,await findDuplicateDocument(env,"",imageHash),traceId);return;}throw error;}
    await respondText(env,event,`${reading.kind} image received. ✅\nReview queue ID: ${documentId}\nReason: This document is not a supported bank or wallet payment receipt for automatic posting.\nAction: Review it manually before recording an amount.`,traceId);return;
  }
  const validation=validateBankSlip(reading),ownership=actorValues(actor),documentArgs=[documentId,messageId,to,"BANK_SLIP",imageKey,validation.ok?"WAITING_CONFIRM":"WAITING_REVIEW",JSON.stringify(document),traceId,now,document.channel,document.institution,document.transactionType,document.transactionStatus,document.paymentDate,document.paymentTime,document.referenceId,referenceKey,document.sender,document.senderAccountMasked,document.recipient,document.recipientAccountMasked,document.merchant,satangOrNull(document.grossAmountBaht),satangOrNull(document.discountAmountBaht),satangOrNull(document.paidAmountBaht),document.suggestedDescription,document.suggestedCategory,document.confidence,validation.review?1:0,validation.note,imageHash,null];
  if(!validation.ok){
    try{await documentInsert(env,documentArgs).run();}
    catch(error){if(String(error).includes("UNIQUE")){await pushDuplicateDocument(env,event,await findDuplicateDocument(env,referenceKey,imageHash),traceId);return;}throw error;}
    await respondText(env,event,`Bank or wallet receipt not saved. ❌\nReason: ${validation.note}\nReview queue ID: ${documentId}\nAction: Send a clear full receipt showing successful status, date, reference ID, recipient or merchant, and final paid amount.\nCode: ${validation.code}`,traceId);return;
  }
  const expenseId=randomId("exp"),draft=bankSlipExpenseDraft(document);documentArgs[31]=expenseId;
  try{await env.DB.batch([
    documentInsert(env,documentArgs),
    env.DB.prepare(`UPDATE expense_documents SET submitted_by_employee_id=?,branch_id=?,normalized_json=?,currency='THB',final_paid_satang=?,updated_at=? WHERE document_id=?`).bind(ownership.employeeId,ownership.branchId,JSON.stringify(document),satangOrNull(document.paidAmountBaht),now,documentId),
    env.DB.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at,submitted_by_employee_id,branch_id) VALUES(?,?,?,?,?,?,?,?,?,'WAITING_CONFIRM',?,?,?,?,?)`).bind(expenseId,messageId,to,draft.description,draft.amountSatang,draft.paymentKey,draft.sourceWallet,draft.category,draft.transactionDate,traceId,now,ownership.employeeId,ownership.branchId),
    env.DB.prepare(`INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,linked_by_employee_id,reason,created_at) VALUES(?,?,?,'PAYMENT_EVIDENCE','EXACT_IDENTIFIER',?,?,?)`).bind(randomId("doc_link"),expenseId,documentId,ownership.employeeId,"Bank or wallet payment evidence",now),
    expenseAudit(env,{actor,action:"CREATE_DRAFT",expenseId,documentId,after:{documentType:"BANK_SLIP",status:"WAITING_CONFIRM"}})
  ]);}catch(error){if(String(error).includes("UNIQUE")){const existing=await findDuplicateDocument(env,referenceKey,imageHash);if(await resumeDuplicateConfirmation(env,event,existing,traceId))return;await pushDuplicateDocument(env,event,existing,traceId);return;}throw error;}
  await respondFlex(env,event,buildExpenseSummaryFlex({expenseId,...draft,status:"WAITING_CONFIRM",documentType:"BANK_SLIP",channel:document.channel,institution:document.institution,referenceId:document.referenceId,grossAmountSatang:satangOrNull(document.grossAmountBaht),discountAmountSatang:satangOrNull(document.discountAmountBaht)}),traceId);
}

export async function handleExpensePostback(env:Env,event:LineEvent,actor:Employee,accessActor?:ExpenseActor):Promise<void>{
  const q=new URLSearchParams(event.postback?.data||""),action=q.get("a")||"",id=q.get("id")||"",to=event.source.userId||"",traceId=`postback_${id||"unknown"}`;
  if(!actor.canSubmitExpense){await respondText(env,event,"You are not authorized to manage expenses.",traceId);return;}
  const expense=id?await findExpense(env,id,to):null;if(!expense){await respondText(env,event,"Item not found, or this menu has expired.",traceId);return;}

  if(action==="expense_confirm"){
    if(expense.status==="CANCELLED"){await showCurrent(env,event,expense,traceId);return;}
    if(expense.status==="WAITING_CONFIRM"){
      if(expense.paymentKey==="unconfirmed"||expense.sourceWallet==="UNCONFIRMED"){await respondText(env,event,"Please choose the actual payment method and source before saving this document.",traceId);await respondFlex(env,event,buildExpensePaymentFlex(expense),traceId);return;}
      const reviewer=actorValues(accessActor||actor),confirmedAt=new Date().toISOString();
      await env.DB.prepare(`UPDATE expense_events SET status='CONFIRMED',reviewed_by_employee_id=?,approved_at=?,updated_at=? WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(reviewer.employeeId,confirmedAt,confirmedAt,id,to).run();expense.status="CONFIRMED";
      await env.DB.prepare(`UPDATE expense_documents SET status='CONFIRMED',updated_at=? WHERE expense_id=? AND status='WAITING_CONFIRM'`).bind(new Date().toISOString(),id).run();
      await expenseAudit(env,{actor:accessActor||actor,action:"CONFIRM",expenseId:id,before:{status:"WAITING_CONFIRM"},after:{status:"CONFIRMED"}}).run();
    }
    await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"EXPENSE",entityKey:id,entityVersion:1,traceId});await respondFlex(env,event,buildExpenseSavedFlex(expense),traceId);return;
  }
  if(action==="expense_cancel"){
    const changed=await env.DB.prepare(`UPDATE expense_events SET status='CANCELLED',updated_at=? WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(new Date().toISOString(),id,to).run();
    if(Number(changed.meta.changes||0)===1){await env.DB.prepare(`UPDATE expense_documents SET status='CANCELLED',updated_at=? WHERE expense_id=? AND status='WAITING_CONFIRM'`).bind(new Date().toISOString(),id).run();await expenseAudit(env,{actor:accessActor||actor,action:"CANCEL",expenseId:id,before:{status:"WAITING_CONFIRM"},after:{status:"CANCELLED"}}).run();}
    await respondText(env,event,Number(changed.meta.changes||0)===1?"Expense cancelled. ✅":"This item has already been saved or cancelled.",traceId);return;
  }
  if(action==="expense_undo"){
    const changed=await env.DB.prepare(`UPDATE expense_events SET status='CANCELLED',updated_at=? WHERE expense_id=? AND line_user_id=? AND status='CONFIRMED'`).bind(new Date().toISOString(),id,to).run();
    if(Number(changed.meta.changes||0)===1){await env.DB.prepare(`UPDATE expense_documents SET status='CANCELLED',updated_at=? WHERE expense_id=? AND status='CONFIRMED'`).bind(new Date().toISOString(),id).run();await expenseAudit(env,{actor:accessActor||actor,action:"UNDO",expenseId:id,before:{status:"CONFIRMED"},after:{status:"CANCELLED"}}).run();await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"EXPENSE",entityKey:id,entityVersion:2,traceId});await respondText(env,event,"Expense entry undone. ↩️\nThe original record remains in the audit history, and its status has been updated in Google Sheets.",traceId);}else await respondText(env,event,"This item is already cancelled or cannot be undone.",traceId);return;
  }
  if(expense.status!=="WAITING_CONFIRM"){await showCurrent(env,event,expense,traceId);return;}
  if(action==="expense_back"){await respondFlex(env,event,buildExpenseSummaryFlex(expense),traceId);return;}
  if(action==="expense_payment_menu"){if(expense.documentType==="BANK_SLIP")await respondFlex(env,event,buildExpenseSummaryFlex(expense),traceId);else await respondFlex(env,event,buildExpensePaymentFlex(expense),traceId);return;}
  if(action==="expense_source_menu"){if(expense.documentType==="BANK_SLIP")await respondFlex(env,event,buildExpenseSummaryFlex(expense),traceId);else await respondFlex(env,event,buildExpenseSourceFlex(expense),traceId);return;}
  if(action==="expense_category_menu"){await respondFlex(env,event,buildExpenseCategoryFlex(expense),traceId);return;}
  if(action==="expense_date_menu"){await respondFlex(env,event,buildExpenseDateFlex(expense),traceId);return;}
  if(action==="expense_set_payment"){
    if(expense.documentType==="BANK_SLIP"){await respondFlex(env,event,buildExpenseSummaryFlex(expense),traceId);return;}
    const payment=q.get("payment")||"";if(!allowedPayments.has(payment))throw new Error("Invalid expense payment");expense.paymentKey=payment;expense.sourceWallet=paymentWallet(payment);
    await env.DB.prepare(`UPDATE expense_events SET payment_key=?,source_wallet=?,updated_at=? WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(expense.paymentKey,expense.sourceWallet,new Date().toISOString(),id,to).run();await expenseAudit(env,{actor:accessActor||actor,action:"EDIT",expenseId:id,after:{paymentKey:expense.paymentKey,sourceWallet:expense.sourceWallet}}).run();await respondFlex(env,event,buildExpenseSummaryFlex(expense),traceId);return;
  }
  if(action==="expense_set_source"){
    if(expense.documentType==="BANK_SLIP"){await respondFlex(env,event,buildExpenseSummaryFlex(expense),traceId);return;}
    const source=q.get("source")||"";if(!allowedSources.has(source))throw new Error("Invalid expense source");expense.sourceWallet=source;expense.paymentKey=paymentForWallet(source,expense.paymentKey);
    await env.DB.prepare(`UPDATE expense_events SET payment_key=?,source_wallet=?,updated_at=? WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(expense.paymentKey,expense.sourceWallet,new Date().toISOString(),id,to).run();await expenseAudit(env,{actor:accessActor||actor,action:"EDIT",expenseId:id,after:{paymentKey:expense.paymentKey,sourceWallet:expense.sourceWallet}}).run();await respondFlex(env,event,buildExpenseSummaryFlex(expense),traceId);return;
  }
  if(action==="expense_set_category"){
    const category=q.get("category")||"";if(!allowedCategories.has(category))throw new Error("Invalid expense category");expense.category=category;
    await env.DB.prepare(`UPDATE expense_events SET category=?,updated_at=? WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(category,new Date().toISOString(),id,to).run();await expenseAudit(env,{actor:accessActor||actor,action:"EDIT",expenseId:id,after:{category}}).run();await respondFlex(env,event,buildExpenseSummaryFlex(expense),traceId);return;
  }
  if(action==="expense_set_date_rel"){
    const days=Math.min(1,Math.max(0,Number(q.get("days")||0)));expense.transactionDate=addDays(isoDateInBangkok(),-days);
    await env.DB.prepare(`UPDATE expense_events SET transaction_date=?,updated_at=? WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(expense.transactionDate,new Date().toISOString(),id,to).run();await expenseAudit(env,{actor:accessActor||actor,action:"EDIT",expenseId:id,after:{transactionDate:expense.transactionDate}}).run();await respondFlex(env,event,buildExpenseSummaryFlex(expense),traceId);return;
  }
  if(action==="expense_set_date"){
    const date=event.postback?.params?.date||"";if(!isIsoDate(date))throw new Error("Invalid expense date");expense.transactionDate=date;
    await env.DB.prepare(`UPDATE expense_events SET transaction_date=?,updated_at=? WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(date,new Date().toISOString(),id,to).run();await expenseAudit(env,{actor:accessActor||actor,action:"EDIT",expenseId:id,after:{transactionDate:date}}).run();await respondFlex(env,event,buildExpenseSummaryFlex(expense),traceId);return;
  }
  await respondText(env,event,"Unknown command. Please send the expense again.",traceId);
}
