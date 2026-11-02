import test from 'node:test';
import assert from 'node:assert/strict';
import {getGoogleAccessToken} from '../dist/sheets/google-auth.js';

test('OAuth errors do not expose bodies and token response is bounded and deadline limited',async()=>{
 const key=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const pem=`-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8',key.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
 const env={GOOGLE_SERVICE_ACCOUNT_EMAIL:'test@example.invalid',GOOGLE_PRIVATE_KEY_BASE64:Buffer.from(pem).toString('base64'),EXTERNAL_API_TIMEOUT_MS:'40'};
 const before=globalThis.fetch;let read=0;
 try{
  globalThis.fetch=async()=>({ok:false,status:500,text:async()=>{read++;return 'private oauth data'}});
  await assert.rejects(getGoogleAccessToken(env),e=>e.message==='Google OAuth 500');assert.equal(read,0);
  globalThis.fetch=async()=>new Response('x'.repeat(65537));await assert.rejects(getGoogleAccessToken(env),/invalid or unreadable/);
  globalThis.fetch=async()=>new Response('{"access_token":"sensitive...');await assert.rejects(getGoogleAccessToken(env),e=>e.message==='Google OAuth invalid or unreadable response');
  globalThis.fetch=async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){return new Promise(()=>{});}}));
  const start=Date.now();await assert.rejects(getGoogleAccessToken(env),/invalid or unreadable/);assert.ok(Date.now()-start<1000);
  globalThis.fetch=async()=>new Response(JSON.stringify({access_token:'synthetic-token',expires_in:3600}));assert.equal(await getGoogleAccessToken(env),'synthetic-token');
 }finally{globalThis.fetch=before;}
});
