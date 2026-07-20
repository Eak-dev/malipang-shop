import type { Env } from "../types";
export function isTrue(value:string|undefined):boolean{return String(value??"").toLowerCase()==="true";}
export function numberEnv(value:string|undefined,fallback:number):number{const n=Number(value);return Number.isFinite(n)?n:fallback;}
export function missingRuntimeConfig(env:Env):string[]{
  const required=["LINE_CHANNEL_SECRET","LINE_CHANNEL_ACCESS_TOKEN","ADMIN_TOKEN","GOOGLE_SERVICE_ACCOUNT_EMAIL","GOOGLE_PRIVATE_KEY_BASE64","GOOGLE_SPREADSHEET_ID"] as const;
  const missing=required.filter(key=>!String(env[key]??"").trim());
  if(String(env.ADMIN_TOKEN||"").length<32&&!missing.includes("ADMIN_TOKEN"))missing.push("ADMIN_TOKEN");
  return missing;
}
export function assertRuntimeConfig(env:Env):void{const missing=missingRuntimeConfig(env);if(missing.length)throw new Error(`Missing or invalid configuration: ${missing.join(", ")}`);}
