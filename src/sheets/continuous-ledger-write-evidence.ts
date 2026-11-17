import {appendedLedgerInputsBlank,decodeLedgerCarrier,type CarrierLedger} from './atomic-expense-ledger-template';

type Snapshot={formula:unknown[][];effective:unknown[][]};
export type LedgerEvidenceCoordinates={sheetId:number;row:number;beforeRows:number;projection:CarrierLedger;kind:'CONFIRM'|'CANCEL';mode:'REPLACE'|'APPEND'};
const blank=(v:unknown)=>v===undefined||v===null||v==='';
function valid(c:LedgerEvidenceCoordinates):boolean{return Number.isSafeInteger(c.sheetId)&&c.sheetId>=0&&Number.isSafeInteger(c.beforeRows)&&c.beforeRows>=2&&c.beforeRows<=5000&&Number.isSafeInteger(c.row)&&c.row>=2&&c.row<=5000&&['EXPENSE_RAW','DETAIL'].includes(c.projection)&&['CONFIRM','CANCEL'].includes(c.kind)&&(c.mode==='REPLACE'&&c.row<=c.beforeRows||c.mode==='APPEND'&&c.kind==='CONFIRM'&&c.beforeRows<5000&&c.row===c.beforeRows+1);}
function shape(s:Snapshot,rows:number):boolean{return !!s&&Array.isArray(s.formula)&&Array.isArray(s.effective)&&s.formula.length<=rows&&s.effective.length<=rows&&[...s.formula,...s.effective].every(r=>Array.isArray(r)&&r.length<=26&&r.every(v=>blank(v)||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)));}
async function digest(text:string):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),v=>v.toString(16).padStart(2,'0')).join('');}
function normalized(s:Snapshot,c:LedgerEvidenceCoordinates):unknown[][][]{
 return [s.formula,s.effective].map((values,kind)=>Array.from({length:c.beforeRows},(_,r)=>Array.from({length:26},(_,col)=>{
  // Target cell Z and its formula-derived display are separately validated
  // from the exact marker, payload and accounting readback.
  if(c.mode==='REPLACE'&&r===c.row-1&&(col===25||kind===1&&col<(c.projection==='EXPENSE_RAW'?17:20)))return null;
  const value=values[r]?.[col];return blank(value)?null:value;
 })));
}
export async function ledgerBeforeDigest(s:Snapshot,c:LedgerEvidenceCoordinates):Promise<string>{
 if(!valid(c)||!shape(s,c.beforeRows))throw Error('LEDGER_WRITE_EVIDENCE_INVALID');
 return digest(JSON.stringify(['ledger-before-v1',c.sheetId,c.row,c.beforeRows,c.projection,c.kind,c.mode,normalized(s,c)]));
}
export async function ledgerPayloadDigest(payload:string,kind:'CONFIRM'|'CANCEL'):Promise<string>{
 const row=decodeLedgerCarrier(payload);
 if(!row||kind==='CONFIRM'&&(row.status!=='CONFIRMED'||!row.writeMarker)||kind==='CANCEL'&&(row.status!=='CANCELLED'||!row.cancelMarker))throw Error('LEDGER_WRITE_PAYLOAD_INVALID');
 return digest(JSON.stringify(['ledger-payload-v1',kind,payload]));
}
/** Checks only the positive full-grid transform. The caller must separately
 * authenticate the carrier, formulas, calculated values, source and claim. */
export async function matchesCommittedLedgerMutation(after:Snapshot,c:LedgerEvidenceCoordinates,payload:string,beforeDigest:string,payloadDigest:string):Promise<boolean>{
 const row=decodeLedgerCarrier(payload),marker=c.kind==='CONFIRM'?row?.writeMarker:row?.cancelMarker,afterRows=c.beforeRows+(c.mode==='APPEND'?1:0);
 if(!valid(c)||!row||row.projection!==c.projection||!marker||!/^([0-9a-f]{64})$/.test(beforeDigest)||!/^([0-9a-f]{64})$/.test(payloadDigest)||!shape(after,afterRows)||await ledgerPayloadDigest(payload,c.kind)!==payloadDigest||after.formula[c.row-1]?.[25]!==payload||after.effective[c.row-1]?.[25]!==payload)return false;
 // The normal RAW confirmation writer requires the owner-editable addback
 // to be blank. An appended row is outside the preimage digest, so check it
 // explicitly rather than authenticating a changed amount as our own write.
 if(c.projection==='EXPENSE_RAW'&&c.kind==='CONFIRM'&&(!blank(after.formula[c.row-1]?.[17])||!blank(after.effective[c.row-1]?.[17])))return false;
 if(c.mode==='APPEND'&&!appendedLedgerInputsBlank(c.projection,after.formula[c.row-1]??[],after.effective[c.row-1]??[]))return false;
 let count=0;for(const item of after.formula){const parsed=decodeLedgerCarrier(item[25]);if((c.kind==='CONFIRM'?parsed?.writeMarker:parsed?.cancelMarker)===marker)count++;}if(count!==1)return false;
 // APPEND can only be proven as the one extra last row; REPLACE compares
 // the masked target and every unaffected formula/effective cell.
 const beforeLike={formula:after.formula.slice(0,c.beforeRows),effective:after.effective.slice(0,c.beforeRows)};
 return await ledgerBeforeDigest(beforeLike,c)===beforeDigest;
}
