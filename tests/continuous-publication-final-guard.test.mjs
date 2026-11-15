import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),evidence=require('../dist/sheets/publication-accounting-evidence.js'),finalCheck=require('../dist/sheets/stable-expense-final-check.js');
const {verifyPublicationFinalGuard}=require('../dist/sheets/continuous-publication-final-guard.js'),{encodePublicationCarrier}=require('../dist/sheets/continuous-publication-template.js');
const {ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js');
test('final guard validates staged before CAS and exact pending publication after CAS',async()=>{
 const oldRead=evidence.readPublicationAccountingEvidence,oldFinal=finalCheck.verifyStableExpenseProjections,seen=[];
 try{
  evidence.readPublicationAccountingEvidence=async(_env,target)=>{seen.push(target);return{sheet:target.sheet,rows:target.rows,markers:new Map([['exp_test',{state:target.expected.state,version:target.expected.version}]])};};
  finalCheck.verifyStableExpenseProjections=async(_env,_job,_source,_journal,proof)=>{seen.push(proof.phase);};
  const before={expenseId:'exp_test',version:1,nonce:'a'.repeat(32),state:'STAGED',detailCount:0},after={...before,nonce:'b'.repeat(32),state:'PUBLISHED'},pending={transitionId:'op',before:encodePublicationCarrier(before)},job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_test',entityVersion:1},target={sheetId:7,sheetName:'pub',rows:10},source={digest:'c'.repeat(64)};
  const budget=new ReviewRequestBudget(40);
  assert.equal(await verifyPublicationFinalGuard({},job,source,[],target,'claim','BEFORE',after,2,budget,pending),true);assert.equal(seen[0].expected.state,'STAGED');assert.equal(seen[1],'STAGED');
  assert.equal(await verifyPublicationFinalGuard({},job,source,[],target,'claim','AFTER',after,2,budget,pending),true);assert.deepEqual(seen[2].pendingPublish,{transitionId:'op',before:pending.before,claim:'claim'});assert.equal(seen[3],'PUBLISHED');
  await assert.rejects(verifyPublicationFinalGuard({},job,source,[],target,'claim','BEFORE',after,2,budget),/INTENT/);
 }finally{evidence.readPublicationAccountingEvidence=oldRead;finalCheck.verifyStableExpenseProjections=oldFinal;}
});
