export function queueRetryDelaySeconds(error:unknown):number|undefined{
  const message=String(error instanceof Error?error.message:error).toUpperCase();
  if(message.includes("HTTP 429")||message.includes("RESOURCE_EXHAUSTED")||message.includes("RATE_LIMIT_EXCEEDED"))return 60;
  if(/\bHTTP 5\d\d\b/.test(message)||message.includes("TIMED OUT")||message.includes("TIMEOUT"))return 30;
  return undefined;
}
