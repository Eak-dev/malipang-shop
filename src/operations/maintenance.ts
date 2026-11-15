import { recoverPendingSheetJobs,safeRecordMetric } from "../db/repositories";
import { auditEvidenceRetention } from "../evidence/retention";
import { recoverPendingLineNotifications } from "../line/attendance-notification";
import { recoverDeferredAutoCancelAlerts,sweepSyncFailureAlerts } from "../line/sync-failure-alerts";
import { finalizeMissingPunchPayrolls } from "../payroll/finalize";
import { refreshCurrentEmployeeWages } from "../payroll/repository";
import { recoverPendingStaffConfigSyncs } from "../sheets/staff-config";
import { armNextContinuousExpense,holdContinuousHistoricalExpenses,holdContinuousUndoVersionGaps,holdContinuousConfirmationVersionGaps,holdContinuousExpenseHistory,holdContinuousExpiredLease } from "../sheets/continuous-normal-recovery";
import type { Env } from "../types";
import {issueNoticeProbe,watchdogNoticeWorker} from "../sheets/continuous-notice-readiness";

export const maintenanceSteps=["inbound_leases","payroll","sheets_recovery","staff_config_recovery","line_notification_recovery","evidence_retention"] as const;
export type MaintenanceStep=typeof maintenanceSteps[number];

/** No automatic retry here: each existing operation owns its retry boundary. */
export async function runScheduledMaintenance(env:Env):Promise<void>{
  const failed:MaintenanceStep[]=[];
  const tasks:Record<MaintenanceStep,()=>Promise<unknown>>={
    inbound_leases:()=>env.DB.prepare(`UPDATE inbound_events SET status='STALE',error='PROCESSING_LEASE_EXPIRED' WHERE status='PROCESSING' AND last_attempt_at<?`).bind(new Date(Date.now()-15*60_000).toISOString()).run(),
    // These two operations remain dependent and in their original order.
    payroll:async()=>{await refreshCurrentEmployeeWages(env);await finalizeMissingPunchPayrolls(env);},
    sheets_recovery:async()=>{await holdContinuousExpiredLease(env);await holdContinuousHistoricalExpenses(env);await holdContinuousUndoVersionGaps(env);await holdContinuousConfirmationVersionGaps(env);await holdContinuousExpenseHistory(env);const armed=await armNextContinuousExpense(env);return recoverPendingSheetJobs(env,armed?0:300);},
    staff_config_recovery:()=>recoverPendingStaffConfigSyncs(env),
    line_notification_recovery:async()=>{
      // A failed sweep must not prevent existing notification delivery recovery.
      let sweepFailed=false,deferredFailed=false;
      try{await watchdogNoticeWorker(env);}catch{console.error('notice-watchdog-unavailable');}
      try{await issueNoticeProbe(env,'MAIN_CRON');}catch{console.error('notice-main-probe-unavailable');}
      try{if(await sweepSyncFailureAlerts(env)===null)console.error('sync-alert-unavailable',{reason:'DISABLED_OR_SCHEMA_UNVERIFIED'});}catch{sweepFailed=true;}
      try{await recoverDeferredAutoCancelAlerts(env);}catch{deferredFailed=true;}
      await recoverPendingLineNotifications(env);
      if(sweepFailed||deferredFailed)throw Error('SYNC_ALERT_SWEEP_FAILED');
    },
    evidence_retention:async()=>{const result=await auditEvidenceRetention(env);if(result.errors)throw new Error("EVIDENCE_RETENTION_AUDIT_INCOMPLETE");}
  };
  for(const step of maintenanceSteps){
    const started=Date.now();let outcome="SUCCESS";
    try{await tasks[step]();}catch{
      outcome="FAILED";
      // Retention was already best effort; preserve its severity and policy.
      if(step!=="evidence_retention")failed.push(step);
      console.error("scheduled-maintenance-step-failed",{step});
    }
    await safeRecordMetric(env,"scheduled","scheduled_maintenance_step_ms",Date.now()-started,{step,outcome});
  }
  // Finish independent recoveries before surfacing a failed cron invocation.
  if(failed.length)throw new Error(`SCHEDULED_MAINTENANCE_FAILED:${failed.join(",")}`);
}
