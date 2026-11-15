import type {Env} from './types';
import {normalNoticeHandoffEnabled} from './sheets/continuous-normal-notice-handoff';
import {runNoticeDispatch} from './sheets/continuous-notice-dispatch';
import {wakeSyncFailureAlerts} from './line/sync-failure-alerts';
import {issueNoticeProbe,verifyNoticeProbe} from './sheets/continuous-notice-readiness';

type NoticeMessage={dispatchId:string}|{probeId:string};
/** Isolated entrypoint: no batch may share a phase's request budget. */
export default {
 async queue(batch:MessageBatch<NoticeMessage>,env:Env):Promise<void>{
  if(batch.queue!=='malipang-continuous-notice-phases'||batch.messages.length!==1){for(const message of batch.messages)message.retry();return;}
  const message=batch.messages[0]!;
  if(!normalNoticeHandoffEnabled(env)){if(message.body&&'probeId' in message.body)message.ack();else message.retry();return;}
  try{if('probeId' in message.body){await verifyNoticeProbe(env,message.body.probeId);message.ack();}else {const result=await runNoticeDispatch(env,message.body?.dispatchId);if(result==='DISABLED'||result==='RUNNING')message.retry({delaySeconds:60});else message.ack();}}catch{message.retry();}
 },
 async scheduled(_event:ScheduledController,env:Env):Promise<void>{
  if(!normalNoticeHandoffEnabled(env)||!env.GOOGLE_SPREADSHEET_ID||!env.NOTICE_QUEUE)return;
  const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
  try{await issueNoticeProbe(env,'NOTICE_CRON');}catch{/* Missing proof keeps the gate closed. */}
  // A stale runner is never stolen: it is held and surfaced as an incident.
  const stale=await db.prepare("SELECT dispatch_id,operation_token FROM continuous_notice_dispatches WHERE spreadsheet_id=? AND state='RUNNING' AND updated_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes') ORDER BY updated_at LIMIT 1").bind(book).first<{dispatch_id:string;operation_token:string}>();
  if(stale){
   // A completed close is positive durable proof even if the runner crashed
   // before acknowledging its dispatch. It never needs a replay or alert.
   const settled=await db.prepare("UPDATE continuous_notice_dispatches SET state='DONE',outcome='ALREADY_COMPLETED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE dispatch_id=? AND spreadsheet_id=? AND state='RUNNING' AND EXISTS(SELECT 1 FROM continuous_review_notice_close n WHERE n.spreadsheet_id=continuous_notice_dispatches.spreadsheet_id AND n.operation_token=continuous_notice_dispatches.operation_token AND n.expense_id=continuous_notice_dispatches.expense_id AND n.source_version=continuous_notice_dispatches.source_version AND n.state='COMPLETE')").bind(stale.dispatch_id,book).run();
   if(settled.success!==true||!Number.isSafeInteger(settled.meta?.changes))throw Error('NOTICE_WATCHDOG_SETTLE_UNCERTAIN');
   if(settled.meta.changes===0)try{
    const r=await db.batch([
     db.prepare("UPDATE continuous_notice_dispatches SET state='HELD',outcome='RUNNER_CRASH',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE dispatch_id=? AND spreadsheet_id=? AND state='RUNNING' AND updated_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes')").bind(stale.dispatch_id,book),
     db.prepare("UPDATE stable_workbook_claims SET state='REVIEW',phase='END_NOTICE',review_reason='CONTINUOUS_NOTICE_RUNNER_STALLED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='HELD' AND phase='END_NOTICE_PENDING' AND changes()=1 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='stable_workbook_claims' AND name IN ('sync_alert_claim_insert','sync_alert_claim_update','sync_alert_claim_release','sync_alert_claim_resume'))=4").bind(book,stale.operation_token),
     db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
    ]);
    if(r.length===3&&r.every(x=>x.success===true)&&r[0]!.meta?.changes===1&&r[1]!.meta?.changes===1)await wakeSyncFailureAlerts(env);
   }catch{/* Race or unknown D1 outcome: never free or repeat the runner. */}
  }
  if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||!normalNoticeHandoffEnabled(env)||!env.NOTICE_QUEUE)return;
  const pending=await db.prepare("SELECT d.dispatch_id FROM continuous_notice_dispatches d JOIN stable_workbook_claims c ON c.spreadsheet_id=d.spreadsheet_id AND c.operation_token=d.operation_token AND c.state='HELD' AND c.phase='END_NOTICE_PENDING' WHERE d.spreadsheet_id=? AND d.state='PENDING' ORDER BY d.created_at,d.sequence LIMIT 1").bind(book).first<{dispatch_id:string}>();
  if(pending&&env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&normalNoticeHandoffEnabled(env))await env.NOTICE_QUEUE.send({dispatchId:pending.dispatch_id});
 }
};
