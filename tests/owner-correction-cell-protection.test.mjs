import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOwnerCorrectionCellGuards,inspectOwnerCorrectionCellGuards} from '../dist/sheets/owner-correction-cell-protection.js';
const id='owner_correction_synthetic_123',metadata={metadataId:12,metadataKey:'malipang_expense_daily',metadataValue:'synthetic_expense',sheetId:5,rowIndex:20},account='synthetic@example.invalid';
const valid=col=>({protectedRangeId:100+col,description:`malipang-owner-correction:${id}:${col}`,range:{sheetId:5,startRowIndex:20,endRowIndex:21,startColumnIndex:col,endColumnIndex:col+1},requestingUserCanEdit:true,editors:{users:[account]}});
const inspect=(ranges,columns=[3,7])=>inspectOwnerCorrectionCellGuards({correctionId:id,metadata,columns,ranges,serviceAccount:account});
test('only exact non-warning cell guards with the Worker as editor qualify',()=>{
  assert.equal(inspect([]).kind,'NONE');assert.equal(inspect([valid(3)]).kind,'PARTIAL');assert.equal(inspect([valid(3),valid(7)]).kind,'COMPLETE');
  for(const bad of [{...valid(3),warningOnly:true},{...valid(3),requestingUserCanEdit:false},{...valid(3),editors:{users:[account,'someone@example.invalid']}},{...valid(3),editors:{users:[account],groups:['group@example.invalid']}},{...valid(3),range:{...valid(3).range,endRowIndex:22}},{...valid(3),description:'other'}])assert.equal(inspect([bad,valid(7)]).kind,'CONFLICT');
  assert.equal(inspect([valid(3),valid(3),valid(7)]).kind,'CONFLICT');assert.equal(inspect([], [21]).kind,'CONFLICT');
  assert.equal(inspect([{...valid(3),range:{...valid(3).range,startRowIndex:19,endRowIndex:20}},valid(7)]).kind,'CONFLICT');
});
test('generated guard requests target only the selected input cells',()=>{
  const requests=buildOwnerCorrectionCellGuards({correctionId:id,metadata,columns:[3,7],serviceAccount:account});assert.equal(requests.length,2);
  assert.deepEqual(requests.map(r=>r.addProtectedRange.protectedRange.range),[{sheetId:5,startRowIndex:20,endRowIndex:21,startColumnIndex:3,endColumnIndex:4},{sheetId:5,startRowIndex:20,endRowIndex:21,startColumnIndex:7,endColumnIndex:8}]);
  assert.throws(()=>buildOwnerCorrectionCellGuards({correctionId:id,metadata,columns:[8],serviceAccount:account}));
});
