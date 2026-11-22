import type {Env} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,getSheetGridInfo} from '../sheets/client';
import {assertContinuousDailyActivated} from '../sheets/continuous-daily-route';
import {columnName} from '../sheets/daily-expense';
import {verifyDailyCarrierEvidence} from '../sheets/daily-carrier-auth';
import {decodeAtomicDailyPayload} from '../sheets/atomic-daily-template';
import {readLegacyDailyCoverage} from '../sheets/legacy-daily-coverage';
import {verifyMixedDailyAccounting} from '../sheets/mixed-daily-accounting';
import {ReviewRequestBudget} from '../sheets/review-request-budget';

import {parkedAuditAction,serialAuditAction} from '../sheets/parked-notice-adoption';

export type PilotReadbackIdentity = {jobId:string; fingerprint:string};

/** Independent current-row confirmation after the normal writer has journaled DAILY.
 * The response contains no cell values. Completion of the queue is checked separately. */
export async function verifyNormalPilotRow(env:Env, identity?:PilotReadbackIdentity):Promise<boolean>{
  const book=env.GOOGLE_SPREADSHEET_ID, db=env.DB;
  const scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED,
    env.STABLE_PHASE1_ENABLED,env.STABLE_RECOVERY_GATE_ENABLED,env.STABLE_SHEETS_PACING_ENABLED,
    env.CONTINUOUS_DAILY_ENABLED,env.STABLE_CANCELLATION_PREIMAGE_ENABLED,env.CONTINUOUS_DAILY_SHEET,
    env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET,
    env.CONTINUOUS_DETAIL_SHEET_ID,env.CF_VERSION_METADATA?.id,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64]);
  const initial=scope(), stable=()=>env.DB===db&&scope()===initial;
  if(!book || env.CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED!=='true' ||
    env.STABLE_RECOVERY_GATE_ENABLED!=='true' || env.CONTINUOUS_DAILY_SHEET!=='รายวันต่อเนื่อง_แบบร่าง')return false;
  const target=await assertContinuousDailyActivated(env);
  if(!target || target.sheet!==env.CONTINUOUS_DAILY_SHEET)return false;
  // A legacy unqualified READBACK addresses the original pilot only. A serial
  // observation must bind the reservation, job and source to the same epoch.
  const identityJoin=identity ? `
    JOIN admin_audit audit ON audit.action IN (?,?) AND audit.entity_key=? AND audit.reason=?
      AND json_extract(audit.before_json,'$.book')=r.spreadsheet_id
      AND json_extract(audit.after_json,'$.epoch')=r.epoch_id
      AND json_extract(audit.after_json,'$.version')=?
    JOIN sync_jobs selected ON selected.job_id=audit.entity_key AND selected.entity_type=r.target_type
      AND selected.entity_key=r.target_key AND selected.entity_version=r.target_version` : '';
  const originalPilot=identity ? '' : `AND NOT EXISTS(SELECT 1 FROM admin_audit serial
    WHERE serial.action=? AND json_extract(serial.after_json,'$.epoch')=r.epoch_id)`;
  const identityArgs=identity
    ? [parkedAuditAction,serialAuditAction,identity.jobId,identity.fingerprint,env.CF_VERSION_METADATA?.id??'']
    : [];
  const read=()=>db.prepare(`SELECT r.epoch_id, e.expense_id, e.transaction_date, e.version, p.operation_token, m.marker,
      i.preimage_digest, i.preimage_width, e.description, e.amount_satang, e.payment_key,
      e.source_wallet, e.category, rev.revision
    FROM stable_recovery_epochs r ${identityJoin}
    JOIN continuous_normal_recovery_admissions a ON a.epoch_id=r.epoch_id AND a.spreadsheet_id=r.spreadsheet_id
      AND a.expense_id=r.target_key AND a.source_version=r.target_version
    JOIN expense_events e ON e.expense_id=r.target_key AND e.version=r.target_version
    JOIN stable_source_revision rev ON rev.singleton=1
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
      ${originalPilot}
    LIMIT 2`).bind(...identityArgs,book,target.sheetId,target.sheet,...(identity?[]:[serialAuditAction])).all<{expense_id:string;transaction_date:string;marker:string;preimage_width:number}>();
  const before=await read(), item=before.results?.[0];
  if(!stable() || before.success!==true || before.results?.length!==1 || !item)return false;
  const policy={kind:'continuous-expense' as const,budget:new ReviewRequestBudget(48,'invocation')};
  const grid=await getSheetGridInfo(env,target.sheet,policy);
  if(grid.sheetId!==target.sheetId || grid.rowCount<4 || grid.rowCount>5000 ||
     grid.columnCount!==item.preimage_width || grid.columnCount<29 || grid.columnCount>100)return false;
  const sheet="'"+target.sheet.replaceAll("'","''")+"'!", end=columnName(grid.columnCount);
  const range=sheet+'A1:'+end+grid.rowCount;
  const f=await batchGetSheetFormulaValues(env,[range],policy);
  const v=await batchGetSheetEffectiveSerialValues(env,[range],policy);
  if(f.length!==1||v.length!==1||!Array.isArray(f[0])||!Array.isArray(v[0])||!stable())return false;
  const formula=f[0],effective=v[0];
  const matched=formula.flatMap((row,index)=>{
    const payload=decodeAtomicDailyPayload(row[24]);
    return payload?.operationMarker===item.marker||payload?.expenseId===item.expense_id?[{index,payload}]:[];
  });
  const found=matched[0];
  if(matched.length!==1||!found?.payload||found.payload.expenseId!==item.expense_id||found.payload.operationMarker!==item.marker)return false;
  const {index,payload}=found;
  if(!await verifyDailyCarrierEvidence(env,target.sheet,target.sheetId,grid.columnCount,formula))return false;
  const legacy=await readLegacyDailyCoverage(env,payload.postingYear,payload.postingMonth,target.sheet,policy);
  if(!verifyMixedDailyAccounting({formula,effective},grid.rowCount,grid.columnCount,
    payload.postingYear,payload.postingMonth,legacy.coverage))return false;
  // Re-read the pilot row and the entire carrier column so a same-size edit, move or duplicate
  // between the formula, effective and accounting reads cannot pass the final observation.
  const recheck=[sheet+'A'+(index+1)+':'+end+(index+1),sheet+'Y1:Y'+grid.rowCount];
  const current=async(reader:typeof batchGetSheetFormulaValues,old:unknown[][])=>{
    const result=await reader(env,recheck,policy);
    if(result.length!==2||result[0]?.length!==1||!Array.isArray(result[0][0])||result[0][0].length>grid.columnCount||
       !Array.isArray(result[1])||result[1].length>grid.rowCount)return false;
    const one=result[0][0], markers=result[1], norm=(v:unknown)=>v===null||v===undefined?'':v;
    for(let c=0;c<grid.columnCount;c++)if(norm(one[c])!==norm(old[index]?.[c]))return false;
    for(let r=0;r<grid.rowCount;r++){
      const cells=markers[r];
      if(cells!==undefined&&(!Array.isArray(cells)||cells.length>1)||norm(cells?.[0])!==norm(old[r]?.[24]))return false;
    }
    return true;
  };
  if(!await current(batchGetSheetFormulaValues,formula)||!await current(batchGetSheetEffectiveSerialValues,effective))return false;
  const gridAfter=await getSheetGridInfo(env,target.sheet,policy), after=await read();
  return stable() && after.success===true && JSON.stringify(before.results)===JSON.stringify(after.results) &&
    JSON.stringify(grid)===JSON.stringify(gridAfter);
}
