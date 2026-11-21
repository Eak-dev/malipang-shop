import type {Env,SheetsSyncJob} from '../types';
import {continuousSheetsReadPolicy,getSpreadsheetSheetProperties,type ContinuousSheetsReadPolicy} from './client';
import {ReviewRequestBudget} from './review-request-budget';
import {readReviewedPublicationSource} from './continuous-publication-reviewed-source';
import {reviewedNoticeMatches,type ReviewedNoticeMode} from './continuous-reviewed-notice';
import type {NormalNoticeAuthority} from './normal-notice-authority';
import {resolvePublicationTarget} from './continuous-publication-route';
import {decodePublicationCarrier} from './continuous-publication-template';
import {readPublicationAccountingEvidence} from './publication-accounting-evidence';
import {planPublicationSnapshot} from './publication-snapshot-plan';
import {capturePublicationBatchSnapshot,publicationSnapshotRange} from './publication-batch-snapshot';
import {decodeAtomicDailyPayload} from './atomic-daily-template';
import {decodeLedgerCarrier} from './atomic-expense-ledger-template';
import {indexCarrierLedgerSnapshot} from './atomic-expense-ledger-writer';
import {authenticateCarrierLedgerSnapshot} from './atomic-expense-ledger-auth';
import {pendingDailyCancellations,verifyDailyCarrierEvidence} from './daily-carrier-auth';
import {verifyMixedDailyAccounting} from './mixed-daily-accounting';
import {readLegacyDailyCoverage} from './legacy-daily-coverage';
import {readContinuousReportHealth} from './continuous-report-health';
import {readPublicationHandoffExpenseSource} from './stable-expense-source';
import {verifyStableExpenseProjections} from './stable-expense-final-check';
import {planStableExpenseProjections} from './stable-expense-projection-plan';

type Row={kind:'STAGE'|'PUBLISH'|'REVOKE';sheet_id:number;sheet_name:string;row_number:number;after_value:string;source_digest:string};
type Projection={entity_id:string;projection:'DAILY'|'EXPENSE_RAW'|'DETAIL';state:string;source_version:number;sheet_id:number;sheet_name:string};
const isError=(x:unknown)=>typeof x==='string'&&/^#(?:REF!|N\/A|ERROR!|DIV\/0!|VALUE!|NUM!|NAME\?|NULL!)/i.test(x);

/** Read-only close proof for one exact publication transition. PUBLISH is
 * intentionally unavailable until its complete post-dispatch request budget
 * is proven. REVIEW of a verified REVOKE requires separate opt-in, exact
 * recovery evidence and revalidation of its pre-existing projections.
 * This function never replays a POST or releases a job/claim. */
export async function verifyPublicationHandoff(env:Env,job:SheetsSyncJob,claim:string,transitionId:string,mode:ReviewedNoticeMode,policy:ContinuousSheetsReadPolicy=continuousSheetsReadPolicy,authority:NormalNoticeAuthority='REVIEW'):Promise<boolean>{
 return verifyPublicationHandoffInternal(env,job,claim,transitionId,mode,policy,authority,false);
}

/** Read-only PUBLISH candidate. This is not wired to the runtime notice close. */
export async function verifyPublicationHandoffCandidate(env:Env,job:SheetsSyncJob,claim:string,transitionId:string,mode:ReviewedNoticeMode,policy:ContinuousSheetsReadPolicy=continuousSheetsReadPolicy,authority:NormalNoticeAuthority='REVIEW'):Promise<boolean>{
 return verifyPublicationHandoffInternal(env,job,claim,transitionId,mode,policy,authority,true);
}
async function verifyPublicationHandoffInternal(env:Env,job:SheetsSyncJob,claim:string,transitionId:string,mode:ReviewedNoticeMode,policy:ContinuousSheetsReadPolicy,authority:NormalNoticeAuthority,allowPublish:boolean):Promise<boolean>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,budget=policy.budget;
 if(!book||!claim||!transitionId||!(budget instanceof ReviewRequestBudget)||!['PAUSED','REVIEW_READY'].includes(mode)||!['REVIEW','HANDOFF'].includes(authority)||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(job.entityKey)||!Number.isSafeInteger(job.entityVersion)||job.entityVersion<1)return false;
 const scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.CONTINUOUS_CANCEL_FINANCIAL_FINGERPRINT_ENABLED,env.CONTINUOUS_REVOKE_REVIEW_CLOSE_ENABLED,env.CONTINUOUS_PUBLICATION_ENABLED,env.CONTINUOUS_PUBLICATION_SHEET,env.CONTINUOUS_PUBLICATION_SHEET_ID,env.CONTINUOUS_PUBLICATION_ROWS,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID,env.SHEET_EXPENSE_DAILY,job.kind,job.entityType,job.entityKey,job.entityVersion,claim,transitionId,mode,authority]);const initial=scope(),stable=()=>env.DB===db&&scope()===initial;
 const row=await db.prepare("SELECT i.kind,i.sheet_id,i.sheet_name,i.row_number,i.after_value,i.source_digest FROM continuous_publication_intents i JOIN continuous_publication_markers m ON m.spreadsheet_id=i.spreadsheet_id AND m.entity_id=i.entity_id AND m.sheet_id=i.sheet_id AND m.sheet_name=i.sheet_name AND m.row_number=i.row_number AND m.transition_id=i.transition_id AND m.version=i.source_version AND m.marker=i.after_value WHERE i.transition_id=? AND i.spreadsheet_id=? AND i.entity_id=? AND i.source_version=? AND i.claim_token=? AND i.state='VERIFIED'").bind(transitionId,book,job.entityKey,job.entityVersion,claim).first<Row>();
 const marker=decodePublicationCarrier(row?.after_value),target=await resolvePublicationTarget(env);
 if(!stable()||!row||!marker||!target||row.sheet_id!==target.sheetId||row.sheet_name!==target.sheetName||marker.expenseId!==job.entityKey||marker.version!==job.entityVersion||marker.state!==(row.kind==='STAGE'?'STAGED':row.kind==='PUBLISH'?'PUBLISHED':'REVOKED'))return false;
 if(row.kind==='PUBLISH')return allowPublish&&verifyPublishedHandoff(env,job,claim,transitionId,mode,policy,authority,row,marker,target);
 const source=await readReviewedPublicationSource(env,job,claim,transitionId,{sheetId:row.sheet_id,sheetName:row.sheet_name,row:row.row_number},authority);
 if(!source||source.kind!==row.kind||source.digest!==row.source_digest||!stable())return false;
 if(authority==='REVIEW'){if(row.kind!=='REVOKE'||env.CONTINUOUS_REVOKE_REVIEW_CLOSE_ENABLED!=='true')return false;const proof=await db.prepare("SELECT 1 AS ok FROM continuous_publication_review_evidence p JOIN continuous_revoke_review_close_activation a ON a.singleton=1 WHERE p.transition_id=? AND p.source_digest=? AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_publication_review_evidence' AND name IN ('continuous_publication_review_evidence_insert','continuous_publication_review_evidence_no_update','continuous_publication_review_evidence_no_delete','continuous_publication_review_evidence_no_replace'))=4").bind(transitionId,row.source_digest).first<{ok:number}>();if(!stable()||proof?.ok!==1)return false;}
 const [records,cancels]=await Promise.all([
  db.prepare("SELECT entity_id,projection,state,source_version,sheet_id,sheet_name FROM stable_projection_writes WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND (entity_id=? OR substr(entity_id,1,length(?)+1)=?||'|')").bind(book,job.entityKey,job.entityKey,job.entityKey).all<Projection>(),
  db.prepare("SELECT 1 AS found FROM stable_expense_cancellation_writes WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND (entity_id=? OR substr(entity_id,1,length(?)+1)=?||'|') LIMIT 1").bind(book,job.entityKey,job.entityKey,job.entityKey).all<{found:number}>()
 ]);
 if(!stable()||records.success!==true||cancels.success!==true||!Array.isArray(records.results)||!Array.isArray(cancels.results)||cancels.results.length||records.results.length>502||records.results.some(p=>!['DAILY','EXPENSE_RAW','DETAIL'].includes(p.projection))||row.kind==='STAGE'&&records.results.length||row.kind==='REVOKE'&&records.results.some(p=>p.state!=='VERIFIED'||p.source_version!==job.entityVersion-1))return false;
 const metadata=await getSpreadsheetSheetProperties(env,policy),specs=await planPublicationSnapshot(env,metadata,target),snapshot=await capturePublicationBatchSnapshot(env,specs,budget),evidence=await readPublicationAccountingEvidence(env,{sheet:target.sheetName,sheetId:target.sheetId,rows:target.rows,row:row.row_number,expected:marker,sourceDigest:source.digest},policy,snapshot);
 const daily=snapshot.metadata.find(s=>s.title===env.CONTINUOUS_DAILY_SHEET),legacy=snapshot.metadata.find(s=>s.title===env.SHEET_EXPENSE_DAILY);if(!daily||!legacy)return false;
 const formula=publicationSnapshotRange(snapshot,daily.sheetId,1,daily.rowCount,1,daily.columnCount,'FORMULA'),effective=publicationSnapshotRange(snapshot,daily.sheetId,1,daily.rowCount,1,daily.columnCount,'EFFECTIVE'),key=`MALIPANG_EXPENSE:${job.entityKey}`;
 const entries=formula.flatMap((r,i)=>decodeAtomicDailyPayload(r[24])?.expenseId===job.entityKey?[i]:[]),dailyJournal=records.results.filter(p=>p.projection==='DAILY');
 if(dailyJournal.length>1||dailyJournal.some(p=>p.entity_id!==job.entityKey||p.sheet_id!==daily.sheetId)||entries.length!==dailyJournal.length||effective.some(r=>r[23]===key||isError(r[23]))||formula.some((r,i)=>{const y=r[24],e=effective[i]?.[24];return y!==null&&y!==undefined&&y!==''&&(!decodeAtomicDailyPayload(y)&&!(typeof y==='string'&&/^MPD1_CANCELLED_[0-9a-f]{64}$/.test(y))||y!==e);} ))return false;
 const legacyFormula=publicationSnapshotRange(snapshot,legacy.sheetId,1,legacy.rowCount,24,24,'FORMULA'),legacyEffective=publicationSnapshotRange(snapshot,legacy.sheetId,1,legacy.rowCount,24,24,'EFFECTIVE');
 if(legacyFormula.some((r,i)=>{const f=r[0],e=legacyEffective[i]?.[0],isFormula=typeof f==='string'&&f.startsWith('=');return f===key||e===key||isError(e)||isFormula&&(e===null||e===undefined||e==='')||!isFormula&&(f??null)!==(e??null);} ))return false;
 const reviewed=authority==='REVIEW'&&row.kind==='REVOKE'?{expenseId:job.entityKey,version:job.entityVersion,claim,transitionId}:undefined;
 const pending=await pendingDailyCancellations(env,daily.title,daily.sheetId,claim,reviewed);
 if(!await verifyDailyCarrierEvidence(env,daily.title,daily.sheetId,daily.columnCount,formula,undefined,pending,undefined,reviewed))return false;
 if(entries.length){
  const payload=decodeAtomicDailyPayload(formula[entries[0]!]![24]);if(!payload)return false;
  const coverage=await readLegacyDailyCoverage(env,payload.postingYear,payload.postingMonth,daily.title,policy,snapshot);
  if(!verifyMixedDailyAccounting({formula,effective},daily.rowCount,daily.columnCount,payload.postingYear,payload.postingMonth,coverage.coverage,evidence))return false;
 }
 for(const projection of ['EXPENSE_RAW','DETAIL'] as const){
  const name=projection==='EXPENSE_RAW'?env.CONTINUOUS_RAW_SHEET:env.CONTINUOUS_DETAIL_SHEET,grid=snapshot.metadata.find(s=>s.title===name);if(!grid)return false;
  const f=publicationSnapshotRange(snapshot,grid.sheetId,1,grid.rowCount,1,grid.columnCount,'FORMULA'),e=publicationSnapshotRange(snapshot,grid.sheetId,1,grid.rowCount,1,grid.columnCount,'EFFECTIVE'),snap={formula:f,effective:e};
  const group=records.results.filter(p=>p.projection===projection);if(group.some(p=>p.sheet_id!==grid.sheetId||p.sheet_name!==name))return false;
  const found=f.flatMap((r,i)=>{const carrier=decodeLedgerCarrier(r[25]);if(!carrier||carrier.projection!==projection||carrier.expenseId!==job.entityKey)return[];return[{entity:projection==='DETAIL'?`${carrier.expenseId}|${carrier.itemId}`:carrier.expenseId,carrier,index:i}];});
  const foundIds=new Set(found.map(x=>x.entity));if(foundIds.size!==found.length||found.length!==group.length||group.some(p=>!foundIds.has(p.entity_id)))return false;
  const index=indexCarrierLedgerSnapshot(snap,grid.rowCount,grid.columnCount,projection);
  for(const item of found)if(index.find(item.carrier)!==item.index+1)return false;
  await authenticateCarrierLedgerSnapshot(env,snap,grid.rowCount,projection,grid.title,grid.sheetId);
 }
 if(await readContinuousReportHealth(env,{expenseId:job.entityKey,absent:true,absentFromViews:true},{dailySheet:daily.title},policy,snapshot)!=='OK'||!await reviewedNoticeMatches(env,claim,source.noticeStamp,source.noticeIdentity,mode,policy,authority))return false;
 const after=await capturePublicationBatchSnapshot(env,specs,budget),latest=await readReviewedPublicationSource(env,job,claim,transitionId,{sheetId:row.sheet_id,sheetName:row.sheet_name,row:row.row_number},authority);
 if(!stable()||JSON.stringify(snapshot)!==JSON.stringify(after)||JSON.stringify(source)!==JSON.stringify(latest)||!await reviewedNoticeMatches(env,claim,source.noticeStamp,source.noticeIdentity,mode,policy,authority))return false;return stable();
}

/** Read-only proof for a VERIFIED PUBLISH handoff. This never grants write
 * authority or releases the notice claim; the close transaction must do that. */
async function verifyPublishedHandoff(env:Env,job:SheetsSyncJob,claim:string,transitionId:string,mode:ReviewedNoticeMode,policy:ContinuousSheetsReadPolicy,authority:NormalNoticeAuthority,row:Row,marker:NonNullable<ReturnType<typeof decodePublicationCarrier>>,target:{sheetId:number;sheetName:string;rows:number}):Promise<boolean>{
 if(authority!=='HANDOFF'||!(policy.budget instanceof ReviewRequestBudget))return false;
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,stable=()=>env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book;
 const source=await readPublicationHandoffExpenseSource(env,job,claim,transitionId);
 const noticeSource=await readReviewedPublicationSource(env,job,claim,transitionId,{sheetId:row.sheet_id,sheetName:row.sheet_name,row:row.row_number},authority);
 if(!source||!noticeSource||source.digest!==row.source_digest||noticeSource.digest!==source.digest||noticeSource.revision!==source.revision||noticeSource.kind!=='PUBLISH'||planStableExpenseProjections(source).details.length!==marker.detailCount||!stable())return false;
 const readJournals=async()=>{
  const result=await db.batch([db.prepare("SELECT entity_id,projection,state,source_version,source_digest,sheet_id,sheet_name,operation_token FROM stable_projection_writes WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND (entity_id=? OR substr(entity_id,1,length(?)+1)=?||'|') ORDER BY projection,entity_id").bind(book,job.entityKey,job.entityKey,job.entityKey),db.prepare("SELECT 1 AS found FROM stable_expense_cancellation_writes WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND (entity_id=? OR substr(entity_id,1,length(?)+1)=?||'|') LIMIT 1").bind(book,job.entityKey,job.entityKey,job.entityKey)]);
  if(!stable()||result.length!==2||result.some(x=>x.success!==true||!Array.isArray(x.results))||result[1]!.results!.length||result[0]!.results!.length>502)return null;
  return result[0]!.results! as Parameters<typeof verifyStableExpenseProjections>[3];
 };
 const journals=await readJournals();if(!journals||!await reviewedNoticeMatches(env,claim,noticeSource.noticeStamp,noticeSource.noticeIdentity,mode,policy,authority))return false;
 const metadata=await getSpreadsheetSheetProperties(env,policy),specs=await planPublicationSnapshot(env,metadata,target),snapshot=await capturePublicationBatchSnapshot(env,specs,policy.budget);
 const evidence=await readPublicationAccountingEvidence(env,{sheet:target.sheetName,sheetId:target.sheetId,rows:target.rows,row:row.row_number,expected:marker,sourceDigest:source.digest},policy,snapshot);
 await verifyStableExpenseProjections(env,job,source,journals,{...evidence,phase:'PUBLISHED'},policy,snapshot);
 const after=await capturePublicationBatchSnapshot(env,specs,policy.budget),latest=await readPublicationHandoffExpenseSource(env,job,claim,transitionId),latestNotice=await readReviewedPublicationSource(env,job,claim,transitionId,{sheetId:row.sheet_id,sheetName:row.sheet_name,row:row.row_number},authority),latestJournals=await readJournals();
 return stable()&&JSON.stringify(snapshot)===JSON.stringify(after)&&!!latest&&latest.fingerprint===source.fingerprint&&latest.revision===source.revision&&latest.digest===source.digest&&JSON.stringify(noticeSource)===JSON.stringify(latestNotice)&&JSON.stringify(journals)===JSON.stringify(latestJournals)&&await reviewedNoticeMatches(env,claim,noticeSource.noticeStamp,noticeSource.noticeIdentity,mode,policy,authority);
}
