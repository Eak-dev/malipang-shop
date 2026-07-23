import type { Env } from "../types";
export function isTrue(value:string|undefined):boolean{return String(value??"").toLowerCase()==="true";}
export function numberEnv(value:string|undefined,fallback:number):number{const n=Number(value);return Number.isFinite(n)?n:fallback;}
export function missingRuntimeConfig(env:Env):string[]{
  const required:Array<keyof Env>=["LINE_CHANNEL_SECRET","LINE_CHANNEL_ACCESS_TOKEN","LINE_OWNER_USER_ID","ADMIN_TOKEN","GOOGLE_SERVICE_ACCOUNT_EMAIL","GOOGLE_PRIVATE_KEY_BASE64","GOOGLE_SPREADSHEET_ID"];
  const missing:string[]=required.filter(key=>!String(env[key]??"").trim());
  if(String(env.ADMIN_TOKEN||"").length<32&&!missing.includes("ADMIN_TOKEN"))missing.push("ADMIN_TOKEN");
  if(!/^U[A-Za-z0-9_-]{20,64}$/.test(String(env.LINE_OWNER_USER_ID||""))&&!missing.includes("LINE_OWNER_USER_ID"))missing.push("LINE_OWNER_USER_ID");
  if(isTrue(env.OPENAI_FALLBACK_ENABLED)&&!String(env.OPENAI_API_KEY||"").trim())missing.push("OPENAI_API_KEY");
  if(isTrue(env.ATTENDANCE_ENABLED)){
    const lat=Number(env.ATTENDANCE_STORE_LAT),lng=Number(env.ATTENDANCE_STORE_LNG),radius=Number(env.ATTENDANCE_ALLOWED_RADIUS_M),maxAge=Number(env.ATTENDANCE_MAX_PHOTO_AGE_MIN),overlayConfidence=Number(env.ATTENDANCE_OVERLAY_MIN_CONFIDENCE),clockConfidence=Number(env.ATTENDANCE_CLOCK_MIN_CONFIDENCE);
    if(!Number.isFinite(lat)||lat< -90||lat>90)missing.push("ATTENDANCE_STORE_LAT");
    if(!Number.isFinite(lng)||lng< -180||lng>180)missing.push("ATTENDANCE_STORE_LNG");
    if(!Number.isFinite(radius)||radius<=0||radius>1000)missing.push("ATTENDANCE_ALLOWED_RADIUS_M");
    if(!Number.isFinite(maxAge)||maxAge<0||maxAge>60)missing.push("ATTENDANCE_MAX_PHOTO_AGE_MIN");
    if(!Number.isFinite(overlayConfidence)||overlayConfidence<0||overlayConfidence>1)missing.push("ATTENDANCE_OVERLAY_MIN_CONFIDENCE");
    if(!Number.isFinite(clockConfidence)||clockConfidence<0||clockConfidence>1)missing.push("ATTENDANCE_CLOCK_MIN_CONFIDENCE");
  }
  return missing;
}
export function assertRuntimeConfig(env:Env):void{const missing=missingRuntimeConfig(env);if(missing.length)throw new Error(`Missing or invalid configuration: ${missing.join(", ")}`);}
