import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{parseSerialLedgerSheetId}=require('../dist/sheets/serial-notice-release-draft.js');
test('ledger target parser accepts sheet zero and rejects missing or noncanonical identifiers',()=>{
 assert.equal(parseSerialLedgerSheetId('0'),0);assert.equal(parseSerialLedgerSheetId('42'),42);
 for(const value of [undefined,'','00','-1',' 1','1.0','1e2','9007199254740992'])assert.equal(parseSerialLedgerSheetId(value),null);
});

test('final snapshot budget rejects excessive cells, strings and unsupported values before encoding',async()=>{
 const {assertFinalSnapshotWithinBudget,verifyStableExpenseProjections}=require('../dist/sheets/stable-expense-final-check.js');
 assert.doesNotThrow(()=>assertFinalSnapshotWithinBudget([[[['text',0,true,null]]]]));
 assert.throws(()=>assertFinalSnapshotWithinBudget([[[Array(300001).fill(null)]]]),/STABLE_FINAL_PROOF_TOO_LARGE/);
 assert.throws(()=>assertFinalSnapshotWithinBudget([[[['x'.repeat(700000)]]]]),/STABLE_FINAL_PROOF_TOO_LARGE/);
 assert.throws(()=>assertFinalSnapshotWithinBudget([[[['\"'.repeat(700000)]]]]),/STABLE_FINAL_PROOF_TOO_LARGE/);
 assert.throws(()=>assertFinalSnapshotWithinBudget([[[[{}]]]]),/STABLE_FINAL_PROOF_VALUE/);
 await assert.rejects(verifyStableExpenseProjections({}, {}, {}, [],undefined,undefined,{},true,async()=>true),/STABLE_FINAL_PROOF_SNAPSHOT_UNVERIFIED/);
});
