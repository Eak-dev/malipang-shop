/** Read-only plan for a complete, freshly read RAW or purchase-detail sheet.
 * Column A holds the business ID. Row numbers returned here are observations
 * for the current request only; they are not persistent identities. */
export type LedgerRowPlan =
  | {status:'PRESENT';observedRow:number}
  | {status:'APPEND';observedRow:number}
  | {status:'REVIEW';reason:string};

const blank=(value:unknown):boolean=>value===null||value===undefined||value==='';
const same=(a:unknown,b:unknown):boolean=>(blank(a)&&blank(b))||a===b;

export function planStableLedgerRow(rows:readonly (readonly unknown[])[],id:string,expected:readonly unknown[],isNew:boolean):LedgerRowPlan{
  if(typeof id!=='string'||!id||id!==id.trim()||id.startsWith('=')||!Array.isArray(expected)||expected.length<1||expected[0]!==id||typeof isNew!=='boolean')return {status:'REVIEW',reason:'INVALID_IDENTITY'};
  if(!Array.isArray(rows)||rows.length<1||!Array.isArray(rows[0]))return {status:'REVIEW',reason:'INCOMPLETE_SNAPSHOT'};
  const matches:number[]=[];let last=1;
  for(let i=1;i<rows.length;i++){
    const row=rows[i]!;if(!Array.isArray(row))return {status:'REVIEW',reason:'INCOMPLETE_SNAPSHOT'};
    if(row.some(value=>!blank(value)))last=i+1;
    if(typeof row[0]==='string'&&row[0]!==id&&row[0].trim()===id)return {status:'REVIEW',reason:'IDENTITY_FORMAT_CONFLICT'};
    if(row[0]===id)matches.push(i+1);
  }
  if(matches.length>1)return {status:'REVIEW',reason:'DUPLICATE_IDENTITY'};
  if(matches.length===1){
    const row=rows[matches[0]!-1]!;
    if(row.some((value:unknown)=>typeof value==='string'&&value.trimStart().startsWith('=')))return {status:'REVIEW',reason:'FORMULA_CONFLICT'};
    if(expected.some((value:unknown,index:number)=>!same(value,row[index]))||row.slice(expected.length).some((value:unknown)=>!blank(value)))return {status:'REVIEW',reason:'DATA_CONFLICT'};
    return {status:'PRESENT',observedRow:matches[0]!};
  }
  if(!isNew)return {status:'REVIEW',reason:'IDENTITY_NOT_FOUND'};
  return {status:'APPEND',observedRow:last+1};
}
