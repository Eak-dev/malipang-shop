import test from 'node:test';
import assert from 'node:assert/strict';
import {findUnambiguousDailyCategoryIdentities} from '../dist/sheets/daily-category-identity.js';

const candidate={expenseId:'synthetic-expense',postingYear:2026,postingMonth:10,postingDay:28,description:'Driver',amountSatang:200000,amountColumn:7};
const row=(number,description='Driver',amount=2000)=>({rowNumber:number,sheetYear:2026,values:[null,10,28,description,null,null,null,amount]});

test('identifies a unique row using month, day, description, payment column and amount',()=>{
  assert.deepEqual(findUnambiguousDailyCategoryIdentities([candidate],[row(10)]),[{expenseId:'synthetic-expense',rowNumber:10}]);
  assert.deepEqual(findUnambiguousDailyCategoryIdentities([candidate],[row(10,'Driver',2001)]),[]);
  assert.deepEqual(findUnambiguousDailyCategoryIdentities([candidate],[{rowNumber:10,sheetYear:2026,values:[null,10,29,'Driver',null,null,null,2000]}]),[]);
  assert.deepEqual(findUnambiguousDailyCategoryIdentities([{...candidate,postingYear:2016}],[row(10)]),[]);
});

test('does not link duplicates, totals, or rows with another payment amount',()=>{
  assert.deepEqual(findUnambiguousDailyCategoryIdentities([candidate],[row(10),row(11)]),[]);
  assert.deepEqual(findUnambiguousDailyCategoryIdentities([candidate,{...candidate,expenseId:'another'}],[row(10)]),[]);
  assert.deepEqual(findUnambiguousDailyCategoryIdentities([candidate],[{rowNumber:10,sheetYear:2026,values:['รวม',10,28,'Driver',null,null,null,2000]}]),[]);
  assert.deepEqual(findUnambiguousDailyCategoryIdentities([candidate],[{rowNumber:10,sheetYear:2026,values:[null,10,28,'Driver',null,null,20,2000]}]),[]);
});
