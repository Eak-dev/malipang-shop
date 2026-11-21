/** Pure, opt-in cutover helpers. These functions never call Google or mutate a
 * sheet. Callers must read fresh formulas, compare identity, validate ranges,
 * guard concurrent writers, test in a separate workbook, and read back.
 * None of this is a provider-settlement or duplicate-prevention protocol. */
const OLD="'รายวัน'";
const NEW="'รายวันต่อเนื่อง_แบบร่าง'";
const unique=(s,needle)=>{
 if(typeof s!=='string'||!s.startsWith('=')||s.split(needle).length!==2)throw Error('REPORT_FORMULA_PREIMAGE_MISMATCH');
 return s;
};
const replaceOnce=(s,old,replacement)=>unique(s,old).replace(old,replacement);
// Stable IDs carry MALIPANG_EXPENSE: on both sheets. Surface duplicate IDs as
// an error instead of hiding them by choosing an arbitrary copy.
const duplicates=range=>`IFERROR(ROWS(FILTER(${range},${range}<>"")),0)<>IFERROR(ROWS(UNIQUE(FILTER(${range},${range}<>""))),0)`;
const duplicateCheck=`OR(${duplicates(`${NEW}!$X$4:$X`)},${duplicates(`${OLD}!$X$5:$X`)},SUMPRODUCT(ARRAYFORMULA((${NEW}!$X$4:$X<>"")*ISNUMBER(MATCH(${NEW}!$X$4:$X,${OLD}!$X$5:$X,0))))>0)`;
const fenced=f=>`=IF(${duplicateCheck},NA(),${f.slice(1)})`;

/** 97 currently uses RAW for >= 2026-08-01 and old daily for earlier dates.
 * Include pre-cutover-date receipts arriving on the new tab by their stable ID
 * in the same RAW pipeline, so modern entries are not added a second time. */
export function continuousCleanFormula(original){
 const predicate='dt>=DATE(2026,8,1)';
 const replacement=`ARRAYFORMULA(((dt>=DATE(2026,8,1))+ISNUMBER(MATCH("MALIPANG_EXPENSE:"&ids,${NEW}!$X$4:$X,0)))>0)`;
 return fenced(replaceOnce(original,predicate,replacement));
}

/** Add new daily amounts to the existing day-based reconciliation; the exact
 * live preimage must match the established 35 report formula for that row. */
export function continuousFlowTotalFormula(original,row){
 if(!Number.isSafeInteger(row)||row<5||row>80)throw Error('REPORT_ROW_INVALID');
 const expected=`=IF(OR(A${row}="",A${row}>TODAY()),"",SUMIF(${OLD}!$U$5:$U$4464,A${row},${OLD}!$I$5:$I$4464)+SUMIF(${OLD}!$U$5:$U$4464,A${row},${OLD}!$R$5:$R$4464))`;
 if(original!==expected)throw Error('REPORT_FORMULA_PREIMAGE_MISMATCH');
 const total=`SUMIF(${NEW}!$U$4:$U,A${row},${NEW}!$I$4:$I)+SUMIF(${NEW}!$U$4:$U,A${row},${NEW}!$R$4:$R)`;
 return fenced(original.slice(0,-1)+`+${total})`);
}
export function continuousFlowCountFormula(original,row){
 if(!Number.isSafeInteger(row)||row<5||row>80)throw Error('REPORT_ROW_INVALID');
 const expected=`=IF(OR(A${row}="",A${row}>TODAY()),"",COUNTIFS(${OLD}!$U$5:$U$4464,A${row},${OLD}!$D$5:$D$4464,"<>"))`;
 if(original!==expected)throw Error('REPORT_FORMULA_PREIMAGE_MISMATCH');
 return fenced(original.slice(0,-1)+`+COUNTIFS(${NEW}!$U$4:$U,A${row},${NEW}!$D$4:$D,"<>"))`);
}
export function continuousCashReconciliationFormula(original){
 const term=`SUMIFS(${OLD}!I5:I4464,${OLD}!U5:U4464,d,${OLD}!W5:W4464,"ทอน/หน้าร้าน")`;
 const add=`SUMIFS(${NEW}!I4:I,${NEW}!U4:U,d,${NEW}!W4:W,"ทอน/หน้าร้าน")`;
 // The new amount is also subtracted only when the verified legacy term is
 // subtracted. A positive occurrence has different accounting semantics.
 return fenced(replaceOnce(original,`-${term}`,`-${term}-${add}`));
}

/** 34 reads the old daily tab except in November/December 2026, when it
 * reads the unified 97 ledger. Add the new daily tab to every other month,
 * including later years, without counting the unified-ledger months twice. */
export function continuousOwnerCashFormula(original,row,column){
 if(!Number.isSafeInteger(row)||row<46||row>76||!['B','C','D','F'].includes(column))throw Error('REPORT_ROW_INVALID');
 const day=`A${row}`,gate=`OR(${day}="",${day}>$E$2)`,modern='OR($B$2="2026-11",$B$2="2026-12")';
 const old=(amount,wallet,exclude)=>`SUMIFS(${OLD}!$${amount}$5:$${amount}$4464,${OLD}!$U$5:$U$4464,${day}${wallet?`,${OLD}!$W$5:$W$4464,"${wallet}"`:''}${exclude?`,${OLD}!$V$5:$V$4464,"<>personal_use"`:''})`;
 const clean=wallet=>`SUMIFS('97_EXPENSE_CLEAN'!$D$2:$D$4500,'97_EXPENSE_CLEAN'!$A$2:$A$4500,${day}${wallet?`,'97_EXPENSE_CLEAN'!$E$2:$E$4500,"${wallet}"`:''}${column==='B'?`,'97_EXPENSE_CLEAN'!$H$2:$H$4500,"<>ACCUMULATED_CASH"`:''})`;
 const makeOld=exclude=>column==='F'?`${old('I',null,exclude)}+${old('R',null,exclude)}`:old(column==='D'?'R':'I',column==='B'?'ทอน/หน้าร้าน':column==='C'?'บัญชีร้าน':null,exclude);
 const modernWallet=column==='B'?'CASH_DRAWER':column==='C'?'SHOP_BANK':column==='D'?'CARD_*':null;
 const wrap=x=>`IF(${gate},"",${x})`;
 const expected=`=IF($B$2="2026-10",IF(${modern},${wrap(clean(modernWallet))},${wrap(makeOld(true))}),IF(${modern},${wrap(clean(modernWallet))},${wrap(makeOld(false))}))`;
 if(original!==expected)throw Error('REPORT_FORMULA_PREIMAGE_MISMATCH');
 const newSum=(amount,wallet,exclude)=>`SUMIFS(${NEW}!$${amount}$4:$${amount},${NEW}!$U$4:$U,${day}${wallet?`,${NEW}!$W$4:$W,"${wallet}"`:''}${exclude?`,${NEW}!$V$4:$V,"<>personal_use"`:''})`;
 const add=exclude=>column==='F'?`${newSum('I',null,exclude)}+${newSum('R',null,exclude)}`:newSum(column==='D'?'R':'I',column==='B'?'ทอน/หน้าร้าน':column==='C'?'บัญชีร้าน':null,exclude);
 return fenced(`=IF(${gate},"",(${original.slice(1)})+IF(${modern},0,IF($B$2="2026-10",${add(true)},${add(false)})))`);
}

/** Preserve J's existing opening-budget and row-order logic; debit legacy
 * expenses by their recorded posting dates, dynamically, so later Undo on the
 * old tab is reflected. Validated historical date coverage is required. */
export function continuousBudgetFormula(original,row){
 if(!Number.isSafeInteger(row)||row<4)throw Error('REPORT_ROW_INVALID');
 const old=`-SUMIFS($I$4:I${row},$A$4:A${row},A${row},$B$4:B${row},B${row})`;
 const debit=`SUMIFS(${OLD}!$I$5:$I,${OLD}!$U$5:$U,">="&DATE(A${row},B${row},1),${OLD}!$U$5:$U,"<"&EDATE(DATE(A${row},B${row},1),1))`;
 return fenced(replaceOnce(original,old,`${old}-${debit}`));
}
