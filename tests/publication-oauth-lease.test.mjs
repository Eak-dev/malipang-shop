import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {generateKeyPairSync} from 'node:crypto';
const require=createRequire(import.meta.url),auth=require('../dist/sheets/google-auth.js'),client=require('../dist/sheets/client.js'),{ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js');
test('OAuth lease uses one fetched token and rejects scope drift or deadline expiry without refresh',async()=>{
 const fetcher=globalThis.fetch,clock=Date.now;let requests=0,now=Date.UTC(2026,10,15);
 try{
  Date.now=()=>now;const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}),env={GOOGLE_SERVICE_ACCOUNT_EMAIL:'synthetic@example.test',GOOGLE_PRIVATE_KEY_BASE64:Buffer.from(privateKey).toString('base64')},budget=new ReviewRequestBudget(40);
  globalThis.fetch=async url=>{requests++;if(String(url).includes('oauth2.googleapis.com'))return Response.json({access_token:'synthetic-token',expires_in:3600});return Response.json({sheets:[{properties:{sheetId:7,title:'pub',gridProperties:{rowCount:3,columnCount:1}}}]});};env.GOOGLE_SPREADSHEET_ID='book';
  const lease=await auth.createGoogleOAuthLease(env,budget,30000);assert.equal(requests,1);assert.equal(budget.used,1);
  for(let i=0;i<20;i++)assert.equal(await auth.getGoogleAccessToken(env,budget,lease),'synthetic-token');assert.equal(requests,1);assert.equal(budget.used,1);
  assert.equal((await client.getSheetGridInfo(env,'pub',{kind:'continuous-expense',budget,oauthLease:lease})).sheetId,7);assert.equal(requests,2);assert.equal(budget.used,2);
  await assert.rejects(auth.getGoogleAccessToken({...env,GOOGLE_SERVICE_ACCOUNT_EMAIL:'changed@example.test'},budget,lease),/LEASE_SCOPE_CHANGED/);
  await assert.rejects(auth.getGoogleAccessToken({...env,GOOGLE_SPREADSHEET_ID:'other'},budget,lease),/LEASE_SCOPE_CHANGED/);
  assert.equal(budget.reserveMutation(),true);await assert.rejects(client.batchUpdateSpreadsheetWithReply(env,[{synthetic:true}],async()=>{now+=30001;},budget,lease),/LEASE_EXPIRED/);assert.equal(requests,2);assert.equal(budget.reserved,false);
  await assert.rejects(auth.getGoogleAccessToken(env,budget,lease),/LEASE_EXPIRED/);await assert.rejects(client.getSheetGridInfo(env,'pub',{kind:'continuous-expense',budget,oauthLease:lease}),/LEASE_EXPIRED/);assert.equal(requests,2);
 }finally{globalThis.fetch=fetcher;Date.now=clock;}
});
