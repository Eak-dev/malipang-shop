import type {Env} from '../types';
import {getLedgerUatSnapshotPart,getRawProductionGridProperties,getRawProductionCompleteGrid,getPersonalProductionGridProperties,getPersonalProductionCompleteGrid} from './client';
import {parseLedgerUatCell} from './ledger-google-probe';
import type {LedgerUatAppendSnapshot} from './ledger-uat-append-planner';

type Obj=Record<string,unknown>;
const object=(v:unknown):Obj=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('LEDGER_APPEND_READ_INVALID');return v as Obj;};
const list=(v:unknown):unknown[]=>{if(!Array.isArray(v))throw Error('LEDGER_APPEND_READ_INVALID');return v;};
const integer=(v:unknown):number=>{if(!Number.isSafeInteger(v)||Number(v)<0)throw Error('LEDGER_APPEND_READ_INVALID');return Number(v);};
function sheetFrom(data:unknown,title:string):Obj{
  const matches=list(object(data).sheets).map(object).filter(s=>object(s.properties).title===title);
  if(matches.length!==1)throw Error('LEDGER_APPEND_SHEET_INVALID');return matches[0]!;
}
function bounds(sheet:Obj):{sheetId:number;rows:number;columns:number}{
  const props=object(sheet.properties),grid=object(props.gridProperties),sheetId=integer(props.sheetId),rows=integer(grid.rowCount),columns=integer(grid.columnCount);
  if(rows<1||rows>=10000||columns<1||columns>64||(rows+1)*columns>50000)throw Error('LEDGER_APPEND_GRID_LIMIT');return{sheetId,rows,columns};
}
function column(n:number):string{let result='';while(n>0){n--;result=String.fromCharCode(65+n%26)+result;n=Math.floor(n/26);}return result;}

/** Isolated UAT reader, not a lock. Grid/identity may change after this read;
 * no production caller or mutation is authorized by the returned snapshot. */
async function readLedgerAppendSnapshot(title:string,expectedSheetId:number,reader:{properties:()=>Promise<unknown>;grid:(rows:number,columns:number)=>Promise<unknown>},includeRowMetadata=false):Promise<LedgerUatAppendSnapshot>{
  if(!title||!Number.isSafeInteger(expectedSheetId)||expectedSheetId<0)throw Error('LEDGER_APPEND_READ_INVALID');
  const initial=sheetFrom(await reader.properties(),title),size=bounds(initial);
  if(size.sheetId!==expectedSheetId)throw Error('LEDGER_APPEND_SHEET_INVALID');
  const sheet=sheetFrom(await reader.grid(size.rows,size.columns),title),current=bounds(sheet);
  if(JSON.stringify(current)!==JSON.stringify(size))throw Error('LEDGER_APPEND_GRID_CHANGED');
  const protectedRanges=sheet.protectedRanges===undefined?[]:list(sheet.protectedRanges),merges=sheet.merges===undefined?[]:list(sheet.merges);
  const blocks=list(sheet.data);if(blocks.length!==1)throw Error('LEDGER_APPEND_READ_INVALID');
  const block=object(blocks[0]);if(integer(block.startRow??0)!==0||integer(block.startColumn??0)!==0)throw Error('LEDGER_APPEND_READ_INVALID');
  const rowData=block.rowData===undefined?[]:list(block.rowData);if(rowData.length>size.rows)throw Error('LEDGER_APPEND_READ_INVALID');
  const rows=Array.from({length:size.rows},(_,r)=>{
    const row=r<rowData.length?object(rowData[r]):{},cells=row.values===undefined?[]:list(row.values);
    if(cells.length>size.columns)throw Error('LEDGER_APPEND_READ_INVALID');
    return Array.from({length:size.columns},(_,c)=>parseLedgerUatCell(cells[c]??{}));
  });
  let rowHasMetadata:boolean[]|undefined,rowMetadataIds:number[][]|undefined;if(includeRowMetadata){const metadata=block.rowMetadata===undefined?[]:list(block.rowMetadata);if(metadata.length>size.rows)throw Error('LEDGER_APPEND_READ_INVALID');rowMetadataIds=Array.from({length:size.rows},(_,i)=>{const row=i<metadata.length?object(metadata[i]):{},items=row.developerMetadata===undefined?[]:list(row.developerMetadata);return items.map(item=>{const m=object(item),id=integer(m.metadataId),location=object(object(m.location).dimensionRange);if(id<1||id>2147483647||integer(location.sheetId)!==size.sheetId||location.dimension!=='ROWS'||integer(location.startIndex)!==i||integer(location.endIndex)!==i+1)throw Error('LEDGER_APPEND_METADATA_INVALID');return id;});});const ids=rowMetadataIds.flat();if(new Set(ids).size!==ids.length)throw Error('LEDGER_APPEND_METADATA_INVALID');rowHasMetadata=rowMetadataIds.map(items=>items.length>0);}
  return {sheetId:size.sheetId,rowCount:size.rows,columnCount:size.columns,rows,hasProtectedRanges:protectedRanges.length>0,hasMerges:merges.length>0,...(rowHasMetadata&&rowMetadataIds?{rowHasMetadata,rowMetadataIds}:{})};
}
export async function readLedgerUatAppendSnapshot(env:Env,title:string,expectedSheetId:number):Promise<LedgerUatAppendSnapshot>{
  return readLedgerAppendSnapshot(title,expectedSheetId,{properties:()=>getLedgerUatSnapshotPart(env,'?fields=sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))'),grid:(rows,columns)=>{
    const range=`'${title.replace(/'/g,"''")}'!A1:${column(columns)}${rows}`;
    const query=new URLSearchParams({ranges:range,fields:'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),protectedRanges,merges,data(startRow,startColumn,rowData(values(userEnteredValue,note,dataValidation))))'});
    return getLedgerUatSnapshotPart(env,`?${query.toString()}`);
  }});
}
/** Candidate production read only. This is not a sheet lock or authorization
 * to insert; the real route remains disconnected and default-off. */
export async function readExpenseRawProductionAppendSnapshot(env:Env,expectedSheetId:number):Promise<LedgerUatAppendSnapshot>{
  if(!env.SHEET_EXPENSE_RAW)throw Error('LEDGER_APPEND_SHEET_INVALID');
  return readLedgerAppendSnapshot(env.SHEET_EXPENSE_RAW,expectedSheetId,{properties:()=>getRawProductionGridProperties(env),grid:(rows,columns)=>getRawProductionCompleteGrid(env,rows,columns)});
}
/** Personal snapshot used by identity enrollment planning, not a lock. */
export async function readPersonalRawProductionSnapshot(env:Env,expectedSheetId:number):Promise<LedgerUatAppendSnapshot>{
  if(!env.SHEET_PERSONAL_USE_RAW)throw Error('LEDGER_APPEND_SHEET_INVALID');
  return readLedgerAppendSnapshot(env.SHEET_PERSONAL_USE_RAW,expectedSheetId,{properties:()=>getPersonalProductionGridProperties(env),grid:(rows,columns)=>getPersonalProductionCompleteGrid(env,rows,columns)},true);
}
