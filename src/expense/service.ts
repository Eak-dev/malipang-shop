import { enqueueSheetSync } from "../db/repositories";
import { pushFlex,pushText } from "../line/api";
import { randomId } from "../shared/ids";
import { addDays,isIsoDate,isoDateInBangkok } from "../shared/time";
import type { Employee,Env,LineEvent,VisionResult } from "../types";
import {
  buildExpenseCategoryFlex,buildExpenseDateFlex,buildExpensePaymentFlex,buildExpenseSavedFlex,
  buildExpenseSourceFlex,buildExpenseSummaryFlex,paymentForWallet,paymentWallet,type ExpenseFlexRecord
} from "./flex";
import { bankSlipExpenseDraft,bankSlipReferenceKey,validateBankSlip } from "./bank-slip";
import { parseExpenseText } from "./text-parser";

type ExpenseRow=Record<string,unknown>;
export type ExpenseTextOutcome="CONFIRMED"|"WAITING_CONFIRM"|"REJECTED";
const allowedPayments=new Set(["cash","transfer","kbank","firstchoice","aeon","citibank","ttb","homepro","t1"]);
const allowedSources=new Set(["CASH_DRAWER","SHOP_BANK","CARD_KBANK","CARD_FIRST_CHOICE","CARD_AEON","CARD_CITIBANK","CARD_TTB","CARD_HOMEPRO","CARD_THE1"]);
const allowedCategories=new Set(["ingredients","fillings","packaging","gas","utilities","rent","staff","transport","marketing","equipment","cleaning","bank_fee","general"]);

function recordFromRow(row:ExpenseRow):ExpenseFlexRecord{return{
  expenseId:String(row.expense_id),description:String(row.description),amountSatang:Number(row.amount_satang),
  paymentKey:String(row.payment_key),sourceWallet:String(row.source_wallet),category:String(row.category),
  transactionDate:String(row.transaction_date),status:String(row.status),
  ...(row.document_type?{documentType:String(row.document_type)}:{}),...(row.channel?{channel:String(row.channel)}:{}),
  ...(row.institution?{institution:String(row.institution)}:{}),...(row.reference_id?{referenceId:String(row.reference_id)}:{}),
  ...(row.document_type?{grossAmountSatang:row.gross_amount_satang==null?null:Number(row.gross_amount_satang),discountAmountSatang:row.discount_amount_satang==null?null:Number(row.discount_amount_satang)}:{})
};}
async function findExpense(env:Env,id:string,to:string):Promise<ExpenseFlexRecord|null>{
  const row=await env.DB.prepare(`SELECT * FROM expense_events WHERE expense_id=? AND line_user_id=? LIMIT 1`).bind(id,to).first<ExpenseRow>();
  if(!row)return null;
  const document=await env.DB.prepare(`SELECT document_type,channel,institution,reference_id,gross_amount_satang,discount_amount_satang FROM expense_documents WHERE expense_id=? LIMIT 1`).bind(id).first<ExpenseRow>();
  return recordFromRow(document?{...row,...document}:row);
}
async function findExpenseByMessage(env:Env,messageId:string,to:string):Promise<ExpenseFlexRecord|null>{
  const row=await env.DB.prepare(`SELECT * FROM expense_events WHERE message_id=? AND line_user_id=? LIMIT 1`).bind(messageId,to).first<ExpenseRow>();return row?recordFromRow(row):null;
}
async function showCurrent(env:Env,to:string,expense:ExpenseFlexRecord,traceId:string):Promise<void>{
  if(expense.status==="WAITING_CONFIRM")await pushFlex(env,to,buildExpenseSummaryFlex(expense),traceId);
  else if(expense.status==="CONFIRMED")await pushFlex(env,to,buildExpenseSavedFlex(expense),traceId);
  else await pushText(env,to,"This item was cancelled.",traceId);
}

export async function handleExpenseText(env:Env,event:LineEvent,traceId:string):Promise<ExpenseTextOutcome>{
  const to=event.source.userId||"",messageId=event.message?.id||"",parsed=parseExpenseText(event.message?.text||"");
  if(!parsed){await pushText(env,to,["Invalid expense format. ❌","","Examples:","• Egg change 375","• Electricity transfer 1200","• Boxes kbank 350","• 28/01 Egg change 375"].join("\n"),traceId);return"REJECTED";}
  const id=randomId("exp"),status=parsed.quickSave?"CONFIRMED":"WAITING_CONFIRM",now=new Date().toISOString();
  const inserted=await env.DB.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO NOTHING`).bind(id,messageId,to,parsed.description,parsed.amountSatang,parsed.paymentKey,parsed.sourceWallet,parsed.category,parsed.transactionDate,status,traceId,now).run();
  let expense:ExpenseFlexRecord={expenseId:id,description:parsed.description,amountSatang:parsed.amountSatang,paymentKey:parsed.paymentKey,sourceWallet:parsed.sourceWallet,category:parsed.category,transactionDate:parsed.transactionDate,status};
  if(Number(inserted.meta.changes||0)===0){const existing=await findExpenseByMessage(env,messageId,to);if(!existing)throw new Error("Expense message conflict without an existing row");expense=existing;}
  if(expense.status==="CONFIRMED")await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"EXPENSE",entityKey:expense.expenseId,entityVersion:1,traceId});
  await showCurrent(env,to,expense,traceId);
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
async function pushDuplicateDocument(env:Env,to:string,duplicate:ExpenseRow|null,traceId:string):Promise<void>{
  const existing=duplicate?.document_id?`\nExisting review ID: ${String(duplicate.document_id)}`:"";
  await pushText(env,to,`Duplicate receipt not saved. ❌\nReason: This receipt reference or image is already in the system.${existing}\nAction: Do not submit the same receipt again.\nCode: BANK_SLIP_DUPLICATE`,traceId);
}

export async function handleExpenseImage(env:Env,event:LineEvent,reading:VisionResult,imageKey:string,traceId:string,imageHash:string):Promise<void>{
  const to=event.source.userId||"",messageId=event.message?.id||"",document=reading.kind==="BANK_SLIP"?reading.document:null,referenceKey=document?bankSlipReferenceKey(document):"",duplicate=await findDuplicateDocument(env,referenceKey,imageHash);
  if(duplicate){await pushDuplicateDocument(env,to,duplicate,traceId);return;}
  const documentId=randomId("doc"),now=new Date().toISOString();
  if(!document){
    try{await documentInsert(env,[documentId,messageId,to,reading.kind,imageKey,"WAITING_REVIEW",JSON.stringify(reading.raw),traceId,now,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,reading.confidence,1,reading.note||"Detailed receipt accounting is not enabled for this document type.",imageHash,null]).run();}
    catch(error){if(String(error).includes("UNIQUE")){await pushDuplicateDocument(env,to,await findDuplicateDocument(env,"",imageHash),traceId);return;}throw error;}
    await pushText(env,to,`${reading.kind} image received. ✅\nReview queue ID: ${documentId}\nReason: This document is not a supported bank or wallet payment receipt for automatic posting.\nAction: Review it manually before recording an amount.`,traceId);return;
  }
  const validation=validateBankSlip(reading),documentArgs=[documentId,messageId,to,"BANK_SLIP",imageKey,validation.ok?"WAITING_CONFIRM":"WAITING_REVIEW",JSON.stringify(document),traceId,now,document.channel,document.institution,document.transactionType,document.transactionStatus,document.paymentDate,document.paymentTime,document.referenceId,referenceKey,document.sender,document.senderAccountMasked,document.recipient,document.recipientAccountMasked,document.merchant,satangOrNull(document.grossAmountBaht),satangOrNull(document.discountAmountBaht),satangOrNull(document.paidAmountBaht),document.suggestedDescription,document.suggestedCategory,document.confidence,validation.review?1:0,validation.note,imageHash,null];
  if(!validation.ok){
    try{await documentInsert(env,documentArgs).run();}
    catch(error){if(String(error).includes("UNIQUE")){await pushDuplicateDocument(env,to,await findDuplicateDocument(env,referenceKey,imageHash),traceId);return;}throw error;}
    await pushText(env,to,`Bank or wallet receipt not saved. ❌\nReason: ${validation.note}\nReview queue ID: ${documentId}\nAction: Send a clear full receipt showing successful status, date, reference ID, recipient or merchant, and final paid amount.\nCode: ${validation.code}`,traceId);return;
  }
  const expenseId=randomId("exp"),draft=bankSlipExpenseDraft(document);documentArgs[31]=expenseId;
  try{await env.DB.batch([
    documentInsert(env,documentArgs),
    env.DB.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,'WAITING_CONFIRM',?,?)`).bind(expenseId,messageId,to,draft.description,draft.amountSatang,draft.paymentKey,draft.sourceWallet,draft.category,draft.transactionDate,traceId,now)
  ]);}catch(error){if(String(error).includes("UNIQUE")){await pushDuplicateDocument(env,to,await findDuplicateDocument(env,referenceKey,imageHash),traceId);return;}throw error;}
  await pushFlex(env,to,buildExpenseSummaryFlex({expenseId,...draft,status:"WAITING_CONFIRM",documentType:"BANK_SLIP",channel:document.channel,institution:document.institution,referenceId:document.referenceId,grossAmountSatang:satangOrNull(document.grossAmountBaht),discountAmountSatang:satangOrNull(document.discountAmountBaht)}),traceId);
}

export async function handleExpensePostback(env:Env,event:LineEvent,actor:Employee):Promise<void>{
  const q=new URLSearchParams(event.postback?.data||""),action=q.get("a")||"",id=q.get("id")||"",to=event.source.userId||"",traceId=`postback_${id||"unknown"}`;
  if(!actor.canSubmitExpense){await pushText(env,to,"You are not authorized to manage expenses.",traceId);return;}
  const expense=id?await findExpense(env,id,to):null;if(!expense){await pushText(env,to,"Item not found, or this menu has expired.",traceId);return;}

  if(action==="expense_confirm"){
    if(expense.status==="CANCELLED"){await showCurrent(env,to,expense,traceId);return;}
    if(expense.status==="WAITING_CONFIRM"){
      await env.DB.prepare(`UPDATE expense_events SET status='CONFIRMED',updated_at=? WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(new Date().toISOString(),id,to).run();expense.status="CONFIRMED";
      await env.DB.prepare(`UPDATE expense_documents SET status='CONFIRMED',updated_at=? WHERE expense_id=? AND status='WAITING_CONFIRM'`).bind(new Date().toISOString(),id).run();
    }
    await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"EXPENSE",entityKey:id,entityVersion:1,traceId});await pushFlex(env,to,buildExpenseSavedFlex(expense),traceId);return;
  }
  if(action==="expense_cancel"){
    const changed=await env.DB.prepare(`UPDATE expense_events SET status='CANCELLED',updated_at=? WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(new Date().toISOString(),id,to).run();
    if(Number(changed.meta.changes||0)===1)await env.DB.prepare(`UPDATE expense_documents SET status='CANCELLED',updated_at=? WHERE expense_id=? AND status='WAITING_CONFIRM'`).bind(new Date().toISOString(),id).run();
    await pushText(env,to,Number(changed.meta.changes||0)===1?"Expense cancelled. ✅":"This item has already been saved or cancelled.",traceId);return;
  }
  if(action==="expense_undo"){
    const changed=await env.DB.prepare(`UPDATE expense_events SET status='CANCELLED',updated_at=? WHERE expense_id=? AND line_user_id=? AND status='CONFIRMED'`).bind(new Date().toISOString(),id,to).run();
    if(Number(changed.meta.changes||0)===1){await env.DB.prepare(`UPDATE expense_documents SET status='CANCELLED',updated_at=? WHERE expense_id=? AND status='CONFIRMED'`).bind(new Date().toISOString(),id).run();await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"EXPENSE",entityKey:id,entityVersion:2,traceId});await pushText(env,to,"Expense entry undone. ↩️\nThe original record remains in the audit history, and its status has been updated in Google Sheets.",traceId);}else await pushText(env,to,"This item is already cancelled or cannot be undone.",traceId);return;
  }
  if(expense.status!=="WAITING_CONFIRM"){await showCurrent(env,to,expense,traceId);return;}
  if(action==="expense_back"){await pushFlex(env,to,buildExpenseSummaryFlex(expense),traceId);return;}
  if(action==="expense_payment_menu"){if(expense.documentType==="BANK_SLIP")await pushFlex(env,to,buildExpenseSummaryFlex(expense),traceId);else await pushFlex(env,to,buildExpensePaymentFlex(expense),traceId);return;}
  if(action==="expense_source_menu"){if(expense.documentType==="BANK_SLIP")await pushFlex(env,to,buildExpenseSummaryFlex(expense),traceId);else await pushFlex(env,to,buildExpenseSourceFlex(expense),traceId);return;}
  if(action==="expense_category_menu"){await pushFlex(env,to,buildExpenseCategoryFlex(expense),traceId);return;}
  if(action==="expense_date_menu"){await pushFlex(env,to,buildExpenseDateFlex(expense),traceId);return;}
  if(action==="expense_set_payment"){
    if(expense.documentType==="BANK_SLIP"){await pushFlex(env,to,buildExpenseSummaryFlex(expense),traceId);return;}
    const payment=q.get("payment")||"";if(!allowedPayments.has(payment))throw new Error("Invalid expense payment");expense.paymentKey=payment;expense.sourceWallet=paymentWallet(payment);
    await env.DB.prepare(`UPDATE expense_events SET payment_key=?,source_wallet=?,updated_at=? WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(expense.paymentKey,expense.sourceWallet,new Date().toISOString(),id,to).run();await pushFlex(env,to,buildExpenseSummaryFlex(expense),traceId);return;
  }
  if(action==="expense_set_source"){
    if(expense.documentType==="BANK_SLIP"){await pushFlex(env,to,buildExpenseSummaryFlex(expense),traceId);return;}
    const source=q.get("source")||"";if(!allowedSources.has(source))throw new Error("Invalid expense source");expense.sourceWallet=source;expense.paymentKey=paymentForWallet(source,expense.paymentKey);
    await env.DB.prepare(`UPDATE expense_events SET payment_key=?,source_wallet=?,updated_at=? WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(expense.paymentKey,expense.sourceWallet,new Date().toISOString(),id,to).run();await pushFlex(env,to,buildExpenseSummaryFlex(expense),traceId);return;
  }
  if(action==="expense_set_category"){
    const category=q.get("category")||"";if(!allowedCategories.has(category))throw new Error("Invalid expense category");expense.category=category;
    await env.DB.prepare(`UPDATE expense_events SET category=?,updated_at=? WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(category,new Date().toISOString(),id,to).run();await pushFlex(env,to,buildExpenseSummaryFlex(expense),traceId);return;
  }
  if(action==="expense_set_date_rel"){
    const days=Math.min(1,Math.max(0,Number(q.get("days")||0)));expense.transactionDate=addDays(isoDateInBangkok(),-days);
    await env.DB.prepare(`UPDATE expense_events SET transaction_date=?,updated_at=? WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(expense.transactionDate,new Date().toISOString(),id,to).run();await pushFlex(env,to,buildExpenseSummaryFlex(expense),traceId);return;
  }
  if(action==="expense_set_date"){
    const date=event.postback?.params?.date||"";if(!isIsoDate(date))throw new Error("Invalid expense date");expense.transactionDate=date;
    await env.DB.prepare(`UPDATE expense_events SET transaction_date=?,updated_at=? WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(date,new Date().toISOString(),id,to).run();await pushFlex(env,to,buildExpenseSummaryFlex(expense),traceId);return;
  }
  await pushText(env,to,"Unknown command. Please send the expense again.",traceId);
}
