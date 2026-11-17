import {decodeAtomicDailyPayload} from './atomic-daily-template';

export type CancelSnapshot={formula:unknown[][];effective:unknown[][]};
export type CancelCoordinates={sheetId:number;row:number;rowCount:number;columnCount:number;year:number;month:number};
export const cancelledDailyEffectiveCells=new Set([0,1,2,3,5,6,7,8,9,10,11,12,13,14,15,16,17,18,20,21,22,23,24]);
const blank=(v:unknown)=>v===undefined||v===null||v==='';
const validCoords=(c:CancelCoordinates)=>Number.isSafeInteger(c.sheetId)&&c.sheetId>=0&&Number.isSafeInteger(c.rowCount)&&c.rowCount>=4&&c.rowCount<=5000&&Number.isSafeInteger(c.columnCount)&&c.columnCount>=29&&c.columnCount<=100&&Number.isSafeInteger(c.row)&&c.row>=4&&c.row<=c.rowCount&&Number.isSafeInteger(c.year)&&c.year>=1900&&c.year<=9999&&Number.isInteger(c.month)&&c.month>=1&&c.month<=12;
const validSnapshot=(s:CancelSnapshot,c:CancelCoordinates)=>!!s&&Array.isArray(s.formula)&&Array.isArray(s.effective)&&s.formula.length<=c.rowCount&&s.effective.length<=c.rowCount&&[...s.formula,...s.effective].every(r=>Array.isArray(r)&&r.length<=c.columnCount&&r.every(x=>blank(x)||typeof x==='string'||typeof x==='boolean'||typeof x==='number'&&Number.isFinite(x)));
async function hash(value:string):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');}
export async function dailyCancelTombstone(operationToken:string):Promise<string>{if(!/^[A-Za-z0-9-]{8,128}$/.test(operationToken))throw Error('DAILY_CANCEL_EVIDENCE_INVALID');return `MPD1_CANCELLED_${await hash(JSON.stringify([operationToken]))}`;}

/** Only the target carrier, its calculated cells and later running balances
 * in the same month may differ. All other values and formulas are bound to
 * the pre-dispatch image; accounting must independently verify masked cells. */
export async function dailyCancelMaskedDigest(snapshot:CancelSnapshot,c:CancelCoordinates,publication=false):Promise<string>{
 if(!validCoords(c)||!validSnapshot(snapshot,c))throw Error('DAILY_CANCEL_EVIDENCE_INVALID');
 const data=[snapshot.formula,snapshot.effective].map((grid,kind)=>Array.from({length:c.rowCount},(_,r)=>Array.from({length:c.columnCount},(_,col)=>{
  const masked=kind===0?r===c.row-1&&col===24:r===c.row-1&&(cancelledDailyEffectiveCells.has(col)||publication&&col===25)||r>=c.row&&(col===9||col===18)&&snapshot.effective[r]?.[0]===c.year&&snapshot.effective[r]?.[1]===c.month;
  const v=grid[r]?.[col];return masked||blank(v)?null:v;
 })));
 return hash(JSON.stringify([publication?'daily-cancel-before-publication-v1':'daily-cancel-before-v1',c.sheetId,c.row,c.rowCount,c.columnCount,c.year,c.month,data]));
}

/** Positive postimage only; callers additionally verify accounting, source,
 * exact journal/claim/epoch, notice and grid stability before recording it. */
export async function matchesCommittedDailyCancellation(snapshot:CancelSnapshot,c:CancelCoordinates,entityId:string,tombstone:string,maskedBeforeDigest:string,publication=false):Promise<boolean>{
 if(!validCoords(c)||!validSnapshot(snapshot,c)||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(entityId)||!/^MPD1_CANCELLED_[0-9a-f]{64}$/.test(tombstone)||!/^[0-9a-f]{64}$/.test(maskedBeforeDigest))return false;
 const row=c.row-1,f=snapshot.formula[row]??[],e=snapshot.effective[row]??[];
 if(f[24]!==tombstone||e[24]!==tombstone||!blank(e[4])||publication&&!blank(e[25])||[...cancelledDailyEffectiveCells].some(col=>col!==24&&!blank(e[col])))return false;
 if(snapshot.formula.filter(r=>r[24]===tombstone).length!==1||snapshot.formula.some(r=>decodeAtomicDailyPayload(r[24])?.expenseId===entityId))return false;
 return await dailyCancelMaskedDigest(snapshot,c,publication)===maskedBeforeDigest;
}
