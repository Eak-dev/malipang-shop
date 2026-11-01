import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyCorrectionPatchOutcome,correctionRecoveryAction} from '../dist/sheets/owner-correction-recovery.js';

test('uncertain Google Sheets result is checked against the full old and new input-cell set',()=>{
  const patches=[{metadataId:1,cells:[{columnIndex:3,value:''},{columnIndex:7,value:''}]},{metadataId:2,cells:[{columnIndex:3,value:'Driver'},{columnIndex:7,value:2000}]}];
  const source=Array(8).fill(null);source[3]='Driver';source[7]=2000;const destination=Array(8).fill(null);
  const before=new Map([[1,source],[2,destination]]);
  assert.equal(classifyCorrectionPatchOutcome(patches,before,before),'BEFORE');
  const after=new Map([[1,Array(8).fill('')],[2,[null,null,null,'Driver',null,null,null,2000]]]);
  assert.equal(classifyCorrectionPatchOutcome(patches,before,after),'AFTER');
  assert.equal(classifyCorrectionPatchOutcome(patches,before,new Map([[1,source],[2,after.get(2)]])),'CONFLICT');
  assert.equal(classifyCorrectionPatchOutcome(patches,before,new Map([[1,source]])),'CONFLICT');
});
test('an ambiguous write keeps its lease before retrying or moving to the next phase',()=>{
  const now=Date.parse('2026-10-28T10:00:00Z'),leaseUntil=new Date(now+900000).toISOString();
  for(const outcome of ['BEFORE','AFTER','CONFLICT'])assert.equal(correctionRecoveryAction({outcome,leaseUntil,nowMs:now,currentVersionMatches:true}),'WAIT');
  assert.equal(correctionRecoveryAction({outcome:'BEFORE',leaseUntil,nowMs:now+900000,currentVersionMatches:true}),'RETRY');
  assert.equal(correctionRecoveryAction({outcome:'AFTER',leaseUntil,nowMs:now+900000,currentVersionMatches:true}),'ADVANCE');
  assert.equal(correctionRecoveryAction({outcome:'CONFLICT',leaseUntil,nowMs:now+900000,currentVersionMatches:true}),'REVIEW');
  assert.equal(correctionRecoveryAction({outcome:'AFTER',leaseUntil,nowMs:now+900000,currentVersionMatches:false}),'REVIEW');
});
