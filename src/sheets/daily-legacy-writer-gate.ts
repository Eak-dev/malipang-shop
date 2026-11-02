import type {Env,SheetsSyncJob} from '../types';

/** Opt-in cutover control for writers that run this code. It cannot stop an
 * old worker or an already-dispatched request and is not a Sheets CAS. */
export async function legacyDailyWriterOpen(env:Env):Promise<boolean>{
  // There is not yet a production stable writer route. If a stable flag is
  // enabled or malformed, never silently fall back to numeric-row writes.
  const stable=env.EXPENSE_STABLE_PROJECTION_ENABLED;
  if(stable!==undefined&&stable!==''&&stable!=='false')return false;
  const enabled=env.DAILY_LEGACY_WRITER_GATE_ENABLED;
  if(enabled===undefined||enabled===''||enabled==='false')return true;
  if(enabled!=='true')return false;
  if(!env.GOOGLE_SPREADSHEET_ID||!env.SHEET_EXPENSE_DAILY)return false;
  try{
    const gate=await env.DB.prepare(`SELECT state FROM daily_legacy_writer_gates WHERE spreadsheet_id=? AND sheet_name=?`).bind(env.GOOGLE_SPREADSHEET_ID,env.SHEET_EXPENSE_DAILY).first<{state:string}>();
    return gate?.state==='OPEN';
  }catch{return false;}
}

/** Keep a queue event in an existing or newly-created durable outbox before
 * acknowledging the queue. A PROCESSING job may still be in flight and must
 * be drained/reconciled separately; it is never automatically reclaimed. */
export async function holdLegacyExpenseJob(env:Env,job:SheetsSyncJob):Promise<'REVIEW'|'TERMINAL_HOLD'>{
  if(job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE')throw new Error('DAILY_LEGACY_GATE_JOB_INVALID');
  const now=new Date().toISOString();
  const insert=env.DB.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token) VALUES(?,'EXPENSE',?,?,?,'PENDING',0,?,?,NULL,NULL) ON CONFLICT(entity_type,entity_key,entity_version) DO NOTHING`).bind(crypto.randomUUID(),job.entityKey,job.entityVersion,job.traceId,now,now);
  const hold=env.DB.prepare(`UPDATE sync_jobs SET status='REVIEW',updated_at=?,next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error=CASE WHEN status='FAILED' AND last_error IS NOT NULL THEN last_error ELSE 'DAILY_LEGACY_CUTOVER_HOLD' END WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status IN ('PENDING','FAILED')`).bind(now,job.entityKey,job.entityVersion);
  const inspect=env.DB.prepare(`SELECT status FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=?`).bind(job.entityKey,job.entityVersion);
  const result=await env.DB.batch<{status:string}>([insert,hold,inspect]);
  const status=result[2]?.results?.[0]?.status;
  if(status==='REVIEW')return 'REVIEW';
  // Both states have a durable outbox. PROCESSING is reconciled by the
  // existing stale-lease maintenance; never create an endless resend loop or
  // resolve prior failure alerts merely because the gate is closed.
  if(status==='PROCESSING'||status==='COMPLETED')return 'TERMINAL_HOLD';
  throw new Error('DAILY_LEGACY_CUTOVER_OUTBOX_STATE_UNVERIFIED');
}
