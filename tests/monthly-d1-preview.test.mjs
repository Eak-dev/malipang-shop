import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{bangkokMonth,planMonthlyD1Preview}=require('../dist/sheets/monthly-d1-preview.js');
const headers=[[],[],[]];headers[2][7]='เงินโอน';headers[2][10]='Kbank';headers[1][10]=15;
const item=(overrides={})=>({expense_id:'exp_test',version:1,status:'CONFIRMED',transaction_date:'2026-11-21',description:'=literal',amount_satang:123,payment_key:'transfer',source_wallet:'SHOP_BANK',category:'ingredients',...overrides});
test('month selection follows Bangkok midnight and excludes other months and non-confirmed rows',()=>{
 assert.equal(bangkokMonth(new Date('2026-10-31T16:59:59.000Z')),'2026-10');assert.equal(bangkokMonth(new Date('2026-10-31T17:00:00.000Z')),'2026-11');
 const r=planMonthlyD1Preview([item(),item({expense_id:'exp_other',transaction_date:'2026-10-31'}),item({expense_id:'exp_cancelled',status:'CANCELLED'})],headers,new Date('2026-11-21T12:00:00Z'));
 assert.equal(r.period,'2026-11');assert.equal(r.ready.length,1);assert.equal(r.outsidePeriod,1);assert.deepEqual(r.held,[]);assert.equal(r.ready[0].description,'=literal');assert.equal(r.ready[0].amountColumn,'H');assert.equal(r.ready[0].wallet,'บัญชีร้าน');
});
test('incomplete or invalid items are held individually and do not hide ready items',()=>{
 const r=planMonthlyD1Preview([item(),item({expense_id:'exp_invalid_date',transaction_date:'2026-11-31'}),item({expense_id:'exp_blank',description:''}),item({expense_id:'bad id'}),item({expense_id:'exp_unknown_payment',payment_key:'unsupported'}),item({expense_id:'exp_invalid_amount',amount_satang:1.5})],headers,new Date('2026-11-21T12:00:00Z'));
 assert.equal(r.ready.length,1);assert.deepEqual(r.held.map(x=>x.reason),['DATE_UNVERIFIED','SOURCE_INCOMPLETE','IDENTITY_UNVERIFIED','PAYMENT_UNVERIFIED','SOURCE_INCOMPLETE']);
});
test('credit posting cutoff follows sheet mapping while selection uses transaction month',()=>{
 const r=planMonthlyD1Preview([item({payment_key:'kbank',source_wallet:'CARD_KBANK',transaction_date:'2026-11-21'})],headers,new Date('2026-11-21T12:00:00Z'));
 assert.equal(r.ready.length,1);assert.deepEqual([r.ready[0].postingYear,r.ready[0].postingMonth,r.ready[0].postingDay,r.ready[0].amountColumn],[2026,12,21,'K']);
});
test('ambiguous payment headers hold the item rather than guessing',()=>{
 const ambiguous=[[],[],[]];ambiguous[2][7]='เงินโอน';ambiguous[2][10]='เงินโอน';
 const r=planMonthlyD1Preview([item()],ambiguous,new Date('2026-11-21T12:00:00Z'));assert.equal(r.ready.length,0);assert.equal(r.held[0].reason,'PAYMENT_UNVERIFIED');
});
test('duplicate source identity and missing version are held rather than planned twice',()=>{
 const r=planMonthlyD1Preview([item(),item(),item({expense_id:'exp_missing_version',version:null}),item({expense_id:'exp_valid'})],headers,new Date('2026-11-21T12:00:00Z'));
 assert.deepEqual(r.held.map(x=>x.reason),['SOURCE_DUPLICATE','SOURCE_DUPLICATE','SOURCE_INCOMPLETE']);assert.equal(r.ready.length,1);
});

test('only the exact incident expense and version is held',()=>{
 const incident={expense_id:'exp_test',source_version:1};
 const now=new Date('2026-11-21T12:00:00Z');
 const held=planMonthlyD1Preview([item()],headers,now,incident);
 assert.deepEqual(held.held,[{expenseId:'exp_test',reason:'INCIDENT_REVIEW'}]);
 assert.equal(held.ready.length,0);
 for(const row of [item({version:2}),item({expense_id:'exp_other'})]){
  const next=planMonthlyD1Preview([row],headers,now,incident);
  assert.equal(next.ready.length,1);
  assert.deepEqual(next.held,[]);
 }
});
