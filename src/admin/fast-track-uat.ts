import { handleAttendance } from "../attendance/service";
import { validateAttendancePhoto } from "../domain/attendance";
import { handleExpenseImage,handleExpensePostback,handleExpenseText } from "../expense/service";
import { saveEvidence } from "../evidence/r2";
import { numberEnv } from "../shared/env";
import { randomId,sha256Hex } from "../shared/ids";
import type { Employee,Env,LineEvent } from "../types";
import { classifyAndRead } from "../vision/service";

const MAX_IMAGE_BYTES=5*1024*1024;
const UAT_LINE_ID=/^U[a-fA-F0-9]{20,64}$/;
const UAT_ID=/^uat_[A-Za-z0-9_-]{1,80}$/;

export function assertFastTrackUat(env:Pick<Env,"APP_ENV"|"RUNTIME_MODE">):void{
  if(env.APP_ENV!=="uat"||env.RUNTIME_MODE!=="shadow")throw new Error("Fast-track UAT endpoints require APP_ENV=uat and RUNTIME_MODE=shadow");
}
function uatId(value:string|null,name:string):string{
  const id=String(value||"").trim();if(!UAT_ID.test(id))throw new Error(`${name} must start with uat_`);return id;
}
function uatLineId(value:string|null):string{
  const id=String(value||"").trim();if(!UAT_LINE_ID.test(id))throw new Error("lineUserId must be a valid UAT LINE-style ID");return id;
}
function uatEnv(env:Env,overrides:Partial<Env>={}):Env{
  return{...env,SHADOW_LINE_OUTPUT:"false",WORKERS_AI_ENABLED:"false",OPENAI_FALLBACK_ENABLED:"true",OPENAI_MODEL:"gpt-4.1-mini",...overrides};
}
function receivedAt(url:URL):string{
  const value=url.searchParams.get("receivedAt")||new Date().toISOString(),date=new Date(value);
  if(!Number.isFinite(date.getTime()))throw new Error("receivedAt must be a valid ISO date-time");
  return date.toISOString();
}
async function jpeg(request:Request):Promise<ArrayBuffer>{
  const contentType=(request.headers.get("content-type")||"").split(";",1)[0]?.trim().toLowerCase();
  if(contentType!=="image/jpeg")throw new Error("Only image/jpeg is supported");
  const image=await request.arrayBuffer();
  if(!image.byteLength||image.byteLength>MAX_IMAGE_BYTES)throw new Error("Image must be between 1 byte and 5 MiB");
  return image;
}
async function employeeById(env:Env,employeeId:string):Promise<Employee>{
  const row=await env.DB.prepare(`SELECT employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,daily_wage_satang,grace_min,late_deduction_satang,early_deduction_satang,can_submit_expense,status FROM employees WHERE employee_id=? LIMIT 1`).bind(employeeId).first<Record<string,unknown>>();
  if(!row)throw new Error("UAT employee not found");
  if(!String(row.employee_id).startsWith("UAT"))throw new Error("Fast-track UAT can use only UAT-prefixed employees");
  return{employeeId:String(row.employee_id),staffName:String(row.staff_name),lineUserId:String(row.line_user_id),scheduledIn:String(row.scheduled_in),scheduledOut:String(row.scheduled_out),dailyWageSatang:Number(row.daily_wage_satang),graceMin:Number(row.grace_min),lateDeductionSatang:Number(row.late_deduction_satang),earlyDeductionSatang:Number(row.early_deduction_satang),canSubmitExpense:Number(row.can_submit_expense)===1,status:String(row.status)==="ACTIVE"?"ACTIVE":"INACTIVE"};
}

export async function runUatAttendance(env:Env,request:Request):Promise<Record<string,unknown>>{
  assertFastTrackUat(env);const url=new URL(request.url),image=await jpeg(request);
  const caseId=uatId(url.searchParams.get("caseId"),"caseId"),messageId=uatId(url.searchParams.get("messageId"),"messageId");
  const employeeId=String(url.searchParams.get("employeeId")||"").trim(),employee=await employeeById(env,employeeId);
  const receivedAtIso=receivedAt(url),traceId=`${caseId}_${crypto.randomUUID()}`;
  const radiusText=url.searchParams.get("allowedRadiusM"),radiusOverride=radiusText==null?null:Number(radiusText);
  if(radiusOverride!=null&&(!Number.isFinite(radiusOverride)||radiusOverride<1||radiusOverride>numberEnv(env.ATTENDANCE_ALLOWED_RADIUS_M,120)))throw new Error("allowedRadiusM UAT override must be between 1 and the configured radius");
  const evaluationEnv=uatEnv(env,radiusOverride==null?{}:{ATTENDANCE_ALLOWED_RADIUS_M:String(radiusOverride)});
  const reading=await classifyAndRead(evaluationEnv,image,image,traceId,{usageMetric:"openai_uat_calls",enforceDailyLimit:false});
  const validation=validateAttendancePhoto(reading,receivedAtIso,{
    storeLat:numberEnv(evaluationEnv.ATTENDANCE_STORE_LAT,NaN),storeLng:numberEnv(evaluationEnv.ATTENDANCE_STORE_LNG,NaN),
    allowedRadiusM:numberEnv(evaluationEnv.ATTENDANCE_ALLOWED_RADIUS_M,120),maxPhotoAgeMin:numberEnv(evaluationEnv.ATTENDANCE_MAX_PHOTO_AGE_MIN,3),
    overlayMinConfidence:numberEnv(evaluationEnv.ATTENDANCE_OVERLAY_MIN_CONFIDENCE,0.9),clockMinConfidence:numberEnv(evaluationEnv.ATTENDANCE_CLOCK_MIN_CONFIDENCE,0.7)
  });
  const imageHash=await sha256Hex(image);
  const beforeMessage=await env.DB.prepare(`SELECT COUNT(*) count FROM attendance_events WHERE message_id=?`).bind(messageId).first<{count:number}>();
  const beforeImage=await env.DB.prepare(`SELECT COUNT(*) count FROM attendance_events WHERE image_sha256=?`).bind(imageHash).first<{count:number}>();
  let recorded=false;
  if(validation.ok){
    const event:LineEvent={type:"message",timestamp:new Date(receivedAtIso).getTime(),source:{type:"user",userId:employee.lineUserId},message:{id:messageId,type:"image",contentProvider:{type:"line"}},webhookEventId:`${caseId}_webhook`};
    recorded=await handleAttendance(evaluationEnv,event,employee,reading,image,traceId);
  }
  const eventRow=await env.DB.prepare(`SELECT event_id,message_id,employee_id,work_date,punch_type,official_time,status,validation_code,version FROM attendance_events WHERE message_id=? LIMIT 1`).bind(messageId).first<Record<string,unknown>>();
  const imageRow=await env.DB.prepare(`SELECT event_id,message_id,employee_id,work_date,punch_type,official_time,status,validation_code,version FROM attendance_events WHERE image_sha256=? ORDER BY created_at LIMIT 1`).bind(imageHash).first<Record<string,unknown>>();
  const daily=validation.workDate?await env.DB.prepare(`SELECT employee_id,work_date,time_in,time_out,work_minutes,late_minutes,early_out_minutes,daily_wage_satang,confirmed_wage_satang,pending_wage_satang,pay_status,version FROM attendance_daily WHERE employee_id=? AND work_date=?`).bind(employee.employeeId,validation.workDate).first<Record<string,unknown>>():null;
  const safeReading={kind:reading.kind,provider:reading.provider,photoDate:reading.photoDate,photoTime:reading.photoTime,latitude:reading.latitude,longitude:reading.longitude,locationText:reading.locationText,overlayConfidence:reading.overlayConfidence,clockPresent:reading.clockPresent,clockConfidence:reading.clockConfidence};
  return{caseId,messageId,employeeId,receivedAt:receivedAtIso,radiusOverride,reading:safeReading,validation,recorded,d1:{beforeMessage:Number(beforeMessage?.count||0),beforeImage:Number(beforeImage?.count||0),event:eventRow||null,imageMatch:imageRow||null,daily:daily||null}};
}

export async function runUatExpenseText(env:Env,request:Request):Promise<Record<string,unknown>>{
  assertFastTrackUat(env);const input=await request.json() as{caseId?:string;messageId?:string;lineUserId?:string;text?:string};
  const caseId=uatId(input.caseId||null,"caseId"),messageId=uatId(input.messageId||null,"messageId"),lineUserId=uatLineId(input.lineUserId||null),text=String(input.text||"").trim();
  if(!text||text.length>500)throw new Error("text is required and must not exceed 500 characters");
  const traceId=`${caseId}_${crypto.randomUUID()}`,event:LineEvent={type:"message",timestamp:Date.now(),source:{type:"user",userId:lineUserId},message:{id:messageId,type:"text",text},webhookEventId:`${caseId}_webhook`};
  const outcome=await handleExpenseText(uatEnv(env),event,traceId);
  const expense=await env.DB.prepare(`SELECT expense_id,message_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at,updated_at FROM expense_events WHERE message_id=? AND line_user_id=? LIMIT 1`).bind(messageId,lineUserId).first<Record<string,unknown>>();
  return{caseId,messageId,outcome,expense:expense||null};
}

export async function runUatExpenseAction(env:Env,request:Request):Promise<Record<string,unknown>>{
  assertFastTrackUat(env);const input=await request.json() as{caseId?:string;expenseId?:string;lineUserId?:string;data?:string;date?:string};
  const caseId=uatId(input.caseId||null,"caseId"),expenseId=String(input.expenseId||"").trim(),lineUserId=uatLineId(input.lineUserId||null),data=String(input.data||"").trim();
  if(!expenseId.startsWith("exp_")||!data.includes(`id=${encodeURIComponent(expenseId)}`)&&!data.includes(`id=${expenseId}`))throw new Error("expenseId and matching postback data are required");
  const actor:Employee={employeeId:"UATEXP",staffName:"Fast Track UAT",lineUserId,scheduledIn:"04:00",scheduledOut:"16:00",dailyWageSatang:0,graceMin:0,lateDeductionSatang:0,earlyDeductionSatang:0,canSubmitExpense:true,status:"ACTIVE"};
  const event:LineEvent={type:"postback",timestamp:Date.now(),source:{type:"user",userId:lineUserId},postback:{data,...(input.date?{params:{date:input.date}}:{})}};
  await handleExpensePostback(uatEnv(env),event,actor);
  const expense=await env.DB.prepare(`SELECT expense_id,message_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at,updated_at FROM expense_events WHERE expense_id=? AND line_user_id=? LIMIT 1`).bind(expenseId,lineUserId).first<Record<string,unknown>>();
  const document=await env.DB.prepare(`SELECT document_id,document_type,status,channel,institution,transaction_status,payment_date,payment_time,reference_id,gross_amount_satang,discount_amount_satang,paid_amount_satang,confidence,needs_review,review_note FROM expense_documents WHERE expense_id=? LIMIT 1`).bind(expenseId).first<Record<string,unknown>>();
  return{caseId,expense:expense||null,document:document||null};
}

export async function runUatExpenseImage(env:Env,request:Request):Promise<Record<string,unknown>>{
  assertFastTrackUat(env);const url=new URL(request.url),image=await jpeg(request);
  const caseId=uatId(url.searchParams.get("caseId"),"caseId"),messageId=uatId(url.searchParams.get("messageId"),"messageId"),lineUserId=uatLineId(url.searchParams.get("lineUserId"));
  const traceId=`${caseId}_${crypto.randomUUID()}`,evaluationEnv=uatEnv(env),imageHash=await sha256Hex(image);
  const reading=await classifyAndRead(evaluationEnv,image,image,traceId,{usageMetric:"openai_uat_calls",enforceDailyLimit:false});
  const imageKey=`expense/uat/${caseId}/${messageId}-${imageHash.slice(0,12)}.jpg`;
  const event:LineEvent={type:"message",timestamp:Date.now(),source:{type:"user",userId:lineUserId},message:{id:messageId,type:"image",contentProvider:{type:"line"}},webhookEventId:`${caseId}_webhook`};
  await saveEvidence(evaluationEnv,imageKey,image,{lineUserId,messageId,traceId,uatCase:caseId});
  await handleExpenseImage(evaluationEnv,event,reading,imageKey,traceId,imageHash);
  const document=await env.DB.prepare(`SELECT document_id,expense_id,document_type,status,channel,institution,transaction_status,payment_date,payment_time,reference_id,gross_amount_satang,discount_amount_satang,paid_amount_satang,confidence,needs_review,review_note FROM expense_documents WHERE message_id=? AND line_user_id=? LIMIT 1`).bind(messageId,lineUserId).first<Record<string,unknown>>();
  const expense=document?.expense_id?await env.DB.prepare(`SELECT expense_id,message_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at,updated_at FROM expense_events WHERE expense_id=? LIMIT 1`).bind(String(document.expense_id)).first<Record<string,unknown>>():null;
  return{caseId,messageId,reading:{kind:reading.kind,provider:reading.provider,confidence:reading.confidence,document:reading.document||null},document:document||null,expense:expense||null};
}
