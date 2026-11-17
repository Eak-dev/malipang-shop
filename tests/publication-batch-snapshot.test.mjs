import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),auth=require('../dist/sheets/google-auth.js'),client=require('../dist/sheets/client.js'),{ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),{capturePublicationBatchSnapshot,publicationSnapshotRange}=require('../dist/sheets/publication-batch-snapshot.js');
test('batch snapshot counts real HTTP calls and never passes the explicit budget',async()=>{
 const token=auth.getGoogleAccessToken,fetcher=globalThis.fetch;let calls=0;
 try{
  auth.getGoogleAccessToken=async()=> 'synthetic';
  globalThis.fetch=async url=>{calls++;if(String(url).includes('values:batchGet'))return Response.json({valueRanges:[{values:[['a'],[1]]},{values:[['b'],[2]]}]});return Response.json({spreadsheetId:'book',sheets:[{properties:{sheetId:1,title:'daily',gridProperties:{rowCount:2,columnCount:1}}},{properties:{sheetId:2,title:'raw',gridProperties:{rowCount:2,columnCount:1}}}]});};
  const env={DB:{},GOOGLE_SPREADSHEET_ID:'book',STABLE_SHEETS_PACING_ENABLED:'true'},specs=[{sheetId:1,sheetName:'daily',rows:2,columns:1},{sheetId:2,sheetName:'raw',rows:2,columns:1}],budget=new ReviewRequestBudget(4);
  const result=await capturePublicationBatchSnapshot(env,specs,budget);assert.equal(calls,4);assert.equal(budget.used,4);assert.deepEqual(result.formula,[[['a'],[1]],[['b'],[2]]]);
  calls=0;const small=new ReviewRequestBudget(3);await assert.rejects(capturePublicationBatchSnapshot(env,specs,small),/BUDGET_EXHAUSTED/);assert.equal(calls,3);assert.equal(small.used,3);
 }finally{auth.getGoogleAccessToken=token;globalThis.fetch=fetcher;}
});
test('snapshot rejects duplicate sheet identities before network activity',async()=>{
 const budget=new ReviewRequestBudget(4),spec={sheetId:1,sheetName:'daily',rows:2,columns:1};
 await assert.rejects(capturePublicationBatchSnapshot({DB:{},GOOGLE_SPREADSHEET_ID:'book'},[spec,spec],budget),/SNAPSHOT_INVALID/);assert.equal(budget.used,0);
});
test('distinct bounded ranges on one sheet are fetched in the same batches',async()=>{
 const token=auth.getGoogleAccessToken,fetcher=globalThis.fetch;let calls=0,queries=[];
 try{
  auth.getGoogleAccessToken=async()=> 'synthetic';globalThis.fetch=async url=>{calls++;if(String(url).includes('values:batchGet')){queries.push(new URL(url).searchParams.getAll('ranges'));return Response.json({valueRanges:[{values:[['a']]},{values:[['b']]}]});}return Response.json({spreadsheetId:'book',sheets:[{properties:{sheetId:1,title:'daily',gridProperties:{rowCount:10,columnCount:4}}}]});};
  const env={DB:{},GOOGLE_SPREADSHEET_ID:'book',STABLE_SHEETS_PACING_ENABLED:'true'},base={sheetId:1,sheetName:'daily',rows:10,columns:4},specs=[{...base,startRow:1,endRow:1,startColumn:1,endColumn:1},{...base,startRow:5,endRow:5,startColumn:3,endColumn:3}],budget=new ReviewRequestBudget(4);
  await capturePublicationBatchSnapshot(env,specs,budget);assert.equal(calls,4);assert.deepEqual(queries[0],["'daily'!A1:A1","'daily'!C5:C5"]);
 }finally{auth.getGoogleAccessToken=token;globalThis.fetch=fetcher;}
});
test('OAuth cache miss and one retry count against the same explicit budget',async()=>{
 const token=auth.getGoogleAccessToken,fetcher=globalThis.fetch,wait=client.sheetsReadRetryTiming.wait;let calls=0,tokenFetched=false;
 try{
  auth.getGoogleAccessToken=async(_env,budget)=>{if(!tokenFetched){budget.consumeRead();tokenFetched=true;}return 'synthetic';};client.sheetsReadRetryTiming.wait=async()=>{};
  globalThis.fetch=async url=>{calls++;if(calls===1)return new Response('',{status:503});if(String(url).includes('values:batchGet'))return Response.json({valueRanges:[{values:[['a']]}]});return Response.json({spreadsheetId:'book',sheets:[{properties:{sheetId:1,title:'daily',gridProperties:{rowCount:2,columnCount:1}}}]});};
  const env={DB:{},GOOGLE_SPREADSHEET_ID:'book'},specs=[{sheetId:1,sheetName:'daily',rows:2,columns:1}],budget=new ReviewRequestBudget(6);
  await capturePublicationBatchSnapshot(env,specs,budget);assert.equal(calls,5);assert.equal(budget.used,6);
  calls=0;tokenFetched=false;const short=new ReviewRequestBudget(5);await assert.rejects(capturePublicationBatchSnapshot(env,specs,short),/BUDGET_EXHAUSTED/);assert.equal(calls,4);assert.equal(short.used,5);
 }finally{auth.getGoogleAccessToken=token;globalThis.fetch=fetcher;client.sheetsReadRetryTiming.wait=wait;}
});
test('snapshot slices bounded ranges and rejects disagreement in overlapping evidence',()=>{
 const specs=[{sheetId:1,sheetName:'daily',rows:2,columns:2},{sheetId:1,sheetName:'daily',rows:2,columns:2,startRow:2,endRow:2,startColumn:2,endColumn:2}],snapshot={specs,metadata:[],formula:[[['a','b'],['c','d']],[['d']]],effective:[[['a','b'],['c','d']],[['d']]]};
 assert.deepEqual(publicationSnapshotRange(snapshot,1,2,2,2,2,'FORMULA'),[['d']]);snapshot.formula[1][0][0]='changed';assert.throws(()=>publicationSnapshotRange(snapshot,1,2,2,2,2,'FORMULA'),/OVERLAP/);assert.throws(()=>publicationSnapshotRange(snapshot,2,1,1,1,1,'FORMULA'),/MISSING/);
});
test('postimage read slots remain inaccessible until the mutation has finished',()=>{
 const budget=new ReviewRequestBudget(5);assert.equal(budget.reservePost(2),true);assert.equal(budget.reserveMutation(),true);budget.consumeRead();budget.consumeRead();assert.throws(()=>budget.consumeRead(),/BUDGET_EXHAUSTED/);const ticket=budget.claimMutation();ticket.consume();assert.equal(budget.postReserved,2);assert.throws(()=>budget.consumeRead(),/BUDGET_EXHAUSTED/);budget.releasePost();budget.consumeRead();budget.consumeRead();assert.equal(budget.used,5);
});
