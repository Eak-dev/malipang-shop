import type { Env } from "../types";
import { fetchWithTimeout,readBoundedJson } from "../shared/async";
import { numberEnv } from "../shared/env";
// A single bounded entry, keyed by the full credential identity. Cloudflare
// can reuse one isolate across requests with different bindings or rotations.
// The fingerprint stays in memory only and is never logged or returned.
let cache:{credentialFingerprint:string;token:string;expiresAt:number}|null=null;
async function credentialFingerprint(email:string,privateKey:string):Promise<string>{
  if(typeof email!=='string'||!email||typeof privateKey!=='string'||!privateKey)throw new Error('Google OAuth credentials unavailable');
  const bytes=new TextEncoder().encode(JSON.stringify([email,privateKey]));
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));return b64url(hash);
}
function decodeBase64(value:string):Uint8Array{const binary=atob(value.replace(/\s/g,""));return Uint8Array.from(binary,c=>c.charCodeAt(0));}
function b64url(data:Uint8Array|string):string{const bytes=typeof data==="string"?new TextEncoder().encode(data):data;let binary="";for(const b of bytes)binary+=String.fromCharCode(b);return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
async function importKey(base64Pem:string):Promise<CryptoKey>{const pem=new TextDecoder().decode(decodeBase64(base64Pem));const body=pem.replace(/-----BEGIN PRIVATE KEY-----/g,"").replace(/-----END PRIVATE KEY-----/g,"").replace(/\s/g,"");return crypto.subtle.importKey("pkcs8",decodeBase64(body),{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);}
export async function getGoogleAccessToken(env:Env):Promise<string>{
  const email=env.GOOGLE_SERVICE_ACCOUNT_EMAIL,privateKey=env.GOOGLE_PRIVATE_KEY_BASE64,fingerprint=await credentialFingerprint(email,privateKey);
  if(cache&&cache.credentialFingerprint===fingerprint&&cache.expiresAt>Date.now()+60000)return cache.token;
  const now=Math.floor(Date.now()/1000); const header=b64url(JSON.stringify({alg:"RS256",typ:"JWT"})); const claims=b64url(JSON.stringify({iss:email,scope:"https://www.googleapis.com/auth/spreadsheets",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600})); const input=`${header}.${claims}`;
  const key=await importKey(privateKey); const sig=await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,new TextEncoder().encode(input)); const assertion=`${input}.${b64url(new Uint8Array(sig))}`;
  const timeout=numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000);
  const requestedAt=Date.now(),res=await fetchWithTimeout("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion})},timeout,"Google OAuth");
  if(!res.ok){if(res.body)void res.body.cancel().catch(()=>{});throw new Error(`Google OAuth ${res.status}`);}
  let data:{access_token?:unknown;expires_in?:unknown};
  try{data=await readBoundedJson(res,65536,timeout,"Google OAuth body") as {access_token?:unknown;expires_in?:unknown};}catch{throw new Error("Google OAuth invalid or unreadable response");}
  if(typeof data?.access_token!=="string"||!data.access_token||typeof data.expires_in!=="number"||!Number.isFinite(data.expires_in)||data.expires_in<=0)throw new Error("Google OAuth invalid response");
  const expiresAt=requestedAt+Math.min(data.expires_in,3600)*1000;if(expiresAt<=Date.now())throw new Error('Google OAuth token expired');
  cache={credentialFingerprint:fingerprint,token:data.access_token,expiresAt};return data.access_token;
}
