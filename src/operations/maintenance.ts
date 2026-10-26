import { recoverPendingSheetJobs,safeRecordMetric } from "../db/repositories";
import { auditEvidenceRetention } from "../evidence/retention";
import { recoverPendingLineNotifications } from "../line/attendance-notification";
import { finalizeMissingPunchPayrolls } from "../payroll/finalize";
import { refreshCurrentEmployeeWages } from "../payroll/repository";
import { recoverPendingStaffConfigSyncs } from "../sheets/staff-config";
import type { Env } from "../types";

export const maintenanceSteps=["inbound_leases","payroll","sheets_recovery","staff_config_recovery","line_notification_recovery","evidence_retention"] as const;
export type MaintenanceStep=typeof maintenanceSteps[number];

/** No automatic retry here: each existing operation owns its retry boundary. */
export async function runScheduledMaintenance(env:Env):Promise<void>{
  const failed:MaintenanceStep[]=[];
  const tasks:Record<MaintenanceStep,()=>Promise<unknown>>={
    inbound_leases:()=>env.DB.prepare(`UPDATE inbound_events SET status='STALE',error='PROCESSING_LEASE_EXPIRED' WHERE status='PROCESSING' AND last_attempt_at<?`).bind(new Date(Date.now()-15*60_000).toISOString()).run(),
    // These two operations remain dependent and in their original order.
    payroll:async()=>{await refreshCurrentEmployeeWages(env);await finalizeMissingPunchPayrolls(env);},
    sheets_recovery:()=>recoverPendingSheetJobs(env),
    staff_config_recovery:()=>recoverPendingStaffConfigSyncs(env),
    line_notification_recovery:()=>recoverPendingLineNotifications(env),
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
