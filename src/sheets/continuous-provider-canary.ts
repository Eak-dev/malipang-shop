import type {Env} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,batchUpdateSpreadsheetWithReply,continuousSheetsReadPolicy,getSpreadsheetSheetProperties} from './client';
import {ReviewRequestBudget} from './review-request-budget';

type Canary={canary_id:string;spreadsheet_id:string;sheet_id:number;title:string;nonce:string;credential_fingerprint:string;worker_version:string;state:'PREPARED'|'CREATE_IN_FLIGHT'|'CREATED'|'INSERT_IN_FLIGHT'|'VERIFIED'};
export type ProviderCanaryOutcome='DISABLED'|'HELD'|'IN_PROGRESS'|'VERIFIED';
const integrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_provider_canary' AND name IN ('continuous_provider_canary_insert','continuous_provider_canary_transition','continuous_provider_canary_no_delete','continuous_provider_canary_no_replace'))=4 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_provider_canary_activation' AND name IN ('continuous_provider_canary_activation_no_update','continuous_provider_canary_activation_no_delete','continuous_provider_canary_activation_no_replace'))=3 AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='continuous_provider_canary_one_open') AND EXISTS(SELECT 1 FROM continuous_provider_canary_activation WHERE singleton=1) AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_provider_canary_receipts' AND name IN ('continuous_provider_canary_receipt_insert','continuous_provider_canary_receipt_no_update','continuous_provider_canary_receipt_no_delete','continuous_provider_canary_receipt_no_replace'))=4";
const scope=(e:Env)=>JSON.stringify([e.GOOGLE_SPREADSHEET_ID,e.GOOGLE_SERVICE_ACCOUNT_EMAIL,e.GOOGLE_PRIVATE_KEY_BASE64,e.CONTINUOUS_PROVIDER_CANARY_ENABLED,e.CF_VERSION_METADATA?.id,e.APP_ENV,e.RUNTIME_MODE]);
const blank=(v:unknown)=>v===undefined||v===null||v==='';
const quote=(s:string)=>`'${s.replace(/'/g,"''")}'`;
const versionPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function credentialFingerprint(e:Env):Promise<string|null>{
 const book=e.GOOGLE_SPREADSHEET_ID,email=e.GOOGLE_SERVICE_ACCOUNT_EMAIL,key=e.GOOGLE_PRIVATE_KEY_BASE64,version=e.CF_VERSION_METADATA?.id;
 if(!book||!email||!key||typeof version!=='string'||!versionPattern.test(version))return null;
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(['provider-canary-v1',book,email,key,version])));
 return Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');
}

const valid=(x:Canary)=>/^[0-9a-f-]{36}$/.test(x.canary_id)&&Number.isSafeInteger(x.sheet_id)&&x.sheet_id>0&&x.sheet_id<=2147483647&&/^[0-9a-f]{32}$/.test(x.nonce)&&x.title===`__sync_canary_${x.nonce}`;

/** Candidate is inert without the explicit environment flag and D1 activation.
 * No provider write happens here. Never exposes credentials or sheet contents. */
export async function prepareProviderCanary(env:Env,budget:ReviewRequestBudget):Promise<string|null>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,initial=scope(env);if(env.CONTINUOUS_PROVIDER_CANARY_ENABLED!=='true'||!book||!(budget instanceof ReviewRequestBudget))return null;
 const stable=()=>env.DB===db&&scope(env)===initial,policy={...continuousSheetsReadPolicy,budget},fingerprint=await credentialFingerprint(env),workerVersion=env.CF_VERSION_METADATA?.id;if(!fingerprint||typeof workerVersion!=='string'||!stable())return null;const sheets=await getSpreadsheetSheetProperties(env,policy);if(!stable())return null;
 const nonce=crypto.randomUUID().replaceAll('-','').toLowerCase(),id=crypto.randomUUID(),title=`__sync_canary_${nonce}`,random=new Uint32Array(1);crypto.getRandomValues(random);const sheetId=1+(random[0]!%2147483646);
 if(sheets.some(s=>s.sheetId===sheetId||s.title.toLowerCase()===title.toLowerCase()))return null;
 const r=await db.prepare(`INSERT INTO continuous_provider_canary(canary_id,spreadsheet_id,sheet_id,title,nonce,credential_fingerprint,worker_version,state,created_at,updated_at) SELECT ?,?,?,?,?,?,?,'PREPARED',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${integrity} ON CONFLICT DO NOTHING`).bind(id,book,sheetId,title,nonce,fingerprint,workerVersion).run();
 return stable()&&r.success===true&&r.meta?.changes===1?id:null;
}

/** Only positive exact readback advances a stage. A timeout or old/absent
 * preimage is never retried as a write. The scratch tab does not prove
 * permissions on any protected target or exclude concurrent editors. A
 * missing positive provider reply is never counted as a permission proof. */
export async function stepProviderCanary(env:Env,id:string,budget:ReviewRequestBudget):Promise<ProviderCanaryOutcome>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,initial=scope(env);if(env.CONTINUOUS_PROVIDER_CANARY_ENABLED!=='true')return 'DISABLED';if(!book||!(budget instanceof ReviewRequestBudget)||!/^[0-9a-f-]{36}$/.test(id))return 'HELD';
 const stable=()=>env.DB===db&&scope(env)===initial,policy={...continuousSheetsReadPolicy,budget};
 const row=await db.prepare(`SELECT * FROM continuous_provider_canary WHERE canary_id=? AND spreadsheet_id=? AND ${integrity}`).bind(id,book).first<Canary>();if(!row||!valid(row)||row.worker_version!==env.CF_VERSION_METADATA?.id||row.credential_fingerprint!==await credentialFingerprint(env)||!stable())return 'HELD';if(row.state==='VERIFIED')return 'VERIFIED';
 const props=async()=>await getSpreadsheetSheetProperties(env,policy);
 const absent=async()=>{const p=await props();return stable()&&!p.some(x=>x.sheetId===row.sheet_id||x.title.toLowerCase()===row.title.toLowerCase());};
 const matches=async(shifted:boolean)=>{
  const p=await props(),hits=p.filter(x=>x.sheetId===row.sheet_id||x.title.toLowerCase()===row.title.toLowerCase());if(!stable()||hits.length!==1||hits[0]!.sheetId!==row.sheet_id||hits[0]!.title!==row.title||hits[0]!.rowCount!==6||hits[0]!.columnCount!==3)return false;
  const range=`${quote(row.title)}!A1:C6`,f=await batchGetSheetFormulaValues(env,[range],policy),e=await batchGetSheetEffectiveSerialValues(env,[range],policy);if(!stable()||f.length!==1||e.length!==1||f[0]!.length>6||e[0]!.length>6)return false;
  const move=shifted?2:1,head=`H_${row.nonce}`,value=`M_${row.nonce}`;
  for(let r=0;r<6;r++)for(let c=0;c<3;c++){
   const fv=f[0]![r]?.[c],ev=e[0]![r]?.[c];
   if(r===0&&c===0){if(fv!==head||ev!==head)return false;}
   else if(r===move&&c===0){if(fv!==value||ev!==value)return false;}
   else if(r===move&&c===1){if(fv!=='=1+2'||ev!==3)return false;}
   else if(!blank(fv)||!blank(ev))return false;
  }
  const after=await props();return stable()&&JSON.stringify(p)===JSON.stringify(after);
 };
 const advance=async(from:Canary['state'],to:Canary['state'])=>{const phase=from==='CREATE_IN_FLIGHT'?'CREATE':from==='INSERT_IN_FLIGHT'?'INSERT':null;const guard=phase?" AND EXISTS(SELECT 1 FROM continuous_provider_canary_receipts WHERE canary_id=? AND phase=?)":'';const r=await db.prepare(`UPDATE continuous_provider_canary SET state=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE canary_id=? AND spreadsheet_id=? AND state=? AND ${integrity}${guard}`).bind(to,id,book,from,...phase?[id,phase]:[]).run();return stable()&&r.success===true&&r.meta?.changes===1;};
 if(row.state==='CREATE_IN_FLIGHT')return await matches(false)&&await advance('CREATE_IN_FLIGHT','CREATED')?'IN_PROGRESS':'HELD';
 if(row.state==='INSERT_IN_FLIGHT')return await matches(true)&&await advance('INSERT_IN_FLIGHT','VERIFIED')?'VERIFIED':'HELD';
 let next:Canary['state'],requests:unknown[],before:()=>Promise<boolean>;
 if(row.state==='PREPARED'){
  next='CREATE_IN_FLIGHT';before=absent;const text=(v:string)=>({userEnteredValue:{stringValue:v}});
  requests=[{addSheet:{properties:{sheetId:row.sheet_id,title:row.title,gridProperties:{rowCount:6,columnCount:3}}}},{updateCells:{start:{sheetId:row.sheet_id,rowIndex:0,columnIndex:0},rows:[{values:[text(`H_${row.nonce}`)]},{values:[text(`M_${row.nonce}`),{userEnteredValue:{formulaValue:'=1+2'}}]}],fields:'userEnteredValue'}}];
 }else if(row.state==='CREATED'){
  next='INSERT_IN_FLIGHT';before=()=>matches(false);requests=[{insertRange:{range:{sheetId:row.sheet_id,startRowIndex:1,endRowIndex:2,startColumnIndex:0,endColumnIndex:2},shiftDimension:'ROWS'}}];
 }else return 'HELD';
 if(!await before()||!stable()||!budget.reserveMutation())return 'HELD';
 try{
  const reply=await batchUpdateSpreadsheetWithReply(env,requests,async()=>{if(!await before()||!stable()||!await advance(row.state,next))throw Error('PROVIDER_CANARY_PREIMAGE_CHANGED');},budget);
  const replies=reply&&typeof reply==='object'?(reply as {replies?:unknown}).replies:undefined;
  if(!Array.isArray(replies)||replies.length!==requests.length||replies.some(x=>!x||typeof x!=='object'))throw Error('PROVIDER_CANARY_REPLY_UNVERIFIED');
  if(row.state==='PREPARED'){const first=replies[0] as {addSheet?:{properties?:{sheetId?:unknown}}};if(first.addSheet?.properties?.sheetId!==row.sheet_id)throw Error('PROVIDER_CANARY_REPLY_UNVERIFIED');}
  if(!stable())return 'HELD';
  const phase=row.state==='PREPARED'?'CREATE':'INSERT',saved=await db.prepare(`INSERT INTO continuous_provider_canary_receipts(canary_id,phase,created_at) SELECT ?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${integrity} ON CONFLICT DO NOTHING`).bind(id,phase).run();
  if(!stable()||saved.success!==true||saved.meta?.changes!==1)throw Error('PROVIDER_CANARY_RECEIPT_UNCERTAIN');
 }finally{budget.releaseMutation();}
 return stable()?'IN_PROGRESS':'HELD';
}
