import type {Env} from '../types';

export type StableSourceEligibility = {kind:'NEW'|'ENROLLED';generation:string;watermark:number}|{kind:'REVIEW';reason:string};
const hold=(reason:string):StableSourceEligibility=>({kind:'REVIEW',reason});

/** The UAT marker is intentionally provisioned outside migrations and must
 * belong to a separately verified synthetic DB, not the production binding.
 * These configuration checks are not proof that humans or old workers are
 * excluded from Google Sheets. */
async function assertIsolatedShadow(env:Env):Promise<void>{
  if(env.RUNTIME_MODE!=='shadow'||env.DAILY_STABLE_ID_PROTOTYPE_ENABLED!=='true'||!env.DAILY_STABLE_UAT_SPREADSHEET_ID||!env.DAILY_STABLE_PRODUCTION_SPREADSHEET_ID||env.GOOGLE_SPREADSHEET_ID!==env.DAILY_STABLE_UAT_SPREADSHEET_ID||env.GOOGLE_SPREADSHEET_ID===env.DAILY_STABLE_PRODUCTION_SPREADSHEET_ID||!env.DAILY_STABLE_UAT_DATABASE_MARKER||env.DAILY_STABLE_UAT_EXCLUSIVE_EDITORS!=='true')throw new Error('DAILY_STABLE_UAT_NOT_AUTHORIZED');
  const row=await env.DB.prepare(`SELECT marker FROM daily_stable_uat_guard WHERE marker=?`).bind(env.DAILY_STABLE_UAT_DATABASE_MARKER).first<{marker:string}>();if(!row)throw new Error('DAILY_STABLE_UAT_DATABASE_UNVERIFIED');
}

/** Only a synthetic UAT boundary can be activated by code. It records MAX(seq)
 * atomically with activation. It does not attest old-writer drainage. */
export async function activateStableShadowCutover(env:Env,generation:string):Promise<boolean>{
  await assertIsolatedShadow(env);if(!/^[A-Za-z0-9_-]{8,100}$/.test(generation))throw new Error('DAILY_STABLE_GENERATION_INVALID');
  const now=new Date().toISOString(),r=await env.DB.prepare(`UPDATE daily_stable_cutovers SET state='ACTIVE',source_watermark=(SELECT COALESCE(MAX(sequence),0) FROM daily_stable_source_admissions),activated_at=? WHERE spreadsheet_id=? AND sheet_name=? AND generation=? AND state='PREPARED'`).bind(now,env.GOOGLE_SPREADSHEET_ID,env.SHEET_EXPENSE_DAILY,generation).run();
  return Number(r.meta.changes||0)===1;
}

/** Reject ambiguous/legacy sources, including item-only legacy mappings.
 * Only an admission strictly after the active watermark may be newly created;
 * an already VERIFIED identity may be updated at a later source version.
 * No numeric row location is used as a write target. */
export async function classifyStableShadowSource(env:Env,expenseId:string,version:number):Promise<StableSourceEligibility>{
  try{await assertIsolatedShadow(env);}catch{return hold('DAILY_STABLE_UAT_UNVERIFIED');}
  if(!/^exp_[A-Za-z0-9_-]{1,128}$/.test(expenseId)||!Number.isSafeInteger(version)||version<1)return hold('DAILY_STABLE_SOURCE_INVALID');
  const row=await env.DB.prepare(`SELECT e.status,e.version,a.sequence,c.state AS cutover_state,c.source_watermark,c.generation,
    i.state AS intent_state,i.projected_version,
    EXISTS(SELECT 1 FROM sheet_row_index r WHERE r.sheet_name=? AND (r.entity_key=e.expense_id OR substr(r.entity_key,1,length(e.expense_id)+1)=e.expense_id||'|')) AS legacy_mapping
    FROM expense_events e LEFT JOIN daily_stable_source_admissions a ON a.expense_id=e.expense_id
    LEFT JOIN daily_stable_cutovers c ON c.spreadsheet_id=? AND c.sheet_name=?
    LEFT JOIN daily_stable_row_intents i ON i.spreadsheet_id=? AND i.expense_id=e.expense_id
    WHERE e.expense_id=?`).bind(env.SHEET_EXPENSE_DAILY,env.GOOGLE_SPREADSHEET_ID,env.SHEET_EXPENSE_DAILY,env.GOOGLE_SPREADSHEET_ID,expenseId).first<{status:string;version:number;sequence:number|null;cutover_state:string|null;generation:string|null;source_watermark:number|null;intent_state:string|null;projected_version:number|null;legacy_mapping:number}>();
  if(!row||row.status!=='CONFIRMED'||Number(row.version)!==version)return hold('DAILY_STABLE_SOURCE_CHANGED');
  if(row.cutover_state!=='ACTIVE'||row.source_watermark===null||!row.generation)return hold('DAILY_STABLE_CUTOVER_NOT_ACTIVE');
  if(row.intent_state==='IN_FLIGHT')return hold('DAILY_STABLE_PRIOR_INTENT_REQUIRES_REVIEW');
  if(row.intent_state==='VERIFIED')return Number(row.projected_version)>version?hold('DAILY_STABLE_PROJECTED_VERSION_AHEAD'):{kind:'ENROLLED',generation:row.generation,watermark:Number(row.source_watermark)};
  if(Number(row.legacy_mapping)===1)return hold('DAILY_STABLE_LEGACY_REVIEW_REQUIRED');
  if(row.sequence===null||Number(row.sequence)<=Number(row.source_watermark))return hold('DAILY_STABLE_LEGACY_REVIEW_REQUIRED');
  if(version!==1)return hold('DAILY_STABLE_FIRST_PROJECTION_VERSION_UNVERIFIED');
  return {kind:'NEW',generation:row.generation,watermark:Number(row.source_watermark)};
}
