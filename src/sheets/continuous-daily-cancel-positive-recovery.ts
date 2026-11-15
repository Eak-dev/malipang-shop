import type {Env,SheetsSyncJob} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,continuousSheetsReadPolicy,getSheetGridInfo} from './client';
import {columnName} from './daily-expense';
import {appendDailyRowFormulas} from './append-daily-template';
import {verifyAtomicDailyAccounting} from './atomic-daily-cell-writer';
import {verifyMixedDailyAccounting} from './mixed-daily-accounting';
import {readLegacyDailyCoverage} from './legacy-daily-coverage';
import {assertContinuousDailyActivated} from './continuous-daily-route';
import {continuousAdmissionIntegrity,continuousDailyCutoverIntegrity,continuousReportCutoverIntegrity} from './continuous-daily-cutover';
import {stableSourceIntegrity} from './stable-source-cutover';
import {stableNoticePaused} from './stable-edit-notice';
import {readContinuousReportHealth} from './continuous-report-health';
import {dailyCancelTombstone,matchesCommittedDailyCancellation} from './continuous-daily-cancel-evidence';
import {readCancelledExpenseSource} from './cancelled-expense-source';

type Evidence={sheet_id:number;sheet_name:string;cancellation_version:number;previous_version:number;operation_token:string;target_row:number;row_count:number;column_count:number;posting_year:number;posting_month:number;source_revision:number;source_fingerprint:string;current_revision:number;original_digest:string;masked_before_digest:string;tombstone:string;notice_stamp:string;notice_identity:string};
const integrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND ((tbl_name='continuous_daily_cancel_evidence' AND name IN ('continuous_daily_cancel_evidence_source','continuous_daily_cancel_evidence_no_update','continuous_daily_cancel_evidence_no_delete','continuous_daily_cancel_evidence_no_replace')) OR (tbl_name='stable_expense_projection_preimages' AND name IN ('stable_expense_preimage_verified_source','stable_expense_preimage_no_update','stable_expense_preimage_no_delete','stable_expense_preimage_no_replace')) OR (tbl_name='stable_expense_cancellation_writes' AND name IN ('stable_expense_cancel_preimage_required','stable_expense_cancel_no_delete','stable_expense_cancel_no_replace','stable_expense_cancel_transition')) OR (tbl_name='stable_daily_cancellation_metadata' AND name IN ('stable_daily_cancel_meta_bound','stable_daily_cancel_meta_no_update','stable_daily_cancel_meta_no_delete','stable_daily_cancel_meta_no_replace'))))=16";

/** Verify only one already-dispatched DAILY Undo. No provider mutation or
 * queue replay occurs here; the claim, epoch and job stay fenced in REVIEW.
 * Absence, stale source, edited cells or uncertain readback always fail closed. */
export async function verifyReviewedDailyCancellation(env:Env,job:SheetsSyncJob,operationToken:string):Promise<boolean>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 const scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.SHEET_EXPENSE_DAILY,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.STABLE_PHASE1_ENABLED,env.STABLE_RECOVERY_GATE_ENABLED,env.CONTINUOUS_DAILY_ENABLED,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.APP_ENV,env.RUNTIME_MODE]);
 const initial=scope(),stable=()=>env.DB===db&&scope()===initial;
 if(!book||!operationToken||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(job.entityKey)||!Number.isSafeInteger(job.entityVersion)||job.entityVersion<2||env.STABLE_RECOVERY_GATE_ENABLED!=='true')return false;
 const target=await assertContinuousDailyActivated(env);if(!target||!stable())return false;
 const evidence=await db.prepare(`SELECT w.sheet_id,w.sheet_name,w.cancellation_version,w.previous_version,w.operation_token,w.target_row,w.row_count,w.column_count,w.posting_year,w.posting_month,w.source_revision,w.source_fingerprint,rev.revision current_revision,w.original_digest,w.masked_before_digest,w.tombstone,claim.notice_stamp,claim.notice_identity
  FROM continuous_daily_cancel_evidence w JOIN stable_expense_cancellation_writes c ON c.spreadsheet_id=w.spreadsheet_id AND c.entity_type='EXPENSE' AND c.entity_id=w.entity_id AND c.projection='DAILY' AND c.cancellation_version=w.cancellation_version AND c.previous_version=w.previous_version AND c.operation_token=w.operation_token AND c.preimage_digest=w.original_digest AND c.state='IN_FLIGHT'
  JOIN stable_daily_cancellation_metadata m ON m.spreadsheet_id=w.spreadsheet_id AND m.entity_type=c.entity_type AND m.entity_id=w.entity_id AND m.projection=c.projection AND m.cancellation_version=w.cancellation_version AND m.operation_token=w.operation_token AND m.sheet_id=w.sheet_id AND m.sheet_name=w.sheet_name AND m.posting_year=w.posting_year AND m.posting_month=w.posting_month
  JOIN stable_expense_projection_preimages image ON image.spreadsheet_id=c.spreadsheet_id AND image.entity_type=c.entity_type AND image.entity_id=c.entity_id AND image.projection=c.projection AND image.sheet_id=w.sheet_id AND image.sheet_name=w.sheet_name AND image.source_version=w.previous_version AND image.preimage_width=w.column_count AND image.preimage_digest=w.original_digest
  JOIN stable_projection_writes p ON p.spreadsheet_id=image.spreadsheet_id AND p.entity_type=image.entity_type AND p.entity_id=image.entity_id AND p.projection=image.projection AND p.sheet_id=image.sheet_id AND p.sheet_name=image.sheet_name AND p.source_version=image.source_version AND p.source_digest=image.source_digest AND p.state='VERIFIED'
  JOIN stable_workbook_claims claim ON claim.spreadsheet_id=w.spreadsheet_id AND claim.operation_token=w.operation_token AND claim.state='REVIEW' AND claim.phase='OPERATION'
  JOIN stable_recovery_epochs epoch ON epoch.spreadsheet_id=w.spreadsheet_id AND epoch.target_type='EXPENSE' AND epoch.target_key=w.entity_id AND epoch.target_version=w.cancellation_version AND epoch.state IN ('ARMED','REVIEW')
  JOIN stable_recovery_operations op ON op.epoch_id=epoch.epoch_id AND op.operation_token=w.operation_token AND op.state='ADMITTED'
  JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=w.entity_id AND j.entity_version=w.cancellation_version AND j.status='REVIEW' AND (j.lease_token IS NULL AND j.lease_until IS NULL OR j.lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  JOIN expense_events source ON source.expense_id=w.entity_id AND source.version=w.cancellation_version AND source.status='CANCELLED'
  JOIN stable_source_revision rev ON rev.singleton=1
  WHERE w.spreadsheet_id=? AND w.entity_id=? AND w.cancellation_version=? AND w.operation_token=? AND ${integrity} AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousReportCutoverIntegrity} AND ${continuousAdmissionIntegrity}
  AND NOT EXISTS(SELECT 1 FROM stable_projection_writes other WHERE other.spreadsheet_id=w.spreadsheet_id AND other.state<>'VERIFIED')
  AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes other WHERE other.spreadsheet_id=w.spreadsheet_id AND other.state<>'VERIFIED' AND NOT(other.entity_type='EXPENSE' AND other.entity_id=w.entity_id AND other.projection='DAILY' AND other.cancellation_version=w.cancellation_version AND other.operation_token=w.operation_token))`).bind(book,job.entityKey,job.entityVersion,operationToken).first<Evidence>();
 if(!evidence||evidence.sheet_id!==target.sheetId||evidence.sheet_name!==target.sheet||!evidence.notice_stamp||!evidence.notice_identity||evidence.tombstone!==await dailyCancelTombstone(operationToken)||!stable())return false;
 const cancelledSource=await readCancelledExpenseSource(env,job,operationToken);
 if(!cancelledSource||cancelledSource.revision!==evidence.current_revision||cancelledSource.digest!==evidence.source_fingerprint||!stable())return false;
 const grid=await getSheetGridInfo(env,target.sheet,continuousSheetsReadPolicy),coords={sheetId:evidence.sheet_id,row:evidence.target_row,rowCount:evidence.row_count,columnCount:evidence.column_count,year:evidence.posting_year,month:evidence.posting_month};
 if(grid.sheetId!==coords.sheetId||grid.rowCount!==coords.rowCount||grid.columnCount!==coords.columnCount||!stable())return false;
 const range=`'${target.sheet.replace(/'/g,"''")}'!A1:${columnName(grid.columnCount)}${grid.rowCount}`;
 const take=async()=>{const a=await getSheetGridInfo(env,target.sheet,continuousSheetsReadPolicy),f=await batchGetSheetFormulaValues(env,[range],continuousSheetsReadPolicy),e=await batchGetSheetEffectiveSerialValues(env,[range],continuousSheetsReadPolicy),b=await getSheetGridInfo(env,target.sheet,continuousSheetsReadPolicy);if(!stable()||JSON.stringify(a)!==JSON.stringify(grid)||JSON.stringify(b)!==JSON.stringify(grid)||f.length!==1||e.length!==1)throw Error('DAILY_CANCEL_POSITIVE_READ_UNVERIFIED');return{formula:f[0]!,effective:e[0]!};};
 const snapshot=await take(),legacy=await readLegacyDailyCoverage(env,coords.year,coords.month,target.sheet,continuousSheetsReadPolicy),targetFormula=snapshot.formula[coords.row-1]??[],dynamic=Object.entries(appendDailyRowFormulas()).every(([col,value])=>targetFormula[Number(col)]===value);
 const accounting=dynamic?verifyMixedDailyAccounting(snapshot,grid.rowCount,grid.columnCount,coords.year,coords.month,legacy.coverage):verifyAtomicDailyAccounting(snapshot,grid.rowCount,coords.year,coords.month,legacy.coverage);
 if(!await stableNoticePaused(env,evidence.notice_stamp,evidence.notice_identity)||!await matchesCommittedDailyCancellation(snapshot,coords,job.entityKey,evidence.tombstone,evidence.masked_before_digest)||!accounting||await readContinuousReportHealth(env)!=='OK'||!stable())return false;
 const allTombstones=await db.prepare(`SELECT c.operation_token FROM stable_expense_cancellation_writes c JOIN stable_expense_projection_preimages p ON p.spreadsheet_id=c.spreadsheet_id AND p.entity_type=c.entity_type AND p.entity_id=c.entity_id AND p.projection=c.projection WHERE c.spreadsheet_id=? AND c.entity_type='EXPENSE' AND c.projection='DAILY' AND c.state='VERIFIED' AND p.sheet_id=? AND p.sheet_name=?`).bind(book,target.sheetId,target.sheet).all<{operation_token:string}>();
 if(allTombstones.success!==true||!Array.isArray(allTombstones.results))return false;
 const expected=await Promise.all(allTombstones.results.map(x=>dailyCancelTombstone(x.operation_token)));expected.push(evidence.tombstone);
 const actual=snapshot.formula.flatMap(r=>typeof r[24]==='string'&&/^MPD1_CANCELLED_[0-9a-f]{64}$/.test(r[24])?[r[24]]:[]);
 if(new Set(expected).size!==expected.length||new Set(actual).size!==actual.length||expected.length!==actual.length||!expected.every(x=>actual.includes(x)))return false;
 if(JSON.stringify(await take())!==JSON.stringify(snapshot)||JSON.stringify(await readLegacyDailyCoverage(env,coords.year,coords.month,target.sheet,continuousSheetsReadPolicy))!==JSON.stringify(legacy)||!await stableNoticePaused(env,evidence.notice_stamp,evidence.notice_identity)||!stable())return false;
 const result=await db.prepare(`UPDATE stable_expense_cancellation_writes SET state='VERIFIED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND entity_id=? AND projection='DAILY' AND cancellation_version=? AND previous_version=? AND preimage_digest=? AND operation_token=? AND state='IN_FLIGHT'
  AND ${integrity} AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousReportCutoverIntegrity} AND ${continuousAdmissionIntegrity}
  AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?)
  AND EXISTS(SELECT 1 FROM expense_events e JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version WHERE e.expense_id=? AND e.version=? AND e.status='CANCELLED' AND j.status='REVIEW' AND (j.lease_token IS NULL AND j.lease_until IS NULL OR j.lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))
  AND EXISTS(SELECT 1 FROM stable_workbook_claims claim JOIN stable_recovery_epochs epoch ON epoch.spreadsheet_id=claim.spreadsheet_id JOIN stable_recovery_operations op ON op.epoch_id=epoch.epoch_id AND op.operation_token=claim.operation_token WHERE claim.spreadsheet_id=? AND claim.operation_token=? AND claim.state='REVIEW' AND claim.phase='OPERATION' AND claim.notice_stamp=? AND claim.notice_identity=? AND epoch.state IN ('ARMED','REVIEW') AND epoch.target_type='EXPENSE' AND epoch.target_key=? AND epoch.target_version=? AND op.state='ADMITTED')
  AND EXISTS(SELECT 1 FROM continuous_daily_cancel_evidence w WHERE w.spreadsheet_id=? AND w.entity_id=? AND w.cancellation_version=? AND w.operation_token=? AND w.source_revision=? AND w.source_fingerprint=? AND w.original_digest=? AND w.masked_before_digest=? AND w.tombstone=?)
  AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.state<>'VERIFIED')
  AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes other WHERE other.spreadsheet_id=? AND other.state<>'VERIFIED' AND NOT(other.entity_type='EXPENSE' AND other.entity_id=? AND other.projection='DAILY' AND other.cancellation_version=? AND other.operation_token=?))`)
  .bind(book,job.entityKey,job.entityVersion,evidence.previous_version,evidence.original_digest,operationToken,cancelledSource.revision,job.entityKey,job.entityVersion,book,operationToken,evidence.notice_stamp,evidence.notice_identity,job.entityKey,job.entityVersion,book,job.entityKey,job.entityVersion,operationToken,evidence.source_revision,evidence.source_fingerprint,evidence.original_digest,evidence.masked_before_digest,evidence.tombstone,book,book,job.entityKey,job.entityVersion,operationToken).run();
 if(!stable()||result.success!==true||!Number.isSafeInteger(result.meta?.changes))throw Error('DAILY_CANCEL_POSITIVE_VERIFY_UNCERTAIN');
 return Number(result.meta.changes)===1;
}
