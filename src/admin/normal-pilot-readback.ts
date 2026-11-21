import type {Env} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,getSheetGridInfo} from '../sheets/client';
import {assertContinuousDailyActivated} from '../sheets/continuous-daily-route';
import {columnName} from '../sheets/daily-expense';
import {verifyDailyCarrierEvidence} from '../sheets/daily-carrier-auth';
import {decodeAtomicDailyPayload} from '../sheets/atomic-daily-template';
import {readLegacyDailyCoverage} from '../sheets/legacy-daily-coverage';
import {verifyMixedDailyAccounting} from '../sheets/mixed-daily-accounting';
import {ReviewRequestBudget} from '../sheets/review-request-budget';

/** Independent current-row confirmation after the normal writer has journaled DAILY.
 * The response contains no cell values. Completion of the queue is checked separately. */
export async function verifyNormalPilotRow(env:Env):Promise<boolean>{
  const book=env.GOOGLE_SPREADSHEET_ID, db=env.DB;
  if(!book || env.CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED!=='true' ||
    env.STABLE_RECOVERY_GATE_ENABLED!=='true' || env.CONTINUOUS_DAILY_SHEET!=='รายวันต่อเนื่อง_แบบร่าง')return false;
  const target=await assertContinuousDailyActivated(env);
  if(!target || target.sheet!==env.CONTINUOUS_DAILY_SHEET)return false;
  const read=()=>db.prepare(`SELECT e.expense_id, e.transaction_date, e.version, p.operation_token, m.marker,
      i.preimage_digest, i.preimage_width
    FROM stable_recovery_epochs r
    JOIN continuous_normal_recovery_admissions a ON a.epoch_id=r.epoch_id AND a.spreadsheet_id=r.spreadsheet_id
      AND a.expense_id=r.target_key AND a.source_version=r.target_version
    JOIN expense_events e ON e.expense_id=r.target_key AND e.version=r.target_version
    JOIN stable_recovery_operations o ON o.epoch_id=r.epoch_id
    JOIN stable_projection_writes p ON p.operation_token=o.operation_token AND p.spreadsheet_id=r.spreadsheet_id
      AND p.entity_type='EXPENSE' AND p.entity_id=e.expense_id AND p.source_version=e.version
    JOIN atomic_daily_marker_reservations m ON m.operation_token=p.operation_token AND m.spreadsheet_id=p.spreadsheet_id
      AND m.entity_id=p.entity_id AND m.source_version=p.source_version AND m.sheet_id=p.sheet_id
    JOIN stable_expense_projection_preimages i ON i.spreadsheet_id=p.spreadsheet_id AND i.entity_type=p.entity_type
      AND i.entity_id=p.entity_id AND i.projection=p.projection AND i.sheet_id=p.sheet_id AND i.sheet_name=p.sheet_name
      AND i.source_version=p.source_version AND i.source_digest=p.source_digest
    WHERE r.spreadsheet_id=? AND r.epoch_id GLOB 'normal_pilot296_*' AND r.target_type='EXPENSE'
      AND p.state='VERIFIED' AND p.projection='DAILY' AND p.sheet_id=? AND p.sheet_name=?
      AND e.version=1 AND e.status='CONFIRMED' AND substr(e.transaction_date,1,7)=strftime('%Y-%m','now','+7 hours')
    LIMIT 2`).bind(book,target.sheetId,target.sheet).all<{expense_id:string;transaction_date:string;marker:string;preimage_width:number}>();
  const before=await read(), item=before.results?.[0];
  if(!before.success || before.results?.length!==1 || !item)return false;
  const policy={kind:'continuous-expense' as const,budget:new ReviewRequestBudget(48,'invocation')};
  const grid=await getSheetGridInfo(env,target.sheet,policy);
  if(grid.sheetId!==target.sheetId || grid.rowCount<4 || grid.rowCount>5000 ||
     grid.columnCount!==item.preimage_width || grid.columnCount<29 || grid.columnCount>100)return false;
  const range="'"+target.sheet.replaceAll("'","''")+"'!A1:"+columnName(grid.columnCount)+grid.rowCount;
  const [formula]=await batchGetSheetFormulaValues(env,[range],policy);
  const [effective]=await batchGetSheetEffectiveSerialValues(env,[range],policy);
  if(!formula || !effective)return false;
  const matches=formula.map(row=>decodeAtomicDailyPayload(row[24])).filter(row=>row?.expenseId===item.expense_id);
  const payload=matches[0];
  if(matches.length!==1 || !payload || payload.operationMarker!==item.marker)return false;
  if(!await verifyDailyCarrierEvidence(env,target.sheet,target.sheetId,grid.columnCount,formula))return false;
  const legacy=await readLegacyDailyCoverage(env,payload.postingYear,payload.postingMonth,target.sheet,policy);
  if(!verifyMixedDailyAccounting({formula,effective},grid.rowCount,grid.columnCount,
    payload.postingYear,payload.postingMonth,legacy.coverage))return false;
  const gridAfter=await getSheetGridInfo(env,target.sheet,policy), after=await read();
  return db===env.DB && env.GOOGLE_SPREADSHEET_ID===book && after.success===true &&
    JSON.stringify(before.results)===JSON.stringify(after.results) && JSON.stringify(grid)===JSON.stringify(gridAfter);
}
