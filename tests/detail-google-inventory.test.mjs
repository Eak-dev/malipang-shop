import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {parseDetailInventory,readDetailProviderInventory}=require('../dist/sheets/detail-google-inventory.js');
const {RAW_PROJECTION_HEADERS}=require('../dist/sheets/raw-projection.js');
const client=require('../dist/sheets/client.js'),auth=require('../dist/sheets/google-auth.js'),sourceModule=require('../dist/sheets/detail-source-proof.js');
const cell=v=>v===null||v===''?{}:{userEnteredValue:typeof v==='number'?{numberValue:v}:{stringValue:v}};
const values=id=>[id,'exp_fixture','doc1','2026-10-01','Vendor','INV',id,1,'unit',2,0,2,'',10,'raw','branch','CONFIRMED','private', 'created','updated'];
const source={expenseId:'exp_fixture',version:1,revision:2,fingerprint:'a'.repeat(64),entries:[{itemId:'a',values:values('a')},{itemId:'b',values:values('b')}]};
const marker=(id,row)=>({metadataId:id,metadataKey:'D',visibility:'DOCUMENT',location:{dimensionRange:{sheetId:9,dimension:'ROWS',startIndex:row,endIndex:row+1}}});
function fixture(){return{sheets:[{properties:{sheetId:9,title:'detail',gridProperties:{rowCount:4,columnCount:20}},data:[{startRow:0,startColumn:0,rowData:[{values:RAW_PROJECTION_HEADERS.PURCHASE_DETAILS.map(cell)},{values:values('a').map(cell)},{values:values('b').map(cell)}],rowMetadata:[{},{developerMetadata:[marker(10,1)]},{developerMetadata:[marker(11,2)]}]}]}]};}
test('checks every item, parent, metadata, owned cell and ignores private manual field',()=>{const f=fixture(),r=parseDetailInventory(f,'detail',source);assert.equal(r.items.length,2);assert.deepEqual(r.items.map(x=>x.metadataId),[10,11]);
  f.sheets[0].data[0].rowData[1].values[17]={userEnteredValue:{formulaValue:'=manual'}};assert.equal(parseDetailInventory(f,'detail',source).items.length,2);
  f.sheets[0].data[0].rowData[1].values[7]={userEnteredValue:{numberValue:999}};assert.throws(()=>parseDetailInventory(f,'detail',source),/OWNED_FIELD/);
});
test('row moves resolve by metadata and item id; duplicates and extra siblings hold',()=>{const f=fixture(),block=f.sheets[0].data[0];[block.rowData[1],block.rowData[2]]=[block.rowData[2],block.rowData[1]];block.rowMetadata[1]={developerMetadata:[marker(11,1)]};block.rowMetadata[2]={developerMetadata:[marker(10,2)]};assert.deepEqual(parseDetailInventory(f,'detail',source).items.map(x=>x.metadataId),[10,11]);
  block.rowData[2].values[0]=cell('b');assert.throws(()=>parseDetailInventory(f,'detail',source),/DUPLICATE/);
  const extra=fixture();extra.sheets[0].data[0].rowData.push({values:values('other').map(cell)});assert.throws(()=>parseDetailInventory(extra,'detail',source),/CONFLICT/);
});
test('missing/moved marker, formulas, annotations, incorrect sheet and protection hold',()=>{for(const mutate of [
  f=>{f.sheets[0].data[0].rowMetadata[1]={};},
  f=>{f.sheets[0].data[0].rowMetadata[1]={developerMetadata:[marker(10,2)]};},
  f=>{f.sheets[0].data[0].rowData[1].values[1]={userEnteredValue:{formulaValue:'="exp_fixture"'}};},
  f=>{f.sheets[0].data[0].rowData[1].values[6].note='manual';},
  f=>{f.sheets[0].protectedRanges=[{}];},
  f=>{f.sheets[0].properties.gridProperties.rowCount=2501;}
]){const f=fixture();mutate(f);assert.throws(()=>parseDetailInventory(f,'detail',source));}});
test('empty source cannot certify a sheet containing the same parent',()=>{assert.throws(()=>parseDetailInventory(fixture(),'detail',{...source,entries:[]}),/CONFLICT/)});
test('provider entrypoint fails closed when disabled without leaking input',async()=>{await assert.rejects(readDetailProviderInventory({},'exp_fixture',1,1),/DETAIL_PROVIDER_INVENTORY_UNAVAILABLE/)});
test('typed Google inventory reader is authenticated, tab scoped and sanitizes failures',async()=>{const originalFetch=globalThis.fetch,originalToken=auth.getGoogleAccessToken;try{
  const env={RUNTIME_MODE:'production',DETAIL_IDENTITY_READER_ENABLED:'true',EXPENSE_STABLE_PROJECTION_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'synthetic',SHEET_PURCHASE_DETAILS:"D'et"};let calls=0;
  auth.getGoogleAccessToken=async()=>'test-token';globalThis.fetch=async(url,init)=>{calls++;assert.equal(init.method,'GET');assert.equal(new URL(String(url)).searchParams.get('ranges'),"'D''et'!A1:T2500");return new Response(JSON.stringify(fixture()));};
  await assert.rejects(client.getDetailProductionInventory({...env,DETAIL_IDENTITY_READER_ENABLED:undefined}),/DISABLED/);assert.equal(calls,0);await client.getDetailProductionInventory(env);assert.equal(calls,1);
  globalThis.fetch=async()=>new Response('{SECRET_PRIVATE_SENTINEL');await assert.rejects(client.getDetailProductionInventory(env),e=>e.message==='DETAIL_READER_UNAVAILABLE'&&!String(e).includes('SECRET_PRIVATE_SENTINEL'));
}finally{globalThis.fetch=originalFetch;auth.getGoogleAccessToken=originalToken}});
test('provider double-read rejects source or metadata changing mid-read',async()=>{const originalGrid=client.getDetailProductionInventory,originalSource=sourceModule.readDetailSourceProof;try{
  const env={SHEET_PURCHASE_DETAILS:'detail',SHEET_EXPENSE_DAILY:'daily',SHEET_EXPENSE_RAW:'raw',SHEET_PERSONAL_USE_RAW:'personal',GOOGLE_SPREADSHEET_ID:'book',GOOGLE_SERVICE_ACCOUNT_EMAIL:'test@example.test',GOOGLE_PRIVATE_KEY_BASE64:'test-key',DB:{},RUNTIME_MODE:'production',DETAIL_IDENTITY_READER_ENABLED:'true',EXPENSE_STABLE_PROJECTION_ENABLED:'true'};let n=0;
  sourceModule.readDetailSourceProof=async()=>source;client.getDetailProductionInventory=async()=>{n++;return fixture();};
  const first=await readDetailProviderInventory(env,'exp_fixture',1,2);assert.equal(first.itemCount,2);assert.equal(n,2);
  env.GOOGLE_SPREADSHEET_ID='other-book';assert.notEqual((await readDetailProviderInventory(env,'exp_fixture',1,2)).providerDigest,first.providerDigest);env.GOOGLE_SPREADSHEET_ID='book';
  n=0;client.getDetailProductionInventory=async()=>{n++;const f=fixture();if(n===2)f.sheets[0].data[0].rowMetadata[1]={developerMetadata:[marker(20,1)]};return f;};
  await assert.rejects(readDetailProviderInventory(env,'exp_fixture',1,2),/DETAIL_PROVIDER_INVENTORY_UNAVAILABLE/);
  let reads=0;client.getDetailProductionInventory=async()=>fixture();sourceModule.readDetailSourceProof=async()=>++reads===1?source:{...source,fingerprint:'b'.repeat(64)};
  await assert.rejects(readDetailProviderInventory(env,'exp_fixture',1,2),/DETAIL_PROVIDER_INVENTORY_UNAVAILABLE/);
  sourceModule.readDetailSourceProof=async()=>source;
  for(const change of [()=>{env.GOOGLE_SPREADSHEET_ID='other'},()=>{env.DB={}},()=>{env.DETAIL_IDENTITY_READER_ENABLED='false'},()=>{env.SHEET_PURCHASE_DETAILS='changed'}]){
    const original={...env};client.getDetailProductionInventory=async()=>{change();return fixture()};await assert.rejects(readDetailProviderInventory(env,'exp_fixture',1,2),/DETAIL_PROVIDER_INVENTORY_UNAVAILABLE/);Object.assign(env,original);
  }
  client.getDetailProductionInventory=async()=>fixture();const digest=crypto.subtle.digest.bind(crypto.subtle);
  Object.defineProperty(crypto.subtle,'digest',{configurable:true,value:async(...args)=>{env.GOOGLE_SPREADSHEET_ID='changed-during-hash';return digest(...args)}});
  try{await assert.rejects(readDetailProviderInventory(env,'exp_fixture',1,2),/DETAIL_PROVIDER_INVENTORY_UNAVAILABLE/)}finally{delete crypto.subtle.digest;}
}finally{client.getDetailProductionInventory=originalGrid;sourceModule.readDetailSourceProof=originalSource}});
