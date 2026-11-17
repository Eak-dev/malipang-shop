// Read-only Production snapshot for operators. The repository is public, so
// the output is limited to what an operator needs before a release:
//  - migrations applied on D1 and migrations still pending in this commit
//  - table names present in D1
//  - Worker version ids and traffic split
//  - counts of abnormal work only (FAILED/REVIEW jobs, open failed jobs,
//    workbook claims under review, failed/review inbound events)
// No amounts, identifiers, descriptions, normal-work counts or dates.
// Each query has a fixed column allowlist in QUERIES; sanitizeRows() rejects
// any row whose columns or values do not match it, and tests pin the SQL.
import {execFileSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {pathToFileURL,fileURLToPath} from 'node:url';

const MAX_ROWS=400;
const CODE=/^[A-Z][A-Z0-9_]{0,63}$/;
const KINDS={
  count:v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0,
  migration:v=>typeof v==='string'&&/^\d{4}_[a-z0-9_]{1,80}\.sql$/.test(v),
  table:v=>typeof v==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(v),
  code:v=>typeof v==='string'&&CODE.test(v),
  // Mirrors SheetEntityType in src/types.ts.
  entity:v=>typeof v==='string'&&['ATTENDANCE_EVENT','DAILY_PAYROLL','WEEKLY_PAYROLL','EXPENSE','PERSONAL_USE','SHIFT_SCHEDULE','WAGE_HISTORY','OT_REQUEST','SYSTEM_LOG'].includes(v),
  jobStatus:v=>typeof v==='string'&&['FAILED','REVIEW'].includes(v),
  claimState:v=>typeof v==='string'&&['HELD','REVIEW'].includes(v),
  inboundStatus:v=>typeof v==='string'&&['FAILED','REVIEW'].includes(v),
};

const errorCode=col=>`CASE WHEN ${col} IS NULL THEN 'NONE' WHEN ${col} GLOB '*[^A-Z0-9_]*' OR ${col} GLOB '[^A-Z]*' OR length(${col})>64 THEN 'OTHER' ELSE ${col} END`;
/** name → SQL and the exact columns it may return. */
export const QUERIES=Object.freeze({
  migrations_applied:{sql:'SELECT name AS migration FROM d1_migrations ORDER BY id',columns:{migration:'migration'}},
  tables:{sql:"SELECT name AS table_name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",columns:{table_name:'table'}},
  abnormal_sync_jobs:{sql:`SELECT entity_type,status,${errorCode('last_error')} AS error_code,count(*) AS n FROM sync_jobs WHERE status IN ('FAILED','REVIEW') GROUP BY 1,2,3 ORDER BY 1,2,3`,columns:{entity_type:'entity',status:'jobStatus',error_code:'code',n:'count'}},
  open_failed_jobs:{sql:"SELECT count(*) AS n FROM failed_jobs WHERE status='OPEN'",columns:{n:'count'}},
  workbook_claims:{sql:`SELECT state,${errorCode('review_reason')} AS reason,count(*) AS n FROM stable_workbook_claims GROUP BY 1,2`,columns:{state:'claimState',reason:'code',n:'count'}},
  abnormal_inbound:{sql:"SELECT status,count(*) AS n FROM inbound_events WHERE status IN ('FAILED','REVIEW') GROUP BY 1 ORDER BY 1",columns:{status:'inboundStatus',n:'count'}},
});

export class SnapshotSanitizerError extends Error{
  constructor(reason){super(`SNAPSHOT_SANITIZER_${reason}`);this.name='SnapshotSanitizerError';}
}

/** Returns the rows if every column is allowlisted for this query and every
 * value matches its kind; otherwise throws without echoing the value. */
export function sanitizeRows(queryName,rows){
  const spec=QUERIES[queryName];
  if(!spec)throw new SnapshotSanitizerError('UNKNOWN_QUERY');
  if(!Array.isArray(rows))throw new SnapshotSanitizerError('NOT_ROWS');
  if(rows.length>MAX_ROWS)throw new SnapshotSanitizerError('TOO_MANY_ROWS');
  const allowed=Object.keys(spec.columns);
  return rows.map(row=>{
    if(!row||typeof row!=='object'||Array.isArray(row))throw new SnapshotSanitizerError('NOT_OBJECT');
    const keys=Object.keys(row);
    if(keys.length!==allowed.length||keys.some(k=>!allowed.includes(k)))throw new SnapshotSanitizerError('COLUMNS');
    const out={};
    for(const key of allowed){if(!KINDS[spec.columns[key]](row[key]))throw new SnapshotSanitizerError('VALUE');out[key]=row[key];}
    return out;
  });
}

export function renderTable(title,rows){
  const lines=[`### ${title}`];
  if(!rows.length)return [...lines,'(no rows)',''];
  const keys=Object.keys(rows[0]);
  lines.push(`| ${keys.join(' | ')} |`,`|${keys.map(()=>'---').join('|')}|`);
  for(const row of rows)lines.push(`| ${keys.map(k=>String(row[k])).join(' | ')} |`);
  return [...lines,''];
}

export function pendingMigrations(applied,local){const done=new Set(applied);return local.filter(name=>!done.has(name));}
export function localMigrations(dir=fileURLToPath(new URL('../migrations/',import.meta.url))){return readdirSync(dir).filter(n=>KINDS.migration(n)).sort();}

/** A Cloudflare id is a UUID; anything else is withheld. */
export function safeVersionId(value){return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)?value:'WITHHELD';}
export function safePercentage(value){return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100?String(value):'WITHHELD';}

function wrangler(args){return execFileSync('npx',['wrangler',...args],{encoding:'utf8',stdio:['ignore','pipe','ignore'],maxBuffer:32*1024*1024});}

export function collect(run=wrangler,now=()=>new Date().toISOString(),local=localMigrations()){
  const out=['## Read-only Production snapshot',`- collected_at: ${now()}`,`- source_sha: ${/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA??'')?process.env.GITHUB_SHA:'unknown'}`,''];
  let applied=null;
  for(const [name,{sql}] of Object.entries(QUERIES)){
    try{
      const rows=sanitizeRows(name,JSON.parse(run(['d1','execute','malipang-v5-2','--remote','--json','--command',sql]))[0].results);
      if(name==='migrations_applied')applied=rows.map(r=>r.migration);
      out.push(...renderTable(name,rows));
    }catch(error){out.push(`### ${name}`,error instanceof SnapshotSanitizerError?error.message:'QUERY_FAILED','');}
  }
  out.push('### migrations_pending_in_this_commit');
  if(applied===null)out.push('UNKNOWN (applied list unavailable)','');
  else{const pending=pendingMigrations(applied,local);out.push(...(pending.length?pending.map(n=>`- ${n}`):['(none)']),'');}
  out.push('### worker_deployment');
  try{const status=JSON.parse(run(['deployments','status','--json']));out.push(...(status.versions??[]).map(v=>`- version ${safeVersionId(v.version_id)} at ${safePercentage(v.percentage)}%`),'');}
  catch{out.push('QUERY_FAILED','');}
  return out.join('\n')+'\n';
}

/** True when any section could not be read or was rejected by the sanitizer. */
export function snapshotIncomplete(text){return /^(QUERY_FAILED|SNAPSHOT_SANITIZER_[A-Z_]+|UNKNOWN \(applied list unavailable\))$/m.test(text);}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
  const text=collect();process.stdout.write(text);
  // Print what is safe, then fail the step so an incomplete snapshot is visible.
  if(snapshotIncomplete(text))process.exitCode=1;
}
