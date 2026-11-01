import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMetadataColumnWriteRequest,buildMetadataRowPatchRequest,metadataPatchResponseComplete} from '../dist/sheets/client.js';

test('row metadata writes only the requested category cell and skips all other cells',()=>{
  const data=buildMetadataColumnWriteRequest([{metadataId:123,columnIndex:6,value:'transport'}]);
  assert.deepEqual(data,{valueInputOption:'RAW',data:[{dataFilter:{developerMetadataLookup:{metadataId:123}},majorDimension:'ROWS',values:[[null,null,null,null,null,null,'transport']]}]});
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
