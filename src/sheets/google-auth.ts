import type { Env } from "../types";
let cache:{token:string;expiresAt:number}|null=null;
function decodeBase64(value:string):Uint8Array{const binary=atob(value.replace(/\s/g,""));return Uint8Array.from(binary,c=>c.charCodeAt(0));}
function b64url(data:Uint8Array|string):string{const bytes=typeof data==="string"?new TextEncoder().encode(data):data;let binary="";for(const b of bytes)binary+=String.fromCharCode(b);return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
async function importKey(base64Pem:string):Promise<CryptoKey>{const pem=new TextDecoder().decode(decodeBase64(base64Pem));const body=pem.replace(/-----BEGIN PRIVATE KEY-----/g,"").replace(/-----END PRIVATE KEY-----/g,"").replace(/\s/g,"");return crypto.subtle.importKey("pkcs8",decodeBase64(body),{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);}
export async function getGoogleAccessToken(env:Env):Promise<string>{
  if(cache&&cache.expiresAt>Date.now()+60000)return cache.token;
  const now=Math.floor(Date.now()/1000); const header=b64url(JSON.stringify({alg:"RS256",typ:"JWT"})); const claims=b64url(JSON.stringify({iss:env.GOOGLE_SERVICE_ACCOUNT_EMAIL,scope:"https://www.googleapis.com/auth/spreadsheets",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600})); const input=`${header}.${claims}`;
  const key=await importKey(env.GOOGLE_PRIVATE_KEY_BASE64); const sig=await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,new TextEncoder().encode(input)); const assertion=`${input}.${b64url(new Uint8Array(sig))}`;
  const res=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion})}); if(!res.ok)throw new Error(`Google OAuth ${res.status}: ${await res.text()}`); const data=(await res.json()) as {access_token:string;expires_in:number};cache={token:data.access_token,expiresAt:Date.now()+data.expires_in*1000};return data.access_token;
}
