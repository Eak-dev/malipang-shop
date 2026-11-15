import { buildLineNotificationJob } from './attendance-notification';
import { lineOutputEnabled } from './api';
import type {Env,LineNotificationJob} from '../types';

type DurableIncident={incident_id:number;kind:'JOB'|'WORKBOOK'|'TERMINAL';category:string;state:'OPEN'|'CLOSED';entity_type:string|null;description:string|null;amount_satang:number|null;review_reason:string|null;last_error:string|null};
const prefix='SYNC_ALERT';

async function sendPersisted(env:Env,job:LineNotificationJob):Promise<void>{
 try{await env.JOB_QUEUE.send(job);}catch{
  // The record is already durable; the existing notification recovery sends it.
  await env.DB.prepare("UPDATE failed_jobs SET error='LINE_NOTIFICATION_ENQUEUE_FAILED',updated_at=? WHERE queue_name='malipang-jobs' AND trace_id=? AND job_key=? AND status='OPEN' AND error='PENDING_LINE_NOTIFICATION_DELIVERY'")
   .bind(new Date().toISOString(),job.traceId,`LINE_NOTIFICATION:${job.retryKey}`).run();
 }
}

/** Trigger a separate Queue invocation: a notification failure cannot replay a
 * Sheets writer, and a failed wake-up is recovered by the scheduled sweep. */
export async function wakeSyncFailureAlerts(env:Env):Promise<void>{
 if(!lineOutputEnabled(env))return;
 try{await env.JOB_QUEUE.send({kind:'SYNC_ALERT_SWEEP',traceId:'sync-alert-sweep'});}catch{ /* cron scans durable state */ }
}

/** A proven-unwritten expense is cancelled even when LINE is unavailable.
 * Its minimal incident is upgraded to a normal durable LINE outbox once an
 * owner recipient and output become available. The original incident stores
 * no merchant, amount or receipt data. */
export async function recoverDeferredAutoCancelAlerts(env:Env,limit=4):Promise<number>{
 if(!lineOutputEnabled(env)||!env.LINE_OWNER_USER_ID)return 0;
 const db=env.DB,owner=env.LINE_OWNER_USER_ID,safeLimit=Number.isFinite(limit)?Math.min(20,Math.max(1,Math.floor(limit))):4;
 const rows=await db.prepare(`SELECT f.id,f.updated_at,f.payload_json,e.description,e.amount_satang FROM failed_jobs f LEFT JOIN expense_events e ON e.expense_id=json_extract(CASE WHEN json_valid(f.payload_json) THEN f.payload_json ELSE '{}' END,'$.expenseId') AND e.status='CANCELLED' AND e.version=json_extract(CASE WHEN json_valid(f.payload_json) THEN f.payload_json ELSE '{}' END,'$.version') WHERE f.queue_name='malipang-jobs' AND f.status='OPEN' AND f.error='SYNC_AUTO_CANCEL_AWAITING_RECIPIENT' ORDER BY f.created_at LIMIT ?`).bind(safeLimit).all<{id:string;updated_at:string;payload_json:string;description:string|null;amount_satang:number|null}>();
 if(rows.success===false||!Array.isArray(rows.results))throw Error('SYNC_AUTO_CANCEL_INCIDENT_READ');
 let enqueued=0;
 for(const row of rows.results){
  let incident:{kind?:unknown;expenseId?:unknown;version?:unknown;reason?:unknown;errorCode?:unknown};try{incident=JSON.parse(row.payload_json) as typeof incident}catch{continue;}
  if(incident.kind!=='SYNC_AUTO_CANCEL_PENDING'||typeof incident.expenseId!=='string'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(incident.expenseId)||incident.version!==2||!['MONTH_OPENING','ROW_FORMULA','CAPACITY','LEGACY_COVERAGE','REPORT_UNVERIFIED','LEGACY_READ','PENDING_UNDO','SHEETS_READ'].includes(String(incident.reason)))continue;
  const code=typeof incident.errorCode==='string'&&incident.errorCode.length<=100&&((incident.reason==='REPORT_UNVERIFIED'&&/^REPORT_HEALTH_[A-Z_]+$/.test(incident.errorCode))||(incident.reason==='LEGACY_READ'&&/^LEGACY_COVERAGE_[A-Z_]+$/.test(incident.errorCode))||(incident.reason==='PENDING_UNDO'&&incident.errorCode==='INSERT_DAILY_PENDING_CANCELLATION')||(incident.reason==='SHEETS_READ'&&/^(?:(?:SHEETS_READ|GOOGLE_OAUTH)_(?:HTTP_[45][0-9]{2}|TIMEOUT)|GOOGLE_OAUTH_(?:CREDENTIAL_INVALID|NETWORK|RESPONSE_INVALID)|SHEETS_READ_NETWORK)$/.test(incident.errorCode)))?incident.errorCode:'';
  const why=incident.reason==='LEGACY_COVERAGE'?'ข้อมูลเดือนเดิมในชีตตรวจไม่ผ่าน':incident.reason==='MONTH_OPENING'?'ยอดตั้งต้นในชีตตรวจไม่ผ่าน':incident.reason==='ROW_FORMULA'?'สูตรในชีตตรวจไม่ผ่าน':incident.reason==='REPORT_UNVERIFIED'?'รายงาน Sheets ตรวจสอบไม่ผ่าน':incident.reason==='LEGACY_READ'?'อ่านข้อมูลชีตรายวันเดิมไม่สำเร็จ':incident.reason==='SHEETS_READ'?(code.startsWith('GOOGLE_OAUTH_')?'ยืนยันสิทธิ์ Google ไม่สำเร็จ':'อ่านข้อมูล Sheets ไม่สำเร็จ'):incident.reason==='PENDING_UNDO'?'มีรายการยกเลิกก่อนหน้ารอซิงก์':'พื้นที่ในชีตไม่เพียงพอ';
  const name=typeof row.description==='string'&&row.description.trim()?` ${row.description.replace(/[\r\n\t]+/g,' ').trim().slice(0,80)}`:' 1 รายการ',amount=Number.isSafeInteger(row.amount_satang)&&Number(row.amount_satang)>0?` ${(Number(row.amount_satang)/100).toFixed(2)} บาท`:'';
  const job=await buildLineNotificationJob({to:owner,messages:[{type:'text',text:`⚠️ ยกเลิกค่าใช้จ่าย${name}${amount}อัตโนมัติ เนื่องจาก${why} ก่อนส่งข้อมูลรายการไป Sheets${code?` (รหัส ${code})`:''}`}],identity:`SYNC_AUTO_CANCEL_DEFERRED:${row.id}`,purpose:'SYNC_FAILURE',traceId:'pending'});job.traceId=`SYNC_AUTO_CANCEL_DEFERRED:${job.retryKey}`;
  if(env.DB!==db||env.LINE_OWNER_USER_ID!==owner||!lineOutputEnabled(env))throw Error('SYNC_AUTO_CANCEL_SCOPE_CHANGED');
  const now=new Date().toISOString(),key=`LINE_NOTIFICATION:${job.retryKey}`;
  const result=await db.batch([
   db.prepare(`INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) SELECT ?,'malipang-jobs',?,?,?,'PENDING_LINE_NOTIFICATION_DELIVERY','OPEN',1,?,? WHERE EXISTS(SELECT 1 FROM failed_jobs f WHERE f.id=? AND f.status='OPEN' AND f.error='SYNC_AUTO_CANCEL_AWAITING_RECIPIENT' AND f.updated_at=?) ON CONFLICT(queue_name,trace_id,job_key) DO NOTHING`).bind(crypto.randomUUID(),job.traceId,key,JSON.stringify(job),now,now,row.id,row.updated_at),
   db.prepare(`UPDATE failed_jobs SET status='RESOLVED',resolved_at=?,updated_at=? WHERE id=? AND status='OPEN' AND error='SYNC_AUTO_CANCEL_AWAITING_RECIPIENT' AND updated_at=? AND EXISTS(SELECT 1 FROM failed_jobs n WHERE n.queue_name='malipang-jobs' AND n.trace_id=? AND n.job_key=?)`).bind(now,now,row.id,row.updated_at,job.traceId,key)
  ]);
  if(result.length!==2||result.some(x=>x.success===false||!Number.isSafeInteger(x.meta?.changes))||Number(result[0]!.meta.changes)>1||Number(result[1]!.meta.changes)>1)throw Error('SYNC_AUTO_CANCEL_OUTBOX_UNCERTAIN');
  if(Number(result[0]!.meta.changes)===1){if(Number(result[1]!.meta.changes)!==1)throw Error('SYNC_AUTO_CANCEL_OUTBOX_UNCERTAIN');await sendPersisted(env,job);enqueued++;}
 }
 return enqueued;
}

/** Batch the outbox insert and the incident markers in one transaction. A
 * completed/resolved source never erases an unannounced incident. */
async function persistIncidentAlert(env:Env,incidents:DurableIncident[],message:string):Promise<number>{
 if(!incidents.length)return 0;
 const ids=[...new Set(incidents.map(x=>x.incident_id))].sort((a,b)=>a-b);
 if(ids.some(id=>!Number.isSafeInteger(id)||id<1))throw Error('SYNC_ALERT_INCIDENT_INVALID');
 const idsJson=JSON.stringify(ids),now=new Date().toISOString(),identity=`${prefix}_INCIDENT:${idsJson}`;
 const job=await buildLineNotificationJob({to:env.LINE_OWNER_USER_ID,messages:[{type:'text',text:message}],identity,purpose:'SYNC_FAILURE',traceId:'sync-incident-placeholder'});
 job.traceId=`${prefix}_INCIDENT:${job.retryKey}`;
 const jobKey=`LINE_NOTIFICATION:${job.retryKey}`;
 const insert=env.DB.prepare(`INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at)
  SELECT ?,'malipang-jobs',?,?,?,'PENDING_LINE_NOTIFICATION_DELIVERY','OPEN',1,?,?
  WHERE (SELECT count(*) FROM sync_alert_incidents i JOIN json_each(?) x ON i.incident_id=x.value WHERE i.alerted_at IS NULL)=?
  ON CONFLICT(queue_name,trace_id,job_key) DO NOTHING`)
  .bind(crypto.randomUUID(),job.traceId,jobKey,JSON.stringify(job),now,now,idsJson,ids.length);
 const mark=env.DB.prepare(`UPDATE sync_alert_incidents SET alerted_at=? WHERE incident_id IN (SELECT value FROM json_each(?)) AND alerted_at IS NULL
  AND EXISTS(SELECT 1 FROM failed_jobs WHERE queue_name='malipang-jobs' AND trace_id=? AND job_key=?)`).bind(now,idsJson,job.traceId,jobKey);
 const results=await env.DB.batch([insert,mark]);
 if(results.length!==2||results.some(x=>x.success===false||!Number.isSafeInteger(x.meta?.changes))||Number(results[0]!.meta.changes)>1||![0,ids.length].includes(Number(results[1]!.meta.changes)))throw Error('SYNC_ALERT_INCIDENT_OUTBOX_UNCERTAIN');
 if(Number(results[0]!.meta.changes)!==1)return 0;
 if(Number(results[1]!.meta.changes)!==ids.length)throw Error('SYNC_ALERT_INCIDENT_OUTBOX_UNCERTAIN');
 await sendPersisted(env,job);return ids.length;
}

function durableIncidentText(row:DurableIncident):string{
 if(row.kind==='WORKBOOK'){
  // The claim stores static fault codes, not provider payloads. Allowlist the
  // explanations; do not forward free-form errors or operation identifiers.
  const reason=String(row.review_reason||'');
  const status=/(?:^|:)HTTP_(\d{3})$/.exec(reason)?.[1];
  const detail=reason.startsWith('SHEETS_MUTATION_OUTCOME_UNKNOWN:')
   ? 'ส่งคำสั่งไป Sheets แล้วแต่ยังยืนยันผลไม่ได้'
   : reason==='CONTINUOUS_SYNC_LEASE_EXPIRED_UNCERTAIN'?'งานซิงก์หมดเวลาการประมวลผล ผลใน Sheets ยังไม่ชัดเจน (รหัส CONTINUOUS_SYNC_LEASE_EXPIRED_UNCERTAIN)'
   : status==='401'||status==='403'?'สิทธิ์เข้าถึง Sheets ไม่ผ่าน':status==='429'?'Sheets จำกัดจำนวนคำขอชั่วคราว':
     status&&Number(status)>=500?'บริการ Sheets ขัดข้องชั่วคราว':
     reason==='TIMEOUT'?'การเชื่อมต่อหมดเวลา':
     reason==='WORKER_SUBREQUEST_LIMIT'?'งานซิงก์เกินจำนวนคำขอที่ระบบรองรับ':
     reason==='D1_QUERY_LIMIT'?'งานซิงก์เกินจำนวนคำสั่งฐานข้อมูลที่ระบบรองรับ':'ยังระบุสาเหตุที่แน่ชัดไม่ได้';
  return `⚠️ ระบบพบการพักซิงก์เพื่อตรวจสอบผลใน Sheets\nสาเหตุ: ${detail}\nโปรดตรวจสถานะล่าสุดก่อนส่งรายการซ้ำ`;
 }
 const name=row.entity_type==='EXPENSE'
  ? `ค่าใช้จ่าย${row.description?` ${String(row.description).replace(/[\r\n\t]+/g,' ').slice(0,80)}`:''}${Number.isFinite(row.amount_satang)&&Number(row.amount_satang)>0?` ${(Number(row.amount_satang)/100).toFixed(2)} บาท`:''}`
  : 'ข้อมูลงานรายงาน';
 const detail=row.last_error==='CONTINUOUS_SYNC_LEASE_EXPIRED_UNCERTAIN'?'งานซิงก์หมดเวลาการประมวลผล ผลใน Sheets ยังไม่ชัดเจน (รหัส CONTINUOUS_SYNC_LEASE_EXPIRED_UNCERTAIN)':row.last_error==='CONTINUOUS_CONFIRM_VERSION_GAP'?'รุ่นของรายการที่ยืนยันไม่ต่อเนื่อง ผลใน Sheets ยังต้องตรวจสอบ (รหัส CONTINUOUS_CONFIRM_VERSION_GAP)':row.last_error==='CONTINUOUS_SYNC_HISTORY_UNRECONCILED'?'รายการมีประวัติซิงก์ที่ยังไม่ได้ตรวจผลใน Sheets (รหัส CONTINUOUS_SYNC_HISTORY_UNRECONCILED)':row.last_error==='CONTINUOUS_PRE_CUTOVER_UNRECONCILED'?'รายการก่อนเปลี่ยนชีตยังไม่ได้ตรวจผลเดิมใน Sheets (รหัส CONTINUOUS_PRE_CUTOVER_UNRECONCILED)':row.last_error==='CONTINUOUS_UNDO_VERSION_GAP'?'รุ่นของรายการยกเลิกไม่ต่อเนื่อง ผลใน Sheets ยังต้องตรวจสอบ (รหัส CONTINUOUS_UNDO_VERSION_GAP)':row.category==='MONTH_OPENING'?'ยอดตั้งต้นในชีตรายวันตรวจไม่ผ่าน':
  row.category==='ROW_FORMULA'?'สูตรในชีตรายวันตรวจไม่ผ่าน':
  row.category==='CAPACITY'?'พื้นที่ของเดือนในชีตรายวันไม่เพียงพอ':
  row.category==='CANCELLED_OR_SUPERSEDED'?'รายการถูกยกเลิกหรือมีข้อมูลรุ่นใหม่ ต้องตรวจผลในชีต':
  row.category==='FAILED'?'การซิงก์ล้มเหลว':'ผลการซิงก์ยังไม่ชัดเจน ต้องตรวจสอบ';
 return `⚠️ ${name}: ${row.state==='CLOSED'?'เคยพบปัญหา — ':''}${detail}\nโปรดตรวจสถานะล่าสุดใน Sheets ก่อนส่งรายการซ้ำ`;
}

async function sweepDurableSyncFailureAlerts(env:Env,limit:number):Promise<number>{
 const rows=await env.DB.prepare(`SELECT i.incident_id,i.kind,i.category,i.state,s.entity_type,s.last_error,e.description,e.amount_satang,c.review_reason
  FROM sync_alert_incidents i LEFT JOIN sync_jobs s ON i.kind='JOB' AND s.job_id=i.source_id
  LEFT JOIN expense_events e ON s.entity_type='EXPENSE' AND e.expense_id=s.entity_key
  LEFT JOIN stable_workbook_claims c ON i.kind='WORKBOOK' AND i.state='OPEN' AND c.state='REVIEW' AND CAST(c.rowid AS TEXT)=i.source_id
  WHERE i.alerted_at IS NULL ORDER BY i.incident_id LIMIT ?`).bind(limit).all<DurableIncident>();
 if(rows.success===false||!Array.isArray(rows.results))throw Error('SYNC_ALERT_INCIDENT_READ_UNVERIFIED');
 if(rows.results.length&&!env.LINE_OWNER_USER_ID)throw Error('SYNC_ALERT_OWNER_UNAVAILABLE');
 let sent=0;const terminal=rows.results.filter(x=>x.kind==='TERMINAL');
 for(const row of rows.results.filter(x=>x.kind!=='TERMINAL'))sent+=await persistIncidentAlert(env,[row],durableIncidentText(row));
 if(terminal.length)sent+=await persistIncidentAlert(env,terminal,`⚠️ พบงานซิงก์ ${terminal.length} งานที่ไม่สำเร็จหลังลองซ้ำ ต้องตรวจสอบก่อนดำเนินการต่อ\nผลใน Sheets อาจยังไม่แน่ชัด กรุณาอย่าส่งรายการซ้ำ`);
 return sent;
}

/** Migration 0025 makes the source transition itself durable. Null explicitly
 * means unavailable, never a successful empty scan. Older installations keep
 * their pre-existing notification recovery until the migration is applied. */
export async function syncFailureAlertSchemaReady(env:Env):Promise<boolean>{
 const schema=await env.DB.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='sync_alert_incidents'").first<{n:number}>();
 if(!schema||!Number.isSafeInteger(schema.n)||schema.n<0||schema.n>1)throw Error('SYNC_ALERT_SCHEMA_UNVERIFIED');
 if(schema.n===0)return false;
 const triggers=await env.DB.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND (
  (tbl_name='sync_jobs' AND name IN ('sync_alert_job_insert','sync_alert_job_update','sync_alert_job_complete','sync_alert_job_delete')) OR
  (tbl_name='stable_workbook_claims' AND name IN ('sync_alert_claim_insert','sync_alert_claim_update','sync_alert_claim_release','sync_alert_claim_resume')) OR
  (tbl_name='failed_jobs' AND name IN ('sync_alert_terminal_insert','sync_alert_terminal_update','sync_alert_terminal_resolve','sync_alert_terminal_delete')))` ).first<{n:number}>();
 return !!triggers&&triggers.n===12;
}
export async function sweepSyncFailureAlerts(env:Env,limit=4):Promise<number|null>{
 if(!lineOutputEnabled(env)||!await syncFailureAlertSchemaReady(env))return null;
 return sweepDurableSyncFailureAlerts(env,Math.min(4,Math.max(1,Math.floor(limit))));
}
