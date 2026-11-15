import type {Env} from '../types';
import {decodeLedgerCarrier,encodeLedgerCarrier,type CarrierLedger} from './atomic-expense-ledger-template';
type Snapshot={formula:unknown[][];effective:unknown[][]};
type P={entity_id:string;source_version:number;source_digest:string;state:string;operation_token:string;preimage_digest:string|null;marker_count:number};
type C={entity_id:string;cancellation_version:number;previous_version:number;preimage_digest:string;state:string;operation_token:string};
type W={entity_id:string;operation_kind:'CONFIRM'|'CANCEL';source_version:number;operation_token:string;marker:string};
type Pending={entityId:string;version:number;claim:string;payload:string;kind:'CONFIRMED'|'CANCELLED'};
const blank=(v:unknown)=>v===undefined||v===null||v==='';
async function digest(row:unknown[]):Promise<string>{if(row.length>26||row.some(v=>v!==undefined&&v!==null&&typeof v!=='string'&&typeof v!=='boolean'&&!(typeof v==='number'&&Number.isFinite(v))))throw Error('LEDGER_AUTH_PREIMAGE');const b=new TextEncoder().encode(JSON.stringify(Array.from({length:26},(_,i)=>blank(row[i])?null:row[i])));return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),v=>v.toString(16).padStart(2,'0')).join('');}

/** Authenticate EVERY populated helper carrier, not only the current target.
 * Called after formula/effective checks, under the workbook claim. The one
 * pending carrier must equal the caller's exact reserved payload. */
export async function authenticateCarrierLedgerSnapshot(env:Env,snapshot:Snapshot,rowCount:number,projection:CarrierLedger,sheet:string,sheetId:number,pending?:Pending):Promise<void>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;if(!book||!sheet||!Number.isSafeInteger(sheetId)||sheetId<0||!Number.isSafeInteger(rowCount)||rowCount<2||rowCount>5000)throw Error('LEDGER_AUTH_INPUT');
 const [pr,cr,wr]=await db.batch([
  db.prepare(`SELECT p.entity_id,p.source_version,p.source_digest,p.state,p.operation_token,i.preimage_digest,(SELECT count(*) FROM atomic_daily_marker_reservations m WHERE m.spreadsheet_id=p.spreadsheet_id AND m.sheet_id=p.sheet_id AND m.entity_id=p.entity_id AND m.source_version=p.source_version AND m.operation_token=p.operation_token) marker_count FROM stable_projection_writes p LEFT JOIN stable_expense_projection_preimages i ON i.spreadsheet_id=p.spreadsheet_id AND i.entity_type=p.entity_type AND i.entity_id=p.entity_id AND i.projection=p.projection AND i.sheet_id=p.sheet_id AND i.sheet_name=p.sheet_name AND i.source_version=p.source_version AND i.source_digest=p.source_digest AND i.preimage_width=26 WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND p.projection=? AND p.sheet_id=? AND p.sheet_name=?`).bind(book,projection,sheetId,sheet),
  db.prepare(`SELECT c.entity_id,c.cancellation_version,c.previous_version,c.preimage_digest,c.state,c.operation_token FROM stable_expense_cancellation_writes c JOIN stable_projection_writes p ON p.spreadsheet_id=c.spreadsheet_id AND p.entity_type=c.entity_type AND p.entity_id=c.entity_id AND p.projection=c.projection WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND p.projection=? AND p.sheet_id=? AND p.sheet_name=?`).bind(book,projection,sheetId,sheet),
  db.prepare(`SELECT entity_id,operation_kind,source_version,operation_token,marker FROM continuous_ledger_write_evidence WHERE spreadsheet_id=? AND projection=? AND sheet_id=? AND sheet_name=?`).bind(book,projection,sheetId,sheet)
 ]);
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||pr?.success!==true||cr?.success!==true||wr?.success!==true||!Array.isArray(pr.results)||!Array.isArray(cr.results)||!Array.isArray(wr.results)||pr.results.length>rowCount||cr.results.length>rowCount||wr.results.length>rowCount*2)throw Error('LEDGER_AUTH_READ');
 const projections=pr.results as P[],cancels=cr.results as C[],proofs=wr.results as W[],seen=new Set<string>();
 for(let i=1;i<rowCount;i++){
  const f=snapshot.formula[i]??[],value=f[25],row=decodeLedgerCarrier(value);if(!row)continue;
  if(row.projection!==projection)throw Error('LEDGER_AUTH_ROW');const entity=projection==='DETAIL'?`${row.expenseId}|${row.itemId}`:row.expenseId;
  if(seen.has(entity))throw Error('LEDGER_AUTH_DUPLICATE');seen.add(entity);
  const ps=projections.filter(p=>p.entity_id===entity),cs=cancels.filter(c=>c.entity_id===entity);if(ps.length!==1||cs.length>1)throw Error('LEDGER_AUTH_JOURNAL');
  const p=ps[0]!,c=cs[0],isPending=!!pending&&pending.entityId===entity&&pending.payload===value&&pending.kind===row.status;
  if(p.marker_count!==1||p.source_version!==row.confirmedVersion||!/^[A-Za-z0-9_-]{1,128}$/.test(p.operation_token))throw Error('LEDGER_AUTH_MARKER');
  if(row.writeMarker&&!proofs.some(w=>w.entity_id===entity&&w.operation_kind==='CONFIRM'&&w.source_version===p.source_version&&w.operation_token===p.operation_token&&w.marker===row.writeMarker))throw Error('LEDGER_AUTH_MARKER');
  if(row.cancelMarker&&(!c||!proofs.some(w=>w.entity_id===entity&&w.operation_kind==='CANCEL'&&w.source_version===c.cancellation_version&&w.operation_token===c.operation_token&&w.marker===row.cancelMarker)))throw Error('LEDGER_AUTH_MARKER');
  if(row.status==='CONFIRMED'&&p.state==='IN_FLIGHT'){
   if(!isPending||pending!.claim!==p.operation_token||pending!.version!==p.source_version||c)throw Error('LEDGER_AUTH_IN_FLIGHT');continue;
  }
  if(p.state!=='VERIFIED'||typeof p.preimage_digest!=='string'||!/^[0-9a-f]{64}$/.test(p.preimage_digest))throw Error('LEDGER_AUTH_PREIMAGE');
  const original=f.slice();if(projection==='EXPENSE_RAW')original[17]=null;
  if(row.status==='CANCELLED'){
   const confirmed={...row,status:'CONFIRMED' as const,cancelVersion:null,cancelledAt:''};delete confirmed.cancelMarker;original[25]=encodeLedgerCarrier(confirmed);
   if(!c||c.previous_version!==p.source_version||c.cancellation_version!==row.cancelVersion||c.preimage_digest!==p.preimage_digest||c.state!=='VERIFIED'&&!(isPending&&pending!.claim===c.operation_token&&pending!.version===c.cancellation_version&&c.state==='IN_FLIGHT'))throw Error('LEDGER_AUTH_CANCEL');
  }else if(c)throw Error('LEDGER_AUTH_CANCEL');
  if(await digest(original)!==p.preimage_digest)throw Error('LEDGER_AUTH_PREIMAGE');
 }
 if(projections.some(p=>!seen.has(p.entity_id))||cancels.some(c=>!seen.has(c.entity_id)))throw Error('LEDGER_AUTH_MISSING');
}
