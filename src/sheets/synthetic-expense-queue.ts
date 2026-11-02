import type {Env,SheetsSyncJob} from '../types';
import {assertStableShadowConfig,assertStableShadowDatabase} from './daily-stable-row-shadow';
import {classifyStableShadowSource} from './daily-stable-cutover';
import {assertSyntheticLedgerUat,runSyntheticDailyAndRawCoreWorkflow} from './synthetic-expense-workflow';

export const SYNTHETIC_QUEUE_NAME='malipang-projection-uat';
export const SYNTHETIC_DLQ_NAME='malipang-projection-uat-dlq';
export const SYNTHETIC_PROBE_VALID_MS=15*60_000;
export interface SyntheticQueueMessage{kind:'SYNTHETIC_PROJECTION_UAT';version:number}
export interface SyntheticQueueProbe{kind:'SYNTHETIC_PROJECTION_QUEUE_PROBE';workerVersionId:string;token:string}
export function hasSyntheticQueueKind(message:unknown):boolean{return !!message&&typeof message==='object'&&!Array.isArray(message)&&['SYNTHETIC_PROJECTION_UAT','SYNTHETIC_PROJECTION_QUEUE_PROBE'].includes(String((message as Record<string,unknown>).kind));}

async function assertSyntheticQueue(env:Env):Promise<string>{
  const id=env.DAILY_STABLE_UAT_NEW_EXPENSE_ID||'';
  if(env.RUNTIME_MODE!=='shadow'||env.SYNTHETIC_PROJECTION_UAT_ENABLED!=='true'||!env.SYNTHETIC_PROJECTION_UAT_QUEUE||!env.SYNTHETIC_VERSION_METADATA?.id||!/^[A-Za-z0-9_-]{8,128}$/.test(env.SYNTHETIC_VERSION_METADATA.id))throw new Error('SYNTHETIC_QUEUE_DISABLED');
  assertStableShadowConfig(env,id);await assertStableShadowDatabase(env);await assertSyntheticLedgerUat(env);return id;
}
function validProbe(message:unknown):message is SyntheticQueueProbe{
  if(!message||typeof message!=='object'||Array.isArray(message))return false;const v=message as Record<string,unknown>;
  return Object.keys(v).sort().join(',')==='kind,token,workerVersionId'&&v.kind==='SYNTHETIC_PROJECTION_QUEUE_PROBE'&&typeof v.workerVersionId==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(v.workerVersionId)&&typeof v.token==='string'&&/^[0-9a-f-]{36}$/.test(v.token);
}
async function verifiedProbe(env:Env):Promise<boolean>{
  const now=Date.now(),row=await env.DB.prepare(`SELECT state FROM synthetic_projection_queue_probes WHERE worker_version_id=? AND updated_at>=? AND updated_at<=?`).bind(env.SYNTHETIC_VERSION_METADATA!.id,new Date(now-SYNTHETIC_PROBE_VALID_MS).toISOString(),new Date(now).toISOString()).first<{state:string}>();return row?.state==='VERIFIED';
}

/** An explicit one-shot probe must reach the correctly named QA consumer with
 * the same provider-supplied Worker version and independently marked DB before
 * job envelopes can be sent. It does not prove other consumers are absent. */
export async function startSyntheticQueueProbe(env:Env):Promise<boolean>{
  await assertSyntheticQueue(env);const version=env.SYNTHETIC_VERSION_METADATA!.id,token=crypto.randomUUID(),now=new Date().toISOString();
  const result=await env.DB.prepare(`INSERT INTO synthetic_projection_queue_probes(worker_version_id,probe_token,state,updated_at) VALUES(?,?,'PENDING',?) ON CONFLICT(worker_version_id) DO NOTHING`).bind(version,token,now).run();
  if(Number(result.meta.changes||0)!==1)return false;
  await env.SYNTHETIC_PROJECTION_UAT_QUEUE!.send({kind:'SYNTHETIC_PROJECTION_QUEUE_PROBE',workerVersionId:version,token});return true;
}
/** Called only by the dedicated named consumer. Duplicate delivery is safe. */
export async function acceptSyntheticQueueProbe(env:Env,message:unknown,deadLetter=false):Promise<boolean>{
  await assertSyntheticQueue(env);if(!validProbe(message)||message.workerVersionId!==env.SYNTHETIC_VERSION_METADATA!.id)return false;
  const now=new Date().toISOString(),state=deadLetter?'REVIEW':'VERIFIED';
  const result=await env.DB.prepare(`UPDATE synthetic_projection_queue_probes SET state=?,updated_at=? WHERE worker_version_id=? AND probe_token=? AND state='PENDING'`).bind(state,now,message.workerVersionId,message.token).run();
  if(Number(result.meta.changes||0)===1)return true;
  const row=await env.DB.prepare(`SELECT state FROM synthetic_projection_queue_probes WHERE worker_version_id=? AND probe_token=?`).bind(message.workerVersionId,message.token).first<{state:string}>();
  return row?.state===state;
}
export function isSyntheticQueueMessage(message:unknown):message is SyntheticQueueMessage{
  if(!message||typeof message!=='object'||Array.isArray(message))return false;
  const value=message as Record<string,unknown>;
  return Object.keys(value).sort().join(',')==='kind,version'&&value.kind==='SYNTHETIC_PROJECTION_UAT'&&Number.isSafeInteger(value.version)&&Number(value.version)>0;
}

/** Reserve a bounded re-send interval in D1 before publishing. A failed or
 * uncertain queue send leaves the durable business outbox PENDING and may be
 * retried after that interval. A message contains no expense data or row. */
export async function scheduleSyntheticProjection(env:Env,nowMs=Date.now()):Promise<boolean>{
  const id=await assertSyntheticQueue(env),now=new Date(nowMs).toISOString(),next=new Date(nowMs+300_000).toISOString();
  if(!await verifiedProbe(env))return false;
  const source=await env.DB.prepare(`SELECT e.version FROM expense_events e JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version WHERE e.expense_id=? AND e.status='CONFIRMED' AND j.status IN ('PENDING','FAILED') AND (j.next_attempt_at IS NULL OR j.next_attempt_at<=?) AND NOT EXISTS(SELECT 1 FROM sync_jobs h WHERE h.entity_type='EXPENSE' AND h.entity_key=e.expense_id AND h.status IN ('PROCESSING','REVIEW'))`).bind(id,now).first<{version:number}>();
  if(!source||!Number.isSafeInteger(Number(source.version)))return false;
  const eligible=await classifyStableShadowSource(env,id,Number(source.version));
  if(eligible.kind==='REVIEW'){
    await env.DB.prepare(`UPDATE sync_jobs SET status='REVIEW',updated_at=?,next_attempt_at=NULL,last_error=CASE WHEN status='FAILED' AND last_error IS NOT NULL THEN last_error ELSE 'SYNTHETIC_SOURCE_REVIEW_REQUIRED' END WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status IN ('PENDING','FAILED')`).bind(now,id,source.version).run();return false;
  }
  const reserved=await env.DB.prepare(`INSERT INTO synthetic_projection_dispatches(expense_id,expense_version,cutover_generation,next_attempt_at,updated_at)
    SELECT e.expense_id,e.version,?,?,? FROM expense_events e JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version
    JOIN daily_stable_cutovers c ON c.spreadsheet_id=? AND c.sheet_name=? AND c.state='ACTIVE' AND c.generation=? AND c.source_watermark=?
    WHERE e.expense_id=? AND e.status='CONFIRMED' AND e.version=? AND j.status IN ('PENDING','FAILED') AND (j.next_attempt_at IS NULL OR j.next_attempt_at<=?) AND NOT EXISTS(SELECT 1 FROM sync_jobs h WHERE h.entity_type='EXPENSE' AND h.entity_key=e.expense_id AND h.status IN ('PROCESSING','REVIEW'))
    ON CONFLICT(expense_id,expense_version,cutover_generation) DO UPDATE SET next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at WHERE synthetic_projection_dispatches.next_attempt_at<=?`).bind(eligible.generation,next,now,env.GOOGLE_SPREADSHEET_ID,env.SHEET_EXPENSE_DAILY,eligible.generation,eligible.watermark,id,source.version,now,now).run();
  if(Number(reserved.meta.changes||0)!==1)return false;
  await env.SYNTHETIC_PROJECTION_UAT_QUEUE!.send({kind:'SYNTHETIC_PROJECTION_UAT',version:Number(source.version)});return true;
}

/** Only a pre-existing synthetic outbox can authorize consuming a message. */
export async function processSyntheticProjection(env:Env,message:unknown):Promise<'ACK'|'RETRY'>{
  const id=await assertSyntheticQueue(env);if(!isSyntheticQueueMessage(message))throw new Error('SYNTHETIC_QUEUE_MESSAGE_INVALID');
  if(!await verifiedProbe(env))throw new Error('SYNTHETIC_QUEUE_PROBE_UNVERIFIED');
  const row=await env.DB.prepare(`SELECT status FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=?`).bind(id,message.version).first<{status:string}>();
  if(!row)throw new Error('SYNTHETIC_QUEUE_OUTBOX_MISSING');
  if(row.status==='REVIEW'||row.status==='COMPLETED')return 'ACK';
  const job:SheetsSyncJob={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:id,entityVersion:message.version,traceId:'synthetic-uat'};
  const result=await runSyntheticDailyAndRawCoreWorkflow(env,job,{beforeDispatch:async()=>{await assertSyntheticQueue(env);if(!await verifiedProbe(env))throw new Error('SYNTHETIC_QUEUE_PROBE_UNVERIFIED');}});
  if(result==='BUSY')return 'RETRY';
  const current=await env.DB.prepare(`SELECT status FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=?`).bind(id,message.version).first<{status:string}>();
  return current?.status==='REVIEW'||current?.status==='COMPLETED'?'ACK':'RETRY';
}

/** A QA DLQ message can be acknowledged only while its durable outbox exists;
 * PENDING jobs are recovered by the QA scheduler, not by a blind DLQ replay. */
export async function syntheticDeadLetterIsDurable(env:Env,message:unknown):Promise<boolean>{
  const id=await assertSyntheticQueue(env);if(!isSyntheticQueueMessage(message))return false;
  if(!await verifiedProbe(env))return false;
  const row=await env.DB.prepare(`SELECT status FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=?`).bind(id,message.version).first<{status:string}>();
  return !!row&&['PENDING','FAILED','PROCESSING','REVIEW','COMPLETED'].includes(row.status);
}

/** Scheduler is isolated to the single configured synthetic expense. Never
 * reclaim an expired PROCESSING lease: a paused request might still arrive. */
export async function recoverSyntheticProjection(env:Env,nowMs=Date.now()):Promise<boolean>{
  const id=await assertSyntheticQueue(env),now=new Date(nowMs).toISOString();
  if(!await verifiedProbe(env))return false;
  await env.DB.prepare(`UPDATE sync_jobs SET status='REVIEW',updated_at=?,next_attempt_at=NULL,last_error='SYNTHETIC_EXPIRED_REVIEW_REQUIRED' WHERE entity_type='EXPENSE' AND entity_key=? AND status='PROCESSING' AND (lease_until IS NULL OR lease_until<=?)`).bind(now,id,now).run();
  await env.DB.prepare(`UPDATE sync_jobs SET status='REVIEW',updated_at=?,next_attempt_at=NULL,last_error=CASE WHEN status='FAILED' AND last_error IS NOT NULL THEN last_error ELSE 'SYNTHETIC_SUPERSEDED_REVIEW_REQUIRED' END WHERE entity_type='EXPENSE' AND entity_key=? AND status IN ('PENDING','FAILED') AND NOT EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=sync_jobs.entity_key AND e.version=sync_jobs.entity_version AND e.status='CONFIRMED')`).bind(now,id).run();
  return scheduleSyntheticProjection(env,nowMs);
}
