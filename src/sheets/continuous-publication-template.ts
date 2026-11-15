/** The publication carrier is private infrastructure for the continuous
 * expense path. A publication is deliberately independent of the immutable
 * DAILY carrier, whose full-row digest must not change when visibility does. */
export const PUBLICATION_SEPARATOR='␟';
export type PublicationState='STAGED'|'PUBLISHED'|'REVOKED';
export type PublicationCarrier={expenseId:string;version:number;nonce:string;state:PublicationState;detailCount:number};
const idPattern=/^exp_[A-Za-z0-9_-]{1,128}$/;
const noncePattern=/^[0-9a-f]{32}$/;

/** Values are canonical; hidden separators, ambiguous versions, and strings
 * that could alter a Sheets COUNTIF criterion are not accepted. */
export function encodePublicationCarrier(v:PublicationCarrier):string{
 if(!idPattern.test(v.expenseId)||!Number.isSafeInteger(v.version)||v.version<1||!noncePattern.test(v.nonce)||!['STAGED','PUBLISHED','REVOKED'].includes(v.state)||v.state==='REVOKED'&&v.version<2||!Number.isSafeInteger(v.detailCount)||v.detailCount<0||v.detailCount>500)throw Error('PUBLICATION_CARRIER_INVALID');
 return ['PUB1',`MALIPANG_EXPENSE:${v.expenseId}`,v.version,v.nonce,v.state,v.detailCount].join(PUBLICATION_SEPARATOR);
}
export function decodePublicationCarrier(value:unknown):PublicationCarrier|null{
 if(typeof value!=='string')return null;
 const fields=value.split(PUBLICATION_SEPARATOR);
 if(fields.length!==6||fields[0]!=='PUB1'||!fields[1]?.startsWith('MALIPANG_EXPENSE:')||!/^\d+$/.test(fields[2]||'')||!/^\d+$/.test(fields[5]||''))return null;
 const carrier:PublicationCarrier={expenseId:fields[1].slice('MALIPANG_EXPENSE:'.length),version:Number(fields[2]),nonce:fields[3]||'',state:fields[4] as PublicationState,detailCount:Number(fields[5])};
 try{return encodePublicationCarrier(carrier)===value?carrier:null;}catch{return null;}
}

/** Strictly monotonic transition. Every operation changes the nonce, so a
 * delayed old findReplace cannot publish after a completed revocation. */
export function publicationTransition(before:PublicationCarrier,after:PublicationCarrier):{find:string;replacement:string}{
 const find=encodePublicationCarrier(before),replacement=encodePublicationCarrier(after);
 if(before.expenseId!==after.expenseId||before.nonce===after.nonce||before.detailCount!==after.detailCount||
   !(before.state==='STAGED'&&after.state==='PUBLISHED'&&before.version===after.version||
     (before.state==='STAGED'||before.state==='PUBLISHED')&&after.state==='REVOKED'&&after.version===before.version+1))throw Error('PUBLICATION_TRANSITION_INVALID');
 return {find,replacement};
}
/** A zero-match, partial or lost response is not success. Callers must hold
 * the journal until they read the exact positive postimage and verify source. */
export function publicationTransitionRequest(sheetId:number,row:number,before:PublicationCarrier,after:PublicationCarrier):unknown{
 if(!Number.isSafeInteger(sheetId)||sheetId<0||!Number.isSafeInteger(row)||row<2||row>5000)throw Error('PUBLICATION_TARGET_INVALID');
 const {find,replacement}=publicationTransition(before,after);
 return {findReplace:{range:{sheetId,startRowIndex:row-1,endRowIndex:row,startColumnIndex:0,endColumnIndex:1},find,replacement,matchCase:true,matchEntireCell:true,searchByRegex:false,includeFormulas:false}};
}

/** A publication sheet is bootstrapped with a unique typed marker in each
 * unused row. Blank cells cannot be used as provider-side compare-and-swap. */
export function publicationEmptyMarker(row:number,nonce:string):string{
 if(!Number.isSafeInteger(row)||row<2||row>5000||!noncePattern.test(nonce))throw Error('PUBLICATION_TARGET_INVALID');
 return `PUB0_${row}_${nonce}`;
}
/** Planner only: add a new hidden infrastructure tab and initialize every
 * row atomically. Persist an exact bootstrap intent and reconcile unknown
 * responses before dispatching these requests; never use an existing tab. */
export function publicationBootstrapRequests(sheetId:number,title:string,markers:readonly string[]):unknown[]{
 if(!Number.isSafeInteger(sheetId)||sheetId<0||typeof title!=='string'||!title.trim()||title!==title.trim()||title.length>80||!Array.isArray(markers)||markers.length<1||markers.length>4999||markers.some((x,i)=>typeof x!=='string'||!new RegExp(`^PUB0_${i+2}_[0-9a-f]{32}$`).test(x))||new Set(markers.map(x=>x.slice(-32))).size!==markers.length)throw Error('PUBLICATION_BOOTSTRAP_INVALID');
 const rows=[{values:[{userEnteredValue:{stringValue:'Publication_Marker'}}]},...markers.map(x=>({values:[{userEnteredValue:{stringValue:x}}]}))];
 return[{addSheet:{properties:{sheetId,title,hidden:true,gridProperties:{rowCount:rows.length,columnCount:1,frozenRowCount:1}}}},{updateCells:{start:{sheetId,rowIndex:0,columnIndex:0},rows,fields:'userEnteredValue'}}];
}
export function verifyEmptyPublicationColumn(formula:unknown[][],effective:unknown[][],markers:readonly string[]):boolean{
 try{publicationBootstrapRequests(0,'publication',markers);}catch{return false;}
 if(!Array.isArray(formula)||!Array.isArray(effective)||formula.length!==markers.length+1||effective.length!==markers.length+1)return false;
 return ['Publication_Marker',...markers].every((x,i)=>Array.isArray(formula[i])&&Array.isArray(effective[i])&&formula[i]!.length===1&&effective[i]!.length===1&&formula[i]![0]===x&&effective[i]![0]===x);
}
export function publicationStageRequest(sheetId:number,row:number,emptyMarker:string,after:PublicationCarrier):unknown{
 if(!Number.isSafeInteger(sheetId)||sheetId<0||!Number.isSafeInteger(row)||row<2||row>5000||after.state!=='STAGED'||!new RegExp(`^PUB0_${row}_[0-9a-f]{32}$`).test(emptyMarker))throw Error('PUBLICATION_TARGET_INVALID');
 return {findReplace:{range:{sheetId,startRowIndex:row-1,endRowIndex:row,startColumnIndex:0,endColumnIndex:1},find:emptyMarker,replacement:encodePublicationCarrier(after),matchCase:true,matchEntireCell:true,searchByRegex:false,includeFormulas:false}};
}

/** One helper formula per DAILY row. It returns a state only for a unique,
 * canonically-shaped publication marker; missing/malformed/duplicate markers
 * produce #N/A. Manual rows without a carrier remain untouched. */
export function dailyPublicationStateFormula(row:number,sheet:string,rows=5000):string{
 if(!Number.isSafeInteger(row)||row<4||row>5000||!Number.isSafeInteger(rows)||rows<2||rows>5000||typeof sheet!=='string'||!sheet.trim()||sheet!==sheet.trim()||sheet.length>80)throw Error('PUBLICATION_TARGET_INVALID');
 const target=`'${sheet.replace(/'/g,"''")}'!$A$2:$A$${rows}`,y=`$Y${row}`,sep=PUBLICATION_SEPARATOR;
 const key=`INDEX(SPLIT(${y},"${sep}",FALSE,FALSE),1,2)`,version=`INDEX(SPLIT(${y},"${sep}",FALSE,FALSE),1,12)`,prefix=`"PUB1${sep}"&${key}&"${sep}"`;
 const fields=`SPLIT(INDEX(FILTER(${target},ARRAYFORMULA(LEFT(${target},LEN(${prefix}))=${prefix})),1),"${sep}",FALSE,FALSE)`;
 const valid=`"^PUB1${sep}MALIPANG_EXPENSE:exp_[A-Za-z0-9_-]{1,128}${sep}[1-9][0-9]*${sep}[0-9a-f]{32}${sep}(STAGED|PUBLISHED|REVOKED)${sep}(0|[1-9][0-9]{0,2})$"`;
 const value=`INDEX(FILTER(${target},ARRAYFORMULA(LEFT(${target},LEN(${prefix}))=${prefix})),1)`;
 const markerVersion=`INDEX(${fields},1,3)`,markerState=`INDEX(${fields},1,5)`;
 const harmless=`OR(${y}="",REGEXMATCH(TO_TEXT(${y}),"^MPD1_CANCELLED_[0-9a-f]{64}$"),REGEXMATCH(TO_TEXT(${y}),"^MPD1_EMPTY_[0-9]+_[0-9a-f]{32}$"))`;
 return `=IF(${harmless},"",IF(LEFT(TO_TEXT(${y}),5)<>"MPD1${sep}",NA(),IFERROR(IF(OR(NOT(REGEXMATCH(${key},"^MALIPANG_EXPENSE:exp_[A-Za-z0-9_-]{1,128}$")),NOT(REGEXMATCH(TO_TEXT(${version}),"^[1-9][0-9]*$"))),NA(),IF(COUNTIF(${target},${prefix}&"*")<>1,NA(),IF(AND(REGEXMATCH(${value},${valid}),VALUE(INDEX(${fields},1,6))<=500,VALUE(${markerVersion})=VALUE(${version})+IF(${markerState}="REVOKED",1,0)),${markerState},NA()))),NA())))`;
}

/** Verify the full bounded marker column, not just an arbitrary matching
 * cell. Missing, malformed and duplicate markers are not evidence of absence. */
export function verifyPublicationColumn(formula:unknown[][],effective:unknown[][],rows:number,expected:PublicationCarrier,row:number):boolean{
 if(!Number.isSafeInteger(rows)||rows<2||rows>5000||!Number.isSafeInteger(row)||row<2||row>rows||!Array.isArray(formula)||!Array.isArray(effective)||formula.length>rows||effective.length>rows)return false;
 if(formula[0]?.length!==1||effective[0]?.length!==1||formula[0]![0]!=='Publication_Marker'||effective[0]![0]!=='Publication_Marker')return false;
 let encoded:string;try{encoded=encodePublicationCarrier(expected);}catch{return false;}
 const ids=new Set<string>(),nonces=new Set<string>();let matches=0;
 for(let i=1;i<rows;i++){
  const f=formula[i]??[],e=effective[i]??[];if(!Array.isArray(f)||!Array.isArray(e)||f.length>1||e.length>1)return false;
  const fv=f[0],ev=e[0];
  if(typeof fv!=='string'||fv!==ev)return false;
  if(new RegExp(`^PUB0_${i+1}_[0-9a-f]{32}$`).test(fv)){
   const nonce=fv.slice(-32);if(nonces.has(nonce))return false;nonces.add(nonce);continue;
  }
  const carrier=decodePublicationCarrier(fv);if(!carrier||ids.has(carrier.expenseId)||nonces.has(carrier.nonce))return false;
  ids.add(carrier.expenseId);nonces.add(carrier.nonce);
  if(carrier.expenseId===expected.expenseId){if(i!==row-1||fv!==encoded)return false;matches++;}
 }
 return matches===1;
}
