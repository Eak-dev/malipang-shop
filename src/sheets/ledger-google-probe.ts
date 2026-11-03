import type {Env} from '../types';
import {getLedgerUatSnapshotPart,getRawIdentityProductionMetadata,getRawIdentityProductionGrid} from './client';
import {verifyLedgerMetadataWitness,type LedgerCellState,type LedgerMetadataWitness,type LedgerWriteIdentity} from './ledger-metadata-writer';
import type {LedgerProjectionProbe} from './ledger-stable-projector';
import {RAW_PROJECTION_HEADERS} from './raw-projection';

// UAT-only reader: the resulting snapshot is evidence at a point in time,
// not a lock or a Sheets compare-and-swap. Never wire to production as-is.
type Obj=Record<string,unknown>;
const obj=(x:unknown):Obj=>{if(!x||typeof x!=='object'||Array.isArray(x))throw Error('LEDGER_UAT_RESPONSE_INVALID');return x as Obj;};
const array=(x:unknown):unknown[]=>{if(!Array.isArray(x))throw Error('LEDGER_UAT_RESPONSE_INVALID');return x;};
const integer=(x:unknown):number=>{if(!Number.isSafeInteger(x)||Number(x)<0)throw Error('LEDGER_UAT_RESPONSE_INVALID');return Number(x);};
const limits={EXPENSE:17,PERSONAL_USE:15,PURCHASE_DETAILS:20} as const;
const owned={EXPENSE:[1,2,3,4,5,6,7],PERSONAL_USE:[1,2,3,4,5,6,13,14],PURCHASE_DETAILS:[]} as const;

function witnessOf(data:unknown):LedgerMetadataWitness{
  const m=obj(data),r=obj(obj(m.location).dimensionRange);
  return {metadataId:integer(m.metadataId),metadataKey:String(m.metadataKey??''),sheetId:integer(r.sheetId),dimension:r.dimension as 'ROWS',startIndex:integer(r.startIndex),endIndex:integer(r.endIndex),visibility:m.visibility as 'DOCUMENT'};
}
export function parseLedgerUatCell(data:unknown):LedgerCellState{
  const c=obj(data),v=c.userEnteredValue===undefined?{}:obj(c.userEnteredValue),keys=Object.keys(v);
  if(keys.length>1||keys.some(k=>!['stringValue','numberValue','boolValue','formulaValue'].includes(k)))throw Error('LEDGER_UAT_CELL_INVALID');
  let entered:string|number|boolean|null=null,formula:string|null=null;
  if(keys.length){const k=keys[0]!,x=v[k];
    if(k==='formulaValue'){if(typeof x!=='string')throw Error('LEDGER_UAT_CELL_INVALID');formula=x;}
    else if(k==='stringValue'&&typeof x==='string'||k==='boolValue'&&typeof x==='boolean'||k==='numberValue'&&typeof x==='number'&&Number.isFinite(x))entered=x as string|number|boolean;
    else throw Error('LEDGER_UAT_CELL_INVALID');
  }
  if(c.note!==undefined&&typeof c.note!=='string')throw Error('LEDGER_UAT_CELL_INVALID');
  if(c.dataValidation!==undefined)obj(c.dataValidation);
  return {entered,formula,note:c.note===undefined?null:c.note as string,hasValidation:c.dataValidation!==undefined};
}
const blank=():LedgerCellState=>({entered:null,formula:null,note:null,hasValidation:false});

/** Parse one bounded whole-grid response. Conservatively hold all protected or
 * merged sheets, including warning-only protection and unrelated ranges. */
export function parseLedgerGoogleSnapshot(data:unknown,sheetName:string,identity:LedgerWriteIdentity,witness:LedgerMetadataWitness){
  if(identity.kind==='PURCHASE_DETAILS')throw Error('LEDGER_DETAIL_COORDINATION_UNAVAILABLE');
  const root=obj(data),sheets=array(root.sheets),matches=sheets.map(obj).filter(s=>obj(s.properties).title===sheetName);
  if(matches.length!==1)throw Error('LEDGER_UAT_SHEET_INVALID');
  const sheet=matches[0]!,props=obj(sheet.properties),grid=obj(props.gridProperties),count=integer(grid.rowCount),width=integer(grid.columnCount),size=limits[identity.kind];
  if(integer(props.sheetId)!==identity.sheetId||count<1||count>10000||width<size||witness.startIndex>=count)throw Error('LEDGER_UAT_GRID_INVALID');
  for(const property of ['protectedRanges','merges'])if(sheet[property]!==undefined&&array(sheet[property]).length)throw Error('LEDGER_UAT_SHEET_UNSAFE');
  const blocks=array(sheet.data);if(blocks.length!==1)throw Error('LEDGER_UAT_GRID_INVALID');
  const block=obj(blocks[0]);if(integer(block.startRow??0)!==0||integer(block.startColumn??0)!==0)throw Error('LEDGER_UAT_GRID_INVALID');
  const rows=block.rowData===undefined?[]:array(block.rowData);if(rows.length>count)throw Error('LEDGER_UAT_GRID_INVALID');
  const headerCells=rows[0]===undefined?[]:objectHeaderCells(rows[0]);
  if(!RAW_PROJECTION_HEADERS[identity.kind].every((name,i)=>{const cell=parseLedgerUatCell(headerCells[i]??{});return cell.entered===name&&cell.formula===null;}))throw Error('LEDGER_UAT_HEADER_INVALID');
  const identityRows:unknown[][]=Array.from({length:count},()=>[]);let observed:LedgerCellState[]|undefined;
  for(let r=0;r<rows.length;r++){
    const row=obj(rows[r]),cells=row.values===undefined?[]:array(row.values);if(cells.length>size)throw Error('LEDGER_UAT_GRID_INVALID');
    const id=parseLedgerUatCell(cells[0]??{});if(id.formula!==null)throw Error('LEDGER_UAT_ID_FORMULA');identityRows[r]=[id.entered];
    if(r===witness.startIndex)observed=Array.from({length:size},(_,i)=>parseLedgerUatCell(cells[i]??{}));
  }
  identityRows[0]=[...RAW_PROJECTION_HEADERS[identity.kind]];
  if(!observed)observed=Array.from({length:size},blank);
  verifyLedgerMetadataWitness(identity,witness,identityRows);
  // Expected and observed share the just-read snapshot. The durable hash
  // baseline is independently checked by the projector before dispatch.
  return {witness,identityRows,guard:{fields:[...owned[identity.kind]],expected:observed,observed}};
}
function objectHeaderCells(row:unknown):unknown[]{const r=obj(row);return r.values===undefined?[]:array(r.values);}

function createLedgerGoogleProbe(env:Env,sheetName:string,identity:LedgerWriteIdentity,metadataId:number,reader:{metadata:()=>Promise<unknown>;grid:()=>Promise<unknown>}):LedgerProjectionProbe{
  if(!sheetName||identity.kind==='PURCHASE_DETAILS'||!Number.isSafeInteger(metadataId)||metadataId<1||metadataId>2147483647)throw Error('LEDGER_UAT_PROBE_INVALID');
  return {async read(){
    const before=witnessOf(await reader.metadata()),snapshot=await reader.grid(),after=witnessOf(await reader.metadata());
    if(JSON.stringify(before)!==JSON.stringify(after))throw Error('LEDGER_UAT_METADATA_MOVED');
    return parseLedgerGoogleSnapshot(snapshot,sheetName,identity,after);
  }};
}
export function createLedgerGoogleUatProbe(env:Env,sheetName:string,identity:LedgerWriteIdentity,metadataId:number):LedgerProjectionProbe{
  const col=String.fromCharCode(64+limits[identity.kind]),range=`'${sheetName.replace(/'/g,"''")}'!A1:${col}10000`;
  const query=new URLSearchParams({ranges:range,fields:'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),protectedRanges,merges,data(startRow,startColumn,rowData(values(userEnteredValue,note,dataValidation))))'});
  return createLedgerGoogleProbe(env,sheetName,identity,metadataId,{metadata:()=>getLedgerUatSnapshotPart(env,`/developerMetadata/${metadataId}`),grid:()=>getLedgerUatSnapshotPart(env,`?${query.toString()}`)});
}
/** Candidate production read-only adapter; disabled unless all explicit flags
 * are set. No route is connected and PERSONAL_USE is not yet supported. */
export function createExpenseRawProductionProbe(env:Env,sheetName:string,identity:LedgerWriteIdentity,metadataId:number):LedgerProjectionProbe{
  if(identity.kind!=='EXPENSE'||!sheetName||sheetName!==env.SHEET_EXPENSE_RAW)throw Error('RAW_PRODUCTION_PROBE_INVALID');
  return createLedgerGoogleProbe(env,sheetName,identity,metadataId,{metadata:()=>getRawIdentityProductionMetadata(env,metadataId),grid:()=>getRawIdentityProductionGrid(env)});
}
