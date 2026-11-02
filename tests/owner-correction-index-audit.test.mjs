import test from 'node:test';
import assert from 'node:assert/strict';
import {auditDailyExpenseIndex as audit} from '../dist/sheets/owner-correction-index-audit.js';

const coverage={expenses:'ALL_RELEVANT_EXPENSE_IDS',mappings:'ALL_SHEET_MAPPINGS',metadata:'ALL_DOCUMENT_DAILY_METADATA'};
const marker=(id,expense,row,sheetId=1)=>({metadataId:id,metadataKey:'malipang_expense_daily',metadataValue:expense,sheetId,rowIndex:row-1});
const fixture=()=>({sheetName:'รายวัน',sheetId:1,expenseIds:['A'],mappings:[{entityKey:'A',rowNumber:10}],metadata:[marker(1,'A',10)],coverage});
const single=value=>{const result=audit(value);assert.equal(result.valid,true);return result.entries.find(entry=>entry.expenseId==='A')};

test('distinguishes matching, moved and missing associations',()=>{
  assert.equal(single(fixture()).status,'MATCH');
  const moved=fixture();moved.metadata[0].rowIndex=10;assert.equal(single(moved).status,'MOVED');
  const missing=fixture();missing.metadata=[];assert.deepEqual(single(missing).reasons,['METADATA_MISSING']);
  const orphan=fixture();orphan.mappings=[];assert.deepEqual(single(orphan).reasons,['MAPPING_MISSING']);
  const both=fixture();both.mappings=[];both.metadata=[];assert.equal(single(both).status,'MISSING');
});
test('duplicate identities and IDs never become a match',()=>{
  const duplicate=fixture();duplicate.metadata.push(marker(2,'A',11));assert.equal(single(duplicate).status,'DUPLICATE');
  const repeated=fixture();repeated.metadata.push(marker(1,'B',11));assert.ok(single(repeated).reasons.includes('DUPLICATE_METADATA_ID'));
  const mappings=fixture();mappings.mappings.push({entityKey:'A',rowNumber:11});assert.equal(single(mappings).status,'DUPLICATE');
});
test('detects collisions with other expense metadata, mappings and nonexpense reservations',()=>{
  const f=fixture();f.mappings.push({entityKey:'__owner_move__:other',rowNumber:10});
  const result=audit(f);assert.equal(result.entries[0].status,'COLLISION');assert.equal(result.unclassifiedMappings.length,1);
  const g=fixture();g.metadata.push(marker(2,'B',10));assert.ok(single(g).reasons.includes('METADATA_ROW_OTHER_METADATA'));
  const shifted=fixture();shifted.metadata[0].rowIndex=10;shifted.mappings.push({entityKey:'other',rowNumber:11});assert.equal(single(shifted).status,'COLLISION');
  const wrong=fixture();wrong.metadata[0].sheetId=2;assert.ok(single(wrong).reasons.includes('WRONG_SHEET'));
});
test('requires explicit complete coverage and rejects malformed or duplicate input IDs',()=>{
  assert.deepEqual(audit({...fixture(),coverage:{}}),{valid:false,reason:'INCOMPLETE_COVERAGE'});
  const bad=fixture();bad.metadata[0].rowIndex=-1;assert.deepEqual(audit(bad),{valid:false,reason:'INVALID_INPUT'});
  const ids=fixture();ids.expenseIds.push('A');assert.deepEqual(audit(ids),{valid:false,reason:'INVALID_INPUT'});
});
