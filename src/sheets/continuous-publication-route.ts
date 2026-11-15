import type {Env} from '../types';

type PublicationEnv=Env&{CONTINUOUS_PUBLICATION_ENABLED?:string;CONTINUOUS_PUBLICATION_SHEET?:string;CONTINUOUS_PUBLICATION_SHEET_ID?:string;CONTINUOUS_PUBLICATION_ROWS?:string};
export type PublicationTarget={sheetId:number;sheetName:string;rows:number};
const integer=(value:string|undefined,min:number,max:number):number=>{if(!value||!/^(0|[1-9][0-9]*)$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<min||Number(value)>max)throw Error('PUBLICATION_CONFIG_INVALID');return Number(value);};
/** Configuration is inert unless explicitly enabled and bound to immutable
 * cutover metadata. This is necessary, never sufficient, for provider writes:
 * callers still verify the provider target, bootstrap and report formulas. */
export async function resolvePublicationTarget(env:PublicationEnv):Promise<PublicationTarget|null>{
 const flag=env.CONTINUOUS_PUBLICATION_ENABLED;
 if(flag===undefined||flag==='false'){
  const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;if(!book)return null;
  const schema=await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='continuous_publication_targets'").first<{n:number}>();
  if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||!schema||!Number.isSafeInteger(schema.n)||schema.n<0||schema.n>1)throw Error('PUBLICATION_CUTOVER_UNVERIFIED');
  if(schema.n===1){const active=await db.prepare('SELECT 1 AS ok FROM continuous_publication_targets WHERE spreadsheet_id=?').bind(book).first<{ok:number}>();if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||active)throw Error('PUBLICATION_DISABLE_UNSAFE');}
  return null;
 }
 if(flag!=='true')throw Error('PUBLICATION_CONFIG_INVALID');
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,sheetName=env.CONTINUOUS_PUBLICATION_SHEET,sheetId=integer(env.CONTINUOUS_PUBLICATION_SHEET_ID,0,2147483647),rows=integer(env.CONTINUOUS_PUBLICATION_ROWS,2,5000);
 const scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.CONTINUOUS_PUBLICATION_ENABLED,env.CONTINUOUS_PUBLICATION_SHEET,env.CONTINUOUS_PUBLICATION_SHEET_ID,env.CONTINUOUS_PUBLICATION_ROWS,env.CONTINUOUS_DAILY_ENABLED,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID]);const initial=scope();
 if(!book||!sheetName||sheetName!==sheetName.trim()||sheetName.length>80||env.CONTINUOUS_DAILY_ENABLED!=='true'||!env.CONTINUOUS_DAILY_SHEET||!env.CONTINUOUS_DAILY_SHEET_ID||!env.CONTINUOUS_RAW_SHEET||!env.CONTINUOUS_RAW_SHEET_ID||!env.CONTINUOUS_DETAIL_SHEET||!env.CONTINUOUS_DETAIL_SHEET_ID)throw Error('PUBLICATION_CONFIG_INVALID');
 const result=await db.prepare(`SELECT 1 AS ok FROM continuous_publication_targets p JOIN continuous_daily_cutovers c ON c.spreadsheet_id=p.spreadsheet_id AND c.state='ACTIVE' WHERE p.spreadsheet_id=? AND p.sheet_id=? AND p.sheet_name=? AND p.row_count=? AND c.continuous_sheet_name=? AND c.continuous_sheet_id=? AND c.raw_sheet_name=? AND c.raw_sheet_id=? AND c.detail_sheet_name=? AND c.detail_sheet_id=? AND (SELECT count(*) FROM continuous_report_cutover_attempts a WHERE a.spreadsheet_id=p.spreadsheet_id AND a.stage IN ('VIEWS','DAILY_J','REPORTS') AND a.state='VERIFIED')=3 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_publication_targets' AND name IN ('continuous_publication_target_insert','continuous_publication_target_no_update','continuous_publication_target_no_delete','continuous_publication_target_no_replace'))=4`).bind(book,sheetId,sheetName,rows,env.CONTINUOUS_DAILY_SHEET,integer(env.CONTINUOUS_DAILY_SHEET_ID,0,2147483647),env.CONTINUOUS_RAW_SHEET,integer(env.CONTINUOUS_RAW_SHEET_ID,0,2147483647),env.CONTINUOUS_DETAIL_SHEET,integer(env.CONTINUOUS_DETAIL_SHEET_ID,0,2147483647)).first<{ok:number}>();
 if(env.DB!==db||scope()!==initial||result?.ok!==1)throw Error('PUBLICATION_CUTOVER_UNVERIFIED');
 return{sheetId,sheetName,rows};
}
