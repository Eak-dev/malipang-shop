import type {Env} from '../types';
import {batchUpdateSpreadsheetWithReply} from '../sheets/client';
import {stableNoticeStyleFingerprint} from '../sheets/stable-edit-notice';
import {readContinuousReportHealth} from '../sheets/continuous-report-health';
import {ReviewRequestBudget} from '../sheets/review-request-budget';
import {canaryUnwrittenScope} from './canary-unwritten-scope';
import {readScopedHoldEvidence,SCOPED_HOLD_EVIDENCE_SQL,type ScopedHoldEvidence} from './scoped-hold-incident-evidence';

type Phase='PROBE'|'TIME'|'PROBE_STATUS'|'STATUS'|'COMMIT';
type IncidentEnv=Env & {CONTINUOUS_CANARY_OPERATOR_ENABLED?:string;CANARY_UNWRITTEN_RECOVERY_ENABLED?:string};
type Intent={operation_token:string;job_id:string;expense_id:string;source_revision:number;paused_stamp:string;notice_identity:string;next_stamp:string;ready_status:string;style_digest:string;state:string};
const paused='พักแก้ไฟล์',ready='พร้อมแก้ไข • มีรายการรอตรวจ',sheetId=1815870717;
const integrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='scoped_hold_incident_recovery' AND name IN ('scoped_hold_incident_insert','scoped_hold_incident_transition','scoped_hold_incident_no_delete','scoped_hold_incident_no_replace'))=4";
const request=(column:number,find:string,replacement:string)=>({findReplace:{range:{sheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:column,endColumnIndex:column+1},find,replacement,matchCase:true,matchEntireCell:true,searchByRegex:false,includeFormulas:false}});
const one=(reply:unknown)=>{const r=reply&&typeof reply==='object'?(reply as {replies?:Array<{findReplace?:{valuesChanged?:unknown;occurrencesChanged?:unknown;formulasChanged?:unknown}}>}).replies:undefined;return Array.isArray(r)&&r.length===1&&r[0]?.findReplace?.valuesChanged===1&&r[0].findReplace.occurrencesChanged===1&&Number(r[0].findReplace.formulasChanged??0)===0;};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const matches=(i:Intent,e:ScopedHoldEvidence)=>i.operation_token===e.claim_token&&i.job_id===e.job_id&&i.expense_id===e.expense_id&&i.source_revision===e.source_revision&&i.paused_stamp===e.notice_stamp&&i.notice_identity===e.notice_identity;
function nextStamp():string{const p=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date()),v=(n:string)=>p.find(x=>x.type===n)?.value,nonce=Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');return `${v('year')}-${v('month')}-${v('day')} ${v('hour')}:${v('minute')}:${v('second')} • ${nonce}`;}

/** One phase, one pinned claim and job. Never sends an expense write. */
export async function stepScopedHoldIncident(env:IncidentEnv,phase:Phase,identityHash:string):Promise<'HELD'|'READY'|'IN_PROGRESS'|'COMPLETE'>{
 if(!['PROBE','TIME','PROBE_STATUS','STATUS','COMMIT'].includes(phase)||env.STABLE_PHASE1_ENABLED!=='true'||env.STABLE_RECOVERY_GATE_ENABLED!=='true'||env.CONTINUOUS_DAILY_ENABLED!=='true'||env.CONTINUOUS_CANARY_OPERATOR_ENABLED!=='false'||env.CANARY_UNWRITTEN_RECOVERY_ENABLED!=='false'||env.CONTINUOUS_PUBLICATION_ENABLED==='true'||env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED==='true')return 'HELD';
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,scope=canaryUnwrittenScope(env),stable=()=>env.DB===db&&canaryUnwrittenScope(env)===scope,budget=new ReviewRequestBudget(40);if(!book||!stable())return 'HELD';
 try{
  const i=await db.prepare('SELECT operation_token,job_id,expense_id,source_revision,paused_stamp,notice_identity,next_stamp,ready_status,style_digest,state FROM scoped_hold_incident_recovery WHERE spreadsheet_id=?').bind(book).first<Intent>();
  const e=await readScopedHoldEvidence(env,identityHash);if(!e||!stable()||i&&!matches(i,e))return 'HELD';
  const verify=async(status:string,stamp:string,digest?:string)=>{
   if(await readContinuousReportHealth(env,undefined,undefined,{kind:'continuous-expense',budget})!=='OK'||!stable())return false;
   const style=await stableNoticeStyleFingerprint(env,e.notice_identity,status,stamp,budget),after=await readScopedHoldEvidence(env,identityHash);
   return !!style&&(!digest||style===digest)&&same(after,e)&&stable()?style:false;
  };
  if(phase==='PROBE')return !i&&await verify(paused,e.notice_stamp)?'READY':'HELD';
  if(phase==='TIME'){
   if(i)return 'HELD';const style=await verify(paused,e.notice_stamp);if(!style||!budget.reserveMutation())return 'HELD';const next=nextStamp();if(next===e.notice_stamp)return 'HELD';
   try{const reply=await batchUpdateSpreadsheetWithReply(env,[request(2,e.notice_stamp,next)],async()=>{
    if(await verify(paused,e.notice_stamp,style)!==style)throw Error('SCOPED_HOLD_TIME_PREIMAGE');
    const saved=await db.prepare(`INSERT INTO scoped_hold_incident_recovery(spreadsheet_id,operation_token,job_id,expense_id,source_revision,paused_stamp,notice_identity,next_stamp,ready_status,style_digest,state,created_at,updated_at)
     SELECT ?,proof.claim_token,proof.job_id,proof.expense_id,proof.source_revision,proof.notice_stamp,proof.notice_identity,?,?,?,'TIME_IN_FLIGHT',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM (${SCOPED_HOLD_EVIDENCE_SQL}) proof
     WHERE proof.claim_token=? AND proof.job_id=? AND proof.expense_id=? AND proof.source_revision=? AND proof.notice_stamp=? AND proof.notice_identity=? AND ${integrity}`).bind(book,next,ready,style,book,e.claim_token,e.job_id,e.expense_id,e.source_revision,e.notice_stamp,e.notice_identity).run();
    if(saved.success!==true||saved.meta?.changes!==1||!stable())throw Error('SCOPED_HOLD_TIME_INTENT');
   },budget);if(!one(reply)||!stable())return 'HELD';
   const ack=await db.prepare(`UPDATE scoped_hold_incident_recovery SET state='TIME_ACKED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='TIME_IN_FLIGHT' AND next_stamp=? AND ${integrity}`).bind(book,e.claim_token,next).run();return stable()&&ack.success===true&&ack.meta?.changes===1?'IN_PROGRESS':'HELD';}finally{budget.releaseMutation();}
  }
  if(!i)return 'HELD';
  if(phase==='PROBE_STATUS')return i.state==='TIME_ACKED'&&await verify(paused,i.next_stamp,i.style_digest)?'READY':'HELD';
  if(phase==='STATUS'){
   if(i.state!=='TIME_ACKED'||!await verify(paused,i.next_stamp,i.style_digest)||!budget.reserveMutation())return 'HELD';
   try{const reply=await batchUpdateSpreadsheetWithReply(env,[request(1,paused,ready)],async()=>{
    if(!await verify(paused,i.next_stamp,i.style_digest))throw Error('SCOPED_HOLD_STATUS_PREIMAGE');
    const mark=await db.prepare(`UPDATE scoped_hold_incident_recovery AS r SET state='STATUS_IN_FLIGHT',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE r.spreadsheet_id=? AND r.operation_token=? AND r.state='TIME_ACKED' AND ${integrity} AND EXISTS(SELECT 1 FROM (${SCOPED_HOLD_EVIDENCE_SQL}) proof WHERE proof.job_id=r.job_id AND proof.expense_id=r.expense_id AND proof.claim_token=r.operation_token AND proof.source_revision=r.source_revision AND proof.notice_stamp=r.paused_stamp AND proof.notice_identity=r.notice_identity)`).bind(book,e.claim_token,book).run();
    if(mark.success!==true||mark.meta?.changes!==1||!stable())throw Error('SCOPED_HOLD_STATUS_INTENT');
   },budget);if(!one(reply)||!stable())return 'HELD';const ack=await db.prepare(`UPDATE scoped_hold_incident_recovery SET state='STATUS_ACKED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='STATUS_IN_FLIGHT' AND next_stamp=? AND ${integrity}`).bind(book,e.claim_token,i.next_stamp).run();return stable()&&ack.success===true&&ack.meta?.changes===1?'IN_PROGRESS':'HELD';}finally{budget.releaseMutation();}
  }
  if(phase!=='COMMIT'||i.state!=='STATUS_ACKED'||!await verify(ready,i.next_stamp,i.style_digest))return 'HELD';
  const result=await db.batch([
   db.prepare(`DELETE FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='REVIEW' AND phase='OPERATION' AND review_reason='STABLE_EXPENSE_SOURCE_UNVERIFIED' AND notice_stamp=? AND notice_identity=? AND ${integrity} AND EXISTS(SELECT 1 FROM scoped_hold_incident_recovery r JOIN (${SCOPED_HOLD_EVIDENCE_SQL}) proof ON proof.job_id=r.job_id AND proof.expense_id=r.expense_id AND proof.claim_token=r.operation_token AND proof.source_revision=r.source_revision AND proof.notice_stamp=r.paused_stamp AND proof.notice_identity=r.notice_identity WHERE r.spreadsheet_id=? AND r.operation_token=stable_workbook_claims.operation_token AND r.state='STATUS_ACKED')`).bind(book,e.claim_token,e.notice_stamp,e.notice_identity,book,book),
   db.prepare(`UPDATE scoped_hold_incident_recovery SET state='COMPLETE',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='STATUS_ACKED' AND changes()=1 AND ${integrity}`).bind(book,e.claim_token),
   db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
  ]);
  return stable()&&result.length===3&&result.every(x=>x.success===true)&&[1,2].includes(Number(result[0]?.meta?.changes))&&result[1]?.meta?.changes===1?'COMPLETE':'HELD';
 }catch{return 'HELD';}
}
