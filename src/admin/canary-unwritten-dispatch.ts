import type {Env} from '../types';
import {batchUpdateSpreadsheetWithReply} from '../sheets/client';
import {CANARY_UNWRITTEN_EVIDENCE_SQL,readCanaryUnwrittenEvidence} from './canary-unwritten-evidence';
import {inspectCanaryUnwrittenProvider,type CanaryProofDiagnostic} from './canary-unwritten-provider-proof';
import {finalizeCanaryUnwrittenRecovery} from './canary-unwritten-finalize';
import {canaryUnwrittenScope} from './canary-unwritten-scope';
import {ReviewRequestBudget} from '../sheets/review-request-budget';

type RecoveryEnv=Env & {CONTINUOUS_CANARY_OPERATOR_ENABLED?:string;CANARY_UNWRITTEN_RECOVERY_ENABLED?:string};
type Intent={operation_token:string;epoch_id:string;expense_id:string;source_revision:number;paused_stamp:string;notice_identity:string;next_stamp:string;ready_status:string;provider_digest:string;style_digest:string;state:string};
const paused='พักแก้ไฟล์',plain='พร้อมแก้ไข',review='พร้อมแก้ไข • มีรายการรอตรวจ',sheetId=1815870717;
const integrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='canary_unwritten_recovery' AND name IN ('canary_unwritten_recovery_insert','canary_unwritten_recovery_transition','canary_unwritten_recovery_no_delete','canary_unwritten_recovery_no_replace'))=4";
const request=(column:number,find:string,replacement:string)=>({findReplace:{range:{sheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:column,endColumnIndex:column+1},find,replacement,matchCase:true,matchEntireCell:true,searchByRegex:false,includeFormulas:false}});
const oneChange=(reply:unknown)=>{const r=reply&&typeof reply==='object'?(reply as {replies?:Array<{findReplace?:{valuesChanged?:unknown;occurrencesChanged?:unknown;formulasChanged?:unknown}}>}).replies:undefined;return Array.isArray(r)&&r.length===1&&r[0]?.findReplace?.valuesChanged===1&&r[0].findReplace.occurrencesChanged===1&&Number(r[0].findReplace.formulasChanged??0)===0;};
const readyGuard=`((r.ready_status='${plain}' AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.status='REVIEW' AND NOT (j.entity_type='EXPENSE' AND j.entity_key=r.expense_id AND j.entity_version=1))) OR (r.ready_status='${review}' AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.status='REVIEW' AND NOT (j.entity_type='EXPENSE' AND j.entity_key=r.expense_id AND j.entity_version=1))))`;
const same=(x:unknown,y:unknown)=>JSON.stringify(x)===JSON.stringify(y);
function nextStamp():string{const p=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date()),v=(name:string)=>p.find(x=>x.type===name)?.value,random=Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');return `${v('year')}-${v('month')}-${v('day')} ${v('hour')}:${v('minute')}:${v('second')} • ${random}`;}

/** One incident-specific step behind the default-off admin route. Before any
 * production use, the caller must independently fence and drain every old
 * provider writer and obtain exact owner approval. A database flag, elapsed
 * time, this function, and an absent synthetic row do not prove that fence.
 * IN_FLIGHT and ambiguous replies are permanent holds, never auto-retried. */
export async function stepCanaryUnwrittenRecovery(env:RecoveryEnv,expected:'PROBE'|'TIME'|'STATUS'|'COMMIT',diagnostic?:CanaryProofDiagnostic):Promise<'DISABLED'|'HELD'|'READY'|'IN_PROGRESS'|'RESUMED'|'ALREADY_COMMITTED'>{
 if(env.CANARY_UNWRITTEN_RECOVERY_ENABLED!=='true')return 'DISABLED';
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 const scope=()=>canaryUnwrittenScope(env);
 const initial=scope(),stable=()=>env.DB===db&&scope()===initial;
 const budget=new ReviewRequestBudget(40);
 if(!book||!stable())return 'HELD';
 try{
  const intent=await db.prepare('SELECT operation_token,epoch_id,expense_id,source_revision,paused_stamp,notice_identity,next_stamp,ready_status,provider_digest,style_digest,state FROM canary_unwritten_recovery WHERE spreadsheet_id=?').bind(book).first<Intent>();
  if(!stable())return 'HELD';
  if(expected==='PROBE'){
   if(intent){if(diagnostic){diagnostic.stage='OPERATOR_STATE';diagnostic.reason='CHECK_FAILED'}return 'HELD';}
   return await inspectCanaryUnwrittenProvider(env,undefined,budget,diagnostic)&&stable()?'READY':'HELD';
  }
  if(expected==='COMMIT'&&(intent?.state==='STATUS_ACKED'||intent?.state==='COMPLETE'))return finalizeCanaryUnwrittenRecovery(env);
  if(expected==='TIME'&&intent||expected==='STATUS'&&intent?.state!=='TIME_ACKED'||expected!=='TIME'&&expected!=='STATUS')return 'HELD';
  const evidence=await readCanaryUnwrittenEvidence(env);if(!evidence||!stable())return 'HELD';
  if(!intent){
   const proof=await inspectCanaryUnwrittenProvider(env,undefined,budget),again=await readCanaryUnwrittenEvidence(env);
   if(!proof||!again||!same(evidence,again)||!stable())return 'HELD';
   const others=await db.prepare("SELECT count(*) AS n FROM sync_jobs WHERE status='REVIEW' AND NOT (entity_type='EXPENSE' AND entity_key=? AND entity_version=1)").bind(evidence.expense_id).first<{n:number}>();
   if(!others||!Number.isSafeInteger(others.n)||others.n<0||!stable())return 'HELD';
   const ready=others.n?review:plain,next=nextStamp();
   if(!budget.reserveMutation())return 'HELD';
   try{
    const reply=await batchUpdateSpreadsheetWithReply(env,[request(2,evidence.notice_stamp,next)],async()=>{
     const checked=await inspectCanaryUnwrittenProvider(env,undefined,budget),current=await readCanaryUnwrittenEvidence(env);
     if(!checked||!same(checked,proof)||!current||!same(current,evidence)||!stable())throw Error('CANARY_UNWRITTEN_TIME_PREIMAGE');
     const created=await db.prepare(`INSERT INTO canary_unwritten_recovery(spreadsheet_id,operation_token,epoch_id,expense_id,source_version,source_revision,paused_stamp,notice_identity,next_stamp,ready_status,provider_digest,style_digest,state,created_at,updated_at)
      SELECT ?,proof.claim_token,proof.epoch_id,proof.expense_id,1,proof.source_revision,proof.notice_stamp,proof.notice_identity,?,?,?,?,'TIME_IN_FLIGHT',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM (${CANARY_UNWRITTEN_EVIDENCE_SQL}) proof WHERE proof.claim_token=? AND proof.epoch_id=? AND proof.expense_id=? AND proof.source_revision=? AND proof.notice_stamp=? AND proof.notice_identity=? AND ${integrity}
      AND ((?='${plain}' AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.status='REVIEW' AND NOT (j.entity_type='EXPENSE' AND j.entity_key=proof.expense_id AND j.entity_version=1))) OR (?='${review}' AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.status='REVIEW' AND NOT (j.entity_type='EXPENSE' AND j.entity_key=proof.expense_id AND j.entity_version=1))))`)
      .bind(book,next,ready,proof.fingerprint,proof.styleDigest,book,evidence.claim_token,evidence.epoch_id,evidence.expense_id,evidence.source_revision,evidence.notice_stamp,evidence.notice_identity,ready,ready).run();
     if(created.success!==true||Number(created.meta?.changes)!==1||!stable())throw Error('CANARY_UNWRITTEN_TIME_INTENT');
    },budget);
    if(!oneChange(reply)||!stable())return 'HELD';
    const ack=await db.prepare(`UPDATE canary_unwritten_recovery SET state='TIME_ACKED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='TIME_IN_FLIGHT' AND next_stamp=? AND ${integrity}`).bind(book,evidence.claim_token,next).run();
    return stable()&&ack.success===true&&Number(ack.meta?.changes)===1?'IN_PROGRESS':'HELD';
   }catch{return 'HELD';}finally{budget.releaseMutation();}
  }
  if(intent.operation_token!==evidence.claim_token||intent.epoch_id!==evidence.epoch_id||intent.expense_id!==evidence.expense_id||intent.source_revision!==evidence.source_revision||intent.paused_stamp!==evidence.notice_stamp||intent.notice_identity!==evidence.notice_identity)return 'HELD';
  const first=await inspectCanaryUnwrittenProvider(env,{status:paused,stamp:intent.next_stamp},budget);
  if(!first||first.fingerprint!==intent.provider_digest||first.styleDigest!==intent.style_digest||!stable())return 'HELD';
  if(!budget.reserveMutation())return 'HELD';
  try{
   const reply=await batchUpdateSpreadsheetWithReply(env,[request(1,paused,intent.ready_status)],async()=>{
    const current=await inspectCanaryUnwrittenProvider(env,{status:paused,stamp:intent.next_stamp},budget),latest=await readCanaryUnwrittenEvidence(env);
    if(!current||!same(current,first)||!latest||!same(latest,evidence)||!stable())throw Error('CANARY_UNWRITTEN_STATUS_PREIMAGE');
    const marked=await db.prepare(`UPDATE canary_unwritten_recovery AS r SET state='STATUS_IN_FLIGHT',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE r.spreadsheet_id=? AND r.operation_token=? AND r.state='TIME_ACKED' AND r.provider_digest=? AND r.style_digest=? AND ${integrity} AND ${readyGuard} AND EXISTS(SELECT 1 FROM (${CANARY_UNWRITTEN_EVIDENCE_SQL}) proof WHERE proof.expense_id=r.expense_id AND proof.claim_token=r.operation_token AND proof.epoch_id=r.epoch_id AND proof.source_revision=r.source_revision AND proof.notice_stamp=r.paused_stamp AND proof.notice_identity=r.notice_identity)`)
     .bind(book,intent.operation_token,intent.provider_digest,intent.style_digest,book).run();
    if(marked.success!==true||Number(marked.meta?.changes)!==1||!stable())throw Error('CANARY_UNWRITTEN_STATUS_INTENT');
   },budget);
   if(!oneChange(reply)||!stable())return 'HELD';
   const ack=await db.prepare(`UPDATE canary_unwritten_recovery SET state='STATUS_ACKED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='STATUS_IN_FLIGHT' AND next_stamp=? AND ${integrity}`).bind(book,intent.operation_token,intent.next_stamp).run();
   return stable()&&ack.success===true&&Number(ack.meta?.changes)===1?'IN_PROGRESS':'HELD';
  }catch{return 'HELD';}finally{budget.releaseMutation();}
 }catch{return 'HELD';}
}
