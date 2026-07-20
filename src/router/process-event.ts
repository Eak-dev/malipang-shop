import { handleAttendance } from "../attendance/service";
import { claimInboundEvent,completeInboundEvent,getEmployeeByLineId,InboundBusyError,recordMetric } from "../db/repositories";
import { handleExpenseImage,handleExpensePostback,handleExpenseText } from "../expense/service";
import { saveEvidence } from "../evidence/r2";
import { downloadLineContent,pushText } from "../line/api";
import { sha256Hex } from "../shared/ids";
import type { Env,InboundJob } from "../types";
import { classifyAndRead } from "../vision/service";
export async function processInbound(job:InboundJob,env:Env,_ctx:ExecutionContext):Promise<void>{
  const t0=Date.now(),event=job.event,webhookId=event.webhookEventId||`message:${event.message?.id||job.traceId}`,claim=await claimInboundEvent(env,event,job.traceId,job.receivedAtIso);if(claim==="TERMINAL")return;if(claim==="BUSY")throw new InboundBusyError();
  try{
    const to=event.source.type==="user"?event.source.userId||"":"";if(!to){await completeInboundEvent(env,webhookId,"UNSUPPORTED_CHAT","IGNORED");return;}
    const actor=await getEmployeeByLineId(env,to);
    if(event.type==="postback"){
      if(env.EXPENSE_ENABLED!=="true"){await pushText(env,to,"ระบบค่าใช้จ่ายยังไม่เปิดใช้งานค่ะ");await completeInboundEvent(env,webhookId,"POSTBACK","IGNORED");return;}
      if(!actor){await pushText(env,to,"ไม่พบสิทธิ์ผู้ใช้งานค่ะ");await completeInboundEvent(env,webhookId,"POSTBACK","REJECTED");return;}
      await handleExpensePostback(env,event,actor);await completeInboundEvent(env,webhookId,"POSTBACK","COMPLETED");return;
    }
    if(event.type!=="message"||!event.message){await completeInboundEvent(env,webhookId,"IGNORED","COMPLETED");return;}
    if(event.message.type==="text"){
      if(env.EXPENSE_ENABLED==="true"&&actor?.canSubmitExpense)await handleExpenseText(env,event,job.traceId);else await pushText(env,to,env.EXPENSE_ENABLED==="true"?"ไม่มีสิทธิ์บันทึกค่าใช้จ่ายค่ะ":"ระบบค่าใช้จ่ายยังไม่เปิดใช้งานค่ะ");
      await completeInboundEvent(env,webhookId,"EXPENSE_TEXT",actor?.canSubmitExpense?"COMPLETED":"REJECTED");return;
    }
    if(event.message.type!=="image"){await completeInboundEvent(env,webhookId,"IGNORED","COMPLETED");return;}
    if(event.message.contentProvider?.type&&event.message.contentProvider.type!=="line"){await pushText(env,to,"รุ่นนี้รองรับเฉพาะรูปที่ส่งเข้า LINE โดยตรงค่ะ");await completeInboundEvent(env,webhookId,"EXTERNAL_IMAGE","REJECTED");return;}
    if(!actor||(!(actor.status==="ACTIVE"&&env.ATTENDANCE_ENABLED==="true")&&!(actor.canSubmitExpense&&env.EXPENSE_ENABLED==="true"))){await pushText(env,to,"ไม่พบพนักงานหรือสิทธิ์สำหรับรับรูปนี้ค่ะ");await completeInboundEvent(env,webhookId,"UNAUTHORIZED_IMAGE","REJECTED");return;}
    const originalPromise=downloadLineContent(env,event.message.id,false),preview=await downloadLineContent(env,event.message.id,true).catch(()=>originalPromise),original=await originalPromise,reading=await classifyAndRead(env,preview,original);
    if(reading.kind==="CLOCK"&&actor.status==="ACTIVE"&&env.ATTENDANCE_ENABLED==="true"){
      const recorded=await handleAttendance(env,event,actor,reading,original,job.traceId);await completeInboundEvent(env,webhookId,"ATTENDANCE",recorded?"COMPLETED":"REJECTED");
    }else if(["RECEIPT","BANK_SLIP","ONLINE_ORDER"].includes(reading.kind)&&actor.canSubmitExpense&&env.EXPENSE_ENABLED==="true"){
      const hash=await sha256Hex(original),key=`expense/${new Date(event.timestamp).toISOString().slice(0,10)}/${event.message.id}-${hash.slice(0,12)}.jpg`;await saveEvidence(env,key,original,{lineUserId:to,messageId:event.message.id,traceId:job.traceId});await handleExpenseImage(env,event,reading,key,job.traceId);await completeInboundEvent(env,webhookId,"EXPENSE_IMAGE","COMPLETED");
    }else{await pushText(env,to,"ยังแยกประเภทรูปนี้ไม่ได้ค่ะ กรุณาถ่ายใหม่ให้ชัด");await completeInboundEvent(env,webhookId,"UNKNOWN_IMAGE","REVIEW");}
  }catch(error){await completeInboundEvent(env,webhookId,"ERROR","FAILED",String(error));throw error;}finally{try{await recordMetric(env,job.traceId,"inbound_total_ms",Date.now()-t0);}catch(error){console.error("metric",error);}}
}
