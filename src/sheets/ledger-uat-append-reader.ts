import type {Env} from '../types';
import {getLedgerUatSnapshotPart} from './client';
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
export async function readLedgerUatAppendSnapshot(env:Env,title:string,expectedSheetId:number):Promise<LedgerUatAppendSnapshot>{
  if(!title||!Number.isSafeInteger(expectedSheetId)||expectedSheetId<0)throw Error('LEDGER_APPEND_READ_INVALID');
  const initial=sheetFrom(await getLedgerUatSnapshotPart(env,'?fields=sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))'),title),size=bounds(initial);
  if(size.sheetId!==expectedSheetId)throw Error('LEDGER_APPEND_SHEET_INVALID');
  const range=`'${title.replace(/'/g,"''")}'!A1:${column(size.columns)}${size.rows}`;
  const query=new URLSearchParams({ranges:range,fields:'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),protectedRanges,merges,data(startRow,startColumn,rowData(values(userEnteredValue,note,dataValidation))))'});
  const sheet=sheetFrom(await getLedgerUatSnapshotPart(env,`?${query.toString()}`),title),current=bounds(sheet);
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
  return {sheetId:size.sheetId,rowCount:size.rows,columnCount:size.columns,rows,hasProtectedRanges:protectedRanges.length>0,hasMerges:merges.length>0};
}
