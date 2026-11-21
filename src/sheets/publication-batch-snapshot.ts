import type {Env} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,getSpreadsheetSheetProperties,type ContinuousSheetsReadPolicy} from './client';
import {columnName} from './daily-expense';
import {ReviewRequestBudget} from './review-request-budget';
import type {GoogleOAuthLease} from './google-auth';

export type PublicationSnapshotSpec={sheetId:number;sheetName:string;rows:number;columns:number;startRow?:number;endRow?:number;startColumn?:number;endColumn?:number};
export type PublicationBatchSnapshot={specs:readonly PublicationSnapshotSpec[];metadata:Array<{sheetId:number;title:string;rowCount:number;columnCount:number}>;formula:unknown[][][];effective:unknown[][][]};

/** Read multiple exact sheets with two bounded value requests and a metadata
 * read on each side. This is not an atomic Sheets snapshot or writer lock:
 * callers must verify domain invariants and repeat it at their dispatch and
 * readback fences. All HTTP attempts and OAuth consume the supplied budget. */
export async function capturePublicationBatchSnapshot(env:Env,specs:readonly PublicationSnapshotSpec[],budget:ReviewRequestBudget,oauthLease?:GoogleOAuthLease):Promise<PublicationBatchSnapshot>{
 if(!(budget instanceof ReviewRequestBudget)||!Array.isArray(specs)||specs.length<1||specs.length>64||specs.some(s=>!s||!Number.isSafeInteger(s.sheetId)||s.sheetId<0||typeof s.sheetName!=='string'||!s.sheetName||s.sheetName!==s.sheetName.trim()||s.sheetName.length>80||!Number.isSafeInteger(s.rows)||s.rows<1||s.rows>10000||!Number.isSafeInteger(s.columns)||s.columns<1||s.columns>100||![s.startRow??1,s.endRow??s.rows,s.startColumn??1,s.endColumn??s.columns].every(Number.isSafeInteger)||(s.startRow??1)<1||(s.endRow??s.rows)>(s.rows)||(s.startRow??1)>(s.endRow??s.rows)||(s.startColumn??1)<1||(s.endColumn??s.columns)>s.columns||(s.startColumn??1)>(s.endColumn??s.columns)))throw Error('PUBLICATION_SNAPSHOT_INVALID');
 const byId=new Map<number,string>(),byName=new Map<string,number>(),regions=new Set<string>();
 for(const s of specs){const identity=JSON.stringify([s.sheetName,s.rows,s.columns]),nameIdentity=byName.get(s.sheetName),idIdentity=byId.get(s.sheetId),region=JSON.stringify([s.sheetId,s.startRow??1,s.endRow??s.rows,s.startColumn??1,s.endColumn??s.columns]);if(idIdentity!==undefined&&idIdentity!==identity||nameIdentity!==undefined&&nameIdentity!==s.sheetId||regions.has(region))throw Error('PUBLICATION_SNAPSHOT_INVALID');byId.set(s.sheetId,identity);byName.set(s.sheetName,s.sheetId);regions.add(region);}
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,policy:ContinuousSheetsReadPolicy={kind:'continuous-expense',budget,...oauthLease?{oauthLease}:{}};if(!book)throw Error('PUBLICATION_SNAPSHOT_INVALID');
 const stable=()=>env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book;
 const ranges=specs.map(s=>`'${s.sheetName.replace(/'/g,"''")}'!${columnName(s.startColumn??1)}${s.startRow??1}:${columnName(s.endColumn??s.columns)}${s.endRow??s.rows}`);
 if(ranges.reduce((n,r)=>n+encodeURIComponent(r).length+8,0)>14000)throw Error('PUBLICATION_SNAPSHOT_RANGE_LIMIT');
 const before=await getSpreadsheetSheetProperties(env,policy);
 const match=(s:PublicationSnapshotSpec,metadata:typeof before)=>metadata.some(x=>x.sheetId===s.sheetId&&x.title===s.sheetName&&x.rowCount===s.rows&&x.columnCount===s.columns);
 if(!stable()||specs.some(s=>!match(s,before)))throw Error('PUBLICATION_SNAPSHOT_TARGET');
 const formula=await batchGetSheetFormulaValues(env,ranges,policy),effective=await batchGetSheetEffectiveSerialValues(env,ranges,policy),after=await getSpreadsheetSheetProperties(env,policy);
 if(!stable()||JSON.stringify(before)!==JSON.stringify(after)||formula.length!==specs.length||effective.length!==specs.length)throw Error('PUBLICATION_SNAPSHOT_CHANGED');
 const valid=(data:unknown[][][],i:number)=>Array.isArray(data[i])&&data[i]!.length<=(specs[i]!.endRow??specs[i]!.rows)-(specs[i]!.startRow??1)+1&&data[i]!.every(r=>Array.isArray(r)&&r.length<=(specs[i]!.endColumn??specs[i]!.columns)-(specs[i]!.startColumn??1)+1&&r.every(v=>v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)));
 if(specs.some((_,i)=>!valid(formula,i)||!valid(effective,i)))throw Error('PUBLICATION_SNAPSHOT_SHAPE');
 return{specs:specs.map(s=>({...s})),metadata:before.map(s=>({...s})),formula,effective};
}

/** Resolve an exact bounded rectangle from one captured phase. If more than
 * one captured region covers it, every overlap must agree. Never share a
 * snapshot across the pre-dispatch/post-dispatch boundary. */
export function publicationSnapshotRange(snapshot:PublicationBatchSnapshot,sheetId:number,startRow:number,endRow:number,startColumn:number,endColumn:number,mode:'FORMULA'|'EFFECTIVE'):unknown[][]{
 if(!snapshot||!Number.isSafeInteger(sheetId)||![startRow,endRow,startColumn,endColumn].every(Number.isSafeInteger)||startRow<1||startColumn<1||endRow<startRow||endColumn<startColumn||!['FORMULA','EFFECTIVE'].includes(mode))throw Error('PUBLICATION_SNAPSHOT_RANGE');
 const found=snapshot.specs.flatMap((s,i)=>s.sheetId===sheetId&&(s.startRow??1)<=startRow&&(s.endRow??s.rows)>=endRow&&(s.startColumn??1)<=startColumn&&(s.endColumn??s.columns)>=endColumn?[i]:[]);
 if(!found.length)throw Error('PUBLICATION_SNAPSHOT_RANGE_MISSING');
 const data=mode==='FORMULA'?snapshot.formula:snapshot.effective;
 const select=(i:number)=>{const s=snapshot.specs[i]!,rows=data[i]!;return Array.from({length:endRow-startRow+1},(_,r)=>Array.from({length:endColumn-startColumn+1},(_,c)=>rows[startRow-(s.startRow??1)+r]?.[startColumn-(s.startColumn??1)+c]??null));};
 const result=select(found[0]!);for(const i of found.slice(1))if(JSON.stringify(select(i))!==JSON.stringify(result))throw Error('PUBLICATION_SNAPSHOT_OVERLAP');return result;
}
