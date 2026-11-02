import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateOwnerCorrectionMoveImpact as impact,ownerCorrectionMoveReportsMatch as match} from '../dist/sheets/owner-correction-move-impact.js';

const before={expenseId:'exp_synthetic_move',status:'CONFIRMED',version:1,updatedAt:null,description:'Synthetic',category:'transport',amountSatang:200000,transactionDate:'2026-10-28',paymentKey:'transfer',sourceWallet:'SHOP_BANK'};
const headers=[[],Array(11).fill(null),Array(11).fill(null)];headers[1][10]=25;headers[2][10]='Kbank';
const delta=(period,reportTotalSatang,reportBankSatang,dailyTotalSatang,group=null,groupDelta=0,reportSame=false)=>{const categorySatang=Array(12).fill(0);if(group!==null)categorySatang[group]=groupDelta;return {period,reportTotalSatang,reportBankSatang,dailyTotalSatang,categorySatang,reportCountDelta:Math.sign(reportTotalSatang),dailyCountDelta:Math.sign(dailyTotalSatang),reportTargetBefore:Number(reportTotalSatang<0||reportSame),reportTargetAfter:Number(reportTotalSatang>0||reportSame),dailyTargetBefore:Number(dailyTotalSatang<0),dailyTargetAfter:Number(dailyTotalSatang>0)}};

test('date move removes and adds totals in the respective reporting and ledger months',()=>{
  assert.deepEqual(impact(before,{...before,transactionDate:'2026-11-01'},headers),[
    delta('2026-10',-200000,-200000,-200000,7,-200000),delta('2026-11',200000,200000,200000,7,200000)]);
});
test('a legacy bank fee changes its report group across the legacy cutoff',()=>{
  const old={...before,transactionDate:'2026-07-31',category:'bank_fee'},next={...old,transactionDate:'2026-08-01'};
  assert.deepEqual(impact(old,next,headers),[delta('2026-07',-200000,-200000,-200000,11,-200000),delta('2026-08',200000,200000,200000,10,200000)]);
});
test('a card cutoff changes ledger month while the payment report remains in its original month',()=>{
  assert.deepEqual(impact(before,{...before,paymentKey:'kbank',sourceWallet:'CARD_KBANK'},headers),[
    delta('2026-10',0,-200000,-200000,null,0,true),delta('2026-11',0,0,200000)]);
});
test('a cross-year card statement is identified but is not authorized for writing',()=>{
  const old={...before,transactionDate:'2026-12-28'},next={...old,paymentKey:'kbank',sourceWallet:'CARD_KBANK'};
  assert.deepEqual(impact(old,next,headers),[delta('2026-12',0,-200000,-200000,null,0,true),delta('2027-01',0,0,200000)]);
});
test('invalid, stale, mixed-field and non-move drafts have no expected impact',()=>{
  assert.equal(impact(before,{...before,transactionDate:'2026-10-29'},headers),null);
  assert.equal(impact(before,{...before,transactionDate:'2026-11-01',amountSatang:1},headers),null);
  assert.equal(impact(before,{...before,transactionDate:'2026-11-01',version:2},headers),null);
  assert.equal(impact({...before,amountSatang:-1},{...before,amountSatang:-1,transactionDate:'2026-11-01'},headers),null);
  assert.equal(impact({...before,sourceWallet:'unknown'},{...before,sourceWallet:'unknown',transactionDate:'2026-11-01'},headers),null);
  assert.equal(impact(before,{...before,paymentKey:'kbank',sourceWallet:'SHOP_BANK'},headers),null);
  assert.equal(impact(before,{...before,transactionDate:'invalid'},headers),null);
});
test('report verification requires correct totals, category, counts and unique target in both months',()=>{
  const expected=impact(before,{...before,transactionDate:'2026-11-01'},headers),categories=value=>{const result=Array(12).fill(0);result[7]=value;return result};
  const old=[{period:'2026-10',reportTotalSatang:400000,reportBankSatang:300000,dailyTotalSatang:500000,categorySatang:categories(300000),reportCount:2,dailyCount:2,reportTargetCount:1,dailyTargetCount:1},
    {period:'2026-11',reportTotalSatang:100000,reportBankSatang:100000,dailyTotalSatang:100000,categorySatang:categories(10000),reportCount:1,dailyCount:1,reportTargetCount:0,dailyTargetCount:0}];
  const next=[{period:'2026-10',reportTotalSatang:200000,reportBankSatang:100000,dailyTotalSatang:300000,categorySatang:categories(100000),reportCount:1,dailyCount:1,reportTargetCount:0,dailyTargetCount:0},
    {period:'2026-11',reportTotalSatang:300000,reportBankSatang:300000,dailyTotalSatang:300000,categorySatang:categories(210000),reportCount:2,dailyCount:2,reportTargetCount:1,dailyTargetCount:1}];
  for(const row of [...old,...next]){row.otherRowsDigest='a'.repeat(64);row.formulaDigest='b'.repeat(64)}
  assert.equal(match(expected,old,next),true);
  const duplicate=structuredClone(next);duplicate[1].reportTargetCount=2;assert.equal(match(expected,old,duplicate),false);
  const lost=structuredClone(next);lost[1].dailyTargetCount=0;assert.equal(match(expected,old,lost),false);
  const category=structuredClone(next);category[1].categorySatang[7]--;assert.equal(match(expected,old,category),false);
  const changedOther=structuredClone(next);changedOther[1].otherRowsDigest='c'.repeat(64);assert.equal(match(expected,old,changedOther),false);
  const unknown=structuredClone(old);unknown[0].reportBankSatang=null;assert.equal(match(expected,unknown,next),false);
  assert.equal(match(expected,old,[next[0],next[0]]),false);
  const forged=structuredClone(expected);forged[0].reportTargetBefore=2;assert.equal(match(forged,old,next),false);
});
