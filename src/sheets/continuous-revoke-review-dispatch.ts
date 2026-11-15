import type {Env,SheetsSyncJob} from '../types';
import {ReviewRequestBudget} from './review-request-budget';
import {resolvePublicationTarget} from './continuous-publication-route';
import {reviewedPublicationRecovery} from './continuous-publication-reviewed-recovery';
import {recoverPublicationIntent} from './continuous-publication-executor';
import {rearmReviewedRevokeEpoch} from './continuous-revoke-review-rearm';
import {closeReviewedContinuousExpense} from './continuous-review-close';
import {wakeSyncFailureAlerts} from '../line/sync-failure-alerts';

type Dispatch={dispatch_id:string;spreadsheet_id:string;operation_token:string;expense_id:string;source_version:number;transition_id:string;sequence:number;state:'PENDING'|'RUNNING'|'DONE'|'HELD';owner_token:string|null};
const enabled=(e:Env)=>e.CONTINUOUS_REVOKE_REVIEW_RUNNER_ENABLED==='true'&&e.CONTINUOUS_REVOKE_REVIEW_CLOSE_ENABLED==='true'&&e.CONTINUOUS_REVIEW_CLOSE_ENABLED==='true'&&!!e.GOOGLE_SPREADSHEET_ID&&!!e.NOTICE_QUEUE;
const integrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_revoke_review_dispatch' AND name IN ('continuous_revoke_review_dispatch_insert','continuous_revoke_review_dispatch_transition','continuous_revoke_review_dispatch_no_delete','continuous_revoke_review_dispatch_no_replace'))=4 AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='continuous_revoke_review_dispatch_one_live')";

/** Persist one exact phase hint. This performs no provider read or write. */
export async function sweepRevokeReviewDispatch(env:Env):Promise<void>{
 if(!enabled(env))return;const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID!,q=env.NOTICE_QUEUE!;
 const stale=await db.prepare("SELECT dispatch_id,operation_token,owner_token FROM continuous_revoke_review_dispatch WHERE spreadsheet_id=? AND state='RUNNING' AND updated_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes') ORDER BY updated_at LIMIT 1").bind(book).first<{dispatch_id:string;operation_token:string;owner_token:string}>();
 if(stale){
  const finished=await db.prepare(`UPDATE continuous_revoke_review_dispatch SET state='DONE',outcome='COMPLETE',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE dispatch_id=? AND spreadsheet_id=? AND state='RUNNING' AND owner_token=? AND ${integrity} AND EXISTS(SELECT 1 FROM continuous_review_notice_close n WHERE n.spreadsheet_id=continuous_revoke_review_dispatch.spreadsheet_id AND n.operation_token=continuous_revoke_review_dispatch.operation_token AND n.expense_id=continuous_revoke_review_dispatch.expense_id AND n.source_version=continuous_revoke_review_dispatch.source_version AND n.state='COMPLETE')`).bind(stale.dispatch_id,book,stale.owner_token).run();
  if(finished.success!==true||!Number.isSafeInteger(finished.meta?.changes))throw Error('REVOKE_REVIEW_WATCHDOG_UNCERTAIN');
  if(finished.meta.changes===0)await holdDispatch(env,book,stale.dispatch_id,stale.operation_token,stale.owner_token);
 }
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||!enabled(env))return;
 const seed=crypto.randomUUID();await db.prepare(`INSERT INTO continuous_revoke_review_dispatch(dispatch_id,spreadsheet_id,operation_token,expense_id,source_version,transition_id,sequence,state,created_at,updated_at) SELECT ?,c.spreadsheet_id,c.operation_token,i.entity_id,i.source_version,i.transition_id,0,'PENDING',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM stable_workbook_claims c JOIN stable_recovery_epochs e ON e.spreadsheet_id=c.spreadsheet_id AND e.state IN ('ARMED','REVIEW') AND e.target_type='EXPENSE' JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id AND o.operation_token=c.operation_token AND o.state='ADMITTED' JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.target_key AND j.entity_version=e.target_version AND j.status='REVIEW' AND (j.lease_token IS NULL AND j.lease_until IS NULL OR j.lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) JOIN continuous_publication_intents i ON i.spreadsheet_id=c.spreadsheet_id AND i.claim_token=c.operation_token AND i.entity_id=e.target_key AND i.source_version=e.target_version AND i.kind='REVOKE' AND i.state IN ('IN_FLIGHT','VERIFIED') WHERE c.spreadsheet_id=? AND c.state='REVIEW' AND (c.phase='OPERATION' OR (c.phase IS NULL AND c.review_reason='CONTINUOUS_SYNC_LEASE_EXPIRED_UNCERTAIN')) AND NOT EXISTS(SELECT 1 FROM continuous_revoke_review_dispatch d WHERE d.spreadsheet_id=c.spreadsheet_id AND d.operation_token=c.operation_token) AND EXISTS(SELECT 1 FROM continuous_revoke_review_close_activation WHERE singleton=1) AND ${integrity} LIMIT 1 ON CONFLICT DO NOTHING`).bind(seed,book).run();
 const pending=await db.prepare(`SELECT dispatch_id FROM continuous_revoke_review_dispatch WHERE spreadsheet_id=? AND state='PENDING' AND ${integrity} ORDER BY created_at,sequence LIMIT 1`).bind(book).first<{dispatch_id:string}>();
 if(pending&&env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&enabled(env))await q.send({revokeReviewDispatchId:pending.dispatch_id});
}

async function holdDispatch(env:Env,book:string,id:string,claim:string,owner:string):Promise<void>{
 const db=env.DB,reason='REVOKE_REVIEW_RUNNER_HELD';
 const results=await db.batch([
  db.prepare(`UPDATE continuous_revoke_review_dispatch SET state='HELD',outcome='PROOF_UNCERTAIN',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE dispatch_id=? AND spreadsheet_id=? AND operation_token=? AND state='RUNNING' AND owner_token=? AND ${integrity}`).bind(id,book,claim,owner),
  db.prepare(`UPDATE stable_workbook_claims SET review_reason=CASE WHEN review_reason='REVOKE_REVIEW_CLEANUP_COUNT_CHANGED' THEN review_reason ELSE ? END,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='REVIEW' AND changes()=1`).bind(reason,book,claim),
  db.prepare(`UPDATE sync_alert_incidents SET state='CLOSED',closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE kind='WORKBOOK' AND state='OPEN' AND source_id=(SELECT CAST(rowid AS TEXT) FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND review_reason=?) AND changes()=1`).bind(book,claim,reason),
  db.prepare(`INSERT INTO sync_alert_incidents(kind,source_id,category,state,opened_at) SELECT 'WORKBOOK',CAST(c.rowid AS TEXT),'WORKBOOK_REVIEW','OPEN',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='REVIEW' AND c.review_reason=? AND NOT EXISTS(SELECT 1 FROM sync_alert_incidents i WHERE i.kind='WORKBOOK' AND i.source_id=CAST(c.rowid AS TEXT) AND i.state='OPEN') ON CONFLICT DO NOTHING`).bind(book,claim,reason)
 ]);
 if(env.DB!==db||results.length!==4||results.some(x=>x.success!==true)||results[0]!.meta?.changes!==1||results[1]!.meta?.changes!==1)throw Error('REVOKE_REVIEW_DISPATCH_HOLD_UNCERTAIN');await wakeSyncFailureAlerts(env);
}

/** One owned phase per queue invocation. No RUNNING phase is ever stolen. */
export async function runRevokeReviewDispatch(env:Env,id:string):Promise<'DISABLED'|'DUPLICATE'|'RUNNING'|'NEXT'|'DONE'|'HELD'>{
 if(!enabled(env))return 'DISABLED';if(!/^[0-9a-f-]{36}$/.test(id))throw Error('REVOKE_REVIEW_DISPATCH_INVALID');
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID!,stable=()=>env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&enabled(env);
 const d=await db.prepare(`SELECT dispatch_id,spreadsheet_id,operation_token,expense_id,source_version,transition_id,sequence,state,owner_token FROM continuous_revoke_review_dispatch WHERE dispatch_id=? AND spreadsheet_id=? AND ${integrity}`).bind(id,book).first<Dispatch>();
 if(!d||d.state==='DONE'||d.state==='HELD')return 'DUPLICATE';if(d.state==='RUNNING')return 'RUNNING';
 const owner=crypto.randomUUID(),claimed=await db.prepare(`UPDATE continuous_revoke_review_dispatch SET state='RUNNING',owner_token=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE dispatch_id=? AND spreadsheet_id=? AND state='PENDING' AND ${integrity}`).bind(owner,id,book).run();if(!stable()||claimed.success!==true||claimed.meta?.changes!==1)return 'RUNNING';
 try{
  const job:SheetsSyncJob={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:d.expense_id,entityVersion:d.source_version,traceId:'revoke-review'},budget=new ReviewRequestBudget(40);
  const state=await db.prepare(`SELECT i.state,e.state AS epoch_state,i.sheet_id,i.sheet_name,i.row_number FROM continuous_publication_intents i JOIN stable_recovery_epochs e ON e.spreadsheet_id=i.spreadsheet_id AND e.target_type='EXPENSE' AND e.target_key=i.entity_id AND e.target_version=i.source_version JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id AND o.operation_token=i.claim_token WHERE i.transition_id=? AND i.spreadsheet_id=? AND i.claim_token=? AND i.entity_id=? AND i.source_version=? AND i.kind='REVOKE'`).bind(d.transition_id,book,d.operation_token,d.expense_id,d.source_version).first<{state:string;epoch_state:string;sheet_id:number;sheet_name:string;row_number:number}>();
  if(!state||!stable())throw Error('REVOKE_REVIEW_SOURCE_UNVERIFIED');
  let outcome:'IN_PROGRESS'|'COMPLETE'|'HELD'='HELD';
  if(state.state==='IN_FLIGHT'){
   const target=await resolvePublicationTarget(env);if(!target||target.sheetId!==state.sheet_id||target.sheetName!==state.sheet_name)throw Error('REVOKE_REVIEW_TARGET_UNVERIFIED');
   const exact={sheetId:target.sheetId,sheetName:target.sheetName,row:state.row_number,rows:target.rows},candidate=await reviewedPublicationRecovery(env,job,d.operation_token,d.transition_id,exact,budget,async()=>JSON.stringify(await resolvePublicationTarget(env))===JSON.stringify(target),async()=>false);
   if(!candidate)throw Error('REVOKE_REVIEW_PROOF_UNVERIFIED');await recoverPublicationIntent(candidate.intent,candidate.io);outcome='IN_PROGRESS';
  }else if(state.state==='VERIFIED'&&state.epoch_state==='REVIEW')outcome=await rearmReviewedRevokeEpoch(env,job,d.operation_token,d.transition_id,budget)?'IN_PROGRESS':'HELD';
  else if(state.state==='VERIFIED'&&state.epoch_state==='ARMED'){
   const x=await closeReviewedContinuousExpense(env,job,d.operation_token,budget,'REVIEW');outcome=x==='IN_PROGRESS'?'IN_PROGRESS':x==='RESUMED'||x==='ALREADY_COMPLETED'?'COMPLETE':'HELD';
  }
  if(!stable()||outcome==='HELD'||d.sequence>=32){await holdDispatch(env,book,id,d.operation_token,owner);return 'HELD';}
  if(outcome==='COMPLETE'){
   const done=await db.prepare(`UPDATE continuous_revoke_review_dispatch SET state='DONE',outcome='COMPLETE',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE dispatch_id=? AND spreadsheet_id=? AND state='RUNNING' AND owner_token=? AND ${integrity} AND EXISTS(SELECT 1 FROM continuous_review_notice_close n WHERE n.spreadsheet_id=continuous_revoke_review_dispatch.spreadsheet_id AND n.operation_token=continuous_revoke_review_dispatch.operation_token AND n.expense_id=continuous_revoke_review_dispatch.expense_id AND n.source_version=continuous_revoke_review_dispatch.source_version AND n.state='COMPLETE')`).bind(id,book,owner).run();if(done.success!==true||done.meta?.changes!==1)throw Error('REVOKE_REVIEW_DONE_UNCERTAIN');return 'DONE';
  }
  const next=crypto.randomUUID(),r=await db.batch([
   db.prepare(`UPDATE continuous_revoke_review_dispatch SET state='DONE',outcome='IN_PROGRESS',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE dispatch_id=? AND spreadsheet_id=? AND state='RUNNING' AND owner_token=? AND ${integrity}`).bind(id,book,owner),
   db.prepare(`INSERT INTO continuous_revoke_review_dispatch(dispatch_id,spreadsheet_id,operation_token,expense_id,source_version,transition_id,sequence,state,created_at,updated_at) SELECT ?,?,?,?,?,?,?,'PENDING',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE changes()=1 AND ${integrity}`).bind(next,book,d.operation_token,d.expense_id,d.source_version,d.transition_id,d.sequence+1),
   db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
  ]);if(!stable()||r.length!==3||r.some(x=>x.success!==true)||r[0]!.meta?.changes!==1||r[1]!.meta?.changes!==1)throw Error('REVOKE_REVIEW_NEXT_UNCERTAIN');try{await env.NOTICE_QUEUE!.send({revokeReviewDispatchId:next});}catch{/* durable sweep */}return 'NEXT';
 }catch{
  const current=await db.prepare('SELECT state,owner_token FROM continuous_revoke_review_dispatch WHERE dispatch_id=? AND spreadsheet_id=?').bind(id,book).first<{state:string;owner_token:string|null}>();
  if(current?.state==='DONE')return 'DUPLICATE';if(current?.state==='HELD')return 'HELD';if(current?.state==='RUNNING'&&current.owner_token===owner){await holdDispatch(env,book,id,d.operation_token,owner);return 'HELD';}throw Error('REVOKE_REVIEW_DISPATCH_UNCERTAIN');
 }
}
