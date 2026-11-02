import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOwnerCorrectionFormula as normalize} from '../dist/sheets/owner-correction-formula.js';

test('only safe daily-range extension is normalized',()=>{
  const formula="=SUM('รายวัน'!$I$5:$I$3421)+COUNT('รายวัน'!U5:U3421)",extended="=SUM('รายวัน'!$I$5:$I$3500)+COUNT('รายวัน'!U5:U3500)";
  assert.deepEqual(normalize(formula,3421),{normalized:"=SUM('รายวัน'!$I$5:$I$<ROW_END>)+COUNT('รายวัน'!U5:U<ROW_END>)",endRow:3421});
  assert.equal(normalize(extended,3421).normalized,normalize(formula,3421).normalized);
  assert.equal(normalize(formula.replaceAll('3421','3420'),3421),null);
  assert.equal(normalize(formula.replace('U3421','U3500'),3421),null);
  assert.notEqual(normalize(formula.replace('$I$5','$I$6'),3421).normalized,normalize(formula,3421).normalized);
  assert.notEqual(normalize(formula.replace("'รายวัน'!U5", "'other'!U5"),3421).normalized,normalize(formula,3421).normalized);
});
