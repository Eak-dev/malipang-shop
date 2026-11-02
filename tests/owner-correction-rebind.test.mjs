import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOwnerCorrectionRebind,classifyOwnerCorrectionRebind} from '../dist/sheets/owner-correction-rebind.js';

const source=()=>({metadataId:10,metadataKey:'malipang_expense_daily',metadataValue:'exp_fixture',sheetId:1,rowIndex:10});
const reservation=()=>({metadataId:11,metadataKey:'malipang_correction_reservation',metadataValue:'correction_fixture',sheetId:1,rowIndex:20});
test('rebind promotes the destination marker by id and deletes the old source marker',()=>{
  const requests=buildOwnerCorrectionRebind({expenseId:'exp_fixture',correctionId:'correction_fixture',source:source(),reservation:reservation()});
  assert.equal(requests[0].updateDeveloperMetadata.developerMetadata.metadataKey,'malipang_expense_daily');
  assert.equal(requests[0].updateDeveloperMetadata.developerMetadata.metadataValue,'exp_fixture');
  assert.equal(requests[0].updateDeveloperMetadata.dataFilters[0].developerMetadataLookup.metadataId,11);
  assert.equal(requests[1].deleteDeveloperMetadata.dataFilter.developerMetadataLookup.metadataId,10);
  assert.throws(()=>buildOwnerCorrectionRebind({expenseId:'exp_fixture',correctionId:'other',source:source(),reservation:reservation()}));
});
test('recovery distinguishes original, completed, and unexpected metadata states',()=>{
  const state={expenseId:'exp_fixture',correctionId:'correction_fixture',source:source(),reservation:reservation(),sourceRowIndex:10,destinationRowIndex:20,sheetId:1};
  assert.equal(classifyOwnerCorrectionRebind(state),'BEFORE');
  assert.equal(classifyOwnerCorrectionRebind({...state,source:null,reservation:{...reservation(),metadataKey:'malipang_expense_daily',metadataValue:'exp_fixture'}}),'AFTER');
  assert.equal(classifyOwnerCorrectionRebind({...state,source:{...source(),rowIndex:20}}),'CONFLICT');
  assert.equal(classifyOwnerCorrectionRebind({...state,reservation:{...reservation(),metadataValue:'someone_else'}}),'CONFLICT');
});
