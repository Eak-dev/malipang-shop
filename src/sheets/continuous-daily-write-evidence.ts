import {appendDailyRowFormulas} from './append-daily-template';
import {continuousDailyHelperFormulas} from './continuous-daily-plan';
import {decodeAtomicDailyPayload} from './atomic-daily-template';

/** A digest is useful only for positive readback. Neither an absent marker
 * nor a mismatch establishes that an outstanding request cannot still run. */
export type DailyWriteSnapshot={formula:unknown[][];effective:unknown[][]};
export type DailyWriteCoordinates={sheetId:number;row:number;rowCount:number;columnCount:number};
const helpers=new Set([8,9,17,18,20]);
const blank=(v:unknown)=>v===undefined||v===null||v==='';
const same=(a:unknown,b:unknown)=>blank(a)&&blank(b)||a===b;
function shape(snapshot:DailyWriteSnapshot,rows:number,columns:number):boolean{
 return !!snapshot&&Array.isArray(snapshot.formula)&&Array.isArray(snapshot.effective)&&snapshot.formula.length<=rows&&snapshot.effective.length<=rows&&[...snapshot.formula,...snapshot.effective].every(row=>Array.isArray(row)&&row.length<=columns&&row.every(cell=>blank(cell)||typeof cell==='string'||typeof cell==='boolean'||typeof cell==='number'&&Number.isFinite(cell)));
}
function coords(c:DailyWriteCoordinates):boolean{return Number.isSafeInteger(c.sheetId)&&c.sheetId>=0&&Number.isSafeInteger(c.rowCount)&&c.rowCount>=5&&c.rowCount<5000&&Number.isSafeInteger(c.columnCount)&&c.columnCount>=29&&c.columnCount<=100&&Number.isSafeInteger(c.row)&&c.row>=5&&c.row<=c.rowCount;}
function normalized(snapshot:DailyWriteSnapshot,rows:number,columns:number):unknown[][][]{
 return [snapshot.formula,snapshot.effective].map(values=>Array.from({length:rows},(_,r)=>Array.from({length:columns},(_,c)=>blank(values[r]?.[c])?null:values[r]![c])));
}
async function hash(text:string):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),v=>v.toString(16).padStart(2,'0')).join('');}
export async function dailySnapshotDigest(snapshot:DailyWriteSnapshot,c:DailyWriteCoordinates):Promise<string>{
 if(!coords(c)||!shape(snapshot,c.rowCount,c.columnCount))throw Error('DAILY_WRITE_EVIDENCE_INVALID');
 return hash(JSON.stringify(['daily-before-v1',c.sheetId,c.row,c.rowCount,c.columnCount,normalized(snapshot,c.rowCount,c.columnCount)]));
}
export async function dailyPayloadDigest(payload:string):Promise<string>{
 if(!decodeAtomicDailyPayload(payload)?.operationMarker)throw Error('DAILY_WRITE_PAYLOAD_INVALID');
 return hash(JSON.stringify(['daily-payload-v1',payload]));
}

/** Verify a positive postimage by reconstructing the exact former grid and
 * comparing its digest. This does not itself authorize a state transition:
 * callers must additionally revalidate source, budgets, accounting, number
 * formats, journal identity, lease/claim and all other projections. */
export async function matchesCommittedDailyInsert(after:DailyWriteSnapshot,c:DailyWriteCoordinates,payload:string,beforeDigest:string,payloadDigest:string):Promise<boolean>{
 const parsed=decodeAtomicDailyPayload(payload);
 if(!coords(c)||!parsed?.operationMarker||!/^([0-9a-f]{64})$/.test(beforeDigest)||!/^([0-9a-f]{64})$/.test(payloadDigest)||!shape(after,c.rowCount+1,c.columnCount)||await dailyPayloadDigest(payload)!==payloadDigest)return false;
 const index=c.row-1,af=after.formula,ae=after.effective,formula=appendDailyRowFormulas();
 if(af[index]?.[24]!==payload||ae[index]?.[24]!==payload)return false;
 let matches=0;for(const row of af)if(decodeAtomicDailyPayload(row[24])?.operationMarker===parsed.operationMarker)matches++;
 if(matches!==1)return false;
 for(let column=0;column<25;column++){
  const expected=column===24?payload:formula[column];
  if(!same(af[index]?.[column],expected))return false;
 }
 const f:unknown[][]=[],e:unknown[][]=[];
 for(let r=0;r<c.rowCount;r++){
  const fr:unknown[]=[],er:unknown[]=[];
  for(let col=0;col<c.columnCount;col++){
   if(col>=25||r<index){fr.push(af[r]?.[col]??null);er.push(ae[r]?.[col]??null);continue;}
   const shifted=af[r+1]?.[col],shiftedEffective=ae[r+1]?.[col];
   if(helpers.has(col)){
    const upgraded=col===9&&shifted===formula[9],expected=upgraded?formula[9]:continuousDailyHelperFormulas(r+2)[col];
    if(shifted!==expected||!blank(shiftedEffective))return false;
    fr.push(upgraded?formula[9]:continuousDailyHelperFormulas(r+1)[col]);er.push(null);
   }else{
    if(!blank(shifted)||!blank(shiftedEffective))return false;
    fr.push(null);er.push(null);
   }
  }
  f.push(fr);e.push(er);
 }
 for(let col=25;col<c.columnCount;col++)if(!blank(af[c.rowCount]?.[col])||!blank(ae[c.rowCount]?.[col]))return false;
 return await dailySnapshotDigest({formula:f,effective:e},c)===beforeDigest;
}
