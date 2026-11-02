import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {encodeEnrollmentApproval,verifyEnrollmentApproval}=require('../dist/sheets/daily-row-enrollment.js');
const fcols=[8,9,17,18,20],lcols=Array.from({length:25},(_,i)=>i).filter(i=>!fcols.includes(i));
async function fixture(){
 const keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
 const entry={expenseId:'exp1',expenseVersion:5,postingDate:'2026-10-14',amountSatang:73500,paymentKey:'transfer',expenseStatus:'CONFIRMED',sourceWallet:'SHOP_BANK',category:'general',description:'private',messageId:'synthetic-message',rowNumber:10,metadataId:11,headerDigest:'a'.repeat(64),literals:Object.fromEntries(lcols.map(i=>[i,''])),formulas:Object.fromEntries(fcols.map(i=>[i,'=0']))};
 entry.literals[10]=735;entry.literals[3]='personal';
 const approval={version:'daily-row-enrollment-v1',approvalId:'approval1',reviewerId:'owner-authority',spreadsheetId:'sheet-id',sheetId:1,leaseId:'lease1',leaseVersion:3,issuedAtMs:1000,expiresAtMs:100000,entries:[entry]};
 const context={spreadsheetId:'sheet-id',sheetId:1,leaseId:'lease1',leaseVersion:3,nowMs:2000,approvedPeriod:'2026-10',sourceExpenses:[{expenseId:'exp1',expenseVersion:5,postingDate:'2026-10-14',amountSatang:73500,paymentKey:'transfer',expenseStatus:'CONFIRMED',sourceWallet:'SHOP_BANK',category:'general',description:'private',messageId:'synthetic-message'}]};
 const sign=async value=>new Uint8Array(await crypto.subtle.sign('Ed25519',keys.privateKey,encodeEnrollmentApproval(value)));
 return {approval,context,keys,signature:await sign(approval),sign};
}
test('accept only independently signed and freshly bound enrollment mapping',async()=>{
 const {approval,context,keys,signature}=await fixture();assert.equal(await verifyEnrollmentApproval(approval,signature,keys.publicKey,context),true);
 for(const change of ['row','expense','version','date','amount','payment','status','wallet','category','description','message','literals','formulas','sheet','lease','header','reviewer']){
  const a=structuredClone(approval);
  if(change==='row')a.entries[0].rowNumber++;
  if(change==='expense')a.entries[0].expenseId='other';
  if(change==='version')a.entries[0].expenseVersion++;
  if(change==='date')a.entries[0].postingDate='2026-10-15';
  if(change==='amount')a.entries[0].amountSatang++;
  if(change==='payment')a.entries[0].paymentKey='cash';
  if(change==='status')a.entries[0].expenseStatus='CANCELLED';
  if(change==='wallet')a.entries[0].sourceWallet='CASH_DRAWER';
  if(change==='category')a.entries[0].category='ingredients';
  if(change==='description')a.entries[0].description='other';
  if(change==='message')a.entries[0].messageId='other';
  if(change==='literals')a.entries[0].literals[3]='altered';
  if(change==='formulas')a.entries[0].formulas[9]='=99';
  if(change==='sheet')a.sheetId++;
  if(change==='lease')a.leaseVersion++;
  if(change==='header')a.entries[0].headerDigest='b'.repeat(64);
  if(change==='reviewer')a.reviewerId='other';
  assert.equal(await verifyEnrollmentApproval(a,signature,keys.publicKey,context),false,change);
 }
});
test('reject validly signed stale, ambiguous, incomplete, and cross-fence enrollments',async()=>{
 for(const kind of ['duplicate-expense','duplicate-message','duplicate-row','duplicate-metadata','source-version','source-amount','source-date','source-payment','source-status','source-wallet','source-category','source-description','source-message','zero-version','zero-amount','partial-manifest','missing-formula','expired','future','long-lived','wrong-lease','wrong-sheet','wrong-source-count','wrong-period']){
  const {approval:a,context:c,keys,sign}=await fixture(),e=a.entries[0];
  if(kind.startsWith('duplicate-')){const other=structuredClone(e);other.expenseId='exp2';other.messageId='other-message';other.rowNumber=11;other.metadataId=12;if(kind==='duplicate-expense')other.expenseId=e.expenseId;if(kind==='duplicate-message')other.messageId=e.messageId;if(kind==='duplicate-row')other.rowNumber=e.rowNumber;if(kind==='duplicate-metadata')other.metadataId=e.metadataId;a.entries.push(other);c.sourceExpenses.push({expenseId:other.expenseId,expenseVersion:other.expenseVersion,postingDate:other.postingDate,amountSatang:other.amountSatang,paymentKey:other.paymentKey,expenseStatus:other.expenseStatus,sourceWallet:other.sourceWallet,category:other.category,description:other.description,messageId:other.messageId});}
  if(kind==='source-version')c.sourceExpenses[0].expenseVersion++;
  if(kind==='source-amount')c.sourceExpenses[0].amountSatang++;
  if(kind==='source-date')c.sourceExpenses[0].postingDate='2026-10-15';
  if(kind==='source-payment')c.sourceExpenses[0].paymentKey='cash';
  if(kind==='source-status')c.sourceExpenses[0].expenseStatus='CANCELLED';
  if(kind==='source-wallet')c.sourceExpenses[0].sourceWallet='CASH_DRAWER';
  if(kind==='source-category')c.sourceExpenses[0].category='ingredients';
  if(kind==='source-description')c.sourceExpenses[0].description='other';
  if(kind==='source-message')c.sourceExpenses[0].messageId='other';
  if(kind==='zero-version'){e.expenseVersion=0;c.sourceExpenses[0].expenseVersion=0;}
  if(kind==='zero-amount'){e.amountSatang=0;c.sourceExpenses[0].amountSatang=0;}
  if(kind==='partial-manifest')delete e.literals[24];
  if(kind==='missing-formula')delete e.formulas[9];
  if(kind==='expired')c.nowMs=a.expiresAtMs;
  if(kind==='future')a.issuedAtMs=c.nowMs+1;
  if(kind==='long-lived')a.expiresAtMs=a.issuedAtMs+900001;
  if(kind==='wrong-lease')c.leaseVersion++;
  if(kind==='wrong-sheet')c.sheetId++;
  if(kind==='wrong-source-count')c.sourceExpenses=[];
  if(kind==='wrong-period')c.approvedPeriod='2026-09';
  assert.equal(await verifyEnrollmentApproval(a,await sign(a),keys.publicKey,c),false,kind);
 }
});
test('signature by a different reviewer key is rejected',async()=>{
 const {approval,context,signature}=await fixture(),other=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
 assert.equal(await verifyEnrollmentApproval(approval,signature,other.publicKey,context),false);
});
