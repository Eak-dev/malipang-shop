import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyCategoryDropdownRequests} from '../dist/sheets/daily-category-dropdown.js';
import {expenseCategories} from '../dist/expense/document.js';

test('dropdown uses supported categories and explains owner approval without changing values',()=>{
  const [validation,header]=dailyCategoryDropdownRequests(42);
  assert.deepEqual(validation.setDataValidation.range,{sheetId:42,startRowIndex:4,startColumnIndex:21,endColumnIndex:22});
  assert.deepEqual(validation.setDataValidation.rule.condition.values.map(value=>value.userEnteredValue),[...expenseCategories]);
  assert.match(validation.setDataValidation.rule.inputMessage,/เจ้าของ/);
  assert.equal(header.updateCells.fields,'note');
  assert.throws(()=>dailyCategoryDropdownRequests(-1));
});
