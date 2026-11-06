import type {Env,SheetsSyncJob,StaffConfigSyncJob} from '../types';

/** Recovery is opt-in and never runs on an unreviewed workbook by default.
 * A target job may run multiple VERIFIED stages in one append-only epoch.
 * An ADMITTED operation that did not verify blocks all later stages forever
 * until an independently approved, audited review; time never refunds a slot. */
export type RecoveryIdentity = Pick<SheetsSyncJob,'entityType'|'entityKey'|'entityVersion'> | StaffConfigSyncJob;
type Target={entityType:string;entityKey:string;entityVersion:number};
type Epoch={epoch_id:string;state:string;target_type:string;target_key:string;target_version:number;created_at:string};
export const STABLE_RECOVERY_BLOCKED='STABLE_RECOVERY_GATE_BLOCKED';

export function recoveryGateConfigured(env:Env):boolean {
  return env.STABLE_RECOVERY_GATE_ENABLED!==undefined&&env.STABLE_RECOVERY_GATE_ENABLED!=='false';
}
export function recoveryGateValid(env:Env):boolean{
  return env.STABLE_RECOVERY_GATE_ENABLED==='true' && env.STABLE_PHASE1_ENABLED==='true' &&
    env.STABLE_SHEETS_PACING_ENABLED==='true' && !!env.GOOGLE_SPREADSHEET_ID;
}
function identityOf(job?:RecoveryIdentity):Target|null{
  if(!job)return null;
  if('kind' in job&&job.kind==='STAFF_CONFIG_SYNC'){
    if(typeof job.employeeId!=='string'||!job.employeeId||!Number.isSafeInteger(job.version)||job.version<1)return null;
    return {entityType:'STAFF_CONFIG_SYNC',entityKey:job.employeeId,entityVersion:job.version};
  }
  if(!('entityType' in job)||typeof job.entityType!=='string'||typeof job.entityKey!=='string'||
    !job.entityKey||!Number.isSafeInteger(job.entityVersion)||job.entityVersion<1)return null;
  return {entityType:job.entityType,entityKey:job.entityKey,entityVersion:job.entityVersion};
}
export async function stableRecoveryGateBlocked(env:Env,job?:RecoveryIdentity):Promise<boolean>{
  if(!recoveryGateConfigured(env))return false;
  if(!recoveryGateValid(env))return true;
  const target=identityOf(job);
  if(!target)return true;
  const row=await env.DB.prepare("SELECT epoch_id,state,target_type,target_key,target_version,created_at FROM stable_recovery_epochs WHERE spreadsheet_id=? AND state IN ('ARMED','REVIEW') LIMIT 1")
    .bind(env.GOOGLE_SPREADSHEET_ID).first<Epoch>().catch(()=>null);
  return !row||row.state!=='ARMED'||row.target_type!==target.entityType||
    row.target_key!==target.entityKey||row.target_version!==target.entityVersion;
}

/** Authoritative atomic admission after our HELD claim, but BEFORE any Sheets
 * request or notice mutation. No in-memory lock; cross-invocation D1 constraint. */
export async function admitStableRecovery(env:Env,job:RecoveryIdentity|undefined,operationToken:string):Promise<boolean>{
  if(!recoveryGateConfigured(env))return true;
  if(!recoveryGateValid(env))return false;
  const target=identityOf(job);
  if(!target||!operationToken)return false;
  const result=await env.DB.prepare(`INSERT INTO stable_recovery_operations
   (operation_token,epoch_id,state,admitted_at)
   SELECT ?, e.epoch_id,'ADMITTED',strftime('%Y-%m-%dT%H:%M:%fZ','now')
   FROM stable_recovery_epochs e
   WHERE e.spreadsheet_id=? AND e.state='ARMED' AND
   e.target_type=? AND e.target_key=? AND e.target_version=?
   AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=e.spreadsheet_id AND c.operation_token=? AND c.state='HELD' AND c.notice_stamp IS NULL)
   AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations old WHERE old.epoch_id=e.epoch_id AND old.state='ADMITTED')`)
   .bind(operationToken,env.GOOGLE_SPREADSHEET_ID,target.entityType,target.entityKey,target.entityVersion,operationToken).run();
  if(result.success!==true||!Number.isSafeInteger(result.meta?.changes))throw Error('STABLE_RECOVERY_ADMISSION_UNKNOWN');
  return result.meta.changes===1;
}

/** Called only after verified READY notice and successful business callback.
 * The epoch remains ARMED for the SAME target's following stage (RAW/DETAIL/FINAL).
 * A failed acknowledgement retains the workbook claim for review. */
export async function verifyStableRecoveryAdmission(env:Env,operationToken:string):Promise<void>{
  if(!recoveryGateConfigured(env))return;
  const result=await env.DB.prepare(`UPDATE stable_recovery_operations
   SET state='VERIFIED',verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE operation_token=? AND state='ADMITTED'
   AND EXISTS(SELECT 1 FROM stable_workbook_claims c
      JOIN stable_recovery_epochs e ON e.spreadsheet_id=c.spreadsheet_id
      WHERE c.operation_token=? AND c.state='HELD'
        AND e.epoch_id=stable_recovery_operations.epoch_id AND e.state='ARMED')`)
   .bind(operationToken,operationToken).run();
  if(result.success!==true||result.meta?.changes!==1)throw Error('STABLE_RECOVERY_VERIFICATION_UNCERTAIN');
}

/** A preflight capacity REVIEW is not a VERIFIED financial projection.
 * The notice lifecycle can still close normally, while the exact canary
 * epoch remains REVIEW and cannot admit a later stage. */
export async function holdStableRecoveryCapacity(env:Env,job:RecoveryIdentity|undefined,operationToken:string):Promise<void>{
  if(!recoveryGateConfigured(env))return;
  const target=identityOf(job);
  if(!target||target.entityType!=='EXPENSE')throw Error('STABLE_RECOVERY_CAPACITY_IDENTITY_UNKNOWN');
  const result=await env.DB.prepare(`UPDATE stable_recovery_epochs AS e
    SET state='REVIEW',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE e.spreadsheet_id=? AND e.state='ARMED'
      AND e.target_type=? AND e.target_key=? AND e.target_version=?
      AND EXISTS(SELECT 1 FROM stable_recovery_operations a WHERE a.epoch_id=e.epoch_id
        AND a.operation_token=? AND a.state='ADMITTED')
      AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=e.spreadsheet_id
        AND c.operation_token=? AND c.state='HELD')
      AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type=e.target_type
        AND j.entity_key=e.target_key AND j.entity_version=e.target_version
        AND j.status='REVIEW' AND j.last_error='STABLE_DAILY_CAPACITY')`)
    .bind(env.GOOGLE_SPREADSHEET_ID,target.entityType,target.entityKey,target.entityVersion,operationToken,operationToken).run();
  if(result.success!==true||Number(result.meta?.changes)!==1)throw Error('STABLE_RECOVERY_CAPACITY_HOLD_UNCERTAIN');
}

/** Seal a completed target epoch after its final verified operation.
 * Historical rows remain append-only; no runtime code can re-arm this epoch.
 * For a staged expense, PENDING is deliberately left ARMED until FINAL. */
export async function completeStableRecoveryTarget(env:Env,job:RecoveryIdentity|undefined,operationToken:string):Promise<void>{
  if(!recoveryGateConfigured(env))return;
  const target=identityOf(job);
  if(!target)throw Error('STABLE_RECOVERY_IDENTITY_UNKNOWN');
  const isStaff=target.entityType==='STAFF_CONFIG_SYNC';
  const completed=isStaff
    ? "EXISTS(SELECT 1 FROM staff_config_sync_outbox j WHERE j.employee_id=e.target_key AND j.version=e.target_version AND j.status='COMPLETED')"
    : "EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type=e.target_type AND j.entity_key=e.target_key AND j.entity_version=e.target_version AND j.status='COMPLETED')";
  const done=await env.DB.prepare(`UPDATE stable_recovery_epochs AS e
    SET state='COMPLETE',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE e.spreadsheet_id=? AND e.state='ARMED'
    AND e.target_type=? AND e.target_key=? AND e.target_version=?
    AND EXISTS(SELECT 1 FROM stable_recovery_operations a WHERE a.epoch_id=e.epoch_id AND a.operation_token=? AND a.state='VERIFIED')
    AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=e.spreadsheet_id AND c.operation_token=? AND c.state='HELD')
    AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations a WHERE a.epoch_id=e.epoch_id AND a.state='ADMITTED')
    AND ${completed}`)
    .bind(env.GOOGLE_SPREADSHEET_ID,target.entityType,target.entityKey,target.entityVersion,operationToken,operationToken).run();
  if(done.success!==true||!Number.isSafeInteger(done.meta?.changes))throw Error('STABLE_RECOVERY_COMPLETE_UNKNOWN');
}

export type RecoveryDiagnostic={
 mode:string;state?:string;targetType?:string;admittedStages?:number;unverifiedStages?:number;
 parked?:Array<{entityType:string;count:number}>;epochCreatedAt?:string;targetJobStatus?:string;
};
export async function stableRecoveryGateDiagnostic(env:Env):Promise<RecoveryDiagnostic>{
  if(!recoveryGateConfigured(env))return{mode:'DISABLED'};
  if(!recoveryGateValid(env))return{mode:'INVALID_CONFIG'};
  try{
    const row=await env.DB.prepare("SELECT epoch_id,state,target_type,created_at FROM stable_recovery_epochs WHERE spreadsheet_id=? ORDER BY CASE WHEN state IN ('ARMED','REVIEW') THEN 0 ELSE 1 END,created_at DESC,epoch_id DESC LIMIT 1")
      .bind(env.GOOGLE_SPREADSHEET_ID).first<Pick<Epoch,'epoch_id'|'state'|'target_type'|'created_at'>>();
    if(!row)return{mode:'UNARMED'};
    const [summary,parked]=await Promise.all([
      env.DB.prepare("SELECT count(*) total,sum(CASE WHEN state='ADMITTED' THEN 1 ELSE 0 END) unverified FROM stable_recovery_operations WHERE epoch_id=?").bind(row.epoch_id).first<{total:number;unverified:number|null}>(),
      env.DB.prepare("SELECT entity_type,count(*) n FROM sync_jobs WHERE last_error='STABLE_RECOVERY_GATE_BLOCKED' GROUP BY entity_type ORDER BY entity_type").all<{entity_type:string;n:number}>()
    ]);
    return{mode:'OPT_IN',state:row.state,targetType:row.target_type,epochCreatedAt:row.created_at,
      admittedStages:Number(summary?.total||0),unverifiedStages:Number(summary?.unverified||0),
      parked:(parked.results||[]).map(x=>({entityType:x.entity_type,count:Number(x.n)}))};
  }catch{return{mode:'UNAVAILABLE'};}
}
