import test from 'node:test';
import assert from 'node:assert/strict';
import {planDailyLegacyCandidates} from '../dist/sheets/daily-legacy-enrollment-candidates.js';
const source={expenseId:'exp_fixture',transactionDate:'2026-10-26',description:'คุกกี้',amountSatang:10000,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'วัตถุดิบ',version:1};
function row(n=8){const values=Array(25).fill(null);values[1]=10;values[2]=26;values[3]='คุกกี้';values[7]=100;values[21]='วัตถุดิบ';values[22]='บัญชีร้าน';return{observedRow:n,blockMonth:10,values};}
const headers=[[],[],[]];
test('unique full-field pair is only a review candidate',()=>{assert.deepEqual(planDailyLegacyCandidates([source],[row()],headers,2026),[{expenseId:'exp_fixture',status:'REVIEW_PAIR',observedRow:8}]);});
test('duplicate source or duplicate rows never automatically match',()=>{const r=row();assert.equal(planDailyLegacyCandidates([source,{...source,expenseId:'exp_other'}],[r],headers,2026)[0].status,'HOLD_AMBIGUOUS');assert.equal(planDailyLegacyCandidates([source],[r,row(9)],headers,2026)[0].status,'HOLD_AMBIGUOUS');});
test('wrong wallet, amount column, physical month, or existing ID is held',()=>{for(const mode of ['wallet','column','month','id']){const r=row();if(mode==='wallet')r.values[22]='ทอน/หน้าร้าน';if(mode==='column'){r.values[7]=null;r.values[6]=100;}if(mode==='month')r.blockMonth=11;if(mode==='id')r.values[23]='MALIPANG_EXPENSE:exp_other';assert.equal(planDailyLegacyCandidates([source],[r],headers,2026)[0].status,mode==='id'?'HOLD_UNSAFE':'HOLD_NO_MATCH',mode);}});
test('credit cutoff crossing months is not matched to an October row',()=>{const h=[[],[],[]];h[1][10]=15;h[2][10]='Kbank';const r=row();r.values[7]=null;r.values[10]=100;assert.equal(planDailyLegacyCandidates([{...source,paymentKey:'kbank'}],[r],h,2026)[0].status,'HOLD_NO_MATCH');});

test('already identified or unsafe duplicate still makes a match ambiguous',()=>{for(const mode of ['id','unsafe']){const a=row(8),b=row(9);if(mode==='id')b.values[23]='MALIPANG_EXPENSE:exp_other';else b.unsafe=true;assert.equal(planDailyLegacyCandidates([source],[a,b],headers,2026)[0].status,'HOLD_AMBIGUOUS');}});
