import type { Env } from "../types";
import type {ReviewRequestBudget} from "./review-request-budget";
import { fetchWithTimeout,OperationTimeoutError,withTimeout } from "../shared/async";
import { numberEnv } from "../shared/env";
let cache:{token:string;expiresAt:number}|null=null;
/** Keep provider response bodies out of exceptions and owner alerts. */
export class GoogleOAuthHttpError extends Error{
  constructor(public readonly status:number){super(`GOOGLE_OAUTH_HTTP_${status}`);this.name='GoogleOAuthHttpError';}
}
/** Safe pre-Sheets authentication failures. Never embed credential or response data. */
export class GoogleOAuthPreflightError extends Error{
  constructor(public readonly code:'GOOGLE_OAUTH_CREDENTIAL_INVALID'|'GOOGLE_OAUTH_NETWORK'|'GOOGLE_OAUTH_RESPONSE_INVALID'){
    super(code);this.name='GoogleOAuthPreflightError';
  }
}
function decodeBase64(value:string):Uint8Array{const binary=atob(value.replace(/\s/g,""));return Uint8Array.from(binary,c=>c.charCodeAt(0));}
function b64url(data:Uint8Array|string):string{const bytes=typeof data==="string"?new TextEncoder().encode(data):data;let binary="";for(const b of bytes)binary+=String.fromCharCode(b);return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
async function importKey(base64Pem:string):Promise<CryptoKey>{const pem=new TextDecoder().decode(decodeBase64(base64Pem));const body=pem.replace(/-----BEGIN PRIVATE KEY-----/g,"").replace(/-----END PRIVATE KEY-----/g,"").replace(/\s/g,"");return crypto.subtle.importKey("pkcs8",decodeBase64(body),{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);}
/** Bound both the body size and the whole OAuth exchange time. `fetch()` can
 * resolve when headers arrive while the body remains stalled indefinitely. */
async function readOAuthBody(res:Response,remainingMs:number):Promise<unknown>{
  if(!res.body)throw new GoogleOAuthPreflightError('GOOGLE_OAUTH_RESPONSE_INVALID');
  const reader=res.body.getReader(),chunks:Uint8Array[]=[];let total=0,complete=false;
  const read=async()=>{
    while(true){const part=await reader.read();if(part.done){complete=true;break;}if(!(part.value instanceof Uint8Array))throw new GoogleOAuthPreflightError('GOOGLE_OAUTH_RESPONSE_INVALID');total+=part.value.byteLength;if(total>65536)throw new GoogleOAuthPreflightError('GOOGLE_OAUTH_RESPONSE_INVALID');chunks.push(part.value);}
    const body=new Uint8Array(total);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)) as unknown;}catch{throw new GoogleOAuthPreflightError('GOOGLE_OAUTH_RESPONSE_INVALID');}
  };
  try{return await withTimeout(read(),remainingMs,'Google OAuth');}
  catch(error){if(error instanceof OperationTimeoutError||error instanceof GoogleOAuthPreflightError)throw error;throw new GoogleOAuthPreflightError('GOOGLE_OAUTH_NETWORK');}
  finally{
    // Cancellation is best-effort; don't allow a broken underlying stream to
    // hang the handler after its bounded deadline.
    if(!complete)try{await Promise.race([reader.cancel().catch(()=>{}),new Promise<void>(resolve=>setTimeout(resolve,0))]);}catch{}
    try{reader.releaseLock();}catch{}
  }
}
export async function getGoogleAccessToken(env:Env,budget?:ReviewRequestBudget):Promise<string>{
  if(cache&&cache.expiresAt>Date.now()+60000)return cache.token;
  let assertion:string;
  try{
    if(typeof env.GOOGLE_SERVICE_ACCOUNT_EMAIL!=='string'||!env.GOOGLE_SERVICE_ACCOUNT_EMAIL.trim()||typeof env.GOOGLE_PRIVATE_KEY_BASE64!=='string'||!env.GOOGLE_PRIVATE_KEY_BASE64.trim())throw Error('invalid');
    const now=Math.floor(Date.now()/1000),header=b64url(JSON.stringify({alg:"RS256",typ:"JWT"})),claims=b64url(JSON.stringify({iss:env.GOOGLE_SERVICE_ACCOUNT_EMAIL,scope:"https://www.googleapis.com/auth/spreadsheets",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600})),input=`${header}.${claims}`;
    const key=await importKey(env.GOOGLE_PRIVATE_KEY_BASE64),sig=await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,new TextEncoder().encode(input));assertion=`${input}.${b64url(new Uint8Array(sig))}`;
  }catch{throw new GoogleOAuthPreflightError('GOOGLE_OAUTH_CREDENTIAL_INVALID');}
  let res:Response;const timeoutMs=numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),startedAt=Date.now();
  try{budget?.consumeRead();res=await fetchWithTimeout("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion}),...(budget?{redirect:"error" as RequestRedirect}:{})},timeoutMs,"Google OAuth");}
  catch(error){if(error instanceof TypeError)throw new GoogleOAuthPreflightError('GOOGLE_OAUTH_NETWORK');throw error;}
  if(!res.ok){try{await Promise.race([res.body?.cancel().catch(()=>{}),new Promise<void>(resolve=>setTimeout(resolve,0))]);}catch{}throw new GoogleOAuthHttpError(res.status);}
  const data=await readOAuthBody(res,Math.max(1,Math.floor(timeoutMs-(Date.now()-startedAt))));
  if(!data||typeof data!=='object'||Array.isArray(data))throw new GoogleOAuthPreflightError('GOOGLE_OAUTH_RESPONSE_INVALID');
  const {access_token:token,expires_in:expires}=data as {access_token?:unknown;expires_in?:unknown};
  // Google documents a maximum OAuth access-token size of 2,048 bytes.
  if(typeof token!=='string'||!token||token.length>2048||!/^[\x21-\x7e]+$/.test(token)||typeof expires!=='number'||!Number.isFinite(expires)||expires<=0||expires>31536000)throw new GoogleOAuthPreflightError('GOOGLE_OAUTH_RESPONSE_INVALID');
  cache={token,expiresAt:Date.now()+expires*1000};return token;
}
