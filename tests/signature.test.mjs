import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyLineSignature} from '../dist/line/signature.js';
test('LINE HMAC signature accepts exact raw body only',async()=>{const secret='test-secret',raw='{"events":[]}',key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']),digest=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(raw)),signature=Buffer.from(digest).toString('base64');assert.equal(await verifyLineSignature(raw,signature,secret),true);assert.equal(await verifyLineSignature(raw+' ',signature,secret),false);});
