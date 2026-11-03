import type {Env} from '../types';
import {discoverExpenseProjectionGenerations} from './expense-projection-generation-observer';

export interface ExpenseGenerationKey{spreadsheetId:string;generation:string;expenseId:string;version:number;revision:number}
function check(env:Env):void{
  if(env.RUNTIME_MODE!=='production'||env.EXPENSE_GENERATION_SCHEDULER_ENABLED!=='true'||env.EXPENSE_STABLE_PROJECTION_ENABLED!=='true'||env.DAILY_LEGACY_WRITER_GATE_ENABLED!=='true'||!env.GOOGLE_SPREADSHEET_ID||!env.SHEET_EXPENSE_DAILY||!env.SHEET_EXPENSE_RAW)throw Error('EXPENSE_GENERATION_QUEUE_DISABLED');
}
// This is a discovery/claim precondition, not a Google Sheets lock and not a
// replacement for the canonical per-projection fence immediately before send.
function eligible(alias:string,matchRevision=true):string{return `EXISTS(SELECT 1 FROM expense_events e
  JOIN expense_projection_source_revisions r ON r.expense_id=e.expense_id AND r.state='TRACKED' AND typeof(r.revision)='integer' AND r.revision BETWEEN 1 AND 9007199254740991 ${matchRevision?`AND r.revision=${alias}.source_revision`:''}
  JOIN expense_projection_admissions a ON a.expense_id=e.expense_id
  JOIN expense_projection_cutovers c ON c.spreadsheet_id=${alias}.spreadsheet_id AND c.sheet_name=? AND c.state='ACTIVE' AND c.generation=${alias}.cutover_generation AND a.sequence>c.admission_watermark
  JOIN daily_legacy_writer_gates g ON g.spreadsheet_id=c.spreadsheet_id AND g.sheet_name=c.sheet_name AND g.state='HOLD' AND g.generation=c.generation
  WHERE e.expense_id=${alias}.expense_id AND e.status='CONFIRMED' AND typeof(e.version)='integer' AND e.version BETWEEN 1 AND 9007199254740991 ${matchRevision?`AND e.version=${alias}.source_version`:''}
  AND NOT EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.sheet_name IN (?,?,?) AND (i.entity_key=e.expense_id OR substr(i.entity_key,1,length(e.expense_id)+1)=e.expense_id||'|'))
  AND NOT EXISTS(SELECT 1 FROM expense_projection_generation_observations seen WHERE seen.spreadsheet_id=${alias}.spreadsheet_id AND seen.expense_id=e.expense_id AND seen.source_revision>r.revision)
  AND NOT EXISTS(SELECT 1 FROM expense_projection_generation_jobs seen WHERE seen.spreadsheet_id=${alias}.spreadsheet_id AND seen.expense_id=e.expense_id AND seen.source_revision>r.revision)
  AND NOT EXISTS(SELECT 1 FROM expense_projection_runtime_intents p WHERE p.spreadsheet_id=${alias}.spreadsheet_id AND p.expense_id=e.expense_id AND p.state IN ('IN_FLIGHT','REVIEW'))
  AND NOT EXISTS(SELECT 1 FROM expense_projection_generation_jobs prior WHERE prior.spreadsheet_id=${alias}.spreadsheet_id AND prior.expense_id=e.expense_id AND prior.state IN ('IN_FLIGHT','REVIEW')))`;}
function eligibilityArgs(env:Env):string[]{return[env.SHEET_EXPENSE_DAILY,env.SHEET_EXPENSE_DAILY,env.SHEET_EXPENSE_RAW,env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ'];}

/** Cron entry point. It only creates durable D1 work; it never sends a queue
 * message or writes Sheets. The new consumer and provider path do not exist. */
export async function runExpenseGenerationScheduler(env:Env):Promise<void>{
  check(env);await discoverExpenseProjectionGenerations(env,100);
  const expired=env.DB.prepare(`UPDATE expense_projection_generation_jobs SET state='REVIEW',reason='LEASE_EXPIRED_OUTCOME_UNKNOWN',lease_token=NULL,lease_until=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND state='IN_FLIGHT' AND lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(env.GOOGLE_SPREADSHEET_ID);
  // A previously superseded revision becoming current again is evidence of a
  // rollback or lost tracking. Never silently leave it buried as completed.
  const rollback=env.DB.prepare(`UPDATE expense_projection_generation_jobs AS q SET state='REVIEW',reason='SOURCE_REVISION_ROLLBACK_OR_MISSING',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE q.spreadsheet_id=? AND q.state='SUPERSEDED' AND NOT EXISTS(SELECT 1 FROM expense_events e JOIN expense_projection_source_revisions r ON r.expense_id=e.expense_id WHERE e.expense_id=q.expense_id AND r.state='TRACKED' AND typeof(r.revision)='integer' AND r.revision>q.source_revision)`).bind(env.GOOGLE_SPREADSHEET_ID);
  // PENDING has never been claimed, and there is no transition back to it.
  // Its CAS update races safely with claim: only one can change PENDING.
  const supersede=env.DB.prepare(`UPDATE expense_projection_generation_jobs AS q SET state='SUPERSEDED',reason='SOURCE_ADVANCED_BEFORE_CLAIM',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE q.spreadsheet_id=? AND q.state='PENDING' AND ${eligible('q',false)} AND EXISTS(SELECT 1 FROM expense_projection_source_revisions r WHERE r.expense_id=q.expense_id AND r.revision>q.source_revision)`).bind(env.GOOGLE_SPREADSHEET_ID,...eligibilityArgs(env));
  const stale=env.DB.prepare(`UPDATE expense_projection_generation_jobs AS q SET state='REVIEW',reason='SOURCE_OR_FENCE_CHANGED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE q.spreadsheet_id=? AND q.state='PENDING' AND NOT ${eligible('q')}`).bind(env.GOOGLE_SPREADSHEET_ID,...eligibilityArgs(env));
  const materialize=env.DB.prepare(`INSERT INTO expense_projection_generation_jobs(spreadsheet_id,cutover_generation,expense_id,source_version,source_revision,state,reason,created_at,updated_at)
    WITH candidates AS (SELECT o.*,${eligible('o')} AS exact_ok,(${eligible('o',false)} AND EXISTS(SELECT 1 FROM expense_projection_source_revisions r WHERE r.expense_id=o.expense_id AND r.revision>o.source_revision)) AS current_ok
      FROM expense_projection_generation_observations o JOIN expense_projection_cutovers c ON c.spreadsheet_id=o.spreadsheet_id AND c.generation=o.cutover_generation AND c.sheet_name=? AND c.state='ACTIVE'
      WHERE o.spreadsheet_id=? AND NOT EXISTS(SELECT 1 FROM expense_projection_generation_jobs q WHERE q.spreadsheet_id=o.spreadsheet_id AND q.cutover_generation=o.cutover_generation AND q.expense_id=o.expense_id AND q.source_version=o.source_version AND q.source_revision=o.source_revision)
      ORDER BY o.discovered_at,o.expense_id LIMIT 100)
    SELECT o.spreadsheet_id,o.cutover_generation,o.expense_id,o.source_version,o.source_revision,
      CASE WHEN o.state='REVIEW' THEN 'REVIEW' WHEN o.exact_ok THEN 'PENDING' WHEN o.current_ok THEN 'SUPERSEDED' ELSE 'REVIEW' END,
      CASE WHEN o.state='REVIEW' THEN COALESCE(o.reason,'OBSERVATION_REVIEW') WHEN o.exact_ok THEN NULL WHEN o.current_ok THEN 'SOURCE_ADVANCED_BEFORE_QUEUE' ELSE 'SOURCE_OR_FENCE_CHANGED' END,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM candidates o WHERE 1
    ON CONFLICT(spreadsheet_id,cutover_generation,expense_id,source_version,source_revision) DO NOTHING`).bind(...eligibilityArgs(env),...eligibilityArgs(env),env.SHEET_EXPENSE_DAILY,env.GOOGLE_SPREADSHEET_ID);
  // Batch rollback prevents marking a lease expired without applying the rest
  // of that tick. A lost acknowledgement leaves the durable rows authoritative.
  await env.DB.batch([expired,rollback,supersede,stale,materialize]);
}

/** Foundation for a future consumer; not connected to cron or a queue route.
 * A claim alone is never authority to mutate Sheets or mark any job complete. */
export async function claimExpenseGeneration(env:Env,key:ExpenseGenerationKey):Promise<string|null>{
  check(env);if(env.EXPENSE_GENERATION_WORKER_ENABLED!=='true'||key.spreadsheetId!==env.GOOGLE_SPREADSHEET_ID||!/^[-A-Za-z0-9_]{8,128}$/.test(key.generation)||!/^exp_[-A-Za-z0-9_]{1,128}$/.test(key.expenseId)||!Number.isSafeInteger(key.version)||key.version<1||!Number.isSafeInteger(key.revision)||key.revision<1)throw Error('EXPENSE_GENERATION_WORKER_DISABLED');
  const token=crypto.randomUUID();
  const result=await env.DB.prepare(`UPDATE expense_projection_generation_jobs AS q SET state='IN_FLIGHT',lease_token=?,lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 minutes'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE q.spreadsheet_id=? AND q.cutover_generation=? AND q.expense_id=? AND q.source_version=? AND q.source_revision=? AND q.state='PENDING' AND ${eligible('q')}`).bind(token,key.spreadsheetId,key.generation,key.expenseId,key.version,key.revision,...eligibilityArgs(env)).run();
  return Number(result.meta.changes||0)===1?token:null;
}
