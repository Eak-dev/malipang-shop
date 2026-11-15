import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js');
const {encodePublicationCarrier,publicationEmptyMarker}=require('../dist/sheets/continuous-publication-template.js');
const {readPublicationAccountingEvidence}=require('../dist/sheets/publication-accounting-evidence.js');

test('full marker column must match every immutable verified journal entry',async()=>{
 const names=['getSheetGridInfo','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues'],old=names.map(k=>client[k]);
 try{
  const marker={expenseId:'exp_test',version:1,nonce:'a'.repeat(32),state:'STAGED',detailCount:0},value=encodePublicationCarrier(marker),target={sheet:'pub',sheetId:7,rows:3,row:2,expected:marker,sourceDigest:'b'.repeat(64)};
  let rows=[['Publication_Marker'],[value],[publicationEmptyMarker(3,'c'.repeat(32))]],effective=structuredClone(rows),journal=[{entity_id:'exp_test',sheet_id:7,sheet_name:'pub',row_number:2,version:1,state:'STAGED',marker:value,source_digest:'b'.repeat(64)}];
  const env={GOOGLE_SPREADSHEET_ID:'book',DB:{prepare:()=>({bind(){return this;},all:async()=>({success:true,results:journal})})}};
  client.getSheetGridInfo=async()=>({sheetId:7,rowCount:3,columnCount:1});client.batchGetSheetFormulaValues=async()=>[structuredClone(rows)];client.batchGetSheetEffectiveSerialValues=async()=>[structuredClone(effective)];
  const read=()=>readPublicationAccountingEvidence(env,target);
  assert.deepEqual((await read()).markers,new Map([['exp_test',{state:'STAGED',version:1}]]));
  effective[1][0]='changed';await assert.rejects(read,/COLUMN/);effective=structuredClone(rows);
  journal=[];await assert.rejects(read,/ORPHAN/);journal=[{entity_id:'exp_test',sheet_id:7,sheet_name:'pub',row_number:2,version:1,state:'STAGED',marker:value,source_digest:null}];await assert.rejects(read,/JOURNAL/);
  journal[0].source_digest='b'.repeat(64);rows[2][0]=value;effective=structuredClone(rows);await assert.rejects(read,/COLUMN/);
 }finally{names.forEach((k,i)=>client[k]=old[i]);}
});
test('PUBLISH pending permits only exact provider postimage tied to immutable in-flight intent',async()=>{
 const names=['getSheetGridInfo','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues'],old=names.map(k=>client[k]);
 try{
  const before={expenseId:'exp_test',version:1,nonce:'a'.repeat(32),state:'STAGED',detailCount:0},after={...before,nonce:'d'.repeat(32),state:'PUBLISHED'},oldValue=encodePublicationCarrier(before),newValue=encodePublicationCarrier(after),target={sheet:'pub',sheetId:7,rows:3,row:2,expected:after,sourceDigest:'b'.repeat(64),pendingPublish:{transitionId:'transition',claim:'claim',before:oldValue}};
  let state='IN_FLIGHT',rows=[['Publication_Marker'],[newValue],[publicationEmptyMarker(3,'c'.repeat(32))]],journal=[{entity_id:'exp_test',sheet_id:7,sheet_name:'pub',row_number:2,version:1,state:'STAGED',marker:oldValue,source_digest:'b'.repeat(64)}];
  const env={GOOGLE_SPREADSHEET_ID:'book',DB:{prepare:()=>({bind(){return this;},first:async()=>state?{state}:null,all:async()=>({success:true,results:journal})})}};
  client.getSheetGridInfo=async()=>({sheetId:7,rowCount:3,columnCount:1});client.batchGetSheetFormulaValues=async()=>[structuredClone(rows)];client.batchGetSheetEffectiveSerialValues=async()=>[structuredClone(rows)];
  assert.equal((await readPublicationAccountingEvidence(env,target)).markers.get('exp_test').state,'PUBLISHED');
  state=null;await assert.rejects(readPublicationAccountingEvidence(env,target),/PENDING/);
  state='VERIFIED';await assert.rejects(readPublicationAccountingEvidence(env,target),/PENDING/);
  journal=[{...journal[0],marker:newValue,state:'PUBLISHED'}];assert.equal((await readPublicationAccountingEvidence(env,target)).markers.get('exp_test').state,'PUBLISHED');
  rows[1][0]=oldValue;await assert.rejects(readPublicationAccountingEvidence(env,target),/COLUMN/);
 }finally{names.forEach((k,i)=>client[k]=old[i]);}
});
