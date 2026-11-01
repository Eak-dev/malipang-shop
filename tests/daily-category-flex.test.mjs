import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDailyCategoryReviewFlex} from '../dist/sheets/daily-category-flex.js';

test('owner review shows old and requested categories, amount and version-bound decisions',()=>{
  const card=buildDailyCategoryReviewFlex({requestId:'category_request_fixture',description:'Driver',amountSatang:200000,transactionDate:'2026-10-28',fromCategory:'general',toCategory:'transport',expenseVersion:3,rowNumber:100});
  const json=JSON.stringify(card);
  for(const value of ['Driver','2,000.00','ทั่วไป','ขนส่ง/รถ','sheet_category_approve','sheet_category_reject','v=3'])assert.ok(json.includes(value),value);
});
