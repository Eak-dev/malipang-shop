import type {Env} from '../types';
import {stableSourceIntegrity} from './stable-source-cutover';
import {continuousAdmissionIntegrity,continuousDailyCutoverIntegrity,continuousReportCutoverIntegrity} from './continuous-daily-cutover';

/** Configuration validation only: NEVER treat this as write authority. */
export function continuousDailyTarget(env:Env):{sheet:string;sheetId:number}|null{
 if(env.CONTINUOUS_DAILY_ENABLED===undefined||env.CONTINUOUS_DAILY_ENABLED===''||env.CONTINUOUS_DAILY_ENABLED==='false')return null;
 if(env.CONTINUOUS_DAILY_ENABLED!=='true')throw Error('CONTINUOUS_DAILY_FLAG_INVALID');
 const names=[env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_DETAIL_SHEET],ids=[env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET_ID];
 const reserved=[env.SHEET_EXPENSE_DAILY,env.SHEET_EXPENSE_RAW,env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ',env.SHEET_PERSONAL_USE_RAW||'V52_PERSONAL_USE_RAW',env.SHEET_STAFF_CONFIG,env.SHEET_ATTENDANCE_RAW,env.SHEET_DAILY_PAYROLL,env.SHEET_WEEKLY_PAYROLL,env.SHEET_WAGE_HISTORY,env.SHEET_SHIFT_SCHEDULE,env.SHEET_OT_REQUESTS,env.SHEET_SYSTEM_LOG].filter(Boolean);
 if(env.STABLE_PHASE1_ENABLED!=='true'||env.STABLE_CANCELLATION_PREIMAGE_ENABLED!=='true'||!env.GOOGLE_SPREADSHEET_ID||names.some(n=>!n||n!==n.trim()||reserved.includes(n))||new Set(names).size!==3||ids.some(id=>!id||!/^(0|[1-9]\d*)$/.test(id)||!Number.isSafeInteger(Number(id))||Number(id)>2147483647)||new Set(ids).size!==3)throw Error('CONTINUOUS_DAILY_TARGET_INVALID');
 return{sheet:names[0]!,sheetId:Number(ids[0])};
}

/** Fail closed before any lease, claim or provider write. Configuration and
 * environment labels alone cannot enable this path; D1 must contain the
 * exact immutable cutover plus both verified report-migration stages. This
 * does not itself prove that old external requests have settled. */
export async function assertContinuousDailyActivated(env:Env):Promise<{sheet:string;sheetId:number}|null>{
 const target=continuousDailyTarget(env);if(!target)return null;
 const db=env.DB,scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.SHEET_EXPENSE_DAILY,env.STABLE_PHASE1_ENABLED,env.STABLE_CANCELLATION_PREIMAGE_ENABLED,env.CONTINUOUS_DAILY_ENABLED,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID]),initial=scope();
 const row=await db.prepare(`SELECT 1 AS ok FROM continuous_daily_cutovers c WHERE c.spreadsheet_id=? AND c.state='ACTIVE' AND c.legacy_sheet_name=? AND c.continuous_sheet_name=? AND c.continuous_sheet_id=? AND c.raw_sheet_name=? AND c.raw_sheet_id=? AND c.detail_sheet_name=? AND c.detail_sheet_id=? AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousReportCutoverIntegrity} AND ${continuousAdmissionIntegrity} AND (SELECT count(*) FROM continuous_report_cutover_attempts a WHERE a.spreadsheet_id=c.spreadsheet_id AND a.stage IN ('VIEWS','DAILY_J','REPORTS') AND a.state='VERIFIED')=3`).bind(env.GOOGLE_SPREADSHEET_ID,env.SHEET_EXPENSE_DAILY,target.sheet,target.sheetId,env.CONTINUOUS_RAW_SHEET,Number(env.CONTINUOUS_RAW_SHEET_ID),env.CONTINUOUS_DETAIL_SHEET,Number(env.CONTINUOUS_DETAIL_SHEET_ID)).first<{ok:number}>();
 if(env.DB!==db||scope()!==initial||row?.ok!==1)throw Error('CONTINUOUS_DAILY_NOT_READY');return target;
}
