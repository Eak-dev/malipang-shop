import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectOwnerCorrectionRebind} from '../dist/sheets/owner-correction-rebind-inspection.js';

test('rebind inspection independently verifies original and promoted metadata and values',async()=>{
  const plan={expenseId:'e',dailyMetadataId:1,rawMetadataId:3,rebind:{sourceMetadataId:1,reservationMetadataId:2,sheetId:5,correctionId:'c'},patches:[{metadataId:1,cells:[{columnIndex:1,value:''}]},{metadataId:2,cells:[{columnIndex:1,value:10}]},{metadataId:3,cells:[{columnIndex:1,value:'new'}]}],originalRows:[{metadataId:1,values:[null,9]},{metadataId:2,values:[]},{metadataId:3,values:[null,'old']}]};
  let source={metadataId:1,metadataKey:'malipang_expense_daily',metadataValue:'e',sheetId:5,rowIndex:9};
  let destination={metadataId:2,metadataKey:'malipang_correction_reservation',metadataValue:'c',sheetId:5,rowIndex:20};
  let placement=true, identities=true;
  const ports={metadataById:async(_env,id)=>id===1?source:destination,targets:async(_env,p)=>({identitiesVerified:identities,rows:new Map(p.patches.map(row=>[row.metadataId,[null,row.cells[0].value]]))}),placement:async()=>placement,saved:async()=>({before:{expenseId:'e'},after:{expenseId:'e'},version:2})};
  assert.equal((await inspectOwnerCorrectionRebind({},plan,ports)).valuesVerified,true);
  source=null;destination={...destination,metadataKey:'malipang_expense_daily',metadataValue:'e'};
  let after=await inspectOwnerCorrectionRebind({},plan,ports);assert.equal(after.valuesVerified,true);assert.equal(after.sourceRowIndex,-1);
  placement=false;assert.equal((await inspectOwnerCorrectionRebind({},plan,ports)).valuesVerified,false);
  placement=true;identities=false;assert.equal((await inspectOwnerCorrectionRebind({},plan,ports)).valuesVerified,false);
  identities=true;destination={...destination,metadataValue:'other'};assert.equal((await inspectOwnerCorrectionRebind({},plan,ports)).valuesVerified,false);
  ports.metadataById=async()=>{throw new Error('503')};await assert.rejects(inspectOwnerCorrectionRebind({},plan,ports),/503/);
});
