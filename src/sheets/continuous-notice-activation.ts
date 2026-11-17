import type {Env,SheetsSyncJob} from '../types';
import {normalNoticeHandoffEnabled} from './continuous-normal-notice-handoff';

/** Once activated, never silently fall back to a different writer or target.
 * This does not fence old deployments which never check this marker. */
export const CONTINUOUS_NOTICE_ACTIVATION_BLOCKED='CONTINUOUS_NOTICE_ACTIVATION_BLOCKED';
type Active={spreadsheet_id:string;legacy_sheet_name:string;daily_sheet_name:string;daily_sheet_id:number;raw_sheet_name:string;raw_sheet_id:number;detail_sheet_name:string;detail_sheet_id:number;publication_sheet_name:string;publication_sheet_id:number};
type PublicationEnv=Env&{CONTINUOUS_PUBLICATION_ENABLED?:string;CONTINUOUS_PUBLICATION_SHEET?:string;CONTINUOUS_PUBLICATION_SHEET_ID?:string};
export async function assertContinuousNoticeActivation(env:Env,job:SheetsSyncJob):Promise<void>{
 if(job.entityType!=='EXPENSE')return;
 const db=env.DB;
 let row:(Active&{state:string|null;proof:number})|null;
 try{
  // One D1 query on the ordinary path matters: a paced queue invocation may
  // already be near the platform's per-invocation query limit.
  row=await db.prepare(`SELECT a.spreadsheet_id,a.legacy_sheet_name,a.daily_sheet_name,a.daily_sheet_id,a.raw_sheet_name,a.raw_sheet_id,a.detail_sheet_name,a.detail_sheet_id,a.publication_sheet_name,a.publication_sheet_id,a.state,CASE WHEN a.singleton IS NULL THEN 1 ELSE ((SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_notice_activation' AND name IN ('continuous_notice_activation_insert','continuous_notice_activation_no_update','continuous_notice_activation_no_delete','continuous_notice_activation_no_replace'))=4 AND EXISTS(SELECT 1 FROM continuous_daily_cutovers c JOIN continuous_publication_targets p ON p.spreadsheet_id=c.spreadsheet_id WHERE c.spreadsheet_id=a.spreadsheet_id AND c.state='ACTIVE' AND c.legacy_sheet_name=a.legacy_sheet_name AND c.continuous_sheet_name=a.daily_sheet_name AND c.continuous_sheet_id=a.daily_sheet_id AND c.raw_sheet_name=a.raw_sheet_name AND c.raw_sheet_id=a.raw_sheet_id AND c.detail_sheet_name=a.detail_sheet_name AND c.detail_sheet_id=a.detail_sheet_id AND p.sheet_name=a.publication_sheet_name AND p.sheet_id=a.publication_sheet_id)) END AS proof FROM (SELECT 1 AS singleton) q LEFT JOIN continuous_notice_activation a ON a.singleton=q.singleton`).first<Active&{state:string|null;proof:number}>();
 }catch(error){
  // Pre-migration legacy installations may not have the marker table. Do not
  // treat a transient read error as missing schema: positively check it.
  const schema=await db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='continuous_notice_activation'").first<{ok:number}>();
  if(env.DB!==db||schema||env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED==='true')throw Error(CONTINUOUS_NOTICE_ACTIVATION_BLOCKED);
  return;
 }
 if(env.DB!==db||!row||row.proof!==1)throw Error(CONTINUOUS_NOTICE_ACTIVATION_BLOCKED);
 if(row.state===null){if(env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED==='true')throw Error(CONTINUOUS_NOTICE_ACTIVATION_BLOCKED);return;}
 if(row.state!=='ACTIVE')throw Error(CONTINUOUS_NOTICE_ACTIVATION_BLOCKED);
 const e=env as PublicationEnv;
 if(env.DB!==db||!normalNoticeHandoffEnabled(env)||!env.NOTICE_QUEUE||e.CONTINUOUS_PUBLICATION_ENABLED!=='true'||env.GOOGLE_SPREADSHEET_ID!==row.spreadsheet_id||env.SHEET_EXPENSE_DAILY!==row.legacy_sheet_name||env.CONTINUOUS_DAILY_SHEET!==row.daily_sheet_name||env.CONTINUOUS_DAILY_SHEET_ID!==String(row.daily_sheet_id)||env.CONTINUOUS_RAW_SHEET!==row.raw_sheet_name||env.CONTINUOUS_RAW_SHEET_ID!==String(row.raw_sheet_id)||env.CONTINUOUS_DETAIL_SHEET!==row.detail_sheet_name||env.CONTINUOUS_DETAIL_SHEET_ID!==String(row.detail_sheet_id)||e.CONTINUOUS_PUBLICATION_SHEET!==row.publication_sheet_name||e.CONTINUOUS_PUBLICATION_SHEET_ID!==String(row.publication_sheet_id))throw Error(CONTINUOUS_NOTICE_ACTIVATION_BLOCKED);
}
