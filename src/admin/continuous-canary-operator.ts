import {continuousSheetsReadPolicy,type ContinuousSheetsReadPolicy} from '../sheets/client';
import type {Env} from '../types';
import {confirmExpenseAtomically} from '../expense/confirm';
import {undoConfirmedExpense} from '../expense/undo';
import {assertContinuousDailyActivated} from '../sheets/continuous-daily-route';
import {readContinuousReportHealth} from '../sheets/continuous-report-health';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,getSheetGridInfo} from '../sheets/client';
import {decodeAtomicDailyPayload} from '../sheets/atomic-daily-template';
import {decodeLedgerCarrier} from '../sheets/atomic-expense-ledger-template';
import {abortContinuousCanary} from './continuous-canary-abort';

type CanaryEnv=Env & {CONTINUOUS_CANARY_OPERATOR_ENABLED?:string};
type Canary={spreadsheet_id:string;expense_id:string;document_id:string;item_id:string;line_user_id:string;transaction_date:string;trace_id:string;duplicate_epoch_id:string|null;state:string};
type Action='PREPARE'|'CONFIRM'|'RECONCILE_CONFIRM'|'ARM_CONFIRM'|'ARM_DUPLICATE'|'VERIFY_DUPLICATE'|'UNDO'|'RECONCILE_UNDO'|'ARM_UNDO'|'VERIFY'|'ABORT';
const description='[SYSTEM TEST] Synthetic expense - cancel after verification';
const category='ingredients',wallet='SHOP_BANK',payment='transfer',amount=100;
const integrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_canary_operator' AND name IN ('continuous_canary_no_delete','continuous_canary_no_replace','continuous_canary_transition'))=3";
const recoveryIntegrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('stable_recovery_epoch_no_delete','stable_recovery_epoch_transition','stable_recovery_operation_no_delete','stable_recovery_operation_transition'))=4";
const confirmIntegrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('continuous_canary_confirm_insert','continuous_canary_confirm_no_delete','continuous_canary_confirm_no_replace','continuous_canary_confirm_transition','continuous_canary_confirm_recovery_fenced'))=5 AND (SELECT count(*) FROM sqlite_master WHERE type='index' AND name='continuous_canary_one_open_confirm_attempt')=1";
// Used only with a bound confirmation-attempt alias `a`. A completed business
// confirmation can be recognized without executing it a second time.
const confirmedProof=`${integrity} AND ${confirmIntegrity} AND ${recoveryIntegrity}
 AND EXISTS(SELECT 1 FROM continuous_canary_operator c JOIN expense_events e ON e.expense_id=c.expense_id JOIN expense_documents d ON d.document_id=c.document_id AND d.expense_id=e.expense_id JOIN expense_document_items i ON i.item_id=c.item_id AND i.document_id=d.document_id AND i.expense_id=e.expense_id JOIN expense_document_links l ON l.document_id=d.document_id AND l.expense_id=e.expense_id AND l.relation_type='PRIMARY_PURCHASE_DOCUMENT' JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=1 JOIN expense_audit_log audit ON audit.expense_id=e.expense_id AND audit.document_id=d.document_id AND audit.action='CONFIRM' AND audit.actor_employee_id IS NULL AND audit.branch_id IS NULL AND audit.reason='' AND json_valid(audit.before_json) AND json_valid(audit.after_json) AND json_extract(audit.before_json,'$.status')='WAITING_CONFIRM' AND json_extract(audit.before_json,'$.version')=1 AND json_extract(audit.after_json,'$.status')='CONFIRMED' AND json_extract(audit.after_json,'$.version')=1 AND audit.created_at=e.updated_at
  WHERE c.spreadsheet_id=a.spreadsheet_id AND c.expense_id=a.expense_id AND c.document_id=a.document_id AND c.state IN ('CONFIRMING','CONFIRMED') AND e.status='CONFIRMED' AND e.version=1 AND e.line_user_id=c.line_user_id AND e.trace_id=c.trace_id AND e.description=? AND e.amount_satang=? AND e.payment_key=? AND e.source_wallet=? AND e.category=? AND e.transaction_date=c.transaction_date AND d.status='CONFIRMED' AND d.line_user_id=c.line_user_id AND d.trace_id=c.trace_id AND d.normalized_json=a.snapshot_normalized_json AND d.updated_at=e.updated_at AND i.description='[SYSTEM TEST] Synthetic item' AND i.line_total_satang=100 AND j.status='PENDING' AND j.trace_id=c.trace_id AND j.attempt_count=0 AND j.lease_token IS NULL AND j.lease_until IS NULL)
 AND (SELECT count(*) FROM expense_documents d WHERE d.expense_id=a.expense_id)=1 AND (SELECT count(*) FROM expense_document_items i WHERE i.expense_id=a.expense_id)=1 AND (SELECT count(*) FROM expense_audit_log x WHERE x.expense_id=a.expense_id AND x.action='CONFIRM')=1
 AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=a.expense_id AND j.entity_version<>1)
 AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND substr(f.job_key,1,length(a.expense_id)+9)='EXPENSE:'||a.expense_id||':')
 AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=a.expense_id OR substr(p.entity_id,1,length(a.expense_id)+1)=a.expense_id||'|'))
 AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=a.expense_id OR substr(p.entity_id,1,length(a.expense_id)+1)=a.expense_id||'|'))
 AND NOT EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.entity_key=a.expense_id OR substr(i.entity_key,1,length(a.expense_id)+1)=a.expense_id||'|')
 AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims w WHERE w.spreadsheet_id=a.spreadsheet_id) AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs x WHERE x.spreadsheet_id=a.spreadsheet_id AND x.state IN ('ARMED','REVIEW')) AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations o JOIN stable_recovery_epochs x ON x.epoch_id=o.epoch_id WHERE x.spreadsheet_id=a.spreadsheet_id AND o.state='ADMITTED')`;
const confirmedArgs=()=>[description,amount,payment,wallet,category];
const q=(s:string)=>`'${s.replace(/'/g,"''")}'`;
const stamp=()=>new Date().toISOString();
const token=(p:string)=>`${p}_${crypto.randomUUID().replace(/-/g,'')}`;
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
async function row(env:CanaryEnv):Promise<Canary|null>{return env.DB.prepare(`SELECT * FROM continuous_canary_operator WHERE spreadsheet_id=? AND ${integrity}`).bind(env.GOOGLE_SPREADSHEET_ID).first<Canary>();}
async function move(env:CanaryEnv,r:Canary,from:string,to:string):Promise<void>{
 const result=await env.DB.prepare(`UPDATE continuous_canary_operator SET state=?,updated_at=? WHERE spreadsheet_id=? AND expense_id=? AND state=? AND ${integrity}`).bind(to,stamp(),r.spreadsheet_id,r.expense_id,from).run();
 if(result.success!==true||result.meta?.changes!==1)throw Error('CANARY_STATE_UNCERTAIN');
}
async function ready(env:CanaryEnv):Promise<void>{
 if(env.CONTINUOUS_CANARY_OPERATOR_ENABLED!=='true'||env.STABLE_RECOVERY_GATE_ENABLED!=='true'||env.STABLE_SHEETS_PACING_ENABLED!=='true'||env.SHEETS_SYNC_ENABLED!=='true'||!env.GOOGLE_SPREADSHEET_ID||!await assertContinuousDailyActivated(env))throw Error('CANARY_DISABLED');
}
async function noActive(env:CanaryEnv):Promise<void>{
 const v=await env.DB.prepare(`SELECT 1 AS ok WHERE ${integrity} AND ${recoveryIntegrity} AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims WHERE spreadsheet_id=?) AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs WHERE spreadsheet_id=? AND state IN ('ARMED','REVIEW')) AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations o JOIN stable_recovery_epochs e ON e.epoch_id=o.epoch_id WHERE e.spreadsheet_id=? AND o.state='ADMITTED')`).bind(env.GOOGLE_SPREADSHEET_ID,env.GOOGLE_SPREADSHEET_ID,env.GOOGLE_SPREADSHEET_ID).first<{ok:number}>();
 if(v?.ok!==1)throw Error('CANARY_NOT_QUIESCENT');
}
async function confirmedAttempt(env:CanaryEnv,r:Canary,attempt:string):Promise<boolean>{
 const db=env.DB,book=r.spreadsheet_id;
 const proof=await db.prepare(`SELECT 1 AS ok FROM continuous_canary_confirm_attempts a WHERE a.attempt_id=? AND a.spreadsheet_id=? AND a.expense_id=? AND a.document_id=? AND a.state='CONFIRMED' AND EXISTS(SELECT 1 FROM continuous_canary_operator c WHERE c.spreadsheet_id=a.spreadsheet_id AND c.expense_id=a.expense_id AND c.state='CONFIRMED') AND ${confirmedProof}`).bind(attempt,book,r.expense_id,r.document_id,...confirmedArgs()).first<{ok:number}>();
 return env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&env.CONTINUOUS_CANARY_OPERATOR_ENABLED==='true'&&env.STABLE_RECOVERY_GATE_ENABLED==='true'&&proof?.ok===1;
}
/** Only a positively matched transaction may complete the attempt. If the
 * normal caller and recovery race, D1 serializes their batches and the loser
 * can accept only an exact readback of the already committed result. */
async function settleConfirmedAttempt(env:CanaryEnv,r:Canary,attempt:string):Promise<void>{
 const db=env.DB,book=r.spreadsheet_id;
 try{
  const finish=await db.batch([
   db.prepare(`UPDATE continuous_canary_confirm_attempts AS a SET state='CONFIRMED',updated_at=? WHERE a.attempt_id=? AND a.spreadsheet_id=? AND a.expense_id=? AND a.document_id=? AND a.state='STARTED' AND ${confirmedProof}`).bind(stamp(),attempt,book,r.expense_id,r.document_id,...confirmedArgs()),
   db.prepare("UPDATE continuous_canary_operator SET state='CONFIRMED',updated_at=? WHERE spreadsheet_id=? AND expense_id=? AND state='CONFIRMING' AND changes()=1 AND EXISTS(SELECT 1 FROM continuous_canary_confirm_attempts a WHERE a.attempt_id=? AND a.state='CONFIRMED')").bind(stamp(),book,r.expense_id,attempt),
   db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
  ]);
  if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||finish.length!==3||finish.some(x=>x.success!==true)||Number(finish[0]!.meta?.changes)!==1||Number(finish[1]!.meta?.changes)!==1)throw Error('CANARY_CONFIRM_FINAL_UNCERTAIN');
 }catch(error){if(await confirmedAttempt(env,r,attempt).catch(()=>false))return;throw error;}
}

/** Synthetic one-baht itemized transaction, clearly marked in all projections.
 * Only the normal confirmation, queue writer and Undo execute business state
 * transitions; this does not impersonate a LINE event or send a LINE message.
 * Any unknown outcome remains in a non-retryable intermediate state. */
async function prepare(env:CanaryEnv):Promise<void>{
 await noActive(env);const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID!,now=stamp(),date=today();
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('CANARY_DATE_UNVERIFIED');
 const id=token('exp_canary'),doc=token('doc_canary'),item=token('item_canary'),line=token('CANARY_NO_LINE'),trace=token('trace_canary'),message=token('msg_canary');
 const result=await db.batch([
  db.prepare(`INSERT INTO continuous_canary_operator(spreadsheet_id,expense_id,document_id,item_id,line_user_id,transaction_date,trace_id,state,created_at,updated_at) SELECT ?,?,?,?,?,?,?,'DRAFT',?,? WHERE ${integrity} AND ${recoveryIntegrity} AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims WHERE spreadsheet_id=?) AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs WHERE spreadsheet_id=? AND state IN ('ARMED','REVIEW')) AND EXISTS(SELECT 1 FROM continuous_daily_cutovers WHERE spreadsheet_id=? AND state='ACTIVE')`).bind(book,id,doc,item,line,date,trace,now,now,book,book,book),
  db.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at,updated_at,version) SELECT ?,?,?,?,?,?,?,?,?,'WAITING_CONFIRM',?,?,?,1 WHERE EXISTS(SELECT 1 FROM continuous_canary_operator WHERE spreadsheet_id=? AND expense_id=? AND state='DRAFT')`).bind(id,message,line,description,amount,payment,wallet,category,date,trace,now,now,book,id),
  db.prepare(`INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,trace_id,created_at,updated_at,expense_id,vendor_name,document_number,document_date,final_paid_satang,normalized_json) SELECT ?,?,?,'RECEIPT','WAITING_CONFIRM',?,?,?,?,?,?,?,?,'{}' WHERE EXISTS(SELECT 1 FROM expense_events WHERE expense_id=? AND status='WAITING_CONFIRM')`).bind(doc,token('msg_canary_doc'),line,trace,now,now,id,'[SYSTEM TEST]',token('CANARY'),date,amount,id),
  db.prepare(`INSERT INTO expense_document_items(item_id,document_id,expense_id,description,quantity,unit,unit_price_satang,line_total_satang,needs_review,created_at,updated_at) SELECT ?,?,?,'[SYSTEM TEST] Synthetic item',1,'test',?,?,0,?,? WHERE EXISTS(SELECT 1 FROM expense_documents WHERE document_id=? AND expense_id=?)`).bind(item,doc,id,amount,amount,now,now,doc,id),
  db.prepare(`INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,reason,created_at) SELECT ?,?,?,'PRIMARY_PURCHASE_DOCUMENT','MANUAL','SYSTEM_TEST',? WHERE EXISTS(SELECT 1 FROM expense_document_items WHERE item_id=? AND expense_id=?)`).bind(token('link_canary'),id,doc,now,item,id),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);
 if(env.DB!==db||result.length!==6||result.some(x=>x.success!==true))throw Error('CANARY_PREPARE_UNCERTAIN');
}
async function confirm(env:CanaryEnv,r:Canary):Promise<void>{
 await noActive(env);const doc=await env.DB.prepare("SELECT normalized_json,updated_at FROM expense_documents WHERE document_id=? AND expense_id=? AND status='WAITING_CONFIRM'").bind(r.document_id,r.expense_id).first<{normalized_json:string|null;updated_at:string|null}>();if(!doc)throw Error('CANARY_DRAFT_UNVERIFIED');
 if(typeof doc.updated_at!=='string'||!doc.updated_at||doc.normalized_json!=='{}')throw Error('CANARY_DRAFT_UNVERIFIED');
 const attempt=token('canary_confirm'),now=stamp(),db=env.DB;
 const begin=await db.batch([
  db.prepare(`INSERT INTO continuous_canary_confirm_attempts(attempt_id,spreadsheet_id,expense_id,document_id,snapshot_updated_at,snapshot_normalized_json,state,created_at,updated_at) SELECT ?,?,?,?,?,?,'STARTED',?,? WHERE ${integrity} AND ${confirmIntegrity} AND ${recoveryIntegrity} AND EXISTS(SELECT 1 FROM continuous_canary_operator c WHERE c.spreadsheet_id=? AND c.expense_id=? AND c.document_id=? AND c.state='DRAFT') AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims WHERE spreadsheet_id=?) AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs WHERE spreadsheet_id=? AND state IN ('ARMED','REVIEW'))`).bind(attempt,r.spreadsheet_id,r.expense_id,r.document_id,doc.updated_at,doc.normalized_json,now,now,r.spreadsheet_id,r.expense_id,r.document_id,r.spreadsheet_id,r.spreadsheet_id),
  db.prepare("UPDATE continuous_canary_operator SET state='CONFIRMING',updated_at=? WHERE spreadsheet_id=? AND expense_id=? AND state='DRAFT' AND changes()=1 AND EXISTS(SELECT 1 FROM continuous_canary_confirm_attempts a WHERE a.attempt_id=? AND a.spreadsheet_id=continuous_canary_operator.spreadsheet_id AND a.expense_id=continuous_canary_operator.expense_id AND a.state='STARTED')").bind(now,r.spreadsheet_id,r.expense_id,attempt),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);
 if(env.DB!==db||begin.length!==3||begin.some(x=>x.success!==true)||Number(begin[0]!.meta?.changes)!==1||Number(begin[1]!.meta?.changes)!==1)throw Error('CANARY_CONFIRM_RESERVATION_UNCERTAIN');
 const version=await confirmExpenseAtomically(env,{expenseId:r.expense_id,lineUserId:r.line_user_id,traceId:r.trace_id,actorEmployeeId:null,branchId:null,snapshot:{description,amountSatang:amount,transactionDate:r.transaction_date,paymentKey:payment,sourceWallet:wallet,category,version:1},documentSnapshot:{documentId:r.document_id,normalizedJson:doc.normalized_json,updatedAt:doc.updated_at}});
 if(version!==1)throw Error('CANARY_CONFIRM_UNCERTAIN');
 await settleConfirmedAttempt(env,r,attempt);
}
/** Invalidate the exact reserved document snapshot before reopening a draft.
 * An old confirmation that reaches D1 later cannot match its captured
 * updated_at; if it committed first, the WAITING_CONFIRM guard rejects this
 * transaction. No confirmation or Queue call is issued by this action. */
async function reconcileConfirm(env:CanaryEnv,r:Canary):Promise<void>{
 const db=env.DB,book=r.spreadsheet_id;
 if(r.state==='CONFIRMED'){
  const previous=await db.prepare("SELECT attempt_id FROM continuous_canary_confirm_attempts WHERE spreadsheet_id=? AND expense_id=? AND document_id=? AND state='CONFIRMED' ORDER BY rowid DESC LIMIT 1").bind(book,r.expense_id,r.document_id).first<{attempt_id:string}>();
  if(previous?.attempt_id&&await confirmedAttempt(env,r,previous.attempt_id))return;
  throw Error('CANARY_CONFIRM_RECONCILE_UNVERIFIED');
 }
 if(r.state!=='CONFIRMING')throw Error('CANARY_CONFIRM_RECONCILE_UNVERIFIED');
 const attempt=await db.prepare(`SELECT a.attempt_id,a.snapshot_updated_at,a.snapshot_normalized_json FROM continuous_canary_confirm_attempts a WHERE a.spreadsheet_id=? AND a.expense_id=? AND a.document_id=? AND a.state='STARTED' AND ${confirmIntegrity}`).bind(book,r.expense_id,r.document_id).first<{attempt_id:string;snapshot_updated_at:string;snapshot_normalized_json:string}>();
 if(!attempt||!attempt.attempt_id||typeof attempt.snapshot_updated_at!=='string'||attempt.snapshot_normalized_json!=='{}'||env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book)throw Error('CANARY_CONFIRM_RECONCILE_UNVERIFIED');
 const source=await db.prepare("SELECT status,version FROM expense_events WHERE expense_id=?").bind(r.expense_id).first<{status:string;version:number}>();
 if(source?.status==='CONFIRMED'&&source.version===1){await settleConfirmedAttempt(env,r,attempt.attempt_id);return;}
 if(source?.status!=='WAITING_CONFIRM'||source.version!==1)throw Error('CANARY_CONFIRM_RECONCILE_UNVERIFIED');
 // Never restore any earlier snapshot: an older request may still arrive
 // after multiple recoveries. Distinct ISO seconds give a bounded choice.
 const past=await db.prepare('SELECT snapshot_updated_at FROM continuous_canary_confirm_attempts WHERE spreadsheet_id=? AND expense_id=?').bind(book,r.expense_id).all<{snapshot_updated_at:string}>();
 if(past.success!==true||!Array.isArray(past.results)||past.results.length<1||past.results.length>1000||past.results.some(x=>typeof x.snapshot_updated_at!=='string')||env.DB!==db)throw Error('CANARY_CONFIRM_RECONCILE_UNVERIFIED');
 const used=new Set(past.results.map(x=>x.snapshot_updated_at)),base=Date.now();let next='';
 for(let i=1;i<=used.size+1;i++){const candidate=new Date(base+i*1000).toISOString();if(!used.has(candidate)){next=candidate;break;}}
 if(!next)throw Error('CANARY_CONFIRM_RECONCILE_UNVERIFIED');
 let result:D1Result[];
 try{result=await db.batch([
  db.prepare(`UPDATE expense_documents AS d SET updated_at=? WHERE d.document_id=? AND d.expense_id=? AND d.status='WAITING_CONFIRM' AND d.updated_at IS ? AND d.normalized_json IS ? AND ${integrity} AND ${confirmIntegrity} AND ${recoveryIntegrity}
   AND EXISTS(SELECT 1 FROM continuous_canary_operator c JOIN expense_events e ON e.expense_id=c.expense_id JOIN expense_document_items i ON i.item_id=c.item_id AND i.expense_id=e.expense_id AND i.document_id=d.document_id JOIN expense_document_links l ON l.expense_id=e.expense_id AND l.document_id=d.document_id AND l.relation_type='PRIMARY_PURCHASE_DOCUMENT' JOIN continuous_canary_confirm_attempts a ON a.spreadsheet_id=c.spreadsheet_id AND a.expense_id=c.expense_id AND a.document_id=d.document_id
    WHERE c.spreadsheet_id=? AND c.expense_id=? AND c.document_id=d.document_id AND c.state='CONFIRMING' AND a.attempt_id=? AND a.state='STARTED' AND a.snapshot_updated_at IS d.updated_at AND a.snapshot_normalized_json IS d.normalized_json AND e.status='WAITING_CONFIRM' AND e.version=1 AND e.line_user_id=c.line_user_id AND e.trace_id=c.trace_id AND e.description=? AND e.amount_satang=? AND e.payment_key=? AND e.source_wallet=? AND e.category=? AND e.transaction_date=c.transaction_date AND d.line_user_id=c.line_user_id AND d.trace_id=c.trace_id AND i.description='[SYSTEM TEST] Synthetic item' AND i.line_total_satang=100)
   AND (SELECT count(*) FROM expense_documents x WHERE x.expense_id=d.expense_id)=1 AND (SELECT count(*) FROM expense_document_items x WHERE x.expense_id=d.expense_id)=1
   AND NOT EXISTS(SELECT 1 FROM continuous_canary_confirm_attempts previous WHERE previous.spreadsheet_id=? AND previous.expense_id=d.expense_id AND previous.snapshot_updated_at=?)
   AND NOT EXISTS(SELECT 1 FROM expense_audit_log a WHERE a.expense_id=d.expense_id AND a.action='CONFIRM') AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=d.expense_id)
   AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=d.expense_id OR substr(p.entity_id,1,length(d.expense_id)+1)=d.expense_id||'|'))
   AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=d.expense_id OR substr(p.entity_id,1,length(d.expense_id)+1)=d.expense_id||'|'))
   AND NOT EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.entity_key=d.expense_id OR substr(i.entity_key,1,length(d.expense_id)+1)=d.expense_id||'|')
   AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND substr(f.job_key,1,length(d.expense_id)+9)='EXPENSE:'||d.expense_id||':')
   AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims w WHERE w.spreadsheet_id=?) AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs x WHERE x.spreadsheet_id=? AND x.state IN ('ARMED','REVIEW')) AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations o JOIN stable_recovery_epochs x ON x.epoch_id=o.epoch_id WHERE x.spreadsheet_id=? AND o.state='ADMITTED')`).bind(next,r.document_id,r.expense_id,attempt.snapshot_updated_at,attempt.snapshot_normalized_json,book,r.expense_id,attempt.attempt_id,description,amount,payment,wallet,category,book,next,book,book,book),
  db.prepare(`UPDATE continuous_canary_confirm_attempts SET state='INVALIDATED',recovered_updated_at=?,updated_at=? WHERE attempt_id=? AND spreadsheet_id=? AND expense_id=? AND state='STARTED' AND changes()=1 AND EXISTS(SELECT 1 FROM expense_documents d WHERE d.document_id=continuous_canary_confirm_attempts.document_id AND d.expense_id=continuous_canary_confirm_attempts.expense_id AND d.status='WAITING_CONFIRM' AND d.updated_at=?)`).bind(next,stamp(),attempt.attempt_id,book,r.expense_id,next),
  db.prepare(`UPDATE continuous_canary_operator SET state='DRAFT',updated_at=? WHERE spreadsheet_id=? AND expense_id=? AND state='CONFIRMING' AND changes()=1 AND EXISTS(SELECT 1 FROM continuous_canary_confirm_attempts a WHERE a.attempt_id=? AND a.state='INVALIDATED' AND a.recovered_updated_at=?)`).bind(stamp(),book,r.expense_id,attempt.attempt_id,next),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);}catch(error){
  // The original request may have committed between our source read and
  // recovery transaction. Recognize it only via the same exact proof.
  const current=await db.prepare("SELECT status,version FROM expense_events WHERE expense_id=?").bind(r.expense_id).first<{status:string;version:number}>().catch(()=>null);
  if(env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&current?.status==='CONFIRMED'&&current.version===1){await settleConfirmedAttempt(env,r,attempt.attempt_id);return;}
  throw error;
 }
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||env.CONTINUOUS_CANARY_OPERATOR_ENABLED!=='true'||env.STABLE_RECOVERY_GATE_ENABLED!=='true'||result.length!==4||result.some(x=>x.success!==true)||[0,1,2].some(i=>Number(result[i]!.meta?.changes)!==1))throw Error('CANARY_CONFIRM_RECONCILE_UNCERTAIN');
}
async function arm(env:CanaryEnv,r:Canary,version:1|2):Promise<void>{
 await noActive(env);const expected=version===1?'CONFIRMED':'UNDONE',next=version===1?'ARMED_CONFIRM':'ARMED_UNDO',state=version===1?'CONFIRMED':'CANCELLED',now=stamp(),epoch=token('canary_epoch');
 const results=await env.DB.batch([
  env.DB.prepare(`INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) SELECT ?,?,'ARMED','EXPENSE',?,?,?,? WHERE ${integrity} AND ${recoveryIntegrity} AND EXISTS(SELECT 1 FROM continuous_canary_operator c JOIN expense_events e ON e.expense_id=c.expense_id JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version WHERE c.spreadsheet_id=? AND c.expense_id=? AND c.state=? AND e.status=? AND e.version=? AND j.status='PENDING' AND j.attempt_count=0 AND j.lease_token IS NULL AND j.lease_until IS NULL) AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims WHERE spreadsheet_id=?) AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs WHERE spreadsheet_id=? AND state IN ('ARMED','REVIEW')) AND EXISTS(SELECT 1 FROM continuous_daily_cutovers WHERE spreadsheet_id=? AND state='ACTIVE') AND NOT EXISTS(SELECT 1 FROM failed_jobs WHERE queue_name='malipang-jobs' AND job_key='EXPENSE:'||?||':'||? AND status='OPEN')`).bind(epoch,r.spreadsheet_id,r.expense_id,version,now,now,r.spreadsheet_id,r.expense_id,expected,state,version,r.spreadsheet_id,r.spreadsheet_id,r.spreadsheet_id,r.expense_id,version),
  env.DB.prepare(`UPDATE continuous_canary_operator SET state=?,updated_at=? WHERE spreadsheet_id=? AND expense_id=? AND state=? AND EXISTS(SELECT 1 FROM stable_recovery_epochs WHERE epoch_id=? AND spreadsheet_id=? AND state='ARMED' AND target_type='EXPENSE' AND target_key=? AND target_version=?)`).bind(next,now,r.spreadsheet_id,r.expense_id,expected,epoch,r.spreadsheet_id,r.expense_id,version),
  env.DB.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);
 if(results.length!==3||results.some(x=>x.success!==true)||Number(results[0]!.meta?.changes)!==1||Number(results[1]!.meta?.changes)!==1)throw Error('CANARY_ARM_UNCERTAIN');
}
async function completed(env:CanaryEnv,r:Canary,version:1|2):Promise<void>{
 await noActive(env);
 const value=await env.DB.prepare(`SELECT 1 AS ok WHERE EXISTS(SELECT 1 FROM expense_events e JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version WHERE e.expense_id=? AND e.version=? AND e.status=? AND j.status='COMPLETED') AND EXISTS(SELECT 1 FROM stable_recovery_epochs WHERE spreadsheet_id=? AND state='COMPLETE' AND target_type='EXPENSE' AND target_key=? AND target_version=?) AND (SELECT count(*) FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND ((p.entity_id=? AND p.projection IN ('DAILY','EXPENSE_RAW')) OR (p.entity_id=? AND p.projection='DETAIL')) AND p.source_version=1 AND p.state='VERIFIED')=3 AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND (p.entity_id=? OR substr(p.entity_id,1,length(?)+1)=?||'|') AND p.state<>'VERIFIED') AND (?=1 OR (SELECT count(*) FROM stable_expense_cancellation_writes c WHERE c.spreadsheet_id=? AND c.entity_type='EXPENSE' AND ((c.entity_id=? AND c.projection IN ('DAILY','EXPENSE_RAW')) OR (c.entity_id=? AND c.projection='DETAIL')) AND c.cancellation_version=2 AND c.previous_version=1 AND c.state='VERIFIED')=3)`).bind(r.expense_id,version,version===1?'CONFIRMED':'CANCELLED',r.spreadsheet_id,r.expense_id,version,r.spreadsheet_id,r.expense_id,`${r.expense_id}|${r.item_id}`,r.spreadsheet_id,r.expense_id,r.expense_id,r.expense_id,version,r.spreadsheet_id,r.expense_id,`${r.expense_id}|${r.item_id}`).first<{ok:number}>();
 if(value?.ok!==1)throw Error('CANARY_COMPLETION_UNVERIFIED');
}
/** Atomically reserve an exact second delivery of the already completed v1.
 * The durable epoch/marker precede Queue.send, and an unknown send result is
 * never retried. Only the real consumer can record DUPLICATE_SEEN. */
async function armDuplicate(env:CanaryEnv,r:Canary):Promise<void>{
 if(r.state!=='ARMED_CONFIRM'||r.duplicate_epoch_id!==null)throw Error('CANARY_STATE_UNVERIFIED');
 await completed(env,r,1);await provider(env,r,1);await noActive(env);
 const epoch=token('canary_duplicate'),now=stamp();
 const result=await env.DB.batch([
  env.DB.prepare(`INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) SELECT ?,?,'ARMED','EXPENSE',?,1,?,? WHERE ${integrity} AND ${recoveryIntegrity} AND EXISTS(SELECT 1 FROM continuous_canary_operator c JOIN expense_events e ON e.expense_id=c.expense_id JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=1 WHERE c.spreadsheet_id=? AND c.expense_id=? AND c.state='ARMED_CONFIRM' AND c.duplicate_epoch_id IS NULL AND e.status='CONFIRMED' AND e.version=1 AND j.status='COMPLETED') AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims WHERE spreadsheet_id=?) AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs WHERE spreadsheet_id=? AND state IN ('ARMED','REVIEW')) AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND (p.entity_id=? OR substr(p.entity_id,1,length(?)+1)=?||'|') AND p.state<>'VERIFIED')`).bind(epoch,r.spreadsheet_id,r.expense_id,now,now,r.spreadsheet_id,r.expense_id,r.spreadsheet_id,r.spreadsheet_id,r.spreadsheet_id,r.expense_id,r.expense_id,r.expense_id),
  env.DB.prepare(`UPDATE continuous_canary_operator SET state='DUPLICATE_ARMED',duplicate_epoch_id=?,updated_at=? WHERE spreadsheet_id=? AND expense_id=? AND state='ARMED_CONFIRM' AND duplicate_epoch_id IS NULL AND changes()=1 AND EXISTS(SELECT 1 FROM stable_recovery_epochs e WHERE e.epoch_id=? AND e.spreadsheet_id=? AND e.state='ARMED' AND e.target_type='EXPENSE' AND e.target_key=? AND e.target_version=1)`).bind(epoch,now,r.spreadsheet_id,r.expense_id,epoch,r.spreadsheet_id,r.expense_id),
  env.DB.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);
 if(result.length!==3||result.some(x=>x.success!==true)||Number(result[0]!.meta?.changes)!==1||Number(result[1]!.meta?.changes)!==1)throw Error('CANARY_DUPLICATE_ARM_UNCERTAIN');
 // Failure can mean the Queue accepted the message but its ACK was lost.
 // Keep the epoch armed; an actual delivery records its own evidence.
 await env.JOB_QUEUE.send({kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:r.expense_id,entityVersion:1,traceId:r.trace_id});
}
async function verifyDuplicate(env:CanaryEnv,r:Canary):Promise<void>{
 if(r.state!=='DUPLICATE_SEEN'||!r.duplicate_epoch_id)throw Error('CANARY_DUPLICATE_NOT_SEEN');
 await completed(env,r,1);
 const evidence=await env.DB.prepare("SELECT 1 AS ok FROM stable_recovery_epochs WHERE epoch_id=? AND spreadsheet_id=? AND state='COMPLETE' AND target_type='EXPENSE' AND target_key=? AND target_version=1 AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations WHERE epoch_id=stable_recovery_epochs.epoch_id)").bind(r.duplicate_epoch_id,r.spreadsheet_id,r.expense_id).first<{ok:number}>();
 if(evidence?.ok!==1)throw Error('CANARY_DUPLICATE_NOT_SEEN');
 await provider(env,r,1);await move(env,r,'DUPLICATE_SEEN','DUPLICATE_VERIFIED');
}

/** Resolve only a lost acknowledgement of the synthetic Undo. The business
 * transaction and its v2 outbox must already exist in full; this statement
 * merely advances the private marker and never invokes Undo or Queue.send. */
async function reconcileUndo(env:CanaryEnv,r:Canary):Promise<void>{
 if(r.state!=='UNDOING'||!r.duplicate_epoch_id)throw Error('CANARY_UNDO_RECONCILE_UNVERIFIED');
 const db=env.DB,book=r.spreadsheet_id;
 const result=await db.prepare(`UPDATE continuous_canary_operator AS c SET state='UNDONE',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE c.spreadsheet_id=? AND c.expense_id=? AND c.state='UNDOING' AND c.duplicate_epoch_id=? AND ${integrity} AND ${recoveryIntegrity}
  AND EXISTS(SELECT 1 FROM stable_recovery_epochs d WHERE d.epoch_id=c.duplicate_epoch_id AND d.spreadsheet_id=c.spreadsheet_id AND d.state='COMPLETE' AND d.target_type='EXPENSE' AND d.target_key=c.expense_id AND d.target_version=1 AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations o WHERE o.epoch_id=d.epoch_id))
  AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims w WHERE w.spreadsheet_id=c.spreadsheet_id)
  AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs e WHERE e.spreadsheet_id=c.spreadsheet_id AND e.state IN ('ARMED','REVIEW'))
  AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations o JOIN stable_recovery_epochs e ON e.epoch_id=o.epoch_id WHERE e.spreadsheet_id=c.spreadsheet_id AND o.state='ADMITTED')
  AND EXISTS(SELECT 1 FROM expense_events e JOIN expense_documents d ON d.document_id=c.document_id AND d.expense_id=e.expense_id JOIN expense_document_items i ON i.item_id=c.item_id AND i.document_id=d.document_id AND i.expense_id=e.expense_id JOIN expense_document_links l ON l.document_id=d.document_id AND l.expense_id=e.expense_id AND l.relation_type='PRIMARY_PURCHASE_DOCUMENT'
   JOIN sync_jobs original ON original.entity_type='EXPENSE' AND original.entity_key=e.expense_id AND original.entity_version=1
   JOIN sync_jobs undo ON undo.entity_type='EXPENSE' AND undo.entity_key=e.expense_id AND undo.entity_version=2
   JOIN expense_audit_log a ON a.expense_id=e.expense_id AND a.action='UNDO' AND a.actor_employee_id IS NULL AND a.branch_id IS NULL AND a.reason='' AND json_valid(a.before_json) AND json_valid(a.after_json) AND json_extract(a.before_json,'$.status')='CONFIRMED' AND json_extract(a.before_json,'$.version')=1 AND json_extract(a.after_json,'$.status')='CANCELLED' AND json_extract(a.after_json,'$.version')=2 AND a.created_at=e.updated_at
   WHERE e.expense_id=c.expense_id AND e.status='CANCELLED' AND e.version=2 AND e.line_user_id=c.line_user_id AND e.trace_id=c.trace_id AND e.description=? AND e.amount_satang=? AND e.payment_key=? AND e.source_wallet=? AND e.category=? AND e.transaction_date=c.transaction_date
    AND d.status='CANCELLED' AND d.line_user_id=c.line_user_id AND d.trace_id=c.trace_id AND d.updated_at=e.updated_at AND i.description='[SYSTEM TEST] Synthetic item' AND i.line_total_satang=100
    AND original.status='COMPLETED' AND undo.status='PENDING' AND undo.trace_id=c.trace_id AND undo.attempt_count=0 AND undo.lease_token IS NULL AND undo.lease_until IS NULL)
  AND (SELECT count(*) FROM expense_documents d WHERE d.expense_id=c.expense_id)=1 AND (SELECT count(*) FROM expense_document_items i WHERE i.expense_id=c.expense_id)=1
  AND (SELECT count(*) FROM expense_audit_log a WHERE a.expense_id=c.expense_id AND a.action='UNDO')=1
  AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=c.expense_id AND j.entity_version NOT IN (1,2))
  AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.status='OPEN' AND f.job_key IN ('EXPENSE:'||c.expense_id||':1','EXPENSE:'||c.expense_id||':2'))
  AND (SELECT count(*) FROM stable_projection_writes p WHERE p.spreadsheet_id=c.spreadsheet_id AND p.entity_type='EXPENSE' AND ((p.entity_id=c.expense_id AND p.projection IN ('DAILY','EXPENSE_RAW')) OR (p.entity_id=c.expense_id||'|'||c.item_id AND p.projection='DETAIL')) AND p.source_version=1 AND p.state='VERIFIED')=3
  AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=c.spreadsheet_id AND p.entity_type='EXPENSE' AND (p.entity_id=c.expense_id OR substr(p.entity_id,1,length(c.expense_id)+1)=c.expense_id||'|') AND p.state<>'VERIFIED')
  AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes w WHERE w.spreadsheet_id=c.spreadsheet_id AND w.entity_type='EXPENSE' AND (w.entity_id=c.expense_id OR substr(w.entity_id,1,length(c.expense_id)+1)=c.expense_id||'|'))`).bind(book,r.expense_id,r.duplicate_epoch_id,description,amount,payment,wallet,category).run();
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||env.CONTINUOUS_CANARY_OPERATOR_ENABLED!=='true'||env.STABLE_RECOVERY_GATE_ENABLED!=='true'||result.success!==true||Number(result.meta?.changes)!==1)throw Error('CANARY_UNDO_RECONCILE_UNVERIFIED');
}
async function provider(env:CanaryEnv,r:Canary,version:1|2,policy:ContinuousSheetsReadPolicy=continuousSheetsReadPolicy):Promise<void>{
 const names=[env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_DETAIL_SHEET];if(names.some(n=>!n)||new Set(names).size!==3)throw Error('CANARY_PROVIDER_SCOPE');
 const grids=await Promise.all(names.map(n=>getSheetGridInfo(env,n!,policy)));if(grids.some(g=>g.rowCount>5000)||grids[0]!.sheetId!==Number(env.CONTINUOUS_DAILY_SHEET_ID)||grids[1]!.sheetId!==Number(env.CONTINUOUS_RAW_SHEET_ID)||grids[2]!.sheetId!==Number(env.CONTINUOUS_DETAIL_SHEET_ID))throw Error('CANARY_PROVIDER_SCOPE');
 const ranges=names.map((n,i)=>`${q(n!)}!A1:${i===0?'Y':'Z'}${grids[i]!.rowCount}`);
 const [f,e]=await Promise.all([batchGetSheetFormulaValues(env,ranges,policy),batchGetSheetEffectiveSerialValues(env,ranges,policy)]);if(f.length!==3||e.length!==3)throw Error('CANARY_PROVIDER_READ');
 const daily=f[0]!.flatMap((row,i)=>{const payload=decodeAtomicDailyPayload(row[24]);return payload?.expenseId===r.expense_id?[{payload,row:e[0]![i]??[]}]:[];});
 const raw=f[1]!.flatMap(row=>{const p=decodeLedgerCarrier(row[25]);return p?.expenseId===r.expense_id?[p]:[];});
 const detail=f[2]!.flatMap(row=>{const p=decodeLedgerCarrier(row[25]);return p?.expenseId===r.expense_id&&p.itemId===r.item_id?[p]:[];});
 if(raw.length!==1||detail.length!==1||raw[0]!.status!==(version===1?'CONFIRMED':'CANCELLED')||detail[0]!.status!==(version===1?'CONFIRMED':'CANCELLED'))throw Error('CANARY_PROVIDER_IDENTITY');
 if(version===1){const y=Number(r.transaction_date.slice(0,4)),m=Number(r.transaction_date.slice(5,7)),d=Number(r.transaction_date.slice(8,10)),serial=(Date.UTC(y,m-1,d)-Date.UTC(1899,11,30))/86400000;if(daily.length!==1||daily[0]!.payload.description!==description||daily[0]!.payload.amountSatang!==amount||daily[0]!.row[20]!==serial||daily[0]!.row[8]!==1||daily[0]!.row[21]!==category||daily[0]!.row[23]!==`MALIPANG_EXPENSE:${r.expense_id}`)throw Error('CANARY_DAILY_UNVERIFIED');
  if(await readContinuousReportHealth(env,{expenseId:r.expense_id,transactionDate:r.transaction_date,amountSatang:amount,wallet,category,itemIds:[r.item_id]},undefined,policy)!=='OK')throw Error('CANARY_REPORT_UNVERIFIED');
 }else{if(daily.length!==0)throw Error('CANARY_DAILY_UNVERIFIED');if(await readContinuousReportHealth(env,{expenseId:r.expense_id,absent:true},undefined,policy)!=='OK')throw Error('CANARY_REPORT_UNVERIFIED');}
}
/** Read-only provider verification for the exact completed synthetic v1. */
export async function verifyCompletedCanaryProvider(env:CanaryEnv,expectedExpense:string,policy:ContinuousSheetsReadPolicy):Promise<boolean>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 try{await ready(env);const r=await row(env);if(!r||r.expense_id!==expectedExpense||r.state!=='ARMED_CONFIRM')return false;await provider(env,r,1,policy);return env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&env.CONTINUOUS_CANARY_OPERATOR_ENABLED==='true'&&env.STABLE_RECOVERY_GATE_ENABLED==='true';}catch{return false;}
}
export async function operateContinuousCanary(env:CanaryEnv,action:unknown):Promise<{ok:true;action:Action}>{
 if(action==='ABORT'){await abortContinuousCanary(env);return{ok:true,action:'ABORT'};}
 await ready(env);if(!['PREPARE','CONFIRM','RECONCILE_CONFIRM','ARM_CONFIRM','ARM_DUPLICATE','VERIFY_DUPLICATE','UNDO','RECONCILE_UNDO','ARM_UNDO','VERIFY'].includes(String(action)))throw Error('CANARY_ACTION_INVALID');const a=action as Action;
 if(a==='PREPARE'){await prepare(env);return{ok:true,action:a};}
 const r=await row(env);if(!r)throw Error('CANARY_NOT_PREPARED');
 if(a==='CONFIRM')await confirm(env,r);
 else if(a==='RECONCILE_CONFIRM')await reconcileConfirm(env,r);
 else if(a==='ARM_CONFIRM')await arm(env,r,1);
 else if(a==='ARM_DUPLICATE')await armDuplicate(env,r);
 else if(a==='VERIFY_DUPLICATE')await verifyDuplicate(env,r);
 else if(a==='RECONCILE_UNDO')await reconcileUndo(env,r);
 else if(a==='UNDO'){
  if(r.state!=='DUPLICATE_VERIFIED')throw Error('CANARY_STATE_UNVERIFIED');await completed(env,r,1);await provider(env,r,1);await move(env,r,'DUPLICATE_VERIFIED','UNDOING');
  const version=await undoConfirmedExpense(env,{expenseId:r.expense_id,lineUserId:r.line_user_id,traceId:r.trace_id,actorEmployeeId:null,branchId:null});if(version!==2)throw Error('CANARY_UNDO_UNCERTAIN');await move(env,r,'UNDOING','UNDONE');
 }else if(a==='ARM_UNDO')await arm(env,r,2);
 else {if(r.state!=='ARMED_UNDO')throw Error('CANARY_STATE_UNVERIFIED');await completed(env,r,2);await provider(env,r,2);await move(env,r,'ARMED_UNDO','VERIFIED');}
 return{ok:true,action:a};
}
