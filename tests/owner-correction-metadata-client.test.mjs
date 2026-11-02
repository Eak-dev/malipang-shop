import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {batchGetSheetSerialValues,buildMetadataColumnWriteRequest,buildMetadataRowPatchRequest,getSheetProtectedRanges,getSheetRowMetadataById,metadataPatchResponseComplete} from '../dist/sheets/client.js';
const require=createRequire(import.meta.url),googleAuth=require('../dist/sheets/google-auth.js');

test('row metadata writes only the requested category cell and skips all other cells',()=>{
  const data=buildMetadataColumnWriteRequest([{metadataId:123,columnIndex:6,value:'transport'}]);
  assert.deepEqual(data,{valueInputOption:'RAW',data:[{dataFilter:{developerMetadataLookup:{metadataId:123}},majorDimension:'ROWS',values:[[null,null,null,null,null,null,'transport']]}]});
});
test('metadata lookup distinguishes a verified missing ID from API failure or malformed identity',async()=>{
  const originalFetch=globalThis.fetch,originalAuth=googleAuth.getGoogleAccessToken;
  try{
    googleAuth.getGoogleAccessToken=async()=> 'synthetic';const env={GOOGLE_SPREADSHEET_ID:'synthetic',EXTERNAL_API_TIMEOUT_MS:'1000'};
    globalThis.fetch=async()=>new Response('',{status:404});assert.equal(await getSheetRowMetadataById(env,42),null);
    globalThis.fetch=async()=>new Response('',{status:503});await assert.rejects(getSheetRowMetadataById(env,42));
    globalThis.fetch=async()=>Response.json({metadataId:42,metadataKey:'key',metadataValue:'value',location:{dimensionRange:{sheetId:7,dimension:'ROWS',startIndex:3,endIndex:4}}});
    assert.deepEqual(await getSheetRowMetadataById(env,42),{metadataId:42,metadataKey:'key',metadataValue:'value',sheetId:7,rowIndex:3});
    globalThis.fetch=async()=>Response.json({metadataId:43,metadataKey:'key',metadataValue:'value',location:{dimensionRange:{sheetId:7,dimension:'ROWS',startIndex:3,endIndex:4}}});await assert.rejects(getSheetRowMetadataById(env,42),/INVALID_ROW_METADATA/);
  }finally{globalThis.fetch=originalFetch;googleAuth.getGoogleAccessToken=originalAuth;}
});
test('a patch response is accepted only for exactly the requested unique row identities',()=>{
  const patches=[{metadataId:12,cells:[{columnIndex:3,value:'x'}]},{metadataId:13,cells:[{columnIndex:3,value:''}]}];
  const response=id=>({dataFilter:{developerMetadataLookup:{metadataId:id}},updatedRows:1});
  assert.equal(metadataPatchResponseComplete(patches,{responses:[response(13),response(12)]}),true);
  for(const responses of [[response(12)],[response(12),response(12)],[response(12),response(14)],[response(12),{...response(13),updatedRows:0}]])assert.equal(metadataPatchResponseComplete(patches,{responses}),false);
});

test('a row patch clears only explicit input cells and skips formula columns',()=>{
  const plan=buildMetadataRowPatchRequest([{metadataId:12,cells:[{columnIndex:3,value:'Driver'},{columnIndex:7,value:2000},{columnIndex:21,value:'transport'}]},{metadataId:13,cells:[{columnIndex:3,value:''},{columnIndex:7,value:''}]}],[3,7,21]);
  assert.equal(plan.data[0].values[0][3],'Driver');assert.equal(plan.data[0].values[0][7],2000);assert.equal(plan.data[0].values[0][8],null);assert.equal(plan.data[0].values[0][21],'transport');
  assert.equal(plan.data[1].values[0][3],'');assert.equal(plan.data[1].values[0][8],undefined);
  assert.throws(()=>buildMetadataRowPatchRequest([{metadataId:12,cells:[{columnIndex:8,value:'overwrite'}]}],[3,7,21]));
  assert.throws(()=>buildMetadataRowPatchRequest([{metadataId:12,cells:[{columnIndex:3,value:null}]}],[3]));
  assert.throws(()=>buildMetadataRowPatchRequest([{metadataId:12,cells:[{columnIndex:3,value:'a'},{columnIndex:3,value:'b'}]}],[3]));
});

test('row metadata writes reject duplicate IDs and invalid targets',()=>{
  assert.throws(()=>buildMetadataColumnWriteRequest([{metadataId:2,columnIndex:6,value:'a'},{metadataId:2,columnIndex:7,value:'b'}]));
  for(const [metadataId,columnIndex] of [[0,6],[1,-1],[1,26],[NaN,6]])assert.throws(()=>buildMetadataColumnWriteRequest([{metadataId,columnIndex,value:'a'}]));
});

test('report reads request unformatted numeric date serials rather than locale formatted dates',async()=>{
  const originalFetch=globalThis.fetch,originalAuth=googleAuth.getGoogleAccessToken;try{
    googleAuth.getGoogleAccessToken=async()=> 'synthetic';let url='';globalThis.fetch=async(value)=>{url=String(value);return Response.json({valueRanges:[{values:[[46323]]}]});};
    assert.deepEqual(await batchGetSheetSerialValues({GOOGLE_SPREADSHEET_ID:'synthetic',EXTERNAL_API_TIMEOUT_MS:'1000'},["'QA'!C2"]),[[[46323]]]);
    const parsed=new URL(url);assert.equal(parsed.searchParams.get('valueRenderOption'),'UNFORMATTED_VALUE');assert.equal(parsed.searchParams.get('dateTimeRenderOption'),'SERIAL_NUMBER');assert.deepEqual(parsed.searchParams.getAll('ranges'),["'QA'!C2"]);
  }finally{globalThis.fetch=originalFetch;googleAuth.getGoogleAccessToken=originalAuth;}
});
test('sheet protection lookup requires exactly one matching sheet',async()=>{
  const originalFetch=globalThis.fetch,originalAuth=googleAuth.getGoogleAccessToken;try{
    googleAuth.getGoogleAccessToken=async()=> 'synthetic';const env={GOOGLE_SPREADSHEET_ID:'synthetic',EXTERNAL_API_TIMEOUT_MS:'1000'};
    globalThis.fetch=async()=>Response.json({sheets:[{properties:{sheetId:3,title:'daily'},protectedRanges:[{range:{sheetId:3}}]}]});assert.equal((await getSheetProtectedRanges(env,'daily')).sheetId,3);
    globalThis.fetch=async()=>Response.json({sheets:[{properties:{sheetId:3,title:'daily'}},{properties:{sheetId:4,title:'daily'}}]});await assert.rejects(getSheetProtectedRanges(env,'daily'),/PROTECTION_SHEET_INVALID/);
  }finally{globalThis.fetch=originalFetch;googleAuth.getGoogleAccessToken=originalAuth;}
});
