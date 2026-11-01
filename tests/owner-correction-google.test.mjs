import test from 'node:test';
import assert from 'node:assert/strict';
import {patchOwnerCorrectionGoogle,rebindOwnerCorrectionGoogle} from '../dist/sheets/owner-correction-google.js';

test('Google adapters pass the final write fence and permit only matching reserved identities',async()=>{
  const plan={expenseId:'exp_test',dailyMetadataId:1,rawMetadataId:2,patches:[{metadataId:1,cells:[{columnIndex:21,value:''}]},{metadataId:2,cells:[{columnIndex:6,value:'transport'}]},{metadataId:3,cells:[{columnIndex:21,value:'transport'}]}],originalRows:[],rebind:{sourceMetadataId:1,reservationMetadataId:3,sheetId:100,correctionId:'corr_test'}};
  const source={metadataId:1,metadataKey:'malipang_expense_daily',metadataValue:'exp_test',sheetId:100,rowIndex:10},reservation={metadataId:3,metadataKey:'malipang_correction_reservation',metadataValue:'corr_test',sheetId:100,rowIndex:20},inspection={source,reservation,sourceRowIndex:10,destinationRowIndex:20,valuesVerified:true};
  let fenced=0,calls=0;const ports={patch:async(_env,rows,allowed,before)=>{await before();calls++;assert.equal(rows.length,3);assert.equal(allowed.includes(8),false);},batch:async(_env,requests,before)=>{await before();calls++;assert.equal(requests[0].updateDeveloperMetadata.dataFilters[0].developerMetadataLookup.metadataId,3);assert.equal(requests[1].deleteDeveloperMetadata.dataFilter.developerMetadataLookup.metadataId,1);}};
  await patchOwnerCorrectionGoogle({},plan,async()=>{fenced++},ports);await rebindOwnerCorrectionGoogle({},plan,inspection,async()=>{fenced++},ports);
  assert.equal(fenced,2);assert.equal(calls,2);
  await assert.rejects(rebindOwnerCorrectionGoogle({},plan,{...inspection,reservation:{...reservation,metadataId:4}},async()=>{},ports),/REBIND_INVALID/);assert.equal(calls,2);
});
