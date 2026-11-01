import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyCorrectionPatchOutcome} from '../dist/sheets/owner-correction-recovery.js';

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
