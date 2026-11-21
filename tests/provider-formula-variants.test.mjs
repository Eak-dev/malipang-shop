import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {knownProviderFormulaVariants,knownProviderFormulaEquivalent}=require('../dist/sheets/provider-formula-variants.js');

test('provider variants quote only known sheet references outside formula literals',()=>{
 const source='=IF(A1="V52_EXPENSE_RAW!A1",SUM(V52_EXPENSE_RAW!A1,V52_EXPENSE_RAW_ALL!B1),\'other V52_EXPENSE_RAW!x\'!A1)';
 const variants=knownProviderFormulaVariants(source);
 assert.ok(variants.includes('=IF(A1="V52_EXPENSE_RAW!A1",SUM(\'V52_EXPENSE_RAW\'!A1,\'V52_EXPENSE_RAW_ALL\'!B1),\'other V52_EXPENSE_RAW!x\'!A1)'));
 assert.ok(variants.every(x=>x.includes('"V52_EXPENSE_RAW!A1"')));
 assert.ok(variants.every(x=>x.includes("'other V52_EXPENSE_RAW!x'!A1")));
 assert.ok(variants.length<=8);
 assert.deepEqual(knownProviderFormulaVariants('=SUM(OTHER!A1)'),['=SUM(OTHER!A1)']);
});
test('formula equivalence does not normalize quoted text or changed references',()=>{
 assert.equal(knownProviderFormulaEquivalent('=SUM(V52_EXPENSE_RAW!A1)',"=SUM('V52_EXPENSE_RAW'!A1)"),true);
 assert.equal(knownProviderFormulaEquivalent('=SUM(V52_EXPENSE_RAW!A2)',"=SUM('V52_EXPENSE_RAW'!A1)"),false);
 assert.equal(knownProviderFormulaEquivalent('="V52_EXPENSE_RAW!A1"',`="'V52_EXPENSE_RAW'!A1"`),false);
 assert.equal(knownProviderFormulaEquivalent('=SUM(V52_EXPENSE_RAW_OTHER!A1)',"=SUM('V52_EXPENSE_RAW'!A1)"),false);
});
