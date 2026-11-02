import type {Env} from '../types';
import {inspectSignedExistingRow,type InspectorEnv} from '../sheets/daily-row-attestation-inspector';
import type {EnrollmentApproval} from '../sheets/daily-row-enrollment';
import {readBoundedJson} from '../shared/async';

const MAX_BYTES=32768;
async function bodyWithinLimit(request:Request):Promise<unknown>{
  return readBoundedJson(request,MAX_BYTES,5000,'Inspector request body');
}
export async function readSignedDailyApproval(request:Request):Promise<{approval:EnrollmentApproval;signature:Uint8Array}|null>{
  try{
    const input=await bodyWithinLimit(request);
    if(!input||typeof input!=='object'||Array.isArray(input))return null;
    const {approval,signature}=input as {approval?:unknown;signature?:unknown};
    if(!approval||typeof approval!=='object'||Array.isArray(approval)||typeof signature!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(signature))return null;
    const binary=atob(signature);if(binary.length!==64||btoa(binary)!==signature)return null;
    return {approval:approval as EnrollmentApproval,signature:Uint8Array.from(binary,c=>c.charCodeAt(0))};
  }catch{return null;}
}
export function configuredDailyInspector(env:Env):InspectorEnv{
  return {...env,DAILY_ROW_REVIEWER_ID:env.DAILY_ROW_REVIEWER_ID||'',DAILY_ROW_REVIEWER_ED25519_PUBLIC_KEY_BASE64:env.DAILY_ROW_REVIEWER_ED25519_PUBLIC_KEY_BASE64||'',DAILY_ROW_SHEET_ID:env.DAILY_ROW_SHEET_ID||'',DAILY_ROW_APPROVED_PERIOD:env.DAILY_ROW_APPROVED_PERIOD||''};
}
function response(result:'HELD'|'CONSISTENT_READ_ONLY'):Response{
  return Response.json({ok:true,result,releasePermitted:false},{headers:{'cache-control':'no-store'}});
}
/** Only observes. Signed evidence alone is not a fence or authority to release. */
export async function inspectDailyRowRequest(request:Request,env:Env):Promise<Response>{
  if(env.DAILY_ROW_INSPECTOR_ENABLED!=='true')return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});
  try{
    const signed=await readSignedDailyApproval(request);if(!signed)return response('HELD');
    return response(await inspectSignedExistingRow(configuredDailyInspector(env),signed.approval,signed.signature));
  }catch{return response('HELD');}
}
