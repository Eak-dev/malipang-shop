import type {Env} from '../types';

/** Construct an insert for the same D1 transaction that moves the already
 * read-back projection to VERIFIED. Never creates an image for a legacy row. */
export async function stableExpensePreimageStatement(env:Env,input:{book:string;entity:string;projection:'DAILY'|'EXPENSE_RAW'|'DETAIL';sheetId:number;sheetName:string;version:number;sourceDigest:string;row:unknown[];width:number}):Promise<D1PreparedStatement|null>{
 const flag=env.STABLE_CANCELLATION_PREIMAGE_ENABLED;
 if(flag===undefined||flag==='false')return null;
 if(flag!=='true'||env.GOOGLE_SPREADSHEET_ID!==input.book||!input.book||!input.entity||!input.sheetName||!Number.isSafeInteger(input.sheetId)||input.sheetId<0||!Number.isSafeInteger(input.version)||input.version<1||!/^\w+$/.test(input.projection)||!Number.isSafeInteger(input.width)||input.width<1||input.width>100||!Array.isArray(input.row)||input.row.length>input.width||input.row.some(v=>v!==null&&v!==undefined&&typeof v!=='string'&&typeof v!=='boolean'&&!(typeof v==='number'&&Number.isFinite(v))))throw Error('STABLE_PREIMAGE_INVALID');
 const cells=Array.from({length:input.width},(_,i)=>input.row[i]===undefined||input.row[i]===''?null:input.row[i]);
 const json=JSON.stringify(cells);if(new TextEncoder().encode(json).length>32000)throw Error('STABLE_PREIMAGE_INVALID');
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(json))),v=>v.toString(16).padStart(2,'0')).join('');
 if(env.STABLE_CANCELLATION_PREIMAGE_ENABLED!==flag||env.GOOGLE_SPREADSHEET_ID!==input.book)throw Error('STABLE_PREIMAGE_SCOPE_CHANGED');
 // changes() is scoped to the immediately preceding VERIFIED transition in
 // the same D1 batch; a failed/stale lease must never capture a preimage.
 return env.DB.prepare(`INSERT INTO stable_expense_projection_preimages(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,preimage_width,preimage_digest,created_at) SELECT ?,'EXPENSE',?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE changes()=1`)
  .bind(input.book,input.entity,input.projection,input.sheetId,input.sheetName,input.version,input.sourceDigest,input.width,digest);
}
