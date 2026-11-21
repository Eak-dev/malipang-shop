import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {expectedReportFormulaHashMatches}=require('../dist/admin/continuous-cutover-operator.js');
const sha=s=>createHash('sha256').update(s).digest('hex');

test('activation accepts only the known Sheets canonicalization while verifying the original hash',async()=>{
 const expected='=SUM(\'V52_EXPENSE_RAW_ALL\'!A2:A10)+SUM(\'V52_PURCHASE_DETAIL_ALL\'!B2:B10)+COUNTIF(\'V52_EXPENSE_RAW\'!A2:A10,"x")';
 const observed=expected.replaceAll("'V52_EXPENSE_RAW_ALL'","V52_EXPENSE_RAW_ALL").replaceAll("'V52_PURCHASE_DETAIL_ALL'","V52_PURCHASE_DETAIL_ALL").replaceAll("'V52_EXPENSE_RAW'","V52_EXPENSE_RAW");
 assert.equal(await expectedReportFormulaHashMatches(expected,sha(expected)),true);
 assert.equal(await expectedReportFormulaHashMatches(observed,sha(expected)),true);
 assert.equal(await expectedReportFormulaHashMatches(observed.replace('A2:A10','A3:A10'),sha(expected)),false);
});
test('activation rejects unrelated quote changes, different formulas and invalid hash',async()=>{
 const expected="=SUM('OTHER_LEDGER'!A2:A10)";
 assert.equal(await expectedReportFormulaHashMatches('=SUM(OTHER_LEDGER!A2:A10)',sha(expected)),false);
 assert.equal(await expectedReportFormulaHashMatches("=SUM('OTHER_LEDGER'!A2:A10)",sha(expected)),true);
 assert.equal(await expectedReportFormulaHashMatches('=SUM(V52_EXPENSE_RAW_ALL!A2:A9)',sha("=SUM('V52_EXPENSE_RAW_ALL'!A2:A10)")),false);
 assert.equal(await expectedReportFormulaHashMatches(123,sha(expected)),false);
 assert.equal(await expectedReportFormulaHashMatches(expected,'not-a-hash'),false);
});
