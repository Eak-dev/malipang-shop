import {authorize} from "../access/authorization";
import {getStaffActorByLineId} from "../access/repository";
import {respondFlexToLineEvent,respondTextToLineEvent} from "../line/event-response";
import {activeOwnerSql,type OwnerReviewIdentity} from "../expense/online-order-review-repository";
import type {Env,LineEvent} from "../types";
import {buildDailyCategoryQueueFlex,buildDailyCategoryReviewFlex,type DailyCategoryReviewView} from "./daily-category-flex";
import {collectDailyCategorySnapshot,observeDailyCategoryChanges} from "./daily-category-observer";
import {planDailyCategoryScan} from "./daily-category-scan";
import {approveDailyCategoryChange,rejectDailyCategoryChange,type VerifiedCategoryRow} from "./daily-category-repository";
import {preflightDailyCategoryProjection} from "./daily-category-projection-runner";

interface RequestRow extends Record<string,unknown>{request_id:string;expense_id:string;row_number:number;metadata_id:number;fingerprint:string;from_category:string;to_category:string;expense_version:number;description:string;amount_satang:number;transaction_date:string}
const reply=(env:Env,event:LineEvent,body:string,traceId:string)=>respondTextToLineEvent(env,event,body,{traceId,purpose:"OWNER_RESPONSE"});
const flex=(env:Env,event:LineEvent,body:unknown,traceId:string)=>respondFlexToLineEvent(env,event,body,{traceId,purpose:"OWNER_RESPONSE"});
async function ownerIdentity(env:Env,event:LineEvent):Promise<OwnerReviewIdentity|null>{
  if(env.DAILY_CATEGORY_REVIEW_ENABLED!=="true"||event.source.type!=="user"||!event.source.userId)return null;
  const actor=await getStaffActorByLineId(env,event.source.userId);
  return actor?.role==="OWNER"&&actor.scope==="ORGANIZATION"&&actor.employee.canSubmitExpense&&authorize(actor,"expense.branch.review")?{employeeId:actor.employeeId,lineUserId:event.source.userId}:null;
}
const view=(row:RequestRow):DailyCategoryReviewView=>({requestId:String(row.request_id),description:String(row.description),amountSatang:Number(row.amount_satang),transactionDate:String(row.transaction_date),fromCategory:String(row.from_category),toCategory:String(row.to_category),expenseVersion:Number(row.expense_version),rowNumber:Number(row.row_number)});
const verifiedRow=(row:RequestRow):VerifiedCategoryRow=>({expenseId:String(row.expense_id),rowNumber:Number(row.row_number),metadataId:Number(row.metadata_id),fingerprint:String(row.fingerprint),category:String(row.from_category),expenseVersion:Number(row.expense_version)});
async function loadRequest(env:Env,id:string,owner:OwnerReviewIdentity):Promise<RequestRow|null>{
  return env.DB.prepare(`SELECT r.*,e.description,e.amount_satang,e.transaction_date FROM daily_category_requests r JOIN expense_events e ON e.expense_id=r.expense_id
    WHERE r.request_id=? AND r.status='PENDING' AND ${activeOwnerSql}`).bind(id,owner.employeeId,owner.lineUserId).first<RequestRow>();
}
async function list(env:Env,event:LineEvent,owner:OwnerReviewIdentity,traceId:string):Promise<void>{
  let refreshFailed=false;try{await observeDailyCategoryChanges(env);}catch{refreshFailed=true;}
  const [rows,total]=await Promise.all([
    env.DB.prepare(`SELECT r.*,e.description,e.amount_satang,e.transaction_date FROM daily_category_requests r JOIN expense_events e ON e.expense_id=r.expense_id
      WHERE r.status='PENDING' AND ${activeOwnerSql} ORDER BY r.created_at,r.request_id LIMIT 5`).bind(owner.employeeId,owner.lineUserId).all<RequestRow>(),
    env.DB.prepare(`SELECT COUNT(*) n FROM daily_category_requests WHERE status='PENDING' AND ${activeOwnerSql}`).bind(owner.employeeId,owner.lineUserId).first<{n:number}>()
  ]);
  await flex(env,event,buildDailyCategoryQueueFlex((rows.results||[]).map(view),Number(total?.n||0),refreshFailed),traceId);
}
async function verifyCurrentSheet(env:Env,row:RequestRow):Promise<boolean>{
  const snapshot=await collectDailyCategorySnapshot(env),planned=planDailyCategoryScan(snapshot.expenses,snapshot.rows,snapshot.baselines),entry=planned.find(item=>item.expenseId===String(row.expense_id)),expense=snapshot.expenses.find(item=>item.expenseId===String(row.expense_id));
  return Boolean(entry&&expense&&entry.rowNumber===Number(row.row_number)&&entry.metadataId===Number(row.metadata_id)&&expense.fingerprint===String(row.fingerprint)&&expense.version===Number(row.expense_version)&&entry.observation.kind==="OWNER_REVIEW"&&entry.observation.from===String(row.from_category)&&entry.observation.to===String(row.to_category));
}
async function handle(env:Env,event:LineEvent,traceId:string,action:string,id="",version=""):Promise<void>{
  const owner=await ownerIdentity(env,event);if(!owner){await reply(env,event,"เมนูนี้สำหรับเจ้าของที่ยืนยันตัวตนและได้รับสิทธิ์เท่านั้น",traceId);return;}
  if(action==="list"){await list(env,event,owner,traceId);return;}
  if(!/^[A-Za-z0-9_-]{8,128}$/.test(id)){await reply(env,event,"ไม่พบคำขอ กรุณาพิมพ์ ตรวจหมวด เพื่อเปิดรายการใหม่",traceId);return;}
  const row=await loadRequest(env,id,owner);if(!row){await reply(env,event,"คำขอนี้ได้รับการจัดการแล้วหรือไม่พบ กรุณาพิมพ์ ตรวจหมวด",traceId);return;}
  if(action==="open"){await flex(env,event,buildDailyCategoryReviewFlex(view(row)),traceId);return;}
  const expected=Number(version);if(!Number.isSafeInteger(expected)||expected!==Number(row.expense_version)){await reply(env,event,"ข้อมูลเปลี่ยนแล้ว กรุณาพิมพ์ ตรวจหมวด และตรวจรายการล่าสุด",traceId);return;}
  if(action==="reject"){
    const rejected=await rejectDailyCategoryChange(env,{requestId:id,row:verifiedRow(row),toCategory:String(row.to_category),owner});
    await reply(env,event,rejected?"ไม่อนุมัติแล้ว หมวดในฐานข้อมูลยังเหมือนเดิม กรุณาคืน Dropdown เป็นหมวดเดิมหากไม่ต้องการส่งคำขอซ้ำ":"ข้อมูลเปลี่ยนแล้ว กรุณาตรวจรายการล่าสุด",traceId);return;
  }
  if(action!=="approve"){await reply(env,event,"เมนูนี้ใช้ไม่ได้ กรุณาพิมพ์ ตรวจหมวด",traceId);return;}
  try{
    if(!await verifyCurrentSheet(env,row)){await reply(env,event,"แถวหรือข้อมูลเปลี่ยนแล้ว กรุณาตรวจชีตและเปิดคำขอใหม่",traceId);return;}
    await preflightDailyCategoryProjection(env,{expenseId:String(row.expense_id),version:Number(row.expense_version),fromCategory:String(row.from_category),toCategory:String(row.to_category)});
  }catch{await reply(env,event,"ยังตรวจข้อมูลชีตที่เกี่ยวข้องไม่ครบ จึงยังไม่เปลี่ยนหมวด กรุณาตรวจข้อมูลแล้วลองใหม่",traceId);return;}
  const approved=await approveDailyCategoryChange(env,{requestId:id,row:verifiedRow(row),observedCategory:String(row.to_category),owner,traceId});
  if(approved===null){await reply(env,event,"ข้อมูลหรือสิทธิ์เปลี่ยนแล้ว หรือมีงานซิงก์ค้าง กรุณาตรวจรายการล่าสุด",traceId);return;}
  try{await env.JOB_QUEUE.send({kind:"SHEETS_SYNC",entityType:"EXPENSE_CATEGORY",entityKey:String(row.expense_id),entityVersion:approved,traceId});}catch{/* Durable outbox will be retried by maintenance. */}
  await reply(env,event,"อนุมัติแล้ว ระบบกำลังซิงก์หมวดไปยังข้อมูลที่เกี่ยวข้อง โดยยอดเงินไม่เปลี่ยน",traceId);
}

export async function handleDailyCategoryReviewText(env:Env,event:LineEvent,traceId:string):Promise<boolean>{
  if(!["ตรวจหมวด","คำขอเปลี่ยนหมวด","/category-review"].includes((event.message?.text||"").trim().toLowerCase()))return false;
  await handle(env,event,traceId,"list");return true;
}
export async function handleDailyCategoryReviewPostback(env:Env,event:LineEvent,traceId:string):Promise<boolean>{
  const q=new URLSearchParams(event.postback?.data||""),action=q.get("a")||"";if(!action.startsWith("sheet_category_"))return false;
  await handle(env,event,traceId,action.slice("sheet_category_".length),q.get("id")||"",q.get("v")||"");return true;
}
