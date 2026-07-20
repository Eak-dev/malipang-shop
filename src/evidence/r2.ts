import { isTrue } from "../shared/env";
import { numberEnv } from "../shared/env";
import type { Env } from "../types";
import { withTimeout } from "../shared/async";
import { safeRecordMetric } from "../db/repositories";
export async function saveEvidence(env: Env, key: string, data: ArrayBuffer, metadata: Record<string,string>): Promise<void> {
  if (!isTrue(env.R2_EVIDENCE_ENABLED)) return;
  const started=Date.now();try{await withTimeout(env.EVIDENCE.put(key,data,{httpMetadata:{contentType:"image/jpeg"},customMetadata:metadata}),numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),"R2 upload");}finally{await safeRecordMetric(env,metadata.traceId||"untraced","r2_upload_ms",Date.now()-started,{keyPrefix:key.split("/")[0]||"unknown"});}
}
export async function getEvidence(env: Env, key: string): Promise<Response> {
  const obj=await withTimeout(env.EVIDENCE.get(key),numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),"R2 read"); if(!obj) return new Response("Not found",{status:404});
  const headers=new Headers(); obj.writeHttpMetadata(headers); headers.set("etag",obj.httpEtag); headers.set("cache-control","private, max-age=60");
  return new Response(obj.body,{headers});
}
