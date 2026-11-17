import type {ReviewRequestBudget} from './review-request-budget';
import type {Env,SheetsSyncJob,LineNotificationJob} from '../types';
import {buildLineNotificationJob} from '../line/attendance-notification';
import {lineOutputEnabled} from '../line/api';
import {newStableSourcePredicate,stableSourceIntegrity} from './stable-source-cutover';
import {continuousDailyCutoverIntegrity,continuousReportCutoverIntegrity,continuousAdmissionIntegrity} from './continuous-daily-cutover';
import {assertContinuousDailyActivated} from './continuous-daily-route';
import {recoveryGateConfigured,recoveryGateValid} from './stable-recovery-admission';

/** A D1 snapshot cannot
 * prove a legacy request has settled or fence a human/legacy writer. Do not
 * execute these statements without independently established provider
 * settlement and external-writer exclusion for the whole transaction and
 * subsequent readback. Building statements alone performs no writes. */
export type UnwrittenCancelInput={job:SheetsSyncJob;lease:string;claim:string;sourceRevision:number;sourceDigest:string;description:string;amountSatang:number;reason:'MONTH_OPENING'|'ROW_FORMULA'|'CAPACITY'|'LEGACY_COVERAGE'|'REPORT_UNVERIFIED'|'LEGACY_READ'|'PENDING_UNDO'|'SHEETS_READ';errorCode?:string};
export async function buildUnwrittenExpenseCancellationCandidate(env:Env,input:UnwrittenCancelInput):Promise<{statements:D1PreparedStatement[];notification:LineNotificationJob|null}|null>{
 const daily=await assertContinuousDailyActivated(env);if(!daily)return null;
 const {job,lease,claim,sourceRevision,sourceDigest,description,amountSatang,reason,errorCode}=input,db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,owner=env.LINE_OWNER_USER_ID||'',enabled=lineOutputEnabled(env);
 const allowedCode=errorCode===undefined||typeof errorCode==='string'&&errorCode.length<=100&&((reason==='REPORT_UNVERIFIED'&&/^REPORT_HEALTH_[A-Z_]+$/.test(errorCode))||(reason==='LEGACY_READ'&&/^LEGACY_COVERAGE_[A-Z_]+$/.test(errorCode))||(reason==='PENDING_UNDO'&&errorCode==='INSERT_DAILY_PENDING_CANCELLATION')||(reason==='SHEETS_READ'&&/^(?:(?:SHEETS_READ|GOOGLE_OAUTH)_(?:HTTP_[45][0-9]{2}|TIMEOUT)|GOOGLE_OAUTH_(?:CREDENTIAL_INVALID|NETWORK|RESPONSE_INVALID)|SHEETS_READ_(?:NETWORK|RESPONSE_TOO_LARGE))$/.test(errorCode)));
 if(env.STABLE_PHASE1_ENABLED!=='true'||!book||!lease||!claim||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(job.entityKey)||job.entityVersion!==1||!Number.isSafeInteger(sourceRevision)||sourceRevision<0||!/^[0-9a-f]{64}$/.test(sourceDigest)||typeof description!=='string'||!description.trim()||description.length>1000||!Number.isSafeInteger(amountSatang)||amountSatang<=0||!['MONTH_OPENING','ROW_FORMULA','CAPACITY','LEGACY_COVERAGE','REPORT_UNVERIFIED','LEGACY_READ','PENDING_UNDO','SHEETS_READ'].includes(reason)||!allowedCode)return null;
 const recoveryConfigured=recoveryGateConfigured(env),recoverySetting=env.STABLE_RECOVERY_GATE_ENABLED;if(recoveryConfigured&&!recoveryGateValid(env))return null;
 const detail=reason==='LEGACY_COVERAGE'?'ข้อมูลเดือนเดิมในชีตตรวจไม่ผ่าน':reason==='MONTH_OPENING'?'ยอดตั้งต้นในชีตตรวจไม่ผ่าน':reason==='ROW_FORMULA'?'สูตรในชีตตรวจไม่ผ่าน':reason==='REPORT_UNVERIFIED'?'รายงาน Sheets ตรวจสอบไม่ผ่าน':reason==='LEGACY_READ'?'อ่านข้อมูลชีตรายวันเดิมไม่สำเร็จ':reason==='SHEETS_READ'?(errorCode?.startsWith('GOOGLE_OAUTH_')?'ยืนยันสิทธิ์ Google ไม่สำเร็จ':'อ่านข้อมูล Sheets ไม่สำเร็จ'):reason==='PENDING_UNDO'?'มีรายการยกเลิกก่อนหน้ารอซิงก์':'พื้นที่ในชีตไม่เพียงพอ';
 const name=description.replace(/[\r\n\t]+/g,' ').trim().slice(0,80);
 const alert=await buildLineNotificationJob({to:owner,messages:[{type:'text',text:`⚠️ ยกเลิกค่าใช้จ่าย ${name} ${(amountSatang/100).toFixed(2)} บาทอัตโนมัติ เนื่องจาก${detail} ก่อนส่งข้อมูลรายการไป Sheets${errorCode?` (รหัส ${errorCode})`:''}`}],identity:`SYNC_PRE_DISPATCH_CANCEL:${job.entityKey}:${job.entityVersion}`,purpose:'SYNC_FAILURE',traceId:'sync-auto-cancel'});
 alert.traceId=`SYNC_AUTO_CANCEL:${alert.retryKey}`;
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||(env.LINE_OWNER_USER_ID||'')!==owner||lineOutputEnabled(env)!==enabled||env.STABLE_PHASE1_ENABLED!=='true'||env.STABLE_RECOVERY_GATE_ENABLED!==recoverySetting||recoveryGateConfigured(env)!==recoveryConfigured)return null;
 const deliverNow=!!owner&&enabled,auditId=crypto.randomUUID(),failedId=crypto.randomUUID(),now=new Date().toISOString(),jobKey=deliverNow?`LINE_NOTIFICATION:${alert.retryKey}`:`SYNC_AUTO_CANCEL_PENDING:${alert.retryKey}`;
 const guard=`${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousReportCutoverIntegrity} AND ${continuousAdmissionIntegrity} AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?) AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD') AND ${newStableSourcePredicate('EXPENSE')}
  AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version AND j.status='PROCESSING' AND j.attempt_count=1 AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version<>e.version)
  AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes w WHERE w.entity_type='EXPENSE' AND (w.entity_id=e.expense_id OR substr(w.entity_id,1,length(e.expense_id)+1)=e.expense_id||'|'))
  AND ((?=0 AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs recovery WHERE recovery.spreadsheet_id=? AND recovery.state IN ('ARMED','REVIEW'))) OR (?=1 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('stable_recovery_epoch_no_delete','stable_recovery_epoch_transition','stable_recovery_operation_no_delete','stable_recovery_operation_transition'))=4 AND EXISTS(SELECT 1 FROM stable_recovery_epochs recovery JOIN stable_recovery_operations op ON op.epoch_id=recovery.epoch_id WHERE recovery.spreadsheet_id=? AND recovery.state='ARMED' AND recovery.target_type='EXPENSE' AND recovery.target_key=e.expense_id AND recovery.target_version=e.version AND op.operation_token=? AND op.state='ADMITTED')))
  AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=e.expense_id OR substr(p.entity_id,1,length(e.expense_id)+1)=e.expense_id||'|'))
  AND NOT EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.entity_key=e.expense_id OR substr(i.entity_key,1,length(e.expense_id)+1)=e.expense_id||'|')
  AND NOT EXISTS(SELECT 1 FROM expense_documents d WHERE (d.expense_id=e.expense_id OR EXISTS(SELECT 1 FROM expense_document_links l WHERE l.expense_id=e.expense_id AND l.document_id=d.document_id)) AND (d.expense_id IS NOT e.expense_id OR d.status<>'CONFIRMED' OR EXISTS(SELECT 1 FROM expense_document_links other WHERE other.document_id=d.document_id AND other.expense_id<>e.expense_id)))
  AND NOT EXISTS(SELECT 1 FROM expense_document_cases dc WHERE dc.expense_id=e.expense_id)
  AND EXISTS(SELECT 1 FROM continuous_daily_cutovers cut WHERE cut.spreadsheet_id=? AND cut.state='ACTIVE' AND cut.continuous_sheet_id=? AND cut.continuous_sheet_name=? AND cut.raw_sheet_id=? AND cut.raw_sheet_name=? AND cut.detail_sheet_id=? AND cut.detail_sheet_name=? AND (EXISTS(SELECT 1 FROM continuous_daily_post_cutover_expenses post WHERE post.spreadsheet_id=cut.spreadsheet_id AND post.expense_id=e.expense_id) OR EXISTS(SELECT 1 FROM continuous_daily_source_admissions a WHERE a.spreadsheet_id=cut.spreadsheet_id AND a.expense_id=e.expense_id AND a.source_version=e.version AND a.source_digest=?)) AND (SELECT count(*) FROM continuous_report_cutover_attempts a WHERE a.spreadsheet_id=cut.spreadsheet_id AND a.stage IN ('VIEWS','DAILY_J','REPORTS') AND a.state='VERIFIED')=3)
  AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key='EXPENSE:'||e.expense_id||':'||e.version AND f.status='OPEN')`;
 const insertAudit=db.prepare(`INSERT INTO expense_audit_log(audit_id,actor_employee_id,action,expense_id,branch_id,reason,before_json,after_json,created_at)
  SELECT ?,NULL,'CANCEL',e.expense_id,e.branch_id,?,json_object('status','CONFIRMED','version',e.version),json_object('status','CANCELLED','version',e.version+1),? FROM expense_events e
  WHERE e.expense_id=? AND e.status='CONFIRMED' AND e.version=1 AND e.description=? AND e.amount_satang=? AND ${guard}`)
  .bind(auditId,`SYNC_PRE_DISPATCH_${reason}`,now,job.entityKey,description,amountSatang,sourceRevision,book,claim,job.entityKey,lease,Number(recoveryConfigured),book,Number(recoveryConfigured),book,claim,book,daily.sheetId,daily.sheet,Number(env.CONTINUOUS_RAW_SHEET_ID),env.CONTINUOUS_RAW_SHEET,Number(env.CONTINUOUS_DETAIL_SHEET_ID),env.CONTINUOUS_DETAIL_SHEET,sourceDigest);
 const updateSource=db.prepare(`UPDATE expense_events SET status='CANCELLED',version=version+1,updated_at=? WHERE expense_id=? AND status='CONFIRMED' AND version=1 AND changes()=1 AND EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=? AND expense_id=expense_events.expense_id)`).bind(now,job.entityKey,auditId);
 const updateDocs=db.prepare(`UPDATE expense_documents SET status='CANCELLED',updated_at=? WHERE expense_id=? AND status='CONFIRMED' AND EXISTS(SELECT 1 FROM expense_events e JOIN expense_audit_log a ON a.expense_id=e.expense_id WHERE e.expense_id=? AND e.status='CANCELLED' AND e.version=2 AND a.audit_id=?)`).bind(now,job.entityKey,job.entityKey,auditId);
 const finishJob=db.prepare(`UPDATE sync_jobs SET status='COMPLETED',last_error='STABLE_AUTO_CANCEL_PRE_DISPATCH',updated_at=?,next_attempt_at=NULL,lease_until=NULL,lease_token=NULL WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=1 AND status='PROCESSING' AND lease_token=? AND EXISTS(SELECT 1 FROM expense_events e JOIN expense_audit_log a ON a.expense_id=e.expense_id WHERE e.expense_id=? AND e.status='CANCELLED' AND e.version=2 AND a.audit_id=?)`).bind(now,job.entityKey,lease,job.entityKey,auditId);
 const payload=deliverNow?alert:{kind:'SYNC_AUTO_CANCEL_PENDING',expenseId:job.entityKey,version:job.entityVersion+1,reason,...(errorCode?{errorCode}:{})};
 const outbox=db.prepare(`INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) SELECT ?,'malipang-jobs',?,?,?,?,'OPEN',1,?,? WHERE changes()=1`).bind(failedId,alert.traceId,jobKey,JSON.stringify(payload),deliverNow?'PENDING_LINE_NOTIFICATION_DELIVERY':'SYNC_AUTO_CANCEL_AWAITING_RECIPIENT',now,now);
 // Deliberately fail the whole D1 transaction when any guard failed or the
 // outbox was not durably recorded. Delivery still needs Queue/cron wake-up.
 const requireOutbox=db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok");
 return {statements:[insertAudit,updateSource,updateDocs,finishJob,outbox,requireOutbox],notification:deliverNow?alert:null};
}

/** Caller must pass only a typed, proven pre-dispatch failure while it still
 * owns the claim. D1 batch atomically cancels and persists owner outbox; an
 * enqueue failure is recovered by the existing LINE outbox cron. */
export async function executeUnwrittenExpenseCancellation(env:Env,input:UnwrittenCancelInput,budget?:ReviewRequestBudget):Promise<boolean>{
 const recoverySetting=env.STABLE_RECOVERY_GATE_ENABLED,db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,owner=env.LINE_OWNER_USER_ID,enabled=lineOutputEnabled(env),gate=await buildUnwrittenExpenseCancellationCandidate(env,input);if(!gate)return false;
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||env.LINE_OWNER_USER_ID!==owner||lineOutputEnabled(env)!==enabled||env.STABLE_RECOVERY_GATE_ENABLED!==recoverySetting||!await assertContinuousDailyActivated(env))throw Error('SYNC_PRE_DISPATCH_SCOPE_CHANGED');
 const result=await db.batch(gate.statements);
 if(result.length!==6||result.some(r=>r.success!==true)||[0,1,3,4].some(i=>Number(result[i]!.meta?.changes)!==1))throw Error('SYNC_PRE_DISPATCH_OUTCOME_UNCERTAIN');
 if(gate.notification)try{budget?.consumeQueue();await env.JOB_QUEUE.send(gate.notification);}catch{/* Durable failed_jobs outbox is retried by scheduled recovery. */}
 return true;
}
