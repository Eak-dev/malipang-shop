// Read-only Production snapshot for operators. The repository is public, so
// everything this prints must be safe for a public Actions log:
//  - numbers only in count columns (`n` or names ending in `_n`/`_count`)
//  - text only as short upper-case codes, schema/migration names or ISO days
//  - no amounts, descriptions, identifiers, user IDs or raw provider output
// Every query below is aggregate-only; sanitizeRows() enforces the rule again
// so a future query cannot leak a value by accident.
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const COUNT_COLUMN=/^(n|[a-z][a-z0-9_]*_(n|count))$/;
const DAY_COLUMN=/^[a-z][a-z0-9_]*_day$/;
const NAME_COLUMN=/^(name|migration|table_name)$/;
const CODE=/^[A-Z][A-Z0-9_]{0,63}$/;
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const SCHEMA_NAME=/^[a-z0-9_]{1,64}(\.sql)?$/;
const MAX_ROWS=400;

export class SnapshotSanitizerError extends Error{
  constructor(reason){super(`SNAPSHOT_SANITIZER_${reason}`);this.name='SnapshotSanitizerError';}
}

/** Returns rows with only safe cells, or throws. Never returns the offending value. */
export function sanitizeRows(rows){
  if(!Array.isArray(rows))throw new SnapshotSanitizerError('NOT_ROWS');
  if(rows.length>MAX_ROWS)throw new SnapshotSanitizerError('TOO_MANY_ROWS');
  return rows.map(row=>{
    if(!row||typeof row!=='object'||Array.isArray(row))throw new SnapshotSanitizerError('NOT_OBJECT');
    const out={};
    for(const [key,value] of Object.entries(row)){
      if(!/^[a-z][a-z0-9_]{0,40}$/.test(key))throw new SnapshotSanitizerError('COLUMN_NAME');
      if(COUNT_COLUMN.test(key)){
        if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new SnapshotSanitizerError('COUNT_VALUE');
        out[key]=value;
      }else if(typeof value==='number'){
        throw new SnapshotSanitizerError('NUMBER_OUTSIDE_COUNT');
      }else if(value===null){
        out[key]=null;
      }else if(typeof value!=='string'){
        throw new SnapshotSanitizerError('VALUE_TYPE');
      }else if(DAY_COLUMN.test(key)){
        if(!DAY.test(value))throw new SnapshotSanitizerError('DAY_VALUE');
        out[key]=value;
      }else if(NAME_COLUMN.test(key)){
        if(!SCHEMA_NAME.test(value))throw new SnapshotSanitizerError('NAME_VALUE');
        out[key]=value;
      }else{
        if(!CODE.test(value))throw new SnapshotSanitizerError('CODE_VALUE');
        out[key]=value;
      }
    }
    return out;
  });
}

export function renderTable(title,rows){
  const lines=[`### ${title}`];
  if(!rows.length)return [...lines,'(no rows)',''];
  const keys=Object.keys(rows[0]);
  lines.push(`| ${keys.join(' | ')} |`,`|${keys.map(()=>'---').join('|')}|`);
  for(const row of rows)lines.push(`| ${keys.map(k=>row[k]===null||row[k]===undefined?'-':String(row[k])).join(' | ')} |`);
  return [...lines,''];
}

/** A Cloudflare id is a UUID; anything else is withheld. */
export function safeVersionId(value){return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)?value:'WITHHELD';}
export function safePercentage(value){return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100?String(value):'WITHHELD';}

const errorCode="CASE WHEN last_error IS NULL THEN 'NONE' WHEN last_error GLOB '*[^A-Z0-9_]*' OR last_error GLOB '[^A-Z]*' THEN 'OTHER' ELSE substr(last_error,1,64) END";
export const QUERIES=[
  ['migrations','SELECT name FROM d1_migrations ORDER BY id'],
  ['workbook_claims',"SELECT state,coalesce(phase,'NONE') AS phase,CASE WHEN review_reason IS NULL THEN 'NONE' WHEN review_reason GLOB '*[^A-Z0-9_]*' OR review_reason GLOB '[^A-Z]*' THEN 'OTHER' ELSE substr(review_reason,1,64) END AS reason,count(*) AS n FROM stable_workbook_claims GROUP BY 1,2,3"],
  ['sync_jobs_open',`SELECT entity_type,status,${errorCode} AS error_code,count(*) AS n,substr(min(updated_at),1,10) AS oldest_day,substr(max(updated_at),1,10) AS newest_day FROM sync_jobs WHERE status<>'COMPLETED' GROUP BY 1,2,3 ORDER BY 1,2,3`],
  ['sync_jobs_completed',"SELECT entity_type,count(*) AS n,substr(max(updated_at),1,10) AS newest_day FROM sync_jobs WHERE status='COMPLETED' GROUP BY 1"],
  ['failed_jobs',"SELECT status,count(*) AS n FROM failed_jobs GROUP BY 1"],
  ['inbound_events',"SELECT status,count(*) AS n FROM inbound_events GROUP BY 1"],
  ['expense_status',"SELECT status,count(*) AS n FROM expense_events GROUP BY 1"],
];

function wrangler(args){return execFileSync('npx',['wrangler',...args],{encoding:'utf8',stdio:['ignore','pipe','ignore'],maxBuffer:32*1024*1024});}

export function collect(run=wrangler,now=()=>new Date().toISOString()){
  const out=['## Read-only Production snapshot',`- collected_at: ${now()}`,`- source_sha: ${/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA??'')?process.env.GITHUB_SHA:'unknown'}`,''];
  for(const [name,sql] of QUERIES){
    try{out.push(...renderTable(name,sanitizeRows(JSON.parse(run(['d1','execute','malipang-v5-2','--remote','--json','--command',sql]))[0].results)));}
    catch(error){out.push(`### ${name}`,error instanceof SnapshotSanitizerError?error.message:'QUERY_FAILED','');}
  }
  out.push('### worker_deployment');
  try{const status=JSON.parse(run(['deployments','status','--json']));out.push(...(status.versions??[]).map(v=>`- version ${safeVersionId(v.version_id)} at ${safePercentage(v.percentage)}%`),'');}
  catch{out.push('QUERY_FAILED','');}
  return out.join('\n')+'\n';
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href)process.stdout.write(collect());
