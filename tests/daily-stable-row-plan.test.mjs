import test from 'node:test';
import assert from 'node:assert/strict';
import { planStableDailyExpenseRow, stableDailyExpenseKey } from '../dist/sheets/daily-stable-row-plan.js';
import {expectedHelperFormulae} from '../dist/sheets/daily-stable-row-writes.js';

const empty = () => Array(25).fill(null);
const header = month => {const row=empty();row[1]=month;row[3]='รายรับทั้งหมดในบัญชี';return row;};
const total = month => {const row=empty();row[0]='รวม';row[1]=month;return row;};
const expense = (id, month=10) => {const row=empty();row[1]=month;row[2]=26;row[3]='Example';row[7]=930;row[21]='marketing';row[22]='บัญชีร้าน';row[23]=stableDailyExpenseKey(id);return row;};
const request = (id, previous) => ({expenseId:id, postingMonth:10,allowCreate:false,expectedPrevious:previous});
const clone = rows => rows.map(row=>[...row]);

test('finds durable ID after insert, whole-row sort and delete without relying on former row',()=>{
  const a=expense('exp_a'), b=expense('exp_b');
  let rows=[header(10),a,b,empty(),total(10)];
  assert.deepEqual(planStableDailyExpenseRow(rows,request('exp_a',a)),{status:'FOUND',observedRow:2});
  rows.splice(1,0,empty());
  assert.deepEqual(planStableDailyExpenseRow(rows,request('exp_a',a)),{status:'FOUND',observedRow:3});
  [rows[2],rows[3]]=[rows[3],rows[2]];
  assert.deepEqual(planStableDailyExpenseRow(rows,request('exp_a',a)),{status:'FOUND',observedRow:4});
  rows.splice(1,1);
  assert.deepEqual(planStableDailyExpenseRow(rows,request('exp_a',a)),{status:'FOUND',observedRow:3});
});

test('copied or duplicated ID is held rather than matching multiple rows',()=>{
  const a=expense('exp_a');
  const rows=[header(10),a,[...a],total(10)];
  assert.deepEqual(planStableDailyExpenseRow(rows,request('exp_a',a)),{status:'REVIEW',reason:'DUPLICATE_STABLE_ID'});
});

test('partial sort or edited business fields invalidate trusted preimage',()=>{
  const a=expense('exp_a'), b=expense('exp_b');b[7]=700;b[3]='Other';
  const rows=clone([header(10),a,b,total(10)]);
  // Simulate a partial sort that moves input values but leaves ID behind.
  for (const index of [1,2,3,5,6,7,10,11,12,13,14,15,16,21,22]) [rows[1][index],rows[2][index]]=[rows[2][index],rows[1][index]];
  assert.deepEqual(planStableDailyExpenseRow(rows,request('exp_a',a)),{status:'REVIEW',reason:'IDENTITY_PREIMAGE_MISMATCH'});
});

test('a missing or moved ID never silently becomes a new transaction',()=>{
  const a=expense('exp_a');
  assert.equal(planStableDailyExpenseRow([header(10),empty(),total(10)],request('exp_a',a)).reason,'LEGACY_OR_MISSING_ID_UNVERIFIED');
  assert.equal(planStableDailyExpenseRow([header(10),empty(),total(10),header(11),a,total(11)],request('exp_a',a)).reason,'IDENTITY_OUTSIDE_POSTING_MONTH');
});

test('appends after last occupied row, skips earlier gaps, and exposes missing formulas',()=>{
  const a=expense('exp_a'), b=expense('exp_b');
  const rows=[header(10),a,empty(),b,empty(),total(10)];
  assert.deepEqual(planStableDailyExpenseRow(rows,{expenseId:'exp_new',postingMonth:10,allowCreate:true}),{status:'APPEND',observedRow:5,formulaColumnsMissing:['I','J','R','S','U']});
  const helper=expectedHelperFormulae(1,5);
  for (const [index,name] of [[8,'I'],[9,'J'],[17,'R'],[18,'S'],[20,'U']])rows[4][index]=helper[name];
  assert.deepEqual(planStableDailyExpenseRow(rows,{expenseId:'exp_new',postingMonth:10,allowCreate:true}),{status:'APPEND',observedRow:5,formulaColumnsMissing:[]});
});

test('does not accept a constant or unverified formula in the append helper cells',()=>{
  for(const value of [999,'=ROW()']){
    const candidate=empty();candidate[8]=value;
    assert.deepEqual(planStableDailyExpenseRow([header(10),candidate,total(10)],{expenseId:'exp_new',postingMonth:10,allowCreate:true}),{status:'REVIEW',reason:'APPEND_HELPER_FORMULA_UNVERIFIED'});
  }
});

test('last row with partial input or orphan ID is occupied; full month requests capacity',()=>{
  const incomplete=empty();incomplete[7]=930;
  const orphan=empty();orphan[23]=stableDailyExpenseKey('exp_other');
  assert.deepEqual(planStableDailyExpenseRow([header(10),incomplete,orphan,total(10)],{expenseId:'exp_new',postingMonth:10,allowCreate:true}),{status:'CAPACITY_REQUIRED',observedTotalRow:4});
});

test('does not match an ID without independently supplied prior row evidence',()=>{
  const a=expense('exp_a');
  assert.deepEqual(planStableDailyExpenseRow([header(10),a,total(10)],{expenseId:'exp_a',postingMonth:10,allowCreate:true}),{status:'REVIEW',reason:'MISSING_TRUSTED_PREIMAGE'});
});

test('even a matching preimage is not permission to overwrite an input formula',()=>{
  const a=expense('exp_a');a[7]='=900+30';
  assert.deepEqual(planStableDailyExpenseRow([header(10),a,total(10)],request('exp_a',a)),{status:'REVIEW',reason:'INPUT_CONTAINS_FORMULA'});
});

test('matching preimage does not authorize clearing a second payment amount',()=>{
  const a=expense('exp_a');a[5]=100;
  assert.deepEqual(planStableDailyExpenseRow([header(10),a,total(10)],request('exp_a',a)),{status:'REVIEW',reason:'MULTIPLE_OR_INVALID_AMOUNT_CELLS'});
});

test('duplicate monthly blocks fail closed, and identifiers reject dangerous input',()=>{
  const rows=[header(10),empty(),total(10),header(10),empty(),total(10)];
  assert.equal(planStableDailyExpenseRow(rows,{expenseId:'exp_a',postingMonth:10,allowCreate:true}).reason,'MONTH_BLOCK_NOT_UNIQUE');
  assert.throws(()=>stableDailyExpenseKey('=IMPORTXML("x")'),/INVALID_DAILY_EXPENSE_ID/);
});
