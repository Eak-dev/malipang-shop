import { handleAttendance } from "../attendance/service";
import { authorize } from "../access/authorization";
import { handleHrText,requestOwnAttendanceCorrection } from "../access/hr";
import { getStaffActorByLineId } from "../access/repository";
import { claimInboundEvent,completeInboundEvent,InboundBusyError,recordMetric } from "../db/repositories";
import { handleExpenseImage,handleExpensePostback,handleExpenseText } from "../expense/service";
import { handlePersonalUsePostback,handlePersonalUseText } from "../personal-use/service";
import { saveEvidence } from "../evidence/r2";
import { downloadLineContent } from "../line/api";
import { respondTextToLineEvent } from "../line/event-response";
import { handleOwnerPayrollText } from "../payroll/owner-command";
import { sha256Hex } from "../shared/ids";
import type { Env,InboundJob } from "../types";
import { classifyAndRead } from "../vision/service";
import { describeVisionRejection } from "../vision/failure-reason";
import { attendanceNotAllowedMessage, unauthorizedImageMessage, unsupportedImageMessage } from "../attendance/messages";
export async function processInbound(job:InboundJob,env:Env,_ctx:ExecutionContext):Promise<void>{
  const t0=Date.now(),event=job.event,webhookId=event.webhookEventId||`message:${event.message?.id||job.traceId}`,claim=await claimInboundEvent(env,event,job.traceId,job.receivedAtIso);let expenseImage=false;if(claim==="TERMINAL")return;if(claim==="BUSY")throw new InboundBusyError();
  try{
    const to=event.source.type==="user"?event.source.userId||"":"";if(!to){await completeInboundEvent(env,webhookId,"UNSUPPORTED_CHAT","IGNORED");return;}
    const actor=await getStaffActorByLineId(env,to);
    if(event.type==="postback"){
      if(await handlePersonalUsePostback(env,event,actor)) {await completeInboundEvent(env,webhookId,"PERSONAL_USE_POSTBACK","COMPLETED");return;}
      if(!actor||!authorize(actor,"expense.self.read",{employeeId:actor?.employeeId})){await respondTextToLineEvent(env,event,"You are not authorized to use this menu.",{traceId:job.traceId,purpose:"EMPLOYEE_RESPONSE"});await completeInboundEvent(env,webhookId,"POSTBACK","REJECTED");return;}
      if(env.EXPENSE_ENABLED!=="true"){await respondTextToLineEvent(env,event,"The expense system is currently disabled.",{traceId:job.traceId,purpose:"EMPLOYEE_RESPONSE"});await completeInboundEvent(env,webhookId,"POSTBACK","IGNORED");return;}
      await handleExpensePostback(env,event,actor.employee,actor);await completeInboundEvent(env,webhookId,"POSTBACK","COMPLETED");return;
    }
    if(event.type!=="message"||!event.message){await completeInboundEvent(env,webhookId,"IGNORED","COMPLETED");return;}
    if(event.message.type==="text"){
      if(await handleHrText(env,event,actor,job.traceId)){await completeInboundEvent(env,webhookId,"HR_REGISTRATION","COMPLETED");return;}
      if(actor&&await requestOwnAttendanceCorrection(env,event,actor,event.message.text||"",job.traceId)){await completeInboundEvent(env,webhookId,"SELF_SERVICE_CORRECTION","COMPLETED");return;}
      if(await handleOwnerPayrollText(env,event,actor)){await completeInboundEvent(env,webhookId,"OWNER_OT_TEXT","COMPLETED");return;}
      const personal=await handlePersonalUseText(env,event,job.traceId,actor);
      if(personal!=="NOT_HANDLED"){await completeInboundEvent(env,webhookId,"PERSONAL_USE_TEXT",personal==="REJECTED"?"REJECTED":"COMPLETED");return;}
      if(env.EXPENSE_ENABLED==="true"&&actor?.employee.canSubmitExpense&&authorize(actor,"expense.submit",{employeeId:actor.employeeId})){const outcome=await handleExpenseText(env,event,job.traceId,actor);await completeInboundEvent(env,webhookId,"EXPENSE_TEXT",outcome==="REJECTED"?"REJECTED":"COMPLETED");}
      else{await respondTextToLineEvent(env,event,env.EXPENSE_ENABLED==="true"?"You are not authorized to record expenses.":"The expense system is currently disabled.",{traceId:job.traceId,purpose:"EMPLOYEE_RESPONSE"});await completeInboundEvent(env,webhookId,"EXPENSE_TEXT","REJECTED");}return;
    }
    if(event.message.type!=="image"){await completeInboundEvent(env,webhookId,"IGNORED","COMPLETED");return;}
    if(event.message.contentProvider?.type&&event.message.contentProvider.type!=="line"){
      await respondTextToLineEvent(env,event,unsupportedImageMessage(),{traceId:job.traceId,purpose:"ATTENDANCE_REJECTION",identitySuffix:"attendance-rejection"});
      await completeInboundEvent(env,webhookId,"EXTERNAL_IMAGE","REJECTED");return;
    }
    if(!actor||(!(actor.employee.status==="ACTIVE"&&authorize(actor,"attendance.self.write",{employeeId:actor.employeeId})&&env.ATTENDANCE_ENABLED==="true")&&!(actor.employee.canSubmitExpense&&authorize(actor,"expense.submit",{employeeId:actor.employeeId})&&env.EXPENSE_ENABLED==="true"))){
      await respondTextToLineEvent(env,event,unauthorizedImageMessage(),{traceId:job.traceId,purpose:"ATTENDANCE_REJECTION",identitySuffix:"attendance-rejection"});
      await completeInboundEvent(env,webhookId,"UNAUTHORIZED_IMAGE","REJECTED");return;
    }
    const downloadStarted=Date.now(),originalPromise=downloadLineContent(env,event.message.id,false,job.traceId);
    // With Workers AI disabled in Production, OpenAI always consumes the
    // original image; skip an unused preview transfer.  If Workers AI is ever
    // enabled again, retain the existing parallel attendance-safe path.
    const previewPromise=env.WORKERS_AI_ENABLED==="true"?downloadLineContent(env,event.message.id,true,job.traceId).catch(()=>originalPromise):originalPromise;
    const [preview,original]=await Promise.all([previewPromise,originalPromise]);
    const downloadMs=Date.now()-downloadStarted,visionStarted=Date.now();
    const reading=await classifyAndRead(env,preview,original,job.traceId);
    const visionMs=Date.now()-visionStarted;
    if(reading.kind==="CLOCK"){
      if(actor.employee.status!=="ACTIVE"||!authorize(actor,"attendance.self.write",{employeeId:actor.employeeId})||env.ATTENDANCE_ENABLED!=="true"){const code="ATTENDANCE_NOT_ALLOWED";await respondTextToLineEvent(env,event,attendanceNotAllowedMessage(),{traceId:job.traceId,purpose:"ATTENDANCE_REJECTION",identitySuffix:"attendance-rejection"});await completeInboundEvent(env,webhookId,"ATTENDANCE", "REJECTED",code);return;}
      const recorded=await handleAttendance(env,event,actor.employee,reading,original,job.traceId);await completeInboundEvent(env,webhookId,"ATTENDANCE",recorded?"COMPLETED":"REJECTED",recorded?"":"CLOCK_VALIDATION_FAILED");
    }else if(["RECEIPT","BANK_SLIP","ONLINE_ORDER","DELIVERY_ORDER"].includes(reading.kind)){
      expenseImage=true;
      await recordMetric(env,job.traceId,"expense_image_queue_wait_ms",Math.max(0,Date.now()-Date.parse(job.receivedAtIso)));
      await recordMetric(env,job.traceId,"expense_image_download_ms",downloadMs);
      // The current general vision call classifies and extracts together.  The
      // retained legacy provider metrics break this down further by provider.
      await recordMetric(env,job.traceId,"expense_image_classification_ms",visionMs,{provider:reading.provider});
      await recordMetric(env,job.traceId,"expense_image_extraction_ms",visionMs,{provider:reading.provider,combined:"true"});
      if(!actor.employee.canSubmitExpense||!authorize(actor,"expense.submit",{employeeId:actor.employeeId})||env.EXPENSE_ENABLED!=="true"){const code="EXPENSE_IMAGE_NOT_ALLOWED";await respondTextToLineEvent(env,event,`The expense image was not recorded. ❌\nReason: This account is not authorized, or the expense system is disabled.\nAction: Please contact the shop administrator.\nCode: ${code}`,{traceId:job.traceId,purpose:"EXPENSE_RESPONSE"});await completeInboundEvent(env,webhookId,"EXPENSE_IMAGE","REJECTED",code);return;}
      const hash=await sha256Hex(original),key=`expense/${new Date(event.timestamp).toISOString().slice(0,10)}/${event.message.id}-${hash.slice(0,12)}.jpg`;
      const r2Started=Date.now();await saveEvidence(env,key,original,{lineUserId:to,messageId:event.message.id,traceId:job.traceId});await recordMetric(env,job.traceId,"expense_image_r2_ms",Date.now()-r2Started);
      const persistStarted=Date.now(),responseTiming={replyMs:0};await handleExpenseImage(env,event,reading,key,job.traceId,hash,actor,responseTiming);const persistAndReplyMs=Date.now()-persistStarted;await recordMetric(env,job.traceId,"expense_image_d1_ms",Math.max(0,persistAndReplyMs-responseTiming.replyMs));await recordMetric(env,job.traceId,"expense_image_reply_ms",responseTiming.replyMs);await completeInboundEvent(env,webhookId,"EXPENSE_IMAGE","COMPLETED");
    }else{const rejection=describeVisionRejection(reading);await respondTextToLineEvent(env,event,rejection.message,{traceId:job.traceId,purpose:"ATTENDANCE_REJECTION",identitySuffix:"attendance-rejection"});await completeInboundEvent(env,webhookId,"UNKNOWN_IMAGE","REVIEW",rejection.code);}
  }catch(error){await completeInboundEvent(env,webhookId,"ERROR","FAILED",String(error));throw error;}finally{try{const elapsed=Date.now()-t0;await recordMetric(env,job.traceId,"inbound_total_ms",elapsed);if(expenseImage)await recordMetric(env,job.traceId,"expense_image_total_ms",elapsed);}catch(error){console.error("metric",error);}}
}
