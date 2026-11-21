import type {Env} from '../types';
import {assertContinuousDailyActivated} from '../sheets/continuous-daily-route';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,getSpreadsheetSheetProperties,type ContinuousSheetsReadPolicy} from '../sheets/client';
import type {ReviewRequestBudget} from '../sheets/review-request-budget';
import {stableNoticeStyleFingerprint} from '../sheets/stable-edit-notice';
import {readContinuousReportHealth} from '../sheets/continuous-report-health';
import {decodeAtomicDailyPayload,ATOMIC_DAILY_PREFIX} from '../sheets/atomic-daily-template';
import {decodeLedgerCarrier,LEDGER_PREFIX} from '../sheets/atomic-expense-ledger-template';
import {readCanaryUnwrittenEvidence} from './canary-unwritten-evidence';
import {canaryUnwrittenScope} from './canary-unwritten-scope';

type EvidenceEnv=Env & {CONTINUOUS_CANARY_OPERATOR_ENABLED?:string};
type Grid={sheetId:number;rowCount:number;columnCount:number};
type Snapshot={grids:Grid[];formula:unknown[][][];effective:unknown[][][]};
const quote=(s:string)=>`'${s.replace(/'/g,"''")}'`;
const column=(n:number)=>{let out='';while(n>0){n--;out=String.fromCharCode(65+n%26)+out;n=Math.floor(n/26);}return out;};
const empty=(v:unknown)=>v===null||v===undefined||v==='';

/** Reject malformed carriers and every visible or hidden occurrence of the
 * exact synthetic identifiers. Absence is supporting evidence only: it can
 * never settle an earlier request or by itself authorize any provider write. */
export function canaryAbsentFromSnapshots(s:Snapshot,expenseId:string,itemId:string,documentId:string):boolean{
 if(!/^exp_canary_[a-f0-9]{32}$/.test(expenseId)||!/^item_canary_[a-f0-9]{32}$/.test(itemId)||!/^doc_canary_[a-f0-9]{32}$/.test(documentId)||s.grids.length!==3||s.formula.length!==3||s.effective.length!==3)return false;
 for(let n=0;n<3;n++){
  const grid=s.grids[n],f=s.formula[n],e=s.effective[n];
  if(!grid||!Number.isSafeInteger(grid.sheetId)||grid.sheetId<0||!Number.isSafeInteger(grid.rowCount)||grid.rowCount<2||grid.rowCount>5000||!Number.isSafeInteger(grid.columnCount)||grid.columnCount<(n===0?29:26)||grid.columnCount>100||!Array.isArray(f)||!Array.isArray(e)||f.length>grid.rowCount||e.length>grid.rowCount)return false;
  for(const rows of [f,e])for(const row of rows){
   if(!Array.isArray(row)||row.length>grid.columnCount)return false;
   for(const value of row){
    if(!empty(value)&&typeof value!=='string'&&typeof value!=='boolean'&&!(typeof value==='number'&&Number.isFinite(value)))return false;
    if(typeof value==='string'&&[expenseId,itemId,documentId].some(id=>value.includes(id)))return false;
   }
  }
  for(let i=n===0?3:1;i<grid.rowCount;i++){
   const carrier=f[i]?.[n===0?24:25],rendered=e[i]?.[n===0?24:25];
   if(empty(carrier)&&empty(rendered))continue;
   if(typeof carrier!=='string'||carrier!==rendered)return false;
   if(n===0){
    if(new RegExp(`^MPD1_EMPTY_${i+1}_[0-9a-f]{32}$`).test(carrier)||/^MPD1_CANCELLED_[0-9a-f]{64}$/.test(carrier))continue;
    if(!carrier.startsWith(ATOMIC_DAILY_PREFIX)||!decodeAtomicDailyPayload(carrier))return false;
   }else{
    if(new RegExp(`^MPL1_EMPTY_${i+1}_[0-9a-f]{32}$`).test(carrier))continue;
    const decoded=carrier.startsWith(LEDGER_PREFIX)?decodeLedgerCarrier(carrier):null;
    if(!decoded||decoded.projection!==(n===1?'EXPENSE_RAW':'DETAIL'))return false;
   }
  }
 }
 return true;
}

/** Read-only incident evidence, deliberately not an admin endpoint or a
 * recovery command. A match does not prove old requests are settled and does
 * not authorize release, retry, status changes or any Google mutation. */
export async function inspectCanaryUnwrittenProvider(env:EvidenceEnv,notice?:{status:string;stamp:string},budget?:ReviewRequestBudget):Promise<{fingerprint:string;styleDigest:string}|null>{
 const db=env.DB,scope=()=>canaryUnwrittenScope(env);
 const policy:ContinuousSheetsReadPolicy={kind:'continuous-expense',...(budget?{budget}:{})};
 const initial=scope(),stable=()=>env.DB===db&&scope()===initial;
 try{
  const first=await readCanaryUnwrittenEvidence(env);if(!first||!stable())return null;
  const target=await assertContinuousDailyActivated(env),names=[env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_DETAIL_SHEET],ids=[env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET_ID];
  if(!target||names.some(x=>!x)||ids.some(x=>!x)||new Set(names).size!==3||new Set(ids).size!==3||target.sheet!==names[0]||String(target.sheetId)!==ids[0]||!stable())return null;
  const namesExact=names as string[];
  const take=async():Promise<Snapshot>=>{
   const select=(all:Awaited<ReturnType<typeof getSpreadsheetSheetProperties>>)=>namesExact.map(n=>{const found=all.filter(s=>s.title===n);if(found.length!==1)throw Error('CANARY_PREFLIGHT_GRID');const {sheetId,rowCount,columnCount}=found[0]!;return{sheetId,rowCount,columnCount}});
   const grids=select(await getSpreadsheetSheetProperties(env,policy));
   if(grids.some((g,i)=>String(g.sheetId)!==ids[i]||g.rowCount<2||g.rowCount>5000||g.columnCount<(i===0?29:26)||g.columnCount>100))throw Error('CANARY_PREFLIGHT_GRID');
   const ranges=grids.map((g,i)=>`${quote(namesExact[i]!)}!A1:${column(g.columnCount)}${g.rowCount}`);
   const [formula,effective]=await Promise.all([batchGetSheetFormulaValues(env,ranges,policy),batchGetSheetEffectiveSerialValues(env,ranges,policy)]);
   const again=select(await getSpreadsheetSheetProperties(env,policy));
   if(!stable()||JSON.stringify(grids)!==JSON.stringify(again))throw Error('CANARY_PREFLIGHT_GRID');
   return {grids,formula,effective};
  };
  const expectedStatus=notice?.status??'พักแก้ไฟล์',expectedStamp=notice?.stamp??first.notice_stamp;
  if(!['พักแก้ไฟล์','พร้อมแก้ไข','พร้อมแก้ไข • มีรายการรอตรวจ'].includes(expectedStatus)||!expectedStamp)return null;
  const beforeStyle=await stableNoticeStyleFingerprint(env,first.notice_identity,expectedStatus,expectedStamp,budget);
  if(!beforeStyle||!stable())return null;
  // Hash each large snapshot separately so two full formula grids do not
  // remain reachable at once in the Worker's bounded memory.
  const snapshotDigest=async()=>{
   const snapshot=await take();if(!canaryAbsentFromSnapshots(snapshot,first.expense_id,first.item_id,first.document_id))return null;
   const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(snapshot)));
   return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
  };
  const before=await snapshotDigest();
  if(!before||await readContinuousReportHealth(env,{expenseId:first.expense_id,absent:true,absentFromViews:true},undefined,policy)!=='OK'||!stable())return null;
  const after=await snapshotDigest(),second=await readCanaryUnwrittenEvidence(env),afterStyle=await stableNoticeStyleFingerprint(env,first.notice_identity,expectedStatus,expectedStamp,budget);
  if(!after||!second||beforeStyle!==afterStyle||JSON.stringify(first)!==JSON.stringify(second)||before!==after||!stable())return null;
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([first,before,beforeStyle])));
  if(!stable())return null;
  return {fingerprint:Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join(''),styleDigest:beforeStyle};
 }catch{return null;}
}
