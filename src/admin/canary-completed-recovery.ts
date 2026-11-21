import type {Env} from '../types';
import {batchUpdateSpreadsheetWithReply} from '../sheets/client';
import {stableNoticeStyleFingerprint} from '../sheets/stable-edit-notice';
import {ReviewRequestBudget} from '../sheets/review-request-budget';
import {canaryUnwrittenScope} from './canary-unwritten-scope';
import {CANARY_COMPLETED_EVIDENCE_SQL,readCompletedCanaryEvidence,type CompletedCanaryEvidence} from './canary-completed-evidence';
import {verifyCompletedCanaryProvider} from './continuous-canary-operator';

type RecoveryEnv=Env & {CONTINUOUS_CANARY_OPERATOR_ENABLED?:string;CANARY_UNWRITTEN_RECOVERY_ENABLED?:string};
type Intent={operation_token:string;epoch_id:string;expense_id:string;source_revision:number;paused_stamp:string;notice_identity:string;next_stamp:string;ready_status:string;style_digest:string;state:string};
type Phase='PROBE'|'TIME'|'PROBE_STATUS'|'STATUS'|'COMMIT';
const paused='พักแก้ไฟล์',plain='พร้อมแก้ไข',review='พร้อมแก้ไข • มีรายการรอตรวจ',sheetId=1815870717;
const integrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='canary_completed_recovery' AND name IN ('canary_completed_recovery_insert','canary_completed_recovery_transition','canary_completed_recovery_no_delete','canary_completed_recovery_no_replace'))=4";
const readyGuard=`((r.ready_status='${plain}' AND NOT EXISTS(SELECT 1 FROM sync_jobs WHERE status='REVIEW')) OR (r.ready_status='${review}' AND EXISTS(SELECT 1 FROM sync_jobs WHERE status='REVIEW')))`;
const request=(column:number,find:string,replacement:string)=>({findReplace:{range:{sheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:column,endColumnIndex:column+1},find,replacement,matchCase:true,matchEntireCell:true,searchByRegex:false,includeFormulas:false}});
const oneChange=(reply:unknown)=>{const r=reply&&typeof reply==='object'?(reply as {replies?:Array<{findReplace?:{valuesChanged?:unknown;occurrencesChanged?:unknown;formulasChanged?:unknown}}>}).replies:undefined;return Array.isArray(r)&&r.length===1&&r[0]?.findReplace?.valuesChanged===1&&r[0].findReplace.occurrencesChanged===1&&Number(r[0].findReplace.formulasChanged??0)===0;};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function nextStamp():string{const p=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date()),v=(name:string)=>p.find(x=>x.type===name)?.value,random=Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');return `${v('year')}-${v('month')}-${v('day')} ${v('hour')}:${v('minute')}:${v('second')} • ${random}`;}
async function expectedReady(env:Env):Promise<string|null>{const row=await env.DB.prepare("SELECT count(*) AS n FROM sync_jobs WHERE status='REVIEW'").first<{n:number}>();return row&&Number.isSafeInteger(row.n)&&row.n>=0?(row.n?review:plain):null;}
function matches(i:Intent,e:CompletedCanaryEvidence):boolean{return i.operation_token===e.claim_token&&i.epoch_id===e.epoch_id&&i.expense_id===e.expense_id&&i.source_revision===e.source_revision&&i.paused_stamp===e.notice_stamp&&i.notice_identity===e.notice_identity;}

/** One positive-only step for the completed synthetic expense. No expense or
 * ledger write is re-dispatched. An uncertain notice POST is never retried. */
export async function stepCompletedCanaryRecovery(env:RecoveryEnv,phase:Phase):Promise<'DISABLED'|'HELD'|'READY'|'IN_PROGRESS'|'COMPLETE'>{
 if(env.CANARY_UNWRITTEN_RECOVERY_ENABLED!=='true'||env.CONTINUOUS_CANARY_OPERATOR_ENABLED!=='true'||env.CONTINUOUS_PUBLICATION_ENABLED==='true'||env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED==='true')return 'DISABLED';
 if(!['PROBE','TIME','PROBE_STATUS','STATUS','COMMIT'].includes(phase))return 'HELD';
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,initial=canaryUnwrittenScope(env),stable=()=>env.DB===db&&canaryUnwrittenScope(env)===initial,budget=new ReviewRequestBudget(40);
 if(!book||!stable())return 'HELD';
 try{
  const i=await db.prepare('SELECT operation_token,epoch_id,expense_id,source_revision,paused_stamp,notice_identity,next_stamp,ready_status,style_digest,state FROM canary_completed_recovery WHERE spreadsheet_id=?').bind(book).first<Intent>();
  const e=await readCompletedCanaryEvidence(env);if(!e||!stable()||i&&!matches(i,e))return 'HELD';
  const verify=async(status:string,stamp:string,digest?:string)=>{
   if(!await verifyCompletedCanaryProvider(env,e.expense_id,{kind:'continuous-expense',budget})||!stable())return false;
   const style=await stableNoticeStyleFingerprint(env,e.notice_identity,status,stamp,budget),after=await readCompletedCanaryEvidence(env);
   return !!style&&(!digest||digest===style)&&same(after,e)&&stable()?style:false;
  };
  if(phase==='PROBE')return !i&&await verify(paused,e.notice_stamp)?'READY':'HELD';
  if(phase==='TIME'){
   if(i)return 'HELD';const ready=await expectedReady(env),style=await verify(paused,e.notice_stamp);if(!ready||!style||!budget.reserveMutation())return 'HELD';
   const next=nextStamp();if(next===e.notice_stamp)return 'HELD';
   try{
    const reply=await batchUpdateSpreadsheetWithReply(env,[request(2,e.notice_stamp,next)],async()=>{
     if(await expectedReady(env)!==ready||await verify(paused,e.notice_stamp,style)!==style)throw Error('CANARY_COMPLETED_TIME_PREIMAGE');
     const saved=await db.prepare(`INSERT INTO canary_completed_recovery(spreadsheet_id,operation_token,epoch_id,expense_id,source_revision,paused_stamp,notice_identity,next_stamp,ready_status,style_digest,state,created_at,updated_at)
      SELECT ?,proof.claim_token,proof.epoch_id,proof.expense_id,proof.source_revision,proof.notice_stamp,proof.notice_identity,?,?,?,'TIME_IN_FLIGHT',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM (${CANARY_COMPLETED_EVIDENCE_SQL}) proof
      WHERE proof.claim_token=? AND proof.epoch_id=? AND proof.expense_id=? AND proof.source_revision=? AND proof.notice_stamp=? AND proof.notice_identity=? AND ${integrity}
      AND ((?='${plain}' AND NOT EXISTS(SELECT 1 FROM sync_jobs WHERE status='REVIEW')) OR (?='${review}' AND EXISTS(SELECT 1 FROM sync_jobs WHERE status='REVIEW')))`).bind(book,next,ready,style,book,e.claim_token,e.epoch_id,e.expense_id,e.source_revision,e.notice_stamp,e.notice_identity,ready,ready).run();
     if(saved.success!==true||saved.meta?.changes!==1||!stable())throw Error('CANARY_COMPLETED_TIME_INTENT');
    },budget);
    if(!oneChange(reply)||!stable())return 'HELD';
    const ack=await db.prepare(`UPDATE canary_completed_recovery SET state='TIME_ACKED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='TIME_IN_FLIGHT' AND next_stamp=? AND ${integrity}`).bind(book,e.claim_token,next).run();
    return stable()&&ack.success===true&&ack.meta?.changes===1?'IN_PROGRESS':'HELD';
   }finally{budget.releaseMutation();}
  }
  if(!i)return 'HELD';
  if(phase==='PROBE_STATUS')return i.state==='TIME_ACKED'&&await expectedReady(env)===i.ready_status&&await verify(paused,i.next_stamp,i.style_digest)?'READY':'HELD';
  if(phase==='STATUS'){
   if(i.state!=='TIME_ACKED'||await expectedReady(env)!==i.ready_status||!await verify(paused,i.next_stamp,i.style_digest)||!budget.reserveMutation())return 'HELD';
   try{
    const reply=await batchUpdateSpreadsheetWithReply(env,[request(1,paused,i.ready_status)],async()=>{
     if(await expectedReady(env)!==i.ready_status||!await verify(paused,i.next_stamp,i.style_digest))throw Error('CANARY_COMPLETED_STATUS_PREIMAGE');
     const mark=await db.prepare(`UPDATE canary_completed_recovery AS r SET state='STATUS_IN_FLIGHT',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE r.spreadsheet_id=? AND r.operation_token=? AND r.state='TIME_ACKED' AND ${integrity} AND ${readyGuard} AND EXISTS(SELECT 1 FROM (${CANARY_COMPLETED_EVIDENCE_SQL}) proof WHERE proof.expense_id=r.expense_id AND proof.claim_token=r.operation_token AND proof.epoch_id=r.epoch_id AND proof.source_revision=r.source_revision AND proof.notice_stamp=r.paused_stamp AND proof.notice_identity=r.notice_identity)`).bind(book,e.claim_token,book).run();
     if(mark.success!==true||mark.meta?.changes!==1||!stable())throw Error('CANARY_COMPLETED_STATUS_INTENT');
    },budget);
    if(!oneChange(reply)||!stable())return 'HELD';
    const ack=await db.prepare(`UPDATE canary_completed_recovery SET state='STATUS_ACKED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='STATUS_IN_FLIGHT' AND next_stamp=? AND ${integrity}`).bind(book,e.claim_token,i.next_stamp).run();
    return stable()&&ack.success===true&&ack.meta?.changes===1?'IN_PROGRESS':'HELD';
   }finally{budget.releaseMutation();}
  }
  if(phase!=='COMMIT'||i.state!=='STATUS_ACKED'||await expectedReady(env)!==i.ready_status||!await verify(i.ready_status,i.next_stamp,i.style_digest))return 'HELD';
  const result=await db.batch([
   db.prepare(`UPDATE stable_recovery_operations SET state='VERIFIED',verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_token=? AND epoch_id=? AND state='ADMITTED' AND ${integrity} AND EXISTS(SELECT 1 FROM canary_completed_recovery r JOIN (${CANARY_COMPLETED_EVIDENCE_SQL}) proof ON proof.expense_id=r.expense_id AND proof.claim_token=r.operation_token AND proof.epoch_id=r.epoch_id AND proof.source_revision=r.source_revision AND proof.notice_stamp=r.paused_stamp AND proof.notice_identity=r.notice_identity WHERE r.spreadsheet_id=? AND r.operation_token=stable_recovery_operations.operation_token AND r.state='STATUS_ACKED' AND ${readyGuard})`).bind(e.claim_token,e.epoch_id,book,book),
   db.prepare("UPDATE stable_recovery_epochs SET state='COMPLETE',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE epoch_id=? AND spreadsheet_id=? AND state='ARMED' AND target_type='EXPENSE' AND target_key=? AND target_version=1 AND changes()=1 AND EXISTS(SELECT 1 FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=1 AND status='COMPLETED')").bind(e.epoch_id,book,e.expense_id,e.expense_id),
   db.prepare("DELETE FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='REVIEW' AND phase='OPERATION' AND review_reason='STABLE_EXPENSE_COMPLETION_UNCERTAIN' AND notice_stamp=? AND notice_identity=? AND changes()=1").bind(book,e.claim_token,e.notice_stamp,e.notice_identity),
   db.prepare(`UPDATE canary_completed_recovery SET state='COMPLETE',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='STATUS_ACKED' AND changes()=1 AND ${integrity}`).bind(book,e.claim_token),
   db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
  ]);
  return stable()&&result.length===5&&result.every(x=>x.success===true)&&result[0]?.meta?.changes===1&&result[1]?.meta?.changes===1&&[1,2].includes(Number(result[2]?.meta?.changes))&&result[3]?.meta?.changes===1?'COMPLETE':'HELD';
 }catch{return 'HELD';}
}
