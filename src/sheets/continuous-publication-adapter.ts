import type {Env,SheetsSyncJob} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,batchUpdateSpreadsheetWithReply,continuousSheetsReadPolicy,getSheetGridInfo} from './client';
import {decodePublicationCarrier,encodePublicationCarrier,verifyPublicationColumn} from './continuous-publication-template';
import {validPublicationBefore,type PublicationColumn,type PublicationExecutor,type PublicationIntent} from './continuous-publication-executor';
import {readStableExpenseSource} from './stable-expense-source';
import {readCancelledExpenseSource} from './cancelled-expense-source';
import {stableWorkbookClaimOwned} from './stable-workbook-claim';
import {ReviewRequestBudget} from './review-request-budget';
import {publicationSnapshotRange,type PublicationBatchSnapshot} from './publication-batch-snapshot';
import {GoogleOAuthLease} from './google-auth';

type AdapterInput={job:SheetsSyncJob;lease:string;claim:string;transitionId:string;sheetName:string;intent:PublicationIntent;sourceRevision:number;sourceDigest:string;financialJournalRevision?:number|undefined;budget:ReviewRequestBudget;oauthLease?:GoogleOAuthLease;atomicHandoff?:(prefix:D1PreparedStatement[],transitionId:string)=>Promise<boolean>;verifyHandoff?:(transitionId:string)=>Promise<boolean>;
 /** These checks must verify the activated publication target and, for
  * PUBLISH, exact staged DAILY/RAW/DETAIL provider images and item set. */
 verifyTarget:()=>Promise<boolean>;verifyProjections:(phase:'BEFORE'|'AFTER',snapshot?:PublicationBatchSnapshot)=>Promise<boolean>;captureForGuard?:()=>Promise<PublicationBatchSnapshot>;initialSnapshot?:PublicationBatchSnapshot};

/** Candidate adapter, deliberately not routed or enabled. It cannot replace
 * its caller's cutover/fencing, staged verifier, Undo protocol or reporting
 * checks. A guarded claim does not fence non-cooperating provider writers. */
export function createPublicationAdapter(env:Env,input:AdapterInput):PublicationExecutor{
 const {job,lease,claim,transitionId,sheetName,intent,sourceRevision,sourceDigest,budget,oauthLease}=input,db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,policy={...continuousSheetsReadPolicy,budget,...oauthLease?{oauthLease}:{}};
 const before=decodePublicationCarrier(intent.before),after=intent.after;
 const kind=before?(after.state==='PUBLISHED'?'PUBLISH':'REVOKE'):'STAGE';
 const financial=kind==='REVOKE'&&input.financialJournalRevision!==undefined;
 if(financial&&(!Number.isSafeInteger(input.financialJournalRevision)||Number(input.financialJournalRevision)<0))throw Error('PUBLICATION_FINANCIAL_JOURNAL_INVALID');
 // Grouped PUBLISH has two post-dispatch rounds, each four batched reads,
 // one format read and two notice reads. The invocation-scoped OAuth lease
 // forbids refresh and pacing disables GET retries. Unproven implementations
 // retain the conservative 129-request bound and therefore cannot dispatch.
 const groupedPublish=kind==='PUBLISH'&&oauthLease instanceof GoogleOAuthLease&&!!input.captureForGuard&&!!input.initialSnapshot&&typeof input.atomicHandoff==='function'&&typeof input.verifyHandoff==='function'&&env.STABLE_SHEETS_PACING_ENABLED==='true';
 const leased=oauthLease instanceof GoogleOAuthLease&&env.STABLE_SHEETS_PACING_ENABLED==='true';
 const postReserve=kind==='PUBLISH'?(groupedPublish?14:129):(leased?12:25),preDispatchReserve=groupedPublish?14:leased?12:0;
 const state=before?.state??'EMPTY',beforeNonce=before?.nonce??intent.before.slice(-32);
 const scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.STABLE_PHASE1_ENABLED,env.STABLE_SHEETS_PACING_ENABLED,env.CONTINUOUS_DAILY_ENABLED,env.CONTINUOUS_CANCEL_FINANCIAL_FINGERPRINT_ENABLED,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID,env.APP_ENV,env.RUNTIME_MODE]);
 const initial=scope(),stable=()=>env.DB===db&&scope()===initial;
 if(!book||!lease||!claim||!transitionId||!sheetName||!(budget instanceof ReviewRequestBudget)||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||job.entityKey!==after.expenseId||job.entityVersion!==after.version||!Number.isSafeInteger(sourceRevision)||sourceRevision<0||!/^[0-9a-f]{64}$/.test(sourceDigest)||typeof input.verifyTarget!=='function'||typeof input.verifyProjections!=='function')throw Error('PUBLICATION_ADAPTER_INVALID');
 let currentSnapshot:PublicationBatchSnapshot|undefined,initialSnapshot=input.initialSnapshot;
 const guard=async(phase:'BEFORE'|'AFTER')=>{
  if(!stable()||!await input.verifyTarget()||!await stableWorkbookClaimOwned(env,claim,budget,oauthLease))return false;
  const source=kind==='REVOKE'?await readCancelledExpenseSource(env,job,claim,lease):await readStableExpenseSource(env,job,lease,claim);
  if(!source||source.revision!==sourceRevision||source.digest!==sourceDigest||!stable())return false;
  if(kind==='PUBLISH'&&(!currentSnapshot||!await input.verifyProjections(phase,currentSnapshot)))return false;
  return stable();
 };
 const read=async():Promise<PublicationColumn>=>{
  if(kind==='PUBLISH'&&input.captureForGuard){
   const captured=initialSnapshot??await input.captureForGuard();initialSnapshot=undefined;const grid=captured.metadata.find(x=>x.sheetId===intent.sheetId&&x.title===sheetName);
   if(!stable()||!grid||grid.rowCount!==intent.rows||grid.columnCount<1||grid.columnCount>100)throw Error('PUBLICATION_GRID_UNVERIFIED');currentSnapshot=captured;
   return{formula:publicationSnapshotRange(captured,intent.sheetId,1,intent.rows,1,1,'FORMULA'),effective:publicationSnapshotRange(captured,intent.sheetId,1,intent.rows,1,1,'EFFECTIVE')};
  }
  const grid=await getSheetGridInfo(env,sheetName,policy);
  if(!stable()||grid.sheetId!==intent.sheetId||grid.rowCount!==intent.rows||grid.columnCount<1||grid.columnCount>100)throw Error('PUBLICATION_GRID_UNVERIFIED');
  const range=`'${sheetName.replace(/'/g,"''")}'!A1:A${intent.rows}`;
  const formula=await batchGetSheetFormulaValues(env,[range],policy),effective=await batchGetSheetEffectiveSerialValues(env,[range],policy),latest=await getSheetGridInfo(env,sheetName,policy);
  if(!stable()||JSON.stringify(grid)!==JSON.stringify(latest)||formula.length!==1||effective.length!==1)throw Error('PUBLICATION_GRID_UNVERIFIED');
  return{formula:formula[0]!,effective:effective[0]!};
 };
 const persist=async()=>{
  if(budget.remaining<postReserve+preDispatchReserve+1||!budget.reservePost(postReserve))throw Error('PUBLICATION_BUDGET_POSTIMAGE');
  if(!budget.reserveMutation()){budget.releasePost();throw Error('PUBLICATION_BUDGET_MUTATION');}
  const result=await db.prepare(financial?`INSERT INTO continuous_publication_intents(transition_id,spreadsheet_id,entity_id,sheet_id,sheet_name,row_number,kind,source_version,source_revision,source_digest,claim_token,lease_token,before_state,before_nonce,after_nonce,detail_count,before_value,after_value,state,created_at,updated_at,financial_journal_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'IN_FLIGHT',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),?)`:`INSERT INTO continuous_publication_intents(transition_id,spreadsheet_id,entity_id,sheet_id,sheet_name,row_number,kind,source_version,source_revision,source_digest,claim_token,lease_token,before_state,before_nonce,after_nonce,detail_count,before_value,after_value,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'IN_FLIGHT',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).bind(transitionId,book,job.entityKey,intent.sheetId,sheetName,intent.row,kind,job.entityVersion,sourceRevision,sourceDigest,claim,lease,state,beforeNonce,after.nonce,after.detailCount,intent.before,encodePublicationCarrier(after),...(financial?[input.financialJournalRevision]:[])).run();
  return stable()&&result.success===true&&Number(result.meta?.changes)===1;
 };
 const dispatch=async(request:unknown)=>{
  return await batchUpdateSpreadsheetWithReply(env,[request],async()=>{
  // The OAuth exchange happens before this callback; perform the last check
  // only after it, as close to the irreversible POST as the client allows.
   if(!validPublicationBefore(await read(),intent)||!await guard('BEFORE'))throw Error('PUBLICATION_DISPATCH_UNVERIFIED');
  },budget,oauthLease);
 };
 const commit=async()=>{
  const post=await read();
  if(!verifyPublicationColumn(post.formula,post.effective,intent.rows,after,intent.row)||!await guard('AFTER'))return false;
  // A crash can happen after D1 committed both rows but before its reply was
  // received. Confirm that exact immutable pair rather than writing again.
  const retained=await db.prepare(`SELECT 1 AS ok FROM continuous_publication_intents i JOIN continuous_publication_markers m ON m.spreadsheet_id=i.spreadsheet_id AND m.entity_id=i.entity_id AND m.sheet_id=i.sheet_id AND m.sheet_name=i.sheet_name AND m.row_number=i.row_number AND m.transition_id=i.transition_id AND m.version=i.source_version AND m.marker=i.after_value WHERE i.transition_id=? AND i.spreadsheet_id=? AND i.entity_id=? AND i.kind=? AND i.source_version=? AND i.source_revision=? AND i.source_digest=? AND i.claim_token=? AND i.lease_token=? AND i.before_value=? AND i.after_value=? AND i.state='VERIFIED' AND m.state=?`).bind(transitionId,book,job.entityKey,kind,job.entityVersion,sourceRevision,sourceDigest,claim,lease,intent.before,encodePublicationCarrier(after),after.state).first<{ok:number}>();
  if(!stable())return false;
  if(retained?.ok===1)return input.atomicHandoff?!!input.verifyHandoff&&await input.verifyHandoff(transitionId):true;
  const intentUpdate=db.prepare("UPDATE continuous_publication_intents SET state='VERIFIED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE transition_id=? AND spreadsheet_id=? AND entity_id=? AND source_version=? AND source_revision=? AND source_digest=? AND claim_token=? AND lease_token=? AND state='IN_FLIGHT'").bind(transitionId,book,job.entityKey,job.entityVersion,sourceRevision,sourceDigest,claim,lease);
  const markerUpdate=kind==='STAGE'?db.prepare("INSERT INTO continuous_publication_markers(spreadsheet_id,entity_id,sheet_id,sheet_name,row_number,version,state,marker,transition_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'STAGED',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind(book,job.entityKey,intent.sheetId,sheetName,intent.row,job.entityVersion,encodePublicationCarrier(after),transitionId):db.prepare("UPDATE continuous_publication_markers SET version=?,state=?,marker=?,transition_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND entity_id=? AND sheet_id=? AND sheet_name=? AND row_number=? AND marker=?").bind(job.entityVersion,after.state,encodePublicationCarrier(after),transitionId,book,job.entityKey,intent.sheetId,sheetName,intent.row,intent.before);
  if(input.atomicHandoff)return !!input.verifyHandoff&&stable()&&await input.atomicHandoff([intentUpdate,markerUpdate],transitionId)&&await input.verifyHandoff(transitionId)&&stable();
  const result=await db.batch([
   intentUpdate,
   db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok"),
   markerUpdate,
   db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
  ]);
  return stable()&&result.length===4&&result.every(x=>x.success===true)&&Number(result[0]!.meta?.changes)===1&&Number(result[2]!.meta?.changes)===1;
 };
 return{read,guard,persist,dispatch,commit,release:()=>{budget.releaseMutation();budget.releasePost();}};
}
