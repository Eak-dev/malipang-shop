import { isTrue } from "../shared/env";
import type { Env } from "../types";
export async function saveEvidence(env: Env, key: string, data: ArrayBuffer, metadata: Record<string,string>): Promise<void> {
  if (!isTrue(env.R2_EVIDENCE_ENABLED)) return;
  await env.EVIDENCE.put(key,data,{httpMetadata:{contentType:"image/jpeg"},customMetadata:metadata});
}
export async function getEvidence(env: Env, key: string): Promise<Response> {
  const obj=await env.EVIDENCE.get(key); if(!obj) return new Response("Not found",{status:404});
  const headers=new Headers(); obj.writeHttpMetadata(headers); headers.set("etag",obj.httpEtag); headers.set("cache-control","private, max-age=60");
  return new Response(obj.body,{headers});
}
