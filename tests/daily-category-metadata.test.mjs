import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMetadataColumnWriteRequest} from '../dist/sheets/client.js';

test('row metadata writes only the requested category cell and skips all other cells',()=>{
  const data=buildMetadataColumnWriteRequest([{metadataId:123,columnIndex:6,value:'transport'}]);
  assert.deepEqual(data,{valueInputOption:'RAW',data:[{dataFilter:{developerMetadataLookup:{metadataId:123}},majorDimension:'ROWS',values:[[null,null,null,null,null,null,'transport']]}]});
});

test('row metadata writes reject duplicate IDs and invalid targets',()=>{
  assert.throws(()=>buildMetadataColumnWriteRequest([{metadataId:2,columnIndex:6,value:'a'},{metadataId:2,columnIndex:7,value:'b'}]));
  for(const [metadataId,columnIndex] of [[0,6],[1,-1],[1,26],[NaN,6]])assert.throws(()=>buildMetadataColumnWriteRequest([{metadataId,columnIndex,value:'a'}]));
});
