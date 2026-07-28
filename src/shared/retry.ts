function retryAfterSeconds(error:unknown):number|undefined{
  if(typeof error!=="object"||error===null||!("retryAfterSeconds" in error))return undefined;
  const value=Number((error as{retryAfterSeconds?:unknown}).retryAfterSeconds);
  return Number.isFinite(value)&&value>=0?Math.ceil(value):undefined;
}
function retryAttempt(error:unknown,fallback:number):number{
  if(typeof error==="object"&&error!==null&&"retryAttempt" in error){
    const value=Number((error as{retryAttempt?:unknown}).retryAttempt);
    if(Number.isFinite(value)&&value>0)return Math.floor(value);
  }
  return fallback;
}
export function queueRetryDelaySeconds(error:unknown,attempt=1,random:()=>number=Math.random):number|undefined{
  const message=String(error instanceof Error?error.message:error).toUpperCase();
  const boundedAttempt=Math.min(7,Math.max(1,Math.floor(retryAttempt(error,attempt))));
  if(message.includes("HTTP 429")||message.includes("RESOURCE_EXHAUSTED")||message.includes("RATE_LIMIT_EXCEEDED")){
    const base=Math.max(retryAfterSeconds(error)||0,60*2**(boundedAttempt-1)),jitter=Math.floor(base*.25*Math.max(0,Math.min(1,random())));
    return Math.min(3600,base+jitter);
  }
  if(/\bHTTP 5\d\d\b/.test(message)||message.includes("TIMED OUT")||message.includes("TIMEOUT")){
    const base=30*2**(boundedAttempt-1),jitter=Math.floor(base*.25*Math.max(0,Math.min(1,random())));
    return Math.min(1800,base+jitter);
  }
  return undefined;
}
