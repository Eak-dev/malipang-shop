import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {continuousDailyHelperFormulas,planContinuousDailyExpense}=require('../dist/sheets/continuous-daily-plan.js');
const {verifyContinuousDailyExpense}=require('../dist/sheets/continuous-daily-verification.js');

function fixture(){
 const rows=Array.from({length:8},()=>[]);
 rows[2][7]='เงินโอน';rows[2][6]='NON-FIXED';
 for(let i=3;i<rows.length;i++)Object.assign(rows[i],continuousDailyHelperFormulas(i+1));
 Object.assign(rows[3],{26:2026,27:4,28:1000});
 const input={rows,rowCount:8,columnCount:29,firstDataRow:4,snapshotComplete:true,expenseId:'exp_test',transactionDate:'2026-04-11',description:'test',amountSatang:123,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'ingredients',allowCreate:true};
 const plan=planContinuousDailyExpense(input);assert.equal(plan.status,'APPEND');
 for(const change of plan.changes)rows[3][change.column]=change.userEnteredValue.numberValue??change.userEnteredValue.stringValue;
 const effectiveRows=rows.map(row=>row.slice());
 Object.assign(effectiveRows[3],{8:1.23,9:998.77,17:'',18:998.77,20:(Date.UTC(2026,3,11)-Date.UTC(1899,11,30))/86400000});
 return {...input,rows,effectiveRows,expectedPrevious:Array.from({length:29},(_,i)=>rows[3][i]??null),postingYear:2026,postingMonth:4};
}

test('readback verifies identity, formulas, effective date and actual monthly balance',()=>{
 assert.deepEqual(verifyContinuousDailyExpense(fixture()),{status:'VERIFIED',row:4});
});

test('rejects missing or ambiguous opening and inconsistent monthly balance',()=>{
 const missing=fixture();missing.rows[3][28]='';assert.equal(verifyContinuousDailyExpense(missing).reason,'OPENING_UNVERIFIED');
 const duplicate=fixture();Object.assign(duplicate.rows[4],{26:2026,27:4,28:1000});Object.assign(duplicate.effectiveRows[4],{26:2026,27:4,28:1000});assert.equal(verifyContinuousDailyExpense(duplicate).reason,'OPENING_UNVERIFIED');
 const wrong=fixture();wrong.effectiveRows[3][9]=1000;assert.equal(verifyContinuousDailyExpense(wrong).reason,'ROW_BALANCE_UNVERIFIED');
});

test('rejects changed identity, literal data, formulas and effective date',()=>{
 const changed=fixture();changed.rows[3][23]='MALIPANG_EXPENSE:exp_other';assert.equal(verifyContinuousDailyExpense(changed).status,'REVIEW');
 const effective=fixture();effective.effectiveRows[3][7]=2;assert.equal(verifyContinuousDailyExpense(effective).reason,'TARGET_EFFECTIVE_MISMATCH');
 const formula=fixture();formula.rows[3][9]='=0';formula.expectedPrevious[9]='=0';assert.equal(verifyContinuousDailyExpense(formula).status,'REVIEW');
 const date=fixture();date.effectiveRows[3][20]+=1;assert.equal(verifyContinuousDailyExpense(date).reason,'ROW_EFFECTIVE_DATE_UNVERIFIED');
});

test('rejects duplicate IDs and requires a trusted prior row image',()=>{
 const duplicate=fixture();duplicate.rows[4][23]='MALIPANG_EXPENSE:exp_test';assert.equal(verifyContinuousDailyExpense(duplicate).reason,'DUPLICATE_STABLE_ID');
 const missing=fixture();delete missing.expectedPrevious;assert.equal(verifyContinuousDailyExpense(missing).reason,'MISSING_TRUSTED_PREIMAGE');
});
