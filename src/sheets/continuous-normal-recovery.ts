import type {Env} from '../types';
import {stableSourceIntegrity} from './stable-source-cutover';
import {continuousDailyCutoverIntegrity,continuousReportCutoverIntegrity,continuousAdmissionIntegrity} from './continuous-daily-cutover';
import {assertContinuousDailyActivated} from './continuous-daily-route';
import {recoveryGateValid} from './stable-recovery-admission';

type NormalEnv=Env & {CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED?:string};
const triggers="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('continuous_normal_recovery_insert','continuous_normal_recovery_no_update','continuous_normal_recovery_no_delete'))=3 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('stable_recovery_epoch_no_delete','stable_recovery_epoch_transition','stable_recovery_operation_no_delete','stable_recovery_operation_transition'))=4 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name='continuous_expense_projection_target_fence')=1 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('continuous_canary_no_delete','continuous_canary_no_replace','continuous_canary_transition'))=3 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('continuous_operator_insert','continuous_operator_update','continuous_operator_no_delete','continuous_operator_no_replace'))=4 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('sync_alert_job_insert','sync_alert_job_update','sync_alert_job_complete','sync_alert_job_delete','sync_alert_claim_insert','sync_alert_claim_update','sync_alert_claim_release','sync_alert_claim_resume','sync_alert_terminal_insert','sync_alert_terminal_update','sync_alert_terminal_resolve','sync_alert_terminal_delete'))=12";
const scope=(env:NormalEnv)=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED,env.CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED,env.SHEETS_SYNC_ENABLED,env.STABLE_RECOVERY_GATE_ENABLED,env.STABLE_PHASE1_ENABLED,env.STABLE_SHEETS_PACING_ENABLED,env.CONTINUOUS_DAILY_ENABLED,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID]);
function automaticRecoveryEnabled(env:NormalEnv):boolean{
 const pilot=env.CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED;
 return (pilot===undefined||pilot==='false')&&env.CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED==='true';
}
// Exactly the evidence accepted by the normal coordinator for an Undo whose
// earlier v1 is either proven unwritten or has authenticated projections.
const noWritePredecessor=`NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=e.expense_id OR substr(p.entity_id,1,length(e.expense_id)+1)=e.expense_id||'|')) AND NOT EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.entity_key=e.expense_id OR substr(i.entity_key,1,length(e.expense_id)+1)=e.expense_id||'|') AND EXISTS(SELECT 1 FROM sync_jobs old WHERE old.entity_type='EXPENSE' AND old.entity_key=e.expense_id AND old.entity_version=1 AND ((old.status='PENDING' AND old.attempt_count=0 AND old.lease_token IS NULL AND old.lease_until IS NULL) OR (old.status='COMPLETED' AND old.lease_token IS NULL AND old.lease_until IS NULL AND old.last_error='SUPERSEDED_BEFORE_DISPATCH' AND EXISTS(SELECT 1 FROM stable_recovery_epochs r JOIN stable_recovery_operations o ON o.epoch_id=r.epoch_id WHERE r.spreadsheet_id=c.spreadsheet_id AND r.state='COMPLETE' AND r.target_type='EXPENSE' AND r.target_key=e.expense_id AND r.target_version=1 AND o.state='VERIFIED'))))`;
const writtenPredecessor=`EXISTS(SELECT 1 FROM sync_jobs old JOIN stable_projection_writes p ON p.spreadsheet_id=c.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=old.entity_key AND p.projection='DAILY' AND p.state='VERIFIED' AND p.source_version=1 WHERE old.entity_type='EXPENSE' AND old.entity_key=e.expense_id AND old.entity_version=1 AND old.status='COMPLETED' AND old.lease_token IS NULL AND old.lease_until IS NULL) AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=c.spreadsheet_id AND p.entity_type='EXPENSE' AND (p.entity_id=e.expense_id OR substr(p.entity_id,1,length(e.expense_id)+1)=e.expense_id||'|') AND (p.state<>'VERIFIED' OR p.source_version<>1 OR NOT EXISTS(SELECT 1 FROM stable_expense_projection_preimages i JOIN atomic_daily_marker_reservations m ON m.spreadsheet_id=i.spreadsheet_id AND m.sheet_id=i.sheet_id AND m.entity_id=i.entity_id AND m.source_version=i.source_version WHERE i.spreadsheet_id=p.spreadsheet_id AND i.entity_type=p.entity_type AND i.entity_id=p.entity_id AND i.projection=p.projection AND i.sheet_id=p.sheet_id AND i.sheet_name=p.sheet_name AND i.source_version=p.source_version AND i.source_digest=p.source_digest AND m.operation_token=p.operation_token)))`;

/** Surface only still-confirmed historical expenses that the normal gate
 * deliberately cannot admit. Changing a job to REVIEW is not evidence about
 * a past Sheets request: retain all journals, source data and prior attempts.
 * A concurrent lease wins or loses atomically with this update. */
export async function holdContinuousHistoricalExpenses(env:NormalEnv):Promise<number>{
 if(!automaticRecoveryEnabled(env)||env.SHEETS_SYNC_ENABLED!=='true'||!recoveryGateValid(env)||!env.GOOGLE_SPREADSHEET_ID)return 0;
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,initial=scope(env),stable=()=>env.DB===db&&scope(env)===initial;
 if(!await assertContinuousDailyActivated(env))return 0;if(!stable())throw Error('CONTINUOUS_NORMAL_SCOPE_CHANGED');
 const result=await db.prepare(`UPDATE sync_jobs SET status='REVIEW',last_error='CONTINUOUS_PRE_CUTOVER_UNRECONCILED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL
  WHERE job_id IN (SELECT j.job_id FROM sync_jobs j JOIN expense_events e ON e.expense_id=j.entity_key JOIN continuous_daily_pre_cutover_expenses p ON p.expense_id=e.expense_id AND p.spreadsheet_id=? JOIN continuous_daily_cutovers c ON c.spreadsheet_id=p.spreadsheet_id AND c.state='ACTIVE'
   WHERE j.entity_type='EXPENSE' AND j.entity_version=e.version AND e.status='CONFIRMED' AND j.status='PENDING' AND j.lease_token IS NULL AND j.lease_until IS NULL
   AND EXISTS(SELECT 1 FROM continuous_canary_operator t WHERE t.spreadsheet_id=c.spreadsheet_id AND t.state='VERIFIED' AND t.expense_id<>e.expense_id)
   AND EXISTS(SELECT 1 FROM continuous_cutover_operator o WHERE o.spreadsheet_id=c.spreadsheet_id AND o.state='COMPLETE')
   AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims w WHERE w.spreadsheet_id=c.spreadsheet_id)
   AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs r WHERE r.spreadsheet_id=c.spreadsheet_id AND r.state IN ('ARMED','REVIEW'))
   AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousReportCutoverIntegrity} AND ${continuousAdmissionIntegrity} AND ${triggers}
   ORDER BY j.updated_at LIMIT 20)
  AND status='PENDING' AND lease_token IS NULL AND lease_until IS NULL`).bind(book).run();
 if(!stable()||result.success!==true||!Number.isSafeInteger(result.meta?.changes))throw Error('CONTINUOUS_HISTORICAL_HOLD_UNCERTAIN');return Number(result.meta.changes);
}

/** A version gap cannot safely be mapped to a prior Sheets projection using
 * version-1. Surface the untouched new Undo job as REVIEW so the existing
 * incident outbox alerts the owner instead of silently parking it forever. */
export async function holdContinuousUndoVersionGaps(env:NormalEnv):Promise<number>{
 if(!automaticRecoveryEnabled(env)||env.SHEETS_SYNC_ENABLED!=='true'||!recoveryGateValid(env)||!env.GOOGLE_SPREADSHEET_ID)return 0;
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,initial=scope(env),stable=()=>env.DB===db&&scope(env)===initial;
 if(!await assertContinuousDailyActivated(env))return 0;if(!stable())throw Error('CONTINUOUS_NORMAL_SCOPE_CHANGED');
 const result=await db.prepare(`UPDATE sync_jobs SET status='REVIEW',last_error='CONTINUOUS_UNDO_VERSION_GAP',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL
  WHERE job_id IN (SELECT j.job_id FROM sync_jobs j JOIN expense_events e ON e.expense_id=j.entity_key JOIN continuous_daily_post_cutover_expenses p ON p.expense_id=e.expense_id AND p.spreadsheet_id=? JOIN continuous_daily_cutovers c ON c.spreadsheet_id=p.spreadsheet_id AND c.state='ACTIVE'
   WHERE j.entity_type='EXPENSE' AND j.entity_version=e.version AND e.status='CANCELLED' AND e.version>2 AND j.status='PENDING' AND j.lease_token IS NULL AND j.lease_until IS NULL
   AND EXISTS(SELECT 1 FROM continuous_canary_operator t WHERE t.spreadsheet_id=c.spreadsheet_id AND t.state='VERIFIED' AND t.expense_id<>e.expense_id)
   AND EXISTS(SELECT 1 FROM continuous_cutover_operator o WHERE o.spreadsheet_id=c.spreadsheet_id AND o.state='COMPLETE')
   AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs r WHERE r.spreadsheet_id=c.spreadsheet_id AND r.state IN ('ARMED','REVIEW') AND r.target_type='EXPENSE' AND r.target_key=e.expense_id)
   AND NOT EXISTS(SELECT 1 FROM sync_jobs other WHERE other.entity_type='EXPENSE' AND other.entity_key=e.expense_id AND other.status='PROCESSING')
   AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousReportCutoverIntegrity} AND ${continuousAdmissionIntegrity} AND ${triggers}
   ORDER BY j.updated_at LIMIT 20)
  AND status='PENDING' AND lease_token IS NULL AND lease_until IS NULL`).bind(book).run();
 if(!stable()||result.success!==true||!Number.isSafeInteger(result.meta?.changes))throw Error('CONTINUOUS_UNDO_GAP_HOLD_UNCERTAIN');return Number(result.meta.changes);
}

/** Confirmation also allocates above the sync-version high-water mark. A
 * new confirmed version other than v1 cannot be automatically routed by the
 * v1/v2 coordinator; surface it rather than silently leaving it pending. */
export async function holdContinuousConfirmationVersionGaps(env:NormalEnv):Promise<number>{
 if(!automaticRecoveryEnabled(env)||env.SHEETS_SYNC_ENABLED!=='true'||!recoveryGateValid(env)||!env.GOOGLE_SPREADSHEET_ID)return 0;
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,initial=scope(env),stable=()=>env.DB===db&&scope(env)===initial;
 if(!await assertContinuousDailyActivated(env))return 0;if(!stable())throw Error('CONTINUOUS_NORMAL_SCOPE_CHANGED');
 const result=await db.prepare(`UPDATE sync_jobs SET status='REVIEW',last_error='CONTINUOUS_CONFIRM_VERSION_GAP',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL
  WHERE job_id IN (SELECT j.job_id FROM sync_jobs j JOIN expense_events e ON e.expense_id=j.entity_key JOIN continuous_daily_post_cutover_expenses p ON p.expense_id=e.expense_id AND p.spreadsheet_id=? JOIN continuous_daily_cutovers c ON c.spreadsheet_id=p.spreadsheet_id AND c.state='ACTIVE'
   WHERE j.entity_type='EXPENSE' AND j.entity_version=e.version AND e.status='CONFIRMED' AND e.version>1 AND j.status='PENDING' AND j.lease_token IS NULL AND j.lease_until IS NULL
   AND EXISTS(SELECT 1 FROM continuous_canary_operator t WHERE t.spreadsheet_id=c.spreadsheet_id AND t.state='VERIFIED' AND t.expense_id<>e.expense_id)
   AND EXISTS(SELECT 1 FROM continuous_cutover_operator o WHERE o.spreadsheet_id=c.spreadsheet_id AND o.state='COMPLETE')
   AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs r WHERE r.spreadsheet_id=c.spreadsheet_id AND r.state IN ('ARMED','REVIEW') AND r.target_type='EXPENSE' AND r.target_key=e.expense_id)
   AND NOT EXISTS(SELECT 1 FROM sync_jobs other WHERE other.entity_type='EXPENSE' AND other.entity_key=e.expense_id AND other.status='PROCESSING')
   AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousReportCutoverIntegrity} AND ${continuousAdmissionIntegrity} AND ${triggers}
   ORDER BY j.updated_at LIMIT 20)
  AND status='PENDING' AND lease_token IS NULL AND lease_until IS NULL`).bind(book).run();
 if(!stable()||result.success!==true||!Number.isSafeInteger(result.meta?.changes))throw Error('CONTINUOUS_CONFIRM_GAP_HOLD_UNCERTAIN');return Number(result.meta.changes);
}

/** A new expense with a failed delivery or a previous recovery epoch is not
 * eligible for automatic replay. Do not leave that job silently PENDING: move
 * only its unleased current version to REVIEW and let the durable incident
 * mechanism alert the owner. No past provider outcome is inferred. */
export async function holdContinuousExpenseHistory(env:NormalEnv):Promise<number>{
 if(!automaticRecoveryEnabled(env)||env.SHEETS_SYNC_ENABLED!=='true'||!recoveryGateValid(env)||!env.GOOGLE_SPREADSHEET_ID)return 0;
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,initial=scope(env),stable=()=>env.DB===db&&scope(env)===initial;
 if(!await assertContinuousDailyActivated(env))return 0;if(!stable())throw Error('CONTINUOUS_NORMAL_SCOPE_CHANGED');
 const result=await db.prepare(`UPDATE sync_jobs SET status='REVIEW',last_error='CONTINUOUS_SYNC_HISTORY_UNRECONCILED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL
  WHERE job_id IN (SELECT j.job_id FROM sync_jobs j JOIN expense_events e ON e.expense_id=j.entity_key JOIN continuous_daily_post_cutover_expenses p ON p.expense_id=e.expense_id AND p.spreadsheet_id=? JOIN continuous_daily_cutovers c ON c.spreadsheet_id=p.spreadsheet_id AND c.state='ACTIVE'
   WHERE j.entity_type='EXPENSE' AND j.entity_version=e.version AND ((e.status='CONFIRMED' AND e.version=1) OR (e.status='CANCELLED' AND e.version=2)) AND j.status='PENDING' AND j.lease_token IS NULL AND j.lease_until IS NULL
   AND EXISTS(SELECT 1 FROM continuous_canary_operator t WHERE t.spreadsheet_id=c.spreadsheet_id AND t.state='VERIFIED' AND t.expense_id<>e.expense_id)
   AND EXISTS(SELECT 1 FROM continuous_cutover_operator o WHERE o.spreadsheet_id=c.spreadsheet_id AND o.state='COMPLETE')
   AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs r WHERE r.spreadsheet_id=c.spreadsheet_id AND r.state IN ('ARMED','REVIEW') AND r.target_type='EXPENSE' AND r.target_key=e.expense_id)
   AND NOT EXISTS(SELECT 1 FROM sync_jobs other WHERE other.entity_type='EXPENSE' AND other.entity_key=e.expense_id AND other.status='PROCESSING')
   AND (j.attempt_count>0 OR EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key IN ('EXPENSE:'||e.expense_id||':1','EXPENSE:'||e.expense_id||':2')) OR EXISTS(SELECT 1 FROM stable_recovery_epochs r WHERE r.spreadsheet_id=c.spreadsheet_id AND r.target_type='EXPENSE' AND r.target_key=e.expense_id AND r.target_version=e.version) OR EXISTS(SELECT 1 FROM sync_jobs other WHERE other.entity_type='EXPENSE' AND other.entity_key=e.expense_id AND other.entity_version NOT IN (1,2))
    OR (e.version=1 AND (EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=e.expense_id OR substr(p.entity_id,1,length(e.expense_id)+1)=e.expense_id||'|')) OR EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.entity_key=e.expense_id OR substr(i.entity_key,1,length(e.expense_id)+1)=e.expense_id||'|')))
    OR (e.version=2 AND (EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=e.expense_id OR substr(p.entity_id,1,length(e.expense_id)+1)=e.expense_id||'|')) OR NOT ((${noWritePredecessor}) OR (${writtenPredecessor})))))
   AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousReportCutoverIntegrity} AND ${continuousAdmissionIntegrity} AND ${triggers}
   ORDER BY j.updated_at LIMIT 20)
  AND status='PENDING' AND lease_token IS NULL AND lease_until IS NULL`).bind(book).run();
 if(!stable()||result.success!==true||!Number.isSafeInteger(result.meta?.changes))throw Error('CONTINUOUS_HISTORY_HOLD_UNCERTAIN');return Number(result.meta.changes);
}

/** An expired lease proves only that ownership expired, never that Google
 * did not accept a write. Fence the exact normal-recovery target, preserve
 * all projection intents and do not touch an unlinked workbook claim. */
export async function holdContinuousExpiredLease(env:NormalEnv):Promise<number>{
 if(!automaticRecoveryEnabled(env)||env.SHEETS_SYNC_ENABLED!=='true'||!recoveryGateValid(env)||!env.GOOGLE_SPREADSHEET_ID)return 0;
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,initial=scope(env),stable=()=>env.DB===db&&scope(env)===initial;
 if(!await assertContinuousDailyActivated(env))return 0;if(!stable())throw Error('CONTINUOUS_NORMAL_SCOPE_CHANGED');
 const stamp=new Date().toISOString(),reason='CONTINUOUS_SYNC_LEASE_EXPIRED_UNCERTAIN';
 const results=await db.batch([
  db.prepare(`UPDATE sync_jobs SET status='REVIEW',last_error=?,updated_at=?,next_attempt_at=NULL
   WHERE job_id IN (SELECT j.job_id FROM sync_jobs j JOIN stable_recovery_epochs r ON r.target_type=j.entity_type AND r.target_key=j.entity_key AND r.target_version=j.entity_version AND r.spreadsheet_id=? AND r.state='ARMED' JOIN continuous_normal_recovery_admissions a ON a.epoch_id=r.epoch_id AND a.spreadsheet_id=r.spreadsheet_id AND a.expense_id=r.target_key AND a.source_version=r.target_version JOIN continuous_daily_cutovers c ON c.spreadsheet_id=r.spreadsheet_id AND c.state='ACTIVE'
    WHERE j.entity_type='EXPENSE' AND j.status='PROCESSING' AND j.lease_until IS NOT NULL AND j.lease_until<=?
    AND EXISTS(SELECT 1 FROM continuous_canary_operator t WHERE t.spreadsheet_id=c.spreadsheet_id AND t.state='VERIFIED' AND t.expense_id<>j.entity_key)
    AND EXISTS(SELECT 1 FROM continuous_cutover_operator o WHERE o.spreadsheet_id=c.spreadsheet_id AND o.state='COMPLETE')
    AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousReportCutoverIntegrity} AND ${continuousAdmissionIntegrity} AND ${triggers})
   AND status='PROCESSING' AND lease_until IS NOT NULL AND lease_until<=?`).bind(reason,stamp,book,stamp,stamp),
  db.prepare(`UPDATE stable_workbook_claims SET state='REVIEW',phase=NULL,review_reason=?,updated_at=? WHERE spreadsheet_id=? AND state='HELD'
   AND EXISTS(SELECT 1 FROM stable_recovery_epochs r JOIN continuous_normal_recovery_admissions a ON a.epoch_id=r.epoch_id JOIN stable_recovery_operations op ON op.epoch_id=r.epoch_id AND op.operation_token=stable_workbook_claims.operation_token AND op.state='ADMITTED' JOIN sync_jobs j ON j.entity_type=r.target_type AND j.entity_key=r.target_key AND j.entity_version=r.target_version WHERE r.spreadsheet_id=stable_workbook_claims.spreadsheet_id AND r.state='ARMED' AND j.status='REVIEW' AND j.last_error=? AND j.updated_at=?)`).bind(reason,stamp,book,reason,stamp),
  db.prepare(`UPDATE stable_recovery_epochs SET state='REVIEW',updated_at=? WHERE spreadsheet_id=? AND state='ARMED'
   AND EXISTS(SELECT 1 FROM continuous_normal_recovery_admissions a JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=a.expense_id AND j.entity_version=a.source_version WHERE a.epoch_id=stable_recovery_epochs.epoch_id AND a.spreadsheet_id=stable_recovery_epochs.spreadsheet_id AND j.status='REVIEW' AND j.last_error=? AND j.updated_at=?)`).bind(stamp,book,reason,stamp),
  db.prepare(`SELECT CASE WHEN changes()=1 OR NOT EXISTS(SELECT 1 FROM stable_recovery_epochs r JOIN continuous_normal_recovery_admissions a ON a.epoch_id=r.epoch_id JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=a.expense_id AND j.entity_version=a.source_version WHERE r.spreadsheet_id=? AND r.state='ARMED' AND j.status='REVIEW' AND j.last_error=? AND j.updated_at=?) THEN 1 ELSE json_extract('invalid-json','$') END AS ok`).bind(book,reason,stamp)
 ]);
 if(!stable()||results.length!==4||results.some(r=>r.success!==true)||!Number.isSafeInteger(results[0]?.meta?.changes)||![0,1].includes(Number(results[0]!.meta.changes))||Number(results[2]?.meta?.changes)!==Number(results[0]!.meta.changes))throw Error('CONTINUOUS_EXPIRED_LEASE_HOLD_UNCERTAIN');
 return Number(results[0]!.meta.changes);
}

/** After a verified canary, arm one never-attempted NEW expense version.
 * This leaves the gate enabled: historical and non-expense jobs are not
 * admitted or changed. Every provider outcome is still handled by the usual
 * exact-target epoch, leases, intent journals and readback. */
export async function armNextContinuousExpense(env:NormalEnv):Promise<boolean>{
 if(!automaticRecoveryEnabled(env)||env.SHEETS_SYNC_ENABLED!=='true'||!recoveryGateValid(env)||!env.GOOGLE_SPREADSHEET_ID)return false;
 return armNormalExpenseEpoch(env);
}

/** Only the version-pinned admin action can grant the single pilot slot.
 * The existing queue owns all leases, provider writes, and verification. */
export async function armSingleNormalExpense(env:NormalEnv,jobId:string):Promise<boolean>{
 if(env.CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED!=='true'||env.CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED!=='false'||
    env.SHEETS_SYNC_ENABLED!=='true'||!recoveryGateValid(env)||env.STABLE_SHEETS_PACING_ENABLED!=='true'||
    env.CONTINUOUS_DAILY_SHEET!=='รายวันต่อเนื่อง_แบบร่าง'||!env.GOOGLE_SPREADSHEET_ID||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(jobId))return false;
 return armNormalExpenseEpoch(env,jobId);
}

async function armNormalExpenseEpoch(env:NormalEnv,pilotJobId?:string):Promise<boolean>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,initial=scope(env),stable=()=>env.DB===db&&scope(env)===initial;
 if(!await assertContinuousDailyActivated(env))return false;
 if(!stable())throw Error('CONTINUOUS_NORMAL_SCOPE_CHANGED');
 const epoch=pilotJobId?`normal_pilot296_${crypto.randomUUID()}`:`normal_${crypto.randomUUID()}`,now=new Date().toISOString();
 // Keep the one-shot slot after completion, restart, or uncertain acknowledgement.
 // This predicate runs in the same INSERT that grants the job permission.
 const pilotFilter=pilotJobId?`AND j.job_id=? AND e.status='CONFIRMED' AND e.version=1
 AND length(e.transaction_date)=10 AND date(e.transaction_date,'+0 days')=e.transaction_date
 AND substr(e.transaction_date,1,7)=strftime('%Y-%m','now','+7 hours')
 AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs prior WHERE prior.spreadsheet_id=c.spreadsheet_id AND prior.epoch_id GLOB 'normal_pilot296_*')`:'';

 const select=`FROM sync_jobs j JOIN expense_events e ON e.expense_id=j.entity_key JOIN continuous_daily_post_cutover_expenses post ON post.expense_id=e.expense_id AND post.spreadsheet_id=? JOIN continuous_daily_cutovers c ON c.spreadsheet_id=post.spreadsheet_id AND c.state='ACTIVE'
 WHERE j.entity_type='EXPENSE' AND j.entity_version=e.version AND j.status='PENDING' AND j.attempt_count=0 AND j.lease_token IS NULL AND j.lease_until IS NULL AND (j.next_attempt_at IS NULL OR j.next_attempt_at<=?)
 AND ((e.version=1 AND e.status='CONFIRMED') OR (e.version=2 AND e.status='CANCELLED'))
 AND EXISTS(SELECT 1 FROM continuous_canary_operator t WHERE t.spreadsheet_id=c.spreadsheet_id AND t.state='VERIFIED' AND t.expense_id<>e.expense_id)
 AND EXISTS(SELECT 1 FROM continuous_cutover_operator o WHERE o.spreadsheet_id=c.spreadsheet_id AND o.state='COMPLETE')
 AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims w WHERE w.spreadsheet_id=c.spreadsheet_id)
 AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs r WHERE r.spreadsheet_id=c.spreadsheet_id AND r.state IN ('ARMED','REVIEW'))
 AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations o JOIN stable_recovery_epochs r ON r.epoch_id=o.epoch_id WHERE r.spreadsheet_id=c.spreadsheet_id AND o.state='ADMITTED')
 AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs r WHERE r.spreadsheet_id=c.spreadsheet_id AND r.target_type='EXPENSE' AND r.target_key=e.expense_id AND r.target_version=e.version)
 AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=c.spreadsheet_id AND p.state<>'VERIFIED')
 AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.spreadsheet_id=c.spreadsheet_id AND p.state<>'VERIFIED')
 AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key IN ('EXPENSE:'||e.expense_id||':1','EXPENSE:'||e.expense_id||':2'))
 AND NOT EXISTS(SELECT 1 FROM sync_jobs other WHERE other.entity_type='EXPENSE' AND other.entity_key=e.expense_id AND other.entity_version NOT IN (1,2))
 AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=e.expense_id OR substr(p.entity_id,1,length(e.expense_id)+1)=e.expense_id||'|'))
 AND ((e.version=1 AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=e.expense_id OR substr(p.entity_id,1,length(e.expense_id)+1)=e.expense_id||'|')) AND NOT EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.entity_key=e.expense_id OR substr(i.entity_key,1,length(e.expense_id)+1)=e.expense_id||'|')) OR (e.version=2 AND EXISTS(SELECT 1 FROM sync_jobs old WHERE old.entity_type='EXPENSE' AND old.entity_key=e.expense_id AND old.entity_version=1 AND ((old.status='PENDING' AND old.attempt_count=0 AND old.lease_token IS NULL AND old.lease_until IS NULL) OR (old.status='COMPLETED' AND old.lease_token IS NULL AND old.lease_until IS NULL)))))
 AND (e.version=1 OR (NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=e.expense_id OR substr(p.entity_id,1,length(e.expense_id)+1)=e.expense_id||'|')) AND NOT EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.entity_key=e.expense_id OR substr(i.entity_key,1,length(e.expense_id)+1)=e.expense_id||'|') AND EXISTS(SELECT 1 FROM sync_jobs old WHERE old.entity_type='EXPENSE' AND old.entity_key=e.expense_id AND old.entity_version=1 AND ((old.status='PENDING' AND old.attempt_count=0) OR (old.status='COMPLETED' AND old.last_error='SUPERSEDED_BEFORE_DISPATCH' AND EXISTS(SELECT 1 FROM stable_recovery_epochs r JOIN stable_recovery_operations o ON o.epoch_id=r.epoch_id WHERE r.spreadsheet_id=c.spreadsheet_id AND r.state='COMPLETE' AND r.target_type='EXPENSE' AND r.target_key=e.expense_id AND r.target_version=1 AND o.state='VERIFIED'))))) OR (EXISTS(SELECT 1 FROM sync_jobs old JOIN stable_projection_writes p ON p.spreadsheet_id=c.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=old.entity_key AND p.projection='DAILY' AND p.state='VERIFIED' AND p.source_version=1 WHERE old.entity_type='EXPENSE' AND old.entity_key=e.expense_id AND old.entity_version=1 AND old.status='COMPLETED') AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=c.spreadsheet_id AND p.entity_type='EXPENSE' AND (p.entity_id=e.expense_id OR substr(p.entity_id,1,length(e.expense_id)+1)=e.expense_id||'|') AND (p.state<>'VERIFIED' OR p.source_version<>1 OR NOT EXISTS(SELECT 1 FROM stable_expense_projection_preimages i JOIN atomic_daily_marker_reservations m ON m.spreadsheet_id=i.spreadsheet_id AND m.sheet_id=i.sheet_id AND m.entity_id=i.entity_id AND m.source_version=i.source_version WHERE i.spreadsheet_id=p.spreadsheet_id AND i.entity_type=p.entity_type AND i.entity_id=p.entity_id AND i.projection=p.projection AND i.sheet_id=p.sheet_id AND i.sheet_name=p.sheet_name AND i.source_version=p.source_version AND i.source_digest=p.source_digest AND m.operation_token=p.operation_token)))))
 AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousReportCutoverIntegrity} AND ${continuousAdmissionIntegrity} AND ${triggers}
 ${pilotFilter}
 ORDER BY j.updated_at,j.entity_key LIMIT 1`;
 const result=await db.batch([
  db.prepare(`INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) SELECT ?,c.spreadsheet_id,'ARMED','EXPENSE',e.expense_id,e.version,?,? ${select}`).bind(epoch,now,now,book,now,...(pilotJobId?[pilotJobId]:[])),
  db.prepare("INSERT INTO continuous_normal_recovery_admissions(epoch_id,spreadsheet_id,expense_id,source_version,created_at) SELECT epoch_id,spreadsheet_id,target_key,target_version,? FROM stable_recovery_epochs WHERE epoch_id=? AND state='ARMED'").bind(now,epoch),
  db.prepare("SELECT CASE WHEN changes()=1 OR NOT EXISTS(SELECT 1 FROM stable_recovery_epochs WHERE epoch_id=?) THEN 1 ELSE json_extract('invalid-json','$') END AS ok").bind(epoch)
 ]);
 const first=result[0]?.meta?.changes,second=result[1]?.meta?.changes;
 if(!stable()||result.length!==3||result.some(r=>r.success!==true)||typeof first!=='number'||!Number.isSafeInteger(first)||first!==second||![0,1].includes(first))throw Error('CONTINUOUS_NORMAL_EPOCH_UNCERTAIN');
 return first===1;
}
