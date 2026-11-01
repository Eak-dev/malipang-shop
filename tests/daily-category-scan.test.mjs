import test from 'node:test';
import assert from 'node:assert/strict';
import {planDailyCategoryScan} from '../dist/sheets/daily-category-scan.js';

const expense={expenseId:'exp',postingYear:2026,postingMonth:10,postingDay:28,description:'Driver',amountSatang:200000,amountColumn:7,category:'general',version:1,fingerprint:'synthetic',transactionDate:'2026-10-28'};
const row=()=>{const values=Array(23).fill(null);values[1]=10;values[2]=28;values[3]='Driver';values[7]=2000;values[21]='general';return {rowNumber:100,sheetYear:2026,values,metadataId:10,metadataExpenseId:'exp'}};

test('a later dropdown change becomes an owner request only after a matching baseline',()=>{
  const sheet=row();assert.equal(planDailyCategoryScan([expense],[sheet],new Map())[0].observation.kind,'BASELINE');
  sheet.values[21]='transport';const result=planDailyCategoryScan([expense],[sheet],new Map([['exp',{category:'general',version:1,rowNumber:100,metadataId:10,fingerprint:'synthetic'}]]));
  assert.deepEqual(result[0].observation,{kind:'OWNER_REVIEW',from:'general',to:'transport',expectedVersion:1});
});

test('missing or foreign metadata and initial differences cannot become requests',()=>{
  for(const mutation of [x=>x.metadataId=null,x=>x.metadataExpenseId='different']){const sheet=row();sheet.values[21]='transport';mutation(sheet);assert.equal(planDailyCategoryScan([expense],[sheet],new Map())[0].observation.reason,'IDENTITY_NOT_VERIFIED');}
  const sheet=row();sheet.values[21]='transport';assert.equal(planDailyCategoryScan([expense],[sheet],new Map())[0].observation.reason,'UNBASELINED_DIFFERENCE');
  assert.equal(planDailyCategoryScan([expense],[sheet],new Map([['exp',{category:'general',version:1,rowNumber:100,metadataId:11,fingerprint:'synthetic'}]]))[0].observation.reason,'IDENTITY_NOT_VERIFIED');
  assert.deepEqual(planDailyCategoryScan([expense],[row(),{...row(),rowNumber:101}],new Map()),[]);
});
