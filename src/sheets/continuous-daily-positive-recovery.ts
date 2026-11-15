import {reviewedJobState,reviewedClaimState,type NormalNoticeAuthority} from './normal-notice-authority';
import type {Env,SheetsSyncJob} from '../types';
import type {ContinuousSheetsReadPolicy} from './client';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,continuousSheetsReadPolicy,getSheetCellNumberFormats,getSheetGridInfo} from './client';
import {columnName,legacySourceWallet} from './daily-expense';
import {encodeAtomicDailyPayload} from './atomic-daily-template';
import {matchesCommittedDailyInsert} from './continuous-daily-write-evidence';
import {assertContinuousDailyActivated} from './continuous-daily-route';
import {continuousAdmissionIntegrity,continuousDailyCutoverIntegrity,continuousReportCutoverIntegrity} from './continuous-daily-cutover';
import {stableSourceIntegrity} from './stable-source-cutover';
import {readReviewedDailyExpenseSource} from './stable-expense-source';
import {planStableExpenseProjections} from './stable-expense-projection-plan';
import {readVerifiedLegacyDailyIds,verifiedInsertDailyPayment} from './insert-daily-writer';
import {readLegacyDailyCoverage} from './legacy-daily-coverage';
import {verifyMixedDailyAccounting} from './mixed-daily-accounting';
import {verifyDailyCarrierEvidence} from './daily-carrier-auth';
import {stableExpensePreimageStatement} from './stable-expense-preimage';
import {reviewedNoticeMatches,type ReviewedNoticeMode} from './continuous-reviewed-notice';
import {readContinuousReportHealth} from './continuous-report-health';
import {paymentOptionForPair} from '../expense/document';

type Evidence={sheet_id:number;sheet_name:string;source_version:number;source_digest:string;operation_token:string;marker:string;target_row:number;before_rows:number;before_columns:number;before_digest:string;payload_digest:string;notice_stamp:string;notice_identity:string;projection_state:string};
const integrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND ((tbl_name='continuous_daily_write_evidence' AND name IN ('continuous_daily_evidence_source','continuous_daily_evidence_no_update','continuous_daily_evidence_no_delete','continuous_daily_evidence_no_replace')) OR (tbl_name='stable_expense_projection_preimages' AND name IN ('stable_expense_preimage_verified_source','stable_expense_preimage_no_update','stable_expense_preimage_no_delete','stable_expense_preimage_no_replace')) OR (tbl_name='atomic_daily_marker_reservations' AND name IN ('atomic_daily_marker_no_delete','atomic_daily_marker_no_update','atomic_daily_marker_no_replace'))))=11";

/** Positive-only partial recovery of one DAILY journal. The job, workbook
 * claim, notice and recovery epoch deliberately remain in REVIEW. The caller
 * must separately reconcile their full lifecycle before any subsequent
 * stage can run. Missing/mismatched provider state is never a retry signal. */
export async function verifyReviewedDailyProjection(env:Env,job:SheetsSyncJob,operationToken:string,noticeMode:ReviewedNoticeMode='PAUSED',policy:ContinuousSheetsReadPolicy=continuousSheetsReadPolicy,authority:NormalNoticeAuthority='REVIEW'):Promise<boolean>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 const scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.SHEET_EXPENSE_DAILY,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.STABLE_PHASE1_ENABLED,env.STABLE_CANCELLATION_PREIMAGE_ENABLED,env.STABLE_RECOVERY_GATE_ENABLED,env.CONTINUOUS_DAILY_ENABLED,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.APP_ENV,env.RUNTIME_MODE]);
 const initial=scope(),stable=()=>env.DB===db&&scope()===initial;
 if(!book||!operationToken||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||env.STABLE_RECOVERY_GATE_ENABLED!=='true'||env.STABLE_CANCELLATION_PREIMAGE_ENABLED!=='true')return false;
 const target=await assertContinuousDailyActivated(env);if(!target||!stable())return false;
 const row=await db.prepare(`SELECT w.sheet_id,w.sheet_name,w.source_version,w.source_digest,w.operation_token,w.marker,w.target_row,w.before_rows,w.before_columns,w.before_digest,w.payload_digest,c.notice_stamp,c.notice_identity,p.state projection_state
  FROM continuous_daily_write_evidence w JOIN stable_projection_writes p ON p.spreadsheet_id=w.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=w.entity_id AND p.projection='DAILY' AND p.sheet_id=w.sheet_id AND p.sheet_name=w.sheet_name AND p.source_version=w.source_version AND p.source_digest=w.source_digest AND p.operation_token=w.operation_token AND p.state IN ('IN_FLIGHT','VERIFIED')
  JOIN atomic_daily_marker_reservations m ON m.spreadsheet_id=w.spreadsheet_id AND m.sheet_id=w.sheet_id AND m.entity_id=w.entity_id AND m.source_version=w.source_version AND m.operation_token=w.operation_token AND m.marker=w.marker
  JOIN stable_workbook_claims c ON c.spreadsheet_id=w.spreadsheet_id AND c.operation_token=w.operation_token AND ${reviewedClaimState('c',authority)}
  JOIN stable_recovery_epochs epoch ON epoch.spreadsheet_id=w.spreadsheet_id AND epoch.target_type='EXPENSE' AND epoch.target_key=w.entity_id AND epoch.target_version=w.source_version AND epoch.state IN ('ARMED','REVIEW')
  JOIN stable_recovery_operations op ON op.epoch_id=epoch.epoch_id AND op.operation_token=w.operation_token AND op.state='ADMITTED'
  JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=w.entity_id AND j.entity_version=w.source_version AND ${reviewedJobState('j',authority)}
  WHERE w.spreadsheet_id=? AND w.entity_id=? AND w.source_version=? AND w.operation_token=? AND ${integrity} AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousReportCutoverIntegrity} AND ${continuousAdmissionIntegrity}
  AND NOT EXISTS(SELECT 1 FROM stable_projection_writes other WHERE other.spreadsheet_id=w.spreadsheet_id AND other.entity_type='EXPENSE' AND (other.entity_id=w.entity_id OR substr(other.entity_id,1,length(w.entity_id)+1)=w.entity_id||'|') AND NOT(other.entity_id=w.entity_id AND other.projection='DAILY'))
  AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes cancel WHERE cancel.spreadsheet_id=w.spreadsheet_id AND cancel.entity_type='EXPENSE' AND (cancel.entity_id=w.entity_id OR substr(cancel.entity_id,1,length(w.entity_id)+1)=w.entity_id||'|'))`).bind(book,job.entityKey,job.entityVersion,operationToken).first<Evidence>();
 if(!row||row.sheet_id!==target.sheetId||row.sheet_name!==target.sheet||!row.notice_stamp||!row.notice_identity||!stable())return false;
 const source=await readReviewedDailyExpenseSource(env,job,operationToken,authority);if(!source||source.digest!==row.source_digest||!stable())return false;
 const record=planStableExpenseProjections(source).record,date=/^(\d{4})-(\d{2})-(\d{2})$/.exec(record.transactionDate);if(!date||!paymentOptionForPair(record.paymentKey,record.sourceWallet))return false;
 const grid=await getSheetGridInfo(env,target.sheet,policy),coords={sheetId:row.sheet_id,row:row.target_row,rowCount:row.before_rows,columnCount:row.before_columns};
 if(grid.sheetId!==row.sheet_id||grid.rowCount!==row.before_rows+1||grid.columnCount!==row.before_columns||!stable())return false;
 const range=`'${target.sheet.replace(/'/g,"''")}'!A1:${columnName(grid.columnCount)}${grid.rowCount}`;
 const take=async()=>{const a=await getSheetGridInfo(env,target.sheet,policy),f=await batchGetSheetFormulaValues(env,[range],policy),e=await batchGetSheetEffectiveSerialValues(env,[range],policy),b=await getSheetGridInfo(env,target.sheet,policy);if(!stable()||JSON.stringify(a)!==JSON.stringify(grid)||JSON.stringify(b)!==JSON.stringify(grid)||f.length!==1||e.length!==1)throw Error('DAILY_POSITIVE_READ_UNVERIFIED');return {formula:f[0]!,effective:e[0]!};};
 const snapshot=await take(),payment=verifiedInsertDailyPayment(snapshot.formula,record.paymentKey,Number(date[1]),Number(date[2]),Number(date[3]));
 const payload=encodeAtomicDailyPayload({expenseId:job.entityKey,postingYear:payment.postingYear,postingMonth:payment.postingMonth,postingDay:payment.postingDay,description:record.description.trim(),amountColumn:payment.amountColumn,amountSatang:Number(source.expense.amount_satang),category:record.category.trim(),wallet:legacySourceWallet(record.paymentKey,record.sourceWallet),operationMarker:row.marker});
 const legacy=await readLegacyDailyCoverage(env,payment.postingYear,payment.postingMonth,target.sheet,policy);
 const legacyIdRange=`'${env.SHEET_EXPENSE_DAILY.replace(/'/g,"''")}'!X1:X${legacy.grid.rowCount}`;
 const legacyIds=await readVerifiedLegacyDailyIds(env,legacyIdRange,legacy.grid.rowCount,job.entityKey,policy);
 // This is an additional duplicate guard for positive verification only;
 // absence from the legacy tab can never justify dispatch or retry.
 if(!legacyIds)return false;
 const formats=await getSheetCellNumberFormats(env,target.sheet,row.sheet_id,row.target_row,policy);
 if(!await reviewedNoticeMatches(env,operationToken,row.notice_stamp,row.notice_identity,noticeMode,policy,authority)||!await matchesCommittedDailyInsert(snapshot,coords,payload,row.before_digest,row.payload_digest)||!verifyMixedDailyAccounting(snapshot,grid.rowCount,grid.columnCount,payment.postingYear,payment.postingMonth,legacy.coverage)||!await verifyDailyCarrierEvidence(env,target.sheet,row.sheet_id,grid.columnCount,snapshot.formula,{entityId:job.entityKey,operationToken,payload})||formats.length!==17||!formats.slice(0,15).every(f=>f?.type==='NUMBER'&&f.pattern==='#,##0.00')||formats[16]?.type!=='DATE'||formats[16]?.pattern!=='dd/MM/yyyy'||await readContinuousReportHealth(env,undefined,undefined,policy)!=='OK')return false;
 const latest=await readReviewedDailyExpenseSource(env,job,operationToken,authority);
 if(!latest||latest.revision!==source.revision||latest.digest!==source.digest||latest.fingerprint!==source.fingerprint||JSON.stringify(await take())!==JSON.stringify(snapshot)||JSON.stringify(await readLegacyDailyCoverage(env,payment.postingYear,payment.postingMonth,target.sheet,policy))!==JSON.stringify(legacy)||JSON.stringify(await readVerifiedLegacyDailyIds(env,legacyIdRange,legacy.grid.rowCount,job.entityKey,policy))!==JSON.stringify(legacyIds)||!await reviewedNoticeMatches(env,operationToken,row.notice_stamp,row.notice_identity,noticeMode,policy,authority)||!stable())return false;
 // After a crash following the original D1 transition, verify the provider
 // and retained preimage again, but never attempt a second transition.
 if(row.projection_state==='VERIFIED'){
  const retained=await db.prepare(`SELECT 1 AS ok FROM stable_projection_writes p JOIN stable_expense_projection_preimages i ON i.spreadsheet_id=p.spreadsheet_id AND i.entity_type=p.entity_type AND i.entity_id=p.entity_id AND i.projection=p.projection AND i.sheet_id=p.sheet_id AND i.sheet_name=p.sheet_name AND i.source_version=p.source_version AND i.source_digest=p.source_digest WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND p.entity_id=? AND p.projection='DAILY' AND p.sheet_id=? AND p.sheet_name=? AND p.source_version=? AND p.source_digest=? AND p.operation_token=? AND p.state='VERIFIED' AND i.preimage_width=? AND ${integrity} AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousReportCutoverIntegrity} AND ${continuousAdmissionIntegrity} AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?) AND EXISTS(SELECT 1 FROM expense_events e JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version WHERE e.expense_id=? AND e.version=? AND e.status='CONFIRMED' AND ${reviewedJobState('j',authority)}) AND EXISTS(SELECT 1 FROM stable_workbook_claims c JOIN stable_recovery_epochs epoch ON epoch.spreadsheet_id=c.spreadsheet_id JOIN stable_recovery_operations op ON op.epoch_id=epoch.epoch_id AND op.operation_token=c.operation_token WHERE c.spreadsheet_id=? AND c.operation_token=? AND ${reviewedClaimState('c',authority)} AND c.notice_stamp=? AND c.notice_identity=? AND epoch.state IN ('ARMED','REVIEW') AND epoch.target_type='EXPENSE' AND epoch.target_key=? AND epoch.target_version=? AND op.state='ADMITTED') AND NOT EXISTS(SELECT 1 FROM stable_projection_writes other WHERE other.spreadsheet_id=p.spreadsheet_id AND other.entity_type='EXPENSE' AND (other.entity_id=p.entity_id OR substr(other.entity_id,1,length(p.entity_id)+1)=p.entity_id||'|') AND NOT(other.entity_id=p.entity_id AND other.projection='DAILY')) AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes x WHERE x.spreadsheet_id=p.spreadsheet_id AND x.entity_type='EXPENSE' AND (x.entity_id=p.entity_id OR substr(x.entity_id,1,length(p.entity_id)+1)=p.entity_id||'|'))`).bind(book,job.entityKey,row.sheet_id,row.sheet_name,job.entityVersion,source.digest,operationToken,row.before_columns,source.revision,job.entityKey,job.entityVersion,book,operationToken,row.notice_stamp,row.notice_identity,job.entityKey,job.entityVersion).first<{ok:number}>();
  return stable()&&retained?.ok===1;
 }
 const preimage=await stableExpensePreimageStatement(env,{book,entity:job.entityKey,projection:'DAILY',sheetId:row.sheet_id,sheetName:row.sheet_name,version:row.source_version,sourceDigest:row.source_digest,row:snapshot.formula[row.target_row-1]??[],width:row.before_columns});
 if(!preimage||!stable())return false;
 const result=await db.batch([
  db.prepare(`UPDATE stable_projection_writes SET state='VERIFIED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND entity_id=? AND projection='DAILY' AND sheet_id=? AND sheet_name=? AND source_version=? AND source_digest=? AND operation_token=? AND state='IN_FLIGHT'
   AND ${integrity} AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousReportCutoverIntegrity} AND ${continuousAdmissionIntegrity}
   AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?)
   AND EXISTS(SELECT 1 FROM expense_events e JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version WHERE e.expense_id=? AND e.version=? AND e.status='CONFIRMED' AND ${reviewedJobState('j',authority)})
   AND EXISTS(SELECT 1 FROM stable_workbook_claims c JOIN stable_recovery_epochs epoch ON epoch.spreadsheet_id=c.spreadsheet_id JOIN stable_recovery_operations op ON op.epoch_id=epoch.epoch_id AND op.operation_token=c.operation_token WHERE c.spreadsheet_id=? AND c.operation_token=? AND ${reviewedClaimState('c',authority)} AND c.notice_stamp=? AND c.notice_identity=? AND epoch.state IN ('ARMED','REVIEW') AND epoch.target_type='EXPENSE' AND epoch.target_key=? AND epoch.target_version=? AND op.state='ADMITTED')
   AND EXISTS(SELECT 1 FROM continuous_daily_write_evidence w WHERE w.spreadsheet_id=? AND w.entity_id=? AND w.operation_token=? AND w.marker=? AND w.before_digest=? AND w.payload_digest=?)
   AND NOT EXISTS(SELECT 1 FROM stable_projection_writes other WHERE other.spreadsheet_id=? AND other.entity_type='EXPENSE' AND (other.entity_id=? OR substr(other.entity_id,1,length(?)+1)=?||'|') AND NOT(other.entity_id=? AND other.projection='DAILY'))
   AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes cancel WHERE cancel.spreadsheet_id=? AND cancel.entity_type='EXPENSE' AND (cancel.entity_id=? OR substr(cancel.entity_id,1,length(?)+1)=?||'|'))`)
   .bind(book,job.entityKey,row.sheet_id,row.sheet_name,job.entityVersion,source.digest,operationToken,source.revision,job.entityKey,job.entityVersion,book,operationToken,row.notice_stamp,row.notice_identity,job.entityKey,job.entityVersion,book,job.entityKey,operationToken,row.marker,row.before_digest,row.payload_digest,book,job.entityKey,job.entityKey,job.entityKey,job.entityKey,book,job.entityKey,job.entityKey,job.entityKey),
  preimage,
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);
 if(!stable()||result.length!==3||result.some(r=>r.success!==true)||Number(result[0]!.meta?.changes)!==1||Number(result[1]!.meta?.changes)!==1)throw Error('DAILY_POSITIVE_VERIFY_UNCERTAIN');
 return true;
}
