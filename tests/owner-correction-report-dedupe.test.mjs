import test from 'node:test';
import assert from 'node:assert/strict';
import {correctionReportDeduplicationSafe as safe} from '../dist/sheets/owner-correction-report-dedupe.js';
const before={expenseId:'exp_a',status:'CONFIRMED',transactionDate:'2026-10-28',amountSatang:200000};
const row=(id,amount,order='ORDER-1',day='2026-10-28')=>{const r=[];r[0]=id;r[1]=day;r[3]=amount;r[7]='CONFIRMED';r[16]=order;return r};
test('report dedupe refuses both existing and newly introduced collisions',()=>{
  const a=row('exp_a',2000),b=row('exp_b',3000);
  assert.equal(safe(before,{...before,amountSatang:250000},[a,b]),true);
  assert.equal(safe(before,{...before,amountSatang:300000},[a,b]),false);
  assert.equal(safe(before,{...before,transactionDate:'2026-11-01'},[a,row('exp_b',2000,'order-1','2026-11-04')]),false);
  assert.equal(safe(before,{...before,amountSatang:250000},[a,row('exp_b',2000,' order-1 ')]),false);
  assert.equal(safe(before,{...before},[a,a]),false);
  assert.equal(safe(before,{...before,transactionDate:'2026-07-31'},[a]),false);
  assert.equal(safe(before,{...before},[a,row('exp_c',100,'X','invalid')]),false);
});
