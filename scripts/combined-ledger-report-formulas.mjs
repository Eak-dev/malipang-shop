/** Offline formula planning only. Requires a separately verified inventory of
 * every consumer, exact formula preimages, independent provider tests and a
 * fenced cutover/readback. Never executes Google requests. */
const quote=s=>{if(typeof s!=='string'||!s.trim()||s.length>100)throw Error('LEDGER_REPORT_TITLE_INVALID');return `'${s.replaceAll("'","''")}'`;};
const bounds=n=>{if(!Number.isSafeInteger(n)||n<2||n>5000)throw Error('LEDGER_REPORT_BOUNDS_INVALID');return n;};
const distinct=items=>{if(new Set(items).size!==items.length)throw Error('LEDGER_REPORT_ALIAS');};
const rawOld="'V52_EXPENSE_RAW'",detailOld="'รายละเอียดการซื้อ'";
function duplicateColumn(range){const f=`FILTER(${range},${range}<>"")`;return `IFERROR(ROWS(${f}),0)<>IFERROR(ROWS(UNIQUE(${f})),0)`;}
function duplicatePairs(sheet){const a=`${sheet}!$A$2:$A`,b=`${sheet}!$B$2:$B`,f=`FILTER(${b}&"|"&${a},${a}<>"",${b}<>"")`;return `IFERROR(ROWS(${f}),0)<>IFERROR(ROWS(UNIQUE(${f})),0)`;}
function duplicateRaw(raw){return `OR(${duplicateColumn(`${raw}!$A$2:$A`)},${duplicateColumn(`${rawOld}!$A$2:$A`)},SUMPRODUCT(ARRAYFORMULA((${raw}!$A$2:$A<>"")*ISNUMBER(MATCH(${raw}!$A$2:$A,${rawOld}!$A$2:$A,0))))>0)`;}
function duplicateDetails(detail){return `OR(${duplicatePairs(detail)},${duplicatePairs(detailOld)},SUMPRODUCT(ARRAYFORMULA((${detail}!$A$2:$A<>"")*(${detail}!$B$2:$B<>"")*ISNUMBER(MATCH(${detail}!$B$2:$B&"|"&${detail}!$A$2:$A,${detailOld}!$B$2:$B&"|"&${detailOld}!$A$2:$A,0))))>0)`;}

/** Each helper is a new empty tab with >= oldRows+newRows-1 rows; both tabs
 * reserve columns A:R for RAW (including editable R) or A:T for DETAIL. */
export function combinedLedgerSpillFormulas({rawNew,detailNew,rawCombined,detailCombined,rawOldRows,rawNewRows,detailOldRows,detailNewRows,publishedDaily}){
 distinct(['V52_EXPENSE_RAW','รายละเอียดการซื้อ',rawNew,detailNew,rawCombined,detailCombined,...publishedDaily?[publishedDaily]:[]]);
 const r=quote(rawNew),d=quote(detailNew);quote(rawCombined);quote(detailCombined);
 [rawOldRows,rawNewRows,detailOldRows,detailNewRows].forEach(bounds);
 if(publishedDaily){
  const daily=quote(publishedDaily),visible=`${daily}!$X$4:$X`,dailyError=`SUMPRODUCT(ARRAYFORMULA(--ISERROR(${visible})))>0`;
  // Stage/undo visibility is keyed only by the DAILY X column. FILTER removes
  // the entire unpublished row including RAW's owner-editable R, while the
  // original legacy tab and all manually entered DAILY rows remain intact.
  // Do not IFNA the FILTER result: that could replace an actual error in a
  // populated cell with a blank row. Count first, then filter only if needed.
  const part=(sheet,id,width,end)=>{
   const ids=`${sheet}!$${id}$2:$${id}`,keep=`ARRAYFORMULA((${ids}<>"")*ISNUMBER(MATCH("MALIPANG_EXPENSE:"&${ids},${visible},0)))`;
   return `IF(SUMPRODUCT(${keep})=0,MAKEARRAY(1,${width},LAMBDA(rr,cc,"")),FILTER(${sheet}!A2:${end},${keep}))`;
  };
  return {
   raw:`=IF(OR(${duplicateRaw(r)},${dailyError}),NA(),VSTACK(${rawOld}!A1:R,${part(r,'A',18,'R')}))`,
   detail:`=IF(OR(${duplicateDetails(d)},${dailyError}),NA(),VSTACK(${detailOld}!A1:T,${part(d,'B',20,'T')}))`,
   rawRows:rawOldRows+rawNewRows-1,detailRows:detailOldRows+detailNewRows-1
  };
 }
 return{
  raw:`=IF(${duplicateRaw(r)},NA(),VSTACK(${rawOld}!A1:R,${r}!A2:R))`,
  detail:`=IF(${duplicateDetails(d)},NA(),VSTACK(${detailOld}!A1:T,${d}!A2:T))`,
  rawRows:rawOldRows+rawNewRows-1,detailRows:detailOldRows+detailNewRows-1
 };
}

/** Rewrite only simple one-column A1 data ranges beginning at row 2, as in
 * the live 97/04/98 formulas. Any unrecognized reference is an explicit
 * blocker. Drop prior row-1000 truncation because the helper contains both
 * source grids and has a preverified bounded spill capacity. */
export function rewriteLedgerConsumerFormula(original,{rawNew,detailNew,rawCombined,detailCombined}){
 if(typeof original!=='string'||!original.startsWith('='))throw Error('LEDGER_REPORT_PREIMAGE_INVALID');
 distinct(['V52_EXPENSE_RAW','รายละเอียดการซื้อ',rawNew,detailNew,rawCombined,detailCombined]);
 const r=quote(rawNew),d=quote(detailNew),rc=quote(rawCombined),dc=quote(detailCombined);
 let rawUsed=false,detailUsed=false;
 const replace=(source,combined,kind)=>{
  const escaped=source==='V52_EXPENSE_RAW'?"(?:'V52_EXPENSE_RAW'|V52_EXPENSE_RAW)":"(?:'รายละเอียดการซื้อ'|รายละเอียดการซื้อ)";
  const re=new RegExp(`${escaped}!(\\$?)([A-Z]{1,2})(\\$?)2:(\\$?)([A-Z]{1,2})(?:\\$?\\d+)?`,'g');
  const n=original.match(re)?.length||0;
  original=original.replace(re,(_whole,dollar1,col1,dollar2,dollar3,col2)=>{
   if(col1!==col2)throw Error('LEDGER_REPORT_RANGE_UNVERIFIED');
   return `${combined}!${dollar1}${col1}${dollar2}2:${dollar3}${col2}`;
  });
  if((source==='V52_EXPENSE_RAW'?/(?:'V52_EXPENSE_RAW'|V52_EXPENSE_RAW)!/:/(?:'รายละเอียดการซื้อ'|รายละเอียดการซื้อ)!/).test(original))throw Error('LEDGER_REPORT_REFERENCE_UNVERIFIED');
  if(kind==='raw')rawUsed=n>0;else detailUsed=n>0;
 };
 replace('V52_EXPENSE_RAW',rc,'raw');replace('รายละเอียดการซื้อ',dc,'detail');
 if(!rawUsed&&!detailUsed)throw Error('LEDGER_REPORT_NO_REFERENCE');
 // Spill over capacity puts #REF in A1. Consumers normally reference row 2+
 // so they must explicitly propagate A1 error/header mismatch, otherwise a
 // failed combined sheet could silently look like an empty expense ledger.
 const checks=[rawUsed?duplicateRaw(r):null,rawUsed?`IFERROR(${rc}!$A$1<>"Expense_ID",TRUE)`:null,detailUsed?duplicateDetails(d):null,detailUsed?`IFERROR(${dc}!$A$1<>"Purchase_Item_ID",TRUE)`:null].filter(Boolean).join(',');
 return `=IF(OR(${checks}),NA(),${original.slice(1)})`;
}
