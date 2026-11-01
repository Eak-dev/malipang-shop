import test from 'node:test';
import assert from 'node:assert/strict';
import {planCategoryMetadata} from '../dist/sheets/daily-category-metadata.js';

const target={sheetId:1,rowIndex:4,key:'expense-daily',value:'synthetic-expense'};
test('metadata creation is idempotent and associated with one complete row',()=>{
  const plan=planCategoryMetadata([target],[])[0];assert.equal(plan.kind,'CREATE');
  assert.deepEqual(plan.request.createDeveloperMetadata.developerMetadata.location.dimensionRange,{sheetId:1,dimension:'ROWS',startIndex:4,endIndex:5});
  assert.deepEqual(planCategoryMetadata([target],[{...target,metadataId:123}])[0],{kind:'EXISTING',target,metadataId:123});
});
test('metadata conflicts and duplicate targets stop instead of rebinding',()=>{
  assert.equal(planCategoryMetadata([target],[{...target,rowIndex:5,metadataId:1}])[0].reason,'METADATA_IDENTITY_MISMATCH');
  assert.equal(planCategoryMetadata([target],[{...target,value:'other',metadataId:1}])[0].reason,'ROW_ALREADY_LINKED');
  assert.equal(planCategoryMetadata([target,target],[])[0].reason,'DUPLICATE_TARGET');
});
