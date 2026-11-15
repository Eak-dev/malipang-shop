import test from 'node:test';import assert from 'node:assert/strict';
import {combinedLedgerSpillFormulas,rewriteLedgerConsumerFormula} from '../scripts/combined-ledger-report-formulas.mjs';
const names={rawNew:'raw_new',detailNew:'detail_new',rawCombined:'raw_all',detailCombined:'detail_all'};
test('raw combined projection includes owner-editable R and both sources at the verified capacity',()=>{
 const f=combinedLedgerSpillFormulas({...names,rawOldRows:1000,rawNewRows:1500,detailOldRows:1000,detailNewRows:1300});
 assert.match(f.raw,/VSTACK\('V52_EXPENSE_RAW'!A1:R,'raw_new'!A2:R\)/);
 assert.match(f.detail,/VSTACK\('รายละเอียดการซื้อ'!A1:T,'detail_new'!A2:T\)/);
 assert.equal(f.rawRows,2499);assert.equal(f.detailRows,2299);assert.match(f.raw,/MATCH\(/);assert.match(f.detail,/MATCH\(/);
});
test('combined reports fence duplicates within each source as well as across sources',()=>{
 const f=combinedLedgerSpillFormulas({...names,rawOldRows:1000,rawNewRows:1000,detailOldRows:1000,detailNewRows:1000});
 assert.match(f.raw,/UNIQUE\(FILTER\('raw_new'!\$A\$2:\$A/);
 assert.match(f.raw,/UNIQUE\(FILTER\('V52_EXPENSE_RAW'!\$A\$2:\$A/);
 assert.match(f.detail,/UNIQUE\(FILTER\('detail_new'!\$B\$2:\$B&"\|"&'detail_new'!\$A\$2:\$A/);
 assert.match(f.detail,/UNIQUE\(FILTER\('รายละเอียดการซื้อ'!\$B\$2:\$B&"\|"&'รายละเอียดการซื้อ'!\$A\$2:\$A/);
});
test('consumer rewrite includes new addback basis and removes obsolete row-1000 limit',()=>{
 const input='=SUMIFS(V52_EXPENSE_RAW!D2:D1000,V52_EXPENSE_RAW!H2:H1000,"CONFIRMED",V52_EXPENSE_RAW!R2:R1000,"ACCUMULATED_CASH")';
 const out=rewriteLedgerConsumerFormula(input,names);
 assert.match(out,/'raw_all'!D2:D/);assert.match(out,/'raw_all'!R2:R/);assert.doesNotMatch(out,/raw_all'!R2:R1000/);assert.match(out,/MATCH\('raw_new'!\$A\$2:\$A/);
 assert.match(out,/IFERROR\('raw_all'!\$A\$1<>"Expense_ID",TRUE\)/);
});
test('04 monthly formulas reference both combined sources and independently fence cross-source duplicates',()=>{
 const f='=SUMIFS(\'รายละเอียดการซื้อ\'!$L$2:$L$1000,\'รายละเอียดการซื้อ\'!$Q$2:$Q$1000,"CONFIRMED")+SUM(V52_EXPENSE_RAW!$D$2:$D$1000)';
 const out=rewriteLedgerConsumerFormula(f,names);
 assert.match(out,/'detail_all'!\$L\$2:\$L/);assert.match(out,/'raw_all'!\$D\$2:\$D/);assert.match(out,/'detail_new'!\$B\$2:\$B&"\|"/);
});
test('unknown references, changed range shapes and sheet aliases fail closed',()=>{
 assert.throws(()=>rewriteLedgerConsumerFormula('=V52_EXPENSE_RAW!A1',names),/REFERENCE_UNVERIFIED/);
 assert.throws(()=>rewriteLedgerConsumerFormula('=SUM(V52_EXPENSE_RAW!A2:B1000)',names),/RANGE_UNVERIFIED/);
 assert.throws(()=>rewriteLedgerConsumerFormula('=0',names),/NO_REFERENCE/);
 assert.throws(()=>combinedLedgerSpillFormulas({...names,rawNew:'V52_EXPENSE_RAW',rawOldRows:1000,rawNewRows:1000,detailOldRows:1000,detailNewRows:1000}),/ALIAS/);
});
