import type {Env} from '../types';
import {getDetailProductionInventory} from './client';
import {readDetailSourceProof,type DetailSourceProof} from './detail-source-proof';
import {parseLedgerUatCell} from './ledger-google-probe';
import {RAW_PROJECTION_HEADERS} from './raw-projection';
import {sheetScopesDistinct} from './sheet-scope-isolation';

type Obj=Record<string,unknown>;
const obj=(v:unknown):Obj=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('DETAIL_GRID_INVALID');return v as Obj;};
const arr=(v:unknown):unknown[]=>{if(!Array.isArray(v))throw Error('DETAIL_GRID_INVALID');return v;};
const int=(v:unknown):number=>{if(!Number.isSafeInteger(v)||Number(v)<0)throw Error('DETAIL_GRID_INVALID');return Number(v);};
const fields=[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,18,19] as const;
const equal=(a:unknown,b:unknown)=>a===''?(b===''||b===null):a===b;
interface ItemEvidence{itemId:string;metadataId:number;owned:unknown[]}

/** Internal parser for a bounded full DETAIL grid. This is a comparison of
 * one response, never proof of exclusion, a write lease, or Google CAS. */
export function parseDetailInventory(input:unknown,sheetName:string,source:DetailSourceProof):{sheetId:number;items:ItemEvidence[]}{
  const sheets=arr(obj(input).sheets).map(obj).filter(s=>obj(s.properties).title===sheetName);if(sheets.length!==1)throw Error('DETAIL_GRID_INVALID');
  const sheet=sheets[0]!,props=obj(sheet.properties),grid=obj(props.gridProperties),sheetId=int(props.sheetId),rows=int(grid.rowCount),columns=int(grid.columnCount);
  if(rows<1||rows>2500||columns<20||rows*20>50000)throw Error('DETAIL_GRID_INVALID');
  for(const name of ['protectedRanges','merges'])if(sheet[name]!==undefined&&arr(sheet[name]).length)throw Error('DETAIL_GRID_UNSAFE');
  const blocks=arr(sheet.data);if(blocks.length!==1)throw Error('DETAIL_GRID_INVALID');const block=obj(blocks[0]);if(int(block.startRow??0)!==0||int(block.startColumn??0)!==0)throw Error('DETAIL_GRID_INVALID');
  const data=block.rowData===undefined?[]:arr(block.rowData),metadata=block.rowMetadata===undefined?[]:arr(block.rowMetadata);if(data.length>rows||metadata.length>rows)throw Error('DETAIL_GRID_INVALID');
  const cellsAt=(i:number)=>{const r=data[i]===undefined?{}:obj(data[i]);const a=r.values===undefined?[]:arr(r.values);if(a.length>20)throw Error('DETAIL_GRID_INVALID');return a;};
  const header=cellsAt(0);if(!RAW_PROJECTION_HEADERS.PURCHASE_DETAILS.every((v,i)=>{const c=parseLedgerUatCell(header[i]??{});return c.entered===v&&c.formula===null;}))throw Error('DETAIL_HEADER_INVALID');
  const expected=new Map(source.entries.map(e=>[e.itemId,e]));if(expected.size!==source.entries.length)throw Error('DETAIL_SOURCE_DUPLICATE');
  const seenIds=new Set<string>(),metadataIds=new Set<number>(),found=new Map<string,ItemEvidence>();
  for(let i=1;i<rows;i++){
    const cells=cellsAt(i),a=parseLedgerUatCell(cells[0]??{}),b=parseLedgerUatCell(cells[1]??{});
    if(a.formula!==null||b.formula!==null)throw Error('DETAIL_ID_FORMULA');
    const id=a.entered,parent=b.entered;
    if(id!==null&&id!==''&&(typeof id!=='string'||seenIds.has(id)))throw Error('DETAIL_ID_DUPLICATE');
    if(typeof id==='string'&&id!=='')seenIds.add(id);
    if((id===null||id==='')&&(parent!==null&&parent!==''))throw Error('DETAIL_ID_MISSING');
    const md=metadata[i]===undefined?[]:(obj(metadata[i]).developerMetadata===undefined?[]:arr(obj(metadata[i]).developerMetadata));
    for(const m0 of md){const m=obj(m0),mid=int(m.metadataId);if(mid<1||mid>2147483647||metadataIds.has(mid))throw Error('DETAIL_METADATA_DUPLICATE');metadataIds.add(mid);}
    if(parent!==source.expenseId&&!expected.has(String(id??'')))continue;
    if(parent!==source.expenseId||typeof id!=='string'||!expected.has(id)||md.length!==1)throw Error('DETAIL_INVENTORY_CONFLICT');
    const m=obj(md[0]),r=obj(obj(m.location).dimensionRange),mid=int(m.metadataId);
    if(m.metadataKey!=='D'||m.visibility!=='DOCUMENT'||int(r.sheetId)!==sheetId||r.dimension!=='ROWS'||int(r.startIndex)!==i||int(r.endIndex)!==i+1)throw Error('DETAIL_METADATA_INVALID');
    const wanted=expected.get(id)!,observed=fields.map(index=>{const c=parseLedgerUatCell(cells[index]??{});if(c.formula!==null||c.note!==null||c.hasValidation||!equal(wanted.values[index],c.entered))throw Error('DETAIL_OWNED_FIELD_CONFLICT');return c.entered;});
    found.set(id,{itemId:id,metadataId:mid,owned:observed});
  }
  if(found.size!==expected.size)throw Error('DETAIL_INVENTORY_MISSING');
  return{sheetId,items:[...found.values()].sort((a,b)=>a.itemId<b.itemId?-1:a.itemId>b.itemId?1:0)};
}
/** Trusted-provider readback, default off. Never exposes row numbers and never
 * permits writes; empty source must still match the complete provider inventory.
 * Two reads cannot prevent a concurrent change or an ABA on Google Sheets. */
export async function readDetailProviderInventory(env:Env,expenseId:string,version:number,revision:number):Promise<{sourceFingerprint:string;providerDigest:string;itemCount:number}>{
  try{
    if(!sheetScopesDistinct(env)||!env.SHEET_PURCHASE_DETAILS||!env.GOOGLE_SPREADSHEET_ID||!env.GOOGLE_SERVICE_ACCOUNT_EMAIL||!env.GOOGLE_PRIVATE_KEY_BASE64||!env.DB||env.RUNTIME_MODE!=='production'||env.DETAIL_IDENTITY_READER_ENABLED!=='true'||env.EXPENSE_STABLE_PROJECTION_ENABLED!=='true')throw Error('disabled');
    const keys=['DB','RUNTIME_MODE','DETAIL_IDENTITY_READER_ENABLED','EXPENSE_STABLE_PROJECTION_ENABLED','GOOGLE_SPREADSHEET_ID','GOOGLE_SERVICE_ACCOUNT_EMAIL','GOOGLE_PRIVATE_KEY_BASE64','SHEET_PURCHASE_DETAILS','SHEET_EXPENSE_RAW','SHEET_EXPENSE_DAILY','SHEET_PERSONAL_USE_RAW'] as const;
    const bound=Object.freeze({...env}) as Env,stable=()=>{if(keys.some(k=>env[k]!==bound[k])||!sheetScopesDistinct(env))throw Error('changed');};
    const source=await readDetailSourceProof(bound,expenseId,version,revision);stable();
    const a=parseDetailInventory(await getDetailProductionInventory(bound),bound.SHEET_PURCHASE_DETAILS!,source);stable();
    const b=parseDetailInventory(await getDetailProductionInventory(bound),bound.SHEET_PURCHASE_DETAILS!,source);stable();
    const again=await readDetailSourceProof(bound,expenseId,version,revision);stable();
    if(JSON.stringify(a)!==JSON.stringify(b)||source.fingerprint!==again.fingerprint)throw Error('changed');
    const payload=new TextEncoder().encode(JSON.stringify([bound.GOOGLE_SPREADSHEET_ID,bound.SHEET_PURCHASE_DETAILS,bound.GOOGLE_SERVICE_ACCOUNT_EMAIL,source.fingerprint,a]));if(payload.length>1048576)throw Error('large');
    const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',payload));stable();return{sourceFingerprint:source.fingerprint,providerDigest:Array.from(hash,x=>x.toString(16).padStart(2,'0')).join(''),itemCount:a.items.length};
  }catch{throw Error('DETAIL_PROVIDER_INVENTORY_UNAVAILABLE');}
}
