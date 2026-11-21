import test from 'node:test';
import assert from 'node:assert/strict';
import {planStableLedgerRow as plan} from '../dist/sheets/stable-ledger-row-plan.js';
const header=['ID','Description','Amount'],row=['exp_1','example',100];

test('finds the same ID after whole rows move and confirms the complete data',()=>{
 assert.deepEqual(plan([header,row,[]],'exp_1',row,false),{status:'PRESENT',observedRow:2});
 assert.deepEqual(plan([header,[],row],'exp_1',row,false),{status:'PRESENT',observedRow:3});
});
test('new records append after the last occupied row, even if an earlier row is blank',()=>{
 assert.deepEqual(plan([header,[],['different','other',25],[]],'exp_1',row,true),{status:'APPEND',observedRow:4});
 assert.equal(plan([header,[]],'exp_1',row,false).reason,'IDENTITY_NOT_FOUND');
});
test('duplicate IDs, changed data, extra data and formulas stop for review',()=>{
 assert.equal(plan([header,row,row],'exp_1',row,true).reason,'DUPLICATE_IDENTITY');
 assert.equal(plan([header,[' exp_1 ','example',100]],'exp_1',row,true).reason,'IDENTITY_FORMAT_CONFLICT');
 assert.equal(plan([header,['exp_1','different',100]],'exp_1',row,true).reason,'DATA_CONFLICT');
 assert.equal(plan([header,[...row,'unexpected']],'exp_1',row,true).reason,'DATA_CONFLICT');
 assert.equal(plan([header,['exp_1','example','=100']],'exp_1',row,true).reason,'FORMULA_CONFLICT');
});
test('malformed identity and incomplete sheet data are rejected',()=>{
 assert.equal(plan([header],'=bad',['=bad'],true).reason,'INVALID_IDENTITY');
 assert.equal(plan([], 'exp_1',row,true).reason,'INCOMPLETE_SNAPSHOT');
 assert.equal(plan([header,null],'exp_1',row,true).reason,'INCOMPLETE_SNAPSHOT');
});
