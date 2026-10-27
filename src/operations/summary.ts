import { onlineOrderReviewSummary } from "../expense/online-order-review-repository";
import type { Env } from "../types";
import { maintenanceSteps } from "./maintenance";

const latencyNames=["inbound_queue_wait_ms","expense_image_queue_wait_ms","expense_image_download_ms","expense_image_extraction_ms","expense_image_total_ms","expense_image_end_to_end_ms","line_reply_ms","sheets_sync_ms"] as const;
const jsonLabels="CASE WHEN json_valid(labels_json) THEN labels_json ELSE '{}' END";
const number=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)&&value>=0?value:0;
type Row=Record<string,unknown>;

/** D1-only diagnostic: no outbound probes, recovery, payloads or identities. */
export async function operationsSummary(env:Env,now=Date.now()){
  const at=new Date(now).toISOString(),since=new Date(now-24*60*60_000).toISOString(),stale=new Date(now-15*60_000).toISOString();
  const [inbound,effects,maintenance,latency,orders]=await Promise.all([
    env.DB.prepare(`SELECT
      COUNT(CASE WHEN last_attempt_at>=? AND last_attempt_at<=? THEN 1 END) recent_events,
      COUNT(CASE WHEN last_attempt_at>=? AND last_attempt_at<=? AND status='FAILED' THEN 1 END) recent_failed,
      COUNT(CASE WHEN last_attempt_at<? AND status='FAILED' THEN 1 END) older_failed,
      COUNT(CASE WHEN status='STALE' OR (status='PROCESSING' AND last_attempt_at<?) THEN 1 END) overdue
      FROM inbound_events`).bind(since,at,since,at,since,stale).first<Row>(),
    env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM failed_jobs WHERE status='OPEN') open_failed,
      (SELECT COUNT(*) FROM failed_jobs WHERE status='OPEN' AND error='DEAD_LETTER_MAX_RETRIES') terminal_dlq,
      (SELECT COUNT(*) FROM failed_jobs WHERE status='OPEN' AND job_key LIKE 'LINE_NOTIFICATION:%') pending_notifications,
      (SELECT COUNT(*) FROM failed_jobs WHERE status='OPEN' AND job_key LIKE 'LINE_NOTIFICATION:%' AND error='LINE_PUSH_QUOTA_EXHAUSTED') quota_blocked_notifications,
      (SELECT COUNT(*) FROM sync_jobs WHERE status IN ('PENDING','FAILED','PROCESSING')) pending_sync,
      (SELECT COUNT(*) FROM sync_jobs WHERE status='PROCESSING' AND lease_until<=?) expired_sync_leases,
      (SELECT COUNT(*) FROM metrics WHERE name='line_reply_failure' AND created_at>=? AND created_at<=?) reply_failures,
      (SELECT COUNT(*) FROM metrics WHERE name='line_response_fallback_failure' AND created_at>=? AND created_at<=?) response_fallback_failures`).bind(at,since,at,since,at).first<Row>(),
    env.DB.prepare(`WITH samples AS (
      SELECT id,created_at,value_ms,json_extract(${jsonLabels},'$.step') step,json_extract(${jsonLabels},'$.outcome') outcome
      FROM metrics WHERE created_at<=? AND name='scheduled_maintenance_step_ms'
    ), ranked AS (
      SELECT step,outcome,created_at,value_ms,
        ROW_NUMBER() OVER(PARTITION BY step ORDER BY created_at DESC,id DESC) rank,
        SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END) OVER(PARTITION BY step) attempts,
        SUM(CASE WHEN created_at>=? AND outcome='FAILED' THEN 1 ELSE 0 END) OVER(PARTITION BY step) failures
      FROM samples WHERE step IN (${maintenanceSteps.map(()=>"?").join(",")}) AND outcome IN ('SUCCESS','FAILED')
    ) SELECT step,outcome,created_at,value_ms,attempts,failures FROM ranked WHERE rank=1`).bind(at,since,since,...maintenanceSteps).all<Row>(),
    env.DB.prepare(`SELECT name,COUNT(*) samples,ROUND(AVG(value_ms)) average_ms,MAX(value_ms) maximum_ms
      FROM metrics WHERE created_at>=? AND created_at<=? AND value_ms>=0 AND name IN (${latencyNames.map(()=>"?").join(",")})
      AND (name NOT IN ('inbound_queue_wait_ms','expense_image_queue_wait_ms') OR (json_extract(${jsonLabels},'$.semantics')='INGRESS_TO_START_V2' AND json_extract(${jsonLabels},'$.clockSkew')='false'))
      AND (name<>'expense_image_end_to_end_ms' OR (json_extract(${jsonLabels},'$.semantics')='INGRESS_TO_COMPLETION_V2' AND json_extract(${jsonLabels},'$.clockSkew')='false'))
      GROUP BY name`).bind(since,at,...latencyNames).all<Row>(),
    onlineOrderReviewSummary(env,undefined,now)
  ]);
  const steps=maintenanceSteps.map(step=>{
    const row=maintenance.results?.find(r=>r.step===step),time=typeof row?.created_at==="string"?row.created_at:null;
    const parsed=time?Date.parse(time):NaN,ageMs=Number.isFinite(parsed)?now-parsed:null;
    const status=ageMs==null||ageMs<0?"UNKNOWN":ageMs>15*60_000?"STALE":row?.outcome==="FAILED"?"FAILED":"SUCCESS";
    return{step,status,bestEffort:step==="evidence_retention",lastAttemptAt:time,attempts:number(row?.attempts),failures:number(row?.failures),lastDurationMs:row?number(row.value_ms):null};
  });
  const timings=latencyNames.map(name=>{const row=latency.results?.find(r=>r.name===name);return{name,samples:number(row?.samples),averageMs:row?number(row.average_ms):null,maximumMs:row?number(row.maximum_ms):null};});
  const failures={recentFailedEvents:number(inbound?.recent_failed),olderFailedEvents:number(inbound?.older_failed),overdueEvents:number(inbound?.overdue),openFailedJobs:number(effects?.open_failed),terminalDlqJobs:number(effects?.terminal_dlq)};
  const actions:string[]=[];
  if(failures.recentFailedEvents||failures.overdueEvents)actions.push("INSPECT_INBOUND_WITHOUT_BLIND_REPLAY");
  if(failures.openFailedJobs||number(effects?.expired_sync_leases))actions.push("INSPECT_SIDE_EFFECT_OUTBOXES");
  if(number(effects?.quota_blocked_notifications))actions.push("CHECK_LINE_PUSH_CAPACITY_BEFORE_MANUAL_RECOVERY");
  if(number(effects?.response_fallback_failures))actions.push("INSPECT_UNDELIVERED_RESPONSES");
  if(steps.some(s=>s.status==="FAILED"||s.status==="STALE"))actions.push("INSPECT_SCHEDULED_STEPS");
  if(orders.total)actions.push("REVIEW_HELD_ONLINE_ORDERS_IN_OWNER_LINE");
  const attention=failures.recentFailedEvents>0||failures.overdueEvents>0||failures.openFailedJobs>0||number(effects?.expired_sync_leases)>0||number(effects?.response_fallback_failures)>0||steps.some(s=>s.status==="FAILED"||s.status==="STALE");
  return{ok:true,checkedAt:at,window:{from:since,to:at,hours:24},status:attention?"ATTENTION":steps.some(s=>s.status==="UNKNOWN")?"UNKNOWN":"OK",
    inbound:{recentEvents:number(inbound?.recent_events),...failures},
    sideEffects:{pendingSyncJobs:number(effects?.pending_sync),expiredSyncLeases:number(effects?.expired_sync_leases),pendingNotifications:number(effects?.pending_notifications),quotaBlockedNotifications:number(effects?.quota_blocked_notifications),replyFailures:number(effects?.reply_failures),responseFallbackFailures:number(effects?.response_fallback_failures)},
    scheduled:{staleAfterMinutes:15,steps},latency:timings,onlineOrders:orders,actions};
}
