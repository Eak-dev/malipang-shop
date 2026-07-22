import { enqueueSheetSync } from "../db/repositories";
import { pushFlex,pushText } from "../line/api";
import { randomId } from "../shared/ids";
import { addDays,isIsoDate,isoDateInBangkok } from "../shared/time";
import type { Employee,Env,LineEvent,VisionResult } from "../types";
import {
  buildExpenseCategoryFlex,buildExpenseDateFlex,buildExpensePaymentFlex,buildExpenseSavedFlex,
  buildExpenseSourceFlex,buildExpenseSummaryFlex,paymentForWallet,paymentWallet,type ExpenseFlexRecord
} from "./flex";
import { parseExpenseText } from "./text-parser";

type ExpenseRow=Record<string,unknown>;
export type ExpenseTextOutcome="CONFIRMED"|"WAITING_CONFIRM"|"REJECTED";
const allowedPayments=new Set(["cash","transfer","kbank","firstchoice","aeon","citibank","ttb","homepro","t1"]);
const allowedSources=new Set(["CASH_DRAWER","SHOP_BANK","CARD_KBANK","CARD_FIRST_CHOICE","CARD_AEON","CARD_CITIBANK","CARD_TTB","CARD_HOMEPRO","CARD_THE1"]);
const allowedCategories=new Set(["ingredients","fillings","packaging","gas","utilities","rent","staff","transport","marketing","equipment","cleaning","bank_fee","general"]);

function recordFromRow(row:ExpenseRow):ExpenseFlexRecord{return{
  expenseId:String(row.expense_id),description:String(row.description),amountSatang:Number(row.amount_satang),
  paymentKey:String(row.payment_key),sourceWallet:String(row.source_wallet),category:String(row.category),
  transactionDate:String(row.transaction_date),status:String(row.status)
};}
async function findExpense(env:Env,id:string,to:string):Promise<ExpenseFlexRecord|null>{
  const row=await env.DB.prepare(`SELECT * FROM expense_events WHERE expense_id=? AND line_user_id=? LIMIT 1`).bind(id,to).first<ExpenseRow>();return row?recordFromRow(row):null;
}
async function findExpenseByMessage(env:Env,messageId:string,to:string):Promise<ExpenseFlexRecord|null>{
  const row=await env.DB.prepare(`SELECT * FROM expense_events WHERE message_id=? AND line_user_id=? LIMIT 1`).bind(messageId,to).first<ExpenseRow>();return row?recordFromRow(row):null;
}
async function showCurrent(env:Env,to:string,expense:ExpenseFlexRecord,traceId:string):Promise<void>{
  if(expense.status==="WAITING_CONFIRM")await pushFlex(env,to,buildExpenseSummaryFlex(expense),traceId);
  else if(expense.status==="CONFIRMED")await pushFlex(env,to,buildExpenseSavedFlex(expense),traceId);
  else await pushText(env,to,"รายการนี้ถูกยกเลิกแล้วค่ะ / This item was cancelled.",traceId);
}

export async function handleExpenseText(env:Env,event:LineEvent,traceId:string):Promise<ExpenseTextOutcome>{
  const to=event.source.userId||"",messageId=event.message?.id||"",parsed=parseExpenseText(event.message?.text||"");
  if(!parsed){await pushText(env,to,["รูปแบบไม่ถูกต้องค่ะ ❌ / Invalid format","","ตัวอย่าง / Examples:","• ไข่ ทอน 375","• ค่าไฟ โอน 1200","• กล่อง kbank 350","• 28/01 Egg change 375"].join("\n"),traceId);return"REJECTED";}
  const id=randomId("exp"),status=parsed.quickSave?"CONFIRMED":"WAITING_CONFIRM",now=new Date().toISOString();
  const inserted=await env.DB.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO NOTHING`).bind(id,messageId,to,parsed.description,parsed.amountSatang,parsed.paymentKey,parsed.sourceWallet,parsed.category,parsed.transactionDate,status,traceId,now).run();
  let expense:ExpenseFlexRecord={expenseId:id,description:parsed.description,amountSatang:parsed.amountSatang,paymentKey:parsed.paymentKey,sourceWallet:parsed.sourceWallet,category:parsed.category,transactionDate:parsed.transactionDate,status};
  if(Number(inserted.meta.changes||0)===0){const existing=await findExpenseByMessage(env,messageId,to);if(!existing)throw new Error("Expense message conflict without an existing row");expense=existing;}
  if(expense.status==="CONFIRMED")await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"EXPENSE",entityKey:expense.expenseId,entityVersion:1,traceId});
  await showCurrent(env,to,expense,traceId);
  return expense.status==="CONFIRMED"?"CONFIRMED":expense.status==="WAITING_CONFIRM"?"WAITING_CONFIRM":"REJECTED";
}

export async function handleExpenseImage(env:Env,event:LineEvent,reading:VisionResult,imageKey:string,traceId:string):Promise<void>{
  const to=event.source.userId||"",id=randomId("doc");await env.DB.prepare(`INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,image_key,status,ai_json,trace_id,created_at) VALUES(?,?,?,?,?,'WAITING_REVIEW',?,?,?)`).bind(id,event.message?.id||"",to,reading.kind,imageKey,JSON.stringify(reading.raw),traceId,new Date().toISOString()).run();
  await pushText(env,to,`รับรูป ${reading.kind} แล้วค่ะ ✅\nเก็บในคิวตรวจเลขที่ ${id}\nรุ่นนี้จะไม่ลงยอดจากรูปอัตโนมัติเพื่อป้องกันยอดผิด`,traceId);
}

export async function handleExpensePostback(env:Env,event:LineEvent,actor:Employee):Promise<void>{
  const q=new URLSearchParams(event.postback?.data||""),action=q.get("a")||"",id=q.get("id")||"",to=event.source.userId||"",traceId=`postback_${id||"unknown"}`;
  if(!actor.canSubmitExpense){await pushText(env,to,"ไม่มีสิทธิ์จัดการค่าใช้จ่ายค่ะ",traceId);return;}
  const expense=id?await findExpense(env,id,to):null;if(!expense){await pushText(env,to,"ไม่พบรายการ หรือเมนูหมดอายุแล้วค่ะ / Item not found.",traceId);return;}

  if(action==="expense_confirm"){
    if(expense.status==="CANCELLED"){await showCurrent(env,to,expense,traceId);return;}
    if(expense.status==="WAITING_CONFIRM"){
      await env.DB.prepare(`UPDATE expense_events SET status='CONFIRMED',updated_at=? WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(new Date().toISOString(),id,to).run();expense.status="CONFIRMED";
    }
    await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"EXPENSE",entityKey:id,entityVersion:1,traceId});await pushFlex(env,to,buildExpenseSavedFlex(expense),traceId);return;
  }
  if(action==="expense_cancel"){
    const changed=await env.DB.prepare(`UPDATE expense_events SET status='CANCELLED',updated_at=? WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(new Date().toISOString(),id,to).run();
    await pushText(env,to,Number(changed.meta.changes||0)===1?"ยกเลิกรายการแล้วค่ะ ✅ / Cancelled.":"รายการนี้บันทึกหรือยกเลิกไปแล้วค่ะ",traceId);return;
  }
  if(action==="expense_undo"){
    const changed=await env.DB.prepare(`UPDATE expense_events SET status='CANCELLED',updated_at=? WHERE expense_id=? AND line_user_id=? AND status='CONFIRMED'`).bind(new Date().toISOString(),id,to).run();
    if(Number(changed.meta.changes||0)===1){await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"EXPENSE",entityKey:id,entityVersion:2,traceId});await pushText(env,to,"ยกเลิกย้อนหลังแล้วค่ะ ↩️\nข้อมูลเดิมยังเก็บไว้เป็นประวัติ และอัปเดตสถานะใน Google Sheets แล้ว",traceId);}else await pushText(env,to,"รายการนี้ถูกยกเลิกแล้ว หรือไม่สามารถ Undo ได้ค่ะ",traceId);return;
  }
  if(expense.status!=="WAITING_CONFIRM"){await showCurrent(env,to,expense,traceId);return;}
  if(action==="expense_back"){await pushFlex(env,to,buildExpenseSummaryFlex(expense),traceId);return;}
  if(action==="expense_payment_menu"){await pushFlex(env,to,buildExpensePaymentFlex(expense),traceId);return;}
  if(action==="expense_source_menu"){await pushFlex(env,to,buildExpenseSourceFlex(expense),traceId);return;}
  if(action==="expense_category_menu"){await pushFlex(env,to,buildExpenseCategoryFlex(expense),traceId);return;}
  if(action==="expense_date_menu"){await pushFlex(env,to,buildExpenseDateFlex(expense),traceId);return;}
  if(action==="expense_set_payment"){
    const payment=q.get("payment")||"";if(!allowedPayments.has(payment))throw new Error("Invalid expense payment");expense.paymentKey=payment;expense.sourceWallet=paymentWallet(payment);
    await env.DB.prepare(`UPDATE expense_events SET payment_key=?,source_wallet=?,updated_at=? WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(expense.paymentKey,expense.sourceWallet,new Date().toISOString(),id,to).run();await pushFlex(env,to,buildExpenseSummaryFlex(expense),traceId);return;
  }
  if(action==="expense_set_source"){
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
  await pushText(env,to,"ไม่รู้จักคำสั่งนี้ กรุณาส่งรายการใหม่ค่ะ / Unknown command.",traceId);
}
