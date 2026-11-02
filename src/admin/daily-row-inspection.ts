import type {Env} from '../types';
import {inspectSignedExistingRow,type InspectorEnv} from '../sheets/daily-row-attestation-inspector';
import type {EnrollmentApproval} from '../sheets/daily-row-enrollment';

const MAX_BYTES=32768;
async function bodyWithinLimit(request:Request):Promise<unknown>{
  if(!request.body)throw new Error('missing body');
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{
    while(true){
      const part=await reader.read();if(part.done)break;
      size+=part.value.byteLength;if(size>MAX_BYTES){await reader.cancel().catch(()=>{});throw new Error('body too large');}
      chunks.push(part.value);
    }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
}
function response(result:'HELD'|'CONSISTENT_READ_ONLY'):Response{
  return Response.json({ok:true,result,releasePermitted:false},{headers:{'cache-control':'no-store'}});
}
/** Only observes. Signed evidence alone is not a fence or authority to release. */
export async function inspectDailyRowRequest(request:Request,env:Env):Promise<Response>{
  if(env.DAILY_ROW_INSPECTOR_ENABLED!=='true')return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});
  try{
    const input=await bodyWithinLimit(request);
    if(!input||typeof input!=='object'||Array.isArray(input))return response('HELD');
    const {approval,signature}=input as {approval?:unknown;signature?:unknown};
    if(!approval||typeof approval!=='object'||Array.isArray(approval)||typeof signature!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(signature))return response('HELD');
    const binary=atob(signature);if(binary.length!==64||btoa(binary)!==signature)return response('HELD');
    const configured:InspectorEnv={...env,DAILY_ROW_REVIEWER_ID:env.DAILY_ROW_REVIEWER_ID||'',DAILY_ROW_REVIEWER_ED25519_PUBLIC_KEY_BASE64:env.DAILY_ROW_REVIEWER_ED25519_PUBLIC_KEY_BASE64||'',DAILY_ROW_SHEET_ID:env.DAILY_ROW_SHEET_ID||'',DAILY_ROW_APPROVED_PERIOD:env.DAILY_ROW_APPROVED_PERIOD||''};
    return response(await inspectSignedExistingRow(configured,approval as EnrollmentApproval,Uint8Array.from(binary,c=>c.charCodeAt(0))));
  }catch{return response('HELD');}
}
