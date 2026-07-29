import { safeRecordMetric } from "../db/repositories";
import type { Env,LineEvent,LineNotificationPurpose } from "../types";
import { enqueueLineNotification } from "./attendance-notification";
import { lineOutputEnabled,LineApiError,replyLineMessages } from "./api";

export type LineEventResponseChannel="REPLY"|"PUSH_FALLBACK"|"SUPPRESSED"|"FAILED_OBSERVABLE";

function responseIdentity(event:LineEvent,traceId:string,suffix:string):string{
  return `${event.webhookEventId||event.message?.id||traceId}:${suffix}`;
}
function safeLineFailure(error:unknown):{status:string;code:string}{
  if(error instanceof LineApiError)return{status:String(error.status),code:error.code||"LINE_REPLY_FAILED"};
  return{status:"ERROR",code:"LINE_REPLY_FAILED"};
}

export async function respondToLineEvent(
  env:Env,
  event:LineEvent,
  messages:unknown[],
  input:{traceId:string;purpose:LineNotificationPurpose;identitySuffix?:string}
):Promise<LineEventResponseChannel>{
  if(!lineOutputEnabled(env))return"SUPPRESSED";
  const to=event.source.type==="user"?event.source.userId||"":"",replyToken=event.replyToken?.trim()||"";
  if(replyToken){
    try{
      await replyLineMessages(env,replyToken,messages,input.traceId);
      await safeRecordMetric(env,input.traceId,"line_event_response",0,{channel:"reply",purpose:input.purpose});
      return"REPLY";
    }catch(error){
      const failure=safeLineFailure(error);
      console.error("line-event-reply-failed",{status:failure.status,code:failure.code,purpose:input.purpose});
      await safeRecordMetric(env,input.traceId,"line_reply_failure",0,{status:failure.status,code:failure.code,purpose:input.purpose});
    }
  }
  if(!to){
    await safeRecordMetric(env,input.traceId,"line_response_fallback_failure",0,{reason:"USER_TARGET_MISSING",purpose:input.purpose});
    return"FAILED_OBSERVABLE";
  }
  try{
    await enqueueLineNotification(env,{
      to,
      messages,
      identity:responseIdentity(event,input.traceId,input.identitySuffix||"response"),
      purpose:input.purpose,
      traceId:input.traceId
    });
    await safeRecordMetric(env,input.traceId,"line_event_response",0,{channel:"push_fallback",purpose:input.purpose});
    return"PUSH_FALLBACK";
  }catch(error){
    console.error("line-event-fallback-enqueue-failed",{purpose:input.purpose});
    await safeRecordMetric(env,input.traceId,"line_response_fallback_failure",0,{reason:"ENQUEUE_FAILED",purpose:input.purpose});
    return"FAILED_OBSERVABLE";
  }
}

export function respondTextToLineEvent(
  env:Env,
  event:LineEvent,
  text:string,
  input:{traceId:string;purpose:LineNotificationPurpose;identitySuffix?:string}
):Promise<LineEventResponseChannel>{
  return respondToLineEvent(env,event,[{type:"text",text}],input);
}

export function respondFlexToLineEvent(
  env:Env,
  event:LineEvent,
  message:unknown,
  input:{traceId:string;purpose:LineNotificationPurpose;identitySuffix?:string}
):Promise<LineEventResponseChannel>{
  return respondToLineEvent(env,event,[message],input);
}
