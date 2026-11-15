import type {Env,SheetsSyncJob} from '../types';

type CanaryEnv=Env & {CONTINUOUS_CANARY_OPERATOR_ENABLED?:string};
const integrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_canary_operator' AND name IN ('continuous_canary_no_delete','continuous_canary_no_replace','continuous_canary_transition'))=3";
const recoveryIntegrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('stable_recovery_epoch_no_delete','stable_recovery_epoch_transition','stable_recovery_operation_no_delete','stable_recovery_operation_transition'))=4";

/** Record that the queue consumer actually saw the exact completed canary.
 * This runs only after claimSheetSyncJob refused its COMPLETED job; no Sheet
 * claim or provider write is acquired. The exact duplicate epoch is closed
 * atomically with the marker so no unrelated job can pass the recovery gate. */
export async function recordCanaryDuplicateDelivery(env:CanaryEnv,job:SheetsSyncJob):Promise<void>{
 if(env.CONTINUOUS_CANARY_OPERATOR_ENABLED!=='true'||env.STABLE_RECOVERY_GATE_ENABLED!=='true'||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||job.entityVersion!==1||!env.GOOGLE_SPREADSHEET_ID)return;
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,identity=JSON.stringify([job.entityType,job.entityKey,job.entityVersion,job.traceId]);
 const current=async()=>db.prepare(`SELECT c.state,c.duplicate_epoch_id,e.state AS epoch_state FROM continuous_canary_operator c JOIN stable_recovery_epochs e ON e.epoch_id=c.duplicate_epoch_id WHERE c.spreadsheet_id=? AND c.expense_id=? AND c.trace_id=? AND e.spreadsheet_id=c.spreadsheet_id AND e.target_type='EXPENSE' AND e.target_key=c.expense_id AND e.target_version=1 AND ${integrity} AND ${recoveryIntegrity}`).bind(book,job.entityKey,job.traceId).first<{state:string;duplicate_epoch_id:string;epoch_state:string}>();
 const consistent=()=>env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&env.CONTINUOUS_CANARY_OPERATOR_ENABLED==='true'&&env.STABLE_RECOVERY_GATE_ENABLED==='true'&&identity===JSON.stringify([job.entityType,job.entityKey,job.entityVersion,job.traceId]);
 const found=await current();if(!consistent())throw Error('CANARY_DUPLICATE_SCOPE_CHANGED');if(!found)return;
 if(['DUPLICATE_SEEN','DUPLICATE_VERIFIED','UNDOING','UNDONE','ARMED_UNDO','VERIFIED'].includes(found.state)&&found.epoch_state==='COMPLETE')return;
 if(found.state!=='DUPLICATE_ARMED'||found.epoch_state!=='ARMED')throw Error('CANARY_DUPLICATE_STATE_UNVERIFIED');
 try{
  const result=await db.batch([
   db.prepare(`UPDATE stable_recovery_epochs SET state='COMPLETE',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE epoch_id=? AND spreadsheet_id=? AND state='ARMED' AND target_type='EXPENSE' AND target_key=? AND target_version=1 AND ${integrity} AND ${recoveryIntegrity} AND EXISTS(SELECT 1 FROM continuous_canary_operator c JOIN expense_events e ON e.expense_id=c.expense_id JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=1 WHERE c.spreadsheet_id=? AND c.expense_id=? AND c.trace_id=? AND c.state='DUPLICATE_ARMED' AND c.duplicate_epoch_id=stable_recovery_epochs.epoch_id AND e.status='CONFIRMED' AND e.version=1 AND j.status='COMPLETED') AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims WHERE spreadsheet_id=?) AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations WHERE epoch_id=stable_recovery_epochs.epoch_id) AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND (p.entity_id=? OR substr(p.entity_id,1,length(?)+1)=?||'|') AND p.state<>'VERIFIED')`).bind(found.duplicate_epoch_id,book,job.entityKey,book,job.entityKey,job.traceId,book,book,job.entityKey,job.entityKey,job.entityKey),
   db.prepare(`UPDATE continuous_canary_operator SET state='DUPLICATE_SEEN',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND expense_id=? AND trace_id=? AND state='DUPLICATE_ARMED' AND duplicate_epoch_id=? AND EXISTS(SELECT 1 FROM stable_recovery_epochs e WHERE e.epoch_id=continuous_canary_operator.duplicate_epoch_id AND e.state='COMPLETE' AND e.target_type='EXPENSE' AND e.target_key=continuous_canary_operator.expense_id AND e.target_version=1) AND changes()=1`).bind(book,job.entityKey,job.traceId,found.duplicate_epoch_id),
   db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
  ]);
  if(!consistent()||result.length!==3||result.some(x=>x.success!==true)||Number(result[0]!.meta?.changes)!==1||Number(result[1]!.meta?.changes)!==1)throw Error('CANARY_DUPLICATE_RECEIPT_UNCERTAIN');
 }catch(error){
  // Concurrent delivery or an ACK lost after commit can be classified only
  // by the exact persisted marker and epoch; never enqueue a second copy.
  const after=await current().catch(()=>null);if(consistent()&&after?.state==='DUPLICATE_SEEN'&&after.duplicate_epoch_id===found.duplicate_epoch_id&&after.epoch_state==='COMPLETE')return;throw error;
 }
}
