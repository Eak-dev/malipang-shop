import test from 'node:test';
import assert from 'node:assert/strict';
import {continuousCleanFormula,continuousFlowTotalFormula,continuousFlowCountFormula,continuousCashReconciliationFormula,continuousOwnerCashFormula,continuousBudgetFormula} from '../scripts/continuous-daily-report-formulas.mjs';

test('clean report includes old-date new sheet IDs in RAW branch and rejects ambiguous preimage',()=>{
 const input='=LET(ids,V52_EXPENSE_RAW!A2:A,dt,V52_EXPENSE_RAW!B2:B,raw,FILTER(ids,dt>=DATE(2026,8,1)),raw)';
 const result=continuousCleanFormula(input);
 assert.match(result,/MATCH\("MALIPANG_EXPENSE:"&ids,'รายวันต่อเนื่อง_แบบร่าง'!\$X\$4:\$X,0\)/);
 assert.match(result,/SUMPRODUCT\(ARRAYFORMULA/);
 assert.match(result,/UNIQUE\(FILTER\('รายวันต่อเนื่อง_แบบร่าง'!\$X\$4:\$X/);
 assert.match(result,/UNIQUE\(FILTER\('รายวัน'!\$X\$5:\$X/);
 assert.throws(()=>continuousCleanFormula('=1'),/PREIMAGE/);
 assert.throws(()=>continuousCleanFormula(input+'&(dt>=DATE(2026,8,1))'),/PREIMAGE/);
});
test('flow report adds new totals and counts with duplicate ID guard and exact preimage',()=>{
 const total='=IF(OR(A5="",A5>TODAY()),"",SUMIF(\'รายวัน\'!$U$5:$U$4464,A5,\'รายวัน\'!$I$5:$I$4464)+SUMIF(\'รายวัน\'!$U$5:$U$4464,A5,\'รายวัน\'!$R$5:$R$4464))';
 const count='=IF(OR(A5="",A5>TODAY()),"",COUNTIFS(\'รายวัน\'!$U$5:$U$4464,A5,\'รายวัน\'!$D$5:$D$4464,"<>"))';
 assert.match(continuousFlowTotalFormula(total,5),/'รายวันต่อเนื่อง_แบบร่าง'!\$I\$4:\$I/);
 assert.match(continuousFlowCountFormula(count,5),/'รายวันต่อเนื่อง_แบบร่าง'!\$D\$4:\$D/);
 assert.throws(()=>continuousFlowTotalFormula(total,6),/PREIMAGE/);
 assert.throws(()=>continuousFlowCountFormula(count,4),/ROW_INVALID/);
});
test('cash recon subtracts both independent daily sources and checks identity collisions',()=>{
 const old=`=ROUND(SUMIFS('97_EXPENSE_CLEAN'!D2:D4500,'97_EXPENSE_CLEAN'!A2:A4500,d)-SUMIFS('รายวัน'!I5:I4464,'รายวัน'!U5:U4464,d,'รายวัน'!W5:W4464,"ทอน/หน้าร้าน"),2)`;
 const result=continuousCashReconciliationFormula(old);
 assert.match(result,/-SUMIFS\('รายวัน'!I5:I4464.*\)-SUMIFS\('รายวันต่อเนื่อง_แบบร่าง'!I4:I/);
 assert.throws(()=>continuousCashReconciliationFormula('=0'),/PREIMAGE/);
 assert.throws(()=>continuousCashReconciliationFormula(old.replace('-SUMIFS(', '+SUMIFS(')),/PREIMAGE/);
});
test('monthly budget subtracts old and new debits by posting month, not income or credit',()=>{
 const original='=IF(U4="","",IF(COUNTIFS($AA$4:$AA$243,A4,$AB$4:$AB$243,B4)<>1,"",SUMIFS($AC$4:$AC$243,$AA$4:$AA$243,A4,$AB$4:$AB$243,B4)-SUMIFS($I$4:I4,$A$4:A4,A4,$B$4:B4,B4)))';
 const updated=continuousBudgetFormula(original,4);
 assert.match(updated,/-SUMIFS\(\$I\$4:I4.*\)-SUMIFS\('รายวัน'!\$I\$5:\$I/);
 assert.match(updated,/<"&EDATE\(DATE\(A4,B4,1\),1\)/);
 assert.throws(()=>continuousBudgetFormula(original,5),/PREIMAGE/);
});
test('owner cash report adds new daily rows outside the two unified-ledger months',()=>{
 const old="'รายวัน'",day='A46',gate=`OR(${day}="",${day}>$E$2)`,modern='OR($B$2="2026-11",$B$2="2026-12")';
 const cash=`SUMIFS('97_EXPENSE_CLEAN'!$D$2:$D$4500,'97_EXPENSE_CLEAN'!$A$2:$A$4500,${day},'97_EXPENSE_CLEAN'!$E$2:$E$4500,"CASH_DRAWER",'97_EXPENSE_CLEAN'!$H$2:$H$4500,"<>ACCUMULATED_CASH")`;
 const sum=exclude=>`SUMIFS(${old}!$I$5:$I$4464,${old}!$U$5:$U$4464,${day},${old}!$W$5:$W$4464,"ทอน/หน้าร้าน"${exclude?`,${old}!$V$5:$V$4464,"<>personal_use"`:''})`;
 const wrap=x=>`IF(${gate},"",${x})`;
 const before=`=IF($B$2="2026-10",IF(${modern},${wrap(cash)},${wrap(sum(true))}),IF(${modern},${wrap(cash)},${wrap(sum(false))}))`;
 const after=continuousOwnerCashFormula(before,46,'B');
 assert.match(after,/IF\(OR\(\$B\$2="2026-11",\$B\$2="2026-12"\),0,IF\(\$B\$2="2026-10"/);
 assert.match(after,/IF\(\$B\$2="2026-10",SUMIFS\('รายวันต่อเนื่อง_แบบร่าง'!/);
 assert.throws(()=>continuousOwnerCashFormula(before,47,'B'),/PREIMAGE/);
});
