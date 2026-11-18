// Read-only Production snapshot for operators. The repository is public, so
// the output carries no Production numbers at all:
//  - migration file names applied on D1 and still pending in this commit
//  - table names present in D1
//  - abnormal-work counts as range labels only: 0, 1-9 or 10+
//  - recovery epochs by state (range labels): START_REVIEW needs none ARMED/REVIEW
//  - the other START_REVIEW preconditions as states and range labels: work
//    PROCESSING, projection/cancellation writes and recovery operations (and
//    whether they carry the token of a REVIEW claim), cutover operator rows
//    and report cutover attempts. Counts cover every workbook, so they are
//    never looser than the per-workbook checks in the operator.
//  - TABLE_ABSENT when a section's table does not exist yet (migration not
//    applied); that is a state, not a failure.
//  - the live Worker version compared with an expected SHA-256 of its id:
//    MATCH, MISMATCH, NOT_CHECKED or INVALID_EXPECTED. Only the hash is an
//    input, because Actions prints each step's env block in the public log.
// Each query has a fixed column allowlist in QUERIES, sanitizeRows() rejects
// rows that do not match it, and tests pin the SQL and check the rendered
// output for digits. These checks narrow what a query can expose; they do not
// prove that a future change to QUERIES is safe, which still needs review.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
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
  // Mirrors the CHECK constraint on stable_recovery_epochs.state (migration 0023).
  epochState:v=>typeof v==='string'&&['ARMED','COMPLETE','REVIEW','CLOSED'].includes(v),
  // CHECK constraints: writes 0021/0024, report attempts 0029.
  writeState:v=>typeof v==='string'&&['IN_FLIGHT','VERIFIED','REVIEW'].includes(v),
  recoveryOpState:v=>typeof v==='string'&&['ADMITTED','VERIFIED'].includes(v),
  // CHECK constraint on continuous_cutover_operator.state (migration 0031).
  operatorState:v=>typeof v==='string'&&['STARTING','HELD','VIEWS','DAILY_J','REPORTS','ACTIVATING','RELEASING','REVIEW','COMPLETE'].includes(v),
  reportStage:v=>typeof v==='string'&&['VIEWS','REPORTS','DAILY_J'].includes(v),
  tokenScope:v=>typeof v==='string'&&['REVIEW_CLAIM','OTHER'].includes(v),
  yesNo:v=>typeof v==='string'&&['YES','NO'].includes(v),
};

const errorCode=col=>`CASE WHEN ${col} IS NULL THEN 'NONE' WHEN ${col} GLOB '*[^A-Z0-9_]*' OR ${col} GLOB '[^A-Z]*' OR length(${col})>64 THEN 'OTHER' ELSE ${col} END`;
// Whether a row carries the operation token of a workbook claim in REVIEW,
// without selecting the token itself.
const reviewToken=(alias,sameBook)=>`CASE WHEN EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE ${sameBook?`c.spreadsheet_id=${alias}.spreadsheet_id AND `:''}c.operation_token=${alias}.operation_token AND c.state='REVIEW') THEN 'REVIEW_CLAIM' ELSE 'OTHER' END`;
/** name → SQL, the exact columns it may return and the tables it needs
 * (missing tables print TABLE_ABSENT instead of running the query). */
export const QUERIES=Object.freeze({
  migrations_applied:{sql:'SELECT name AS migration FROM d1_migrations ORDER BY id',columns:{migration:'migration'}},
  tables:{sql:"SELECT name AS table_name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",columns:{table_name:'table'}},
  abnormal_sync_jobs:{sql:`SELECT entity_type,status,${errorCode('last_error')} AS error_code,count(*) AS n FROM sync_jobs WHERE status IN ('FAILED','REVIEW') GROUP BY 1,2,3 ORDER BY 1,2,3`,columns:{entity_type:'entity',status:'jobStatus',error_code:'code',n:'count'}},
  open_failed_jobs:{sql:"SELECT count(*) AS n FROM failed_jobs WHERE status='OPEN'",columns:{n:'count'}},
  workbook_claims:{sql:`SELECT state,${errorCode('phase')} AS phase,${errorCode('review_reason')} AS reason,CASE WHEN notice_stamp IS NOT NULL AND notice_identity IS NOT NULL THEN 'YES' ELSE 'NO' END AS notice,count(*) AS n FROM stable_workbook_claims GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`,columns:{state:'claimState',phase:'code',reason:'code',notice:'yesNo',n:'count'},requires:['stable_workbook_claims']},
  abnormal_inbound:{sql:"SELECT status,count(*) AS n FROM inbound_events WHERE status IN ('FAILED','REVIEW') GROUP BY 1 ORDER BY 1",columns:{status:'inboundStatus',n:'count'}},
  recovery_epochs:{sql:"SELECT state,count(*) AS n FROM stable_recovery_epochs GROUP BY 1 ORDER BY 1",columns:{state:'epochState',n:'count'},requires:['stable_recovery_epochs']},
  processing_sync_jobs:{sql:"SELECT count(*) AS n FROM sync_jobs WHERE status='PROCESSING'",columns:{n:'count'}},
  processing_staff_outbox:{sql:"SELECT count(*) AS n FROM staff_config_sync_outbox WHERE status='PROCESSING'",columns:{n:'count'},requires:['staff_config_sync_outbox']},
  projection_writes:{sql:`SELECT p.state,${reviewToken('p',true)} AS token_scope,count(*) AS n FROM stable_projection_writes p GROUP BY 1,2 ORDER BY 1,2`,columns:{state:'writeState',token_scope:'tokenScope',n:'count'},requires:['stable_projection_writes','stable_workbook_claims']},
  cancellation_writes:{sql:`SELECT p.state,${reviewToken('p',true)} AS token_scope,count(*) AS n FROM stable_expense_cancellation_writes p GROUP BY 1,2 ORDER BY 1,2`,columns:{state:'writeState',token_scope:'tokenScope',n:'count'},requires:['stable_expense_cancellation_writes','stable_workbook_claims']},
  recovery_operations:{sql:`SELECT o.state,${reviewToken('o',false)} AS token_scope,count(*) AS n FROM stable_recovery_operations o GROUP BY 1,2 ORDER BY 1,2`,columns:{state:'recoveryOpState',token_scope:'tokenScope',n:'count'},requires:['stable_recovery_operations','stable_workbook_claims']},
  cutover_operator:{sql:"SELECT state,count(*) AS n FROM continuous_cutover_operator GROUP BY 1 ORDER BY 1",columns:{state:'operatorState',n:'count'},requires:['continuous_cutover_operator']},
  report_cutover_attempts:{sql:"SELECT stage,state,count(*) AS n FROM continuous_report_cutover_attempts GROUP BY 1,2 ORDER BY 1,2",columns:{stage:'reportStage',state:'writeState',n:'count'},requires:['continuous_report_cutover_attempts']},
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

/** A count is never printed; only its range. */
export function countBucket(n){if(!Number.isSafeInteger(n)||n<0)throw new SnapshotSanitizerError('VALUE');return n===0?'0':n<10?'1-9':'10+';}

export function renderTable(queryName,rows){
  const lines=[`### ${queryName}`];
  if(!rows.length)return [...lines,'(no rows)',''];
  const columns=QUERIES[queryName].columns,keys=Object.keys(columns);
  lines.push(`| ${keys.join(' | ')} |`,`|${keys.map(()=>'---').join('|')}|`);
  for(const row of rows)lines.push(`| ${keys.map(k=>columns[k]==='count'?countBucket(row[k]):String(row[k])).join(' | ')} |`);
  return [...lines,''];
}

export function pendingMigrations(applied,local){const done=new Set(applied);return local.filter(name=>!done.has(name));}
export function localMigrations(dir=fileURLToPath(new URL('../migrations/',import.meta.url))){return readdirSync(dir).filter(n=>KINDS.migration(n)).sort();}

export const sha256Hex=value=>createHash('sha256').update(value,'utf8').digest('hex');
/** MATCH only when a single version serves 100% and the SHA-256 of its id
 * equals the expected hash. Neither the id nor the hash is printed. */
export function workerVersionCheck(status,expectedHash){
  if(!expectedHash)return 'NOT_CHECKED';
  if(!/^[0-9a-f]{64}$/.test(expectedHash))return 'INVALID_EXPECTED';
  const versions=Array.isArray(status?.versions)?status.versions:[],only=versions[0];
  return versions.length===1&&only?.percentage===100&&typeof only?.version_id==='string'&&sha256Hex(only.version_id)===expectedHash?'MATCH':'MISMATCH';
}

function wrangler(args){return execFileSync('npx',['wrangler',...args],{encoding:'utf8',stdio:['ignore','pipe','ignore'],maxBuffer:32*1024*1024});}

export function collect(run=wrangler,expectedWorker=process.env.EXPECTED_WORKER_VERSION_SHA256??'',local=localMigrations()){
  const out=['## Read-only Production snapshot',''];
  let applied=null,tables=null;
  for(const [name,{sql,requires=[]}] of Object.entries(QUERIES)){
    // Only a successful table list can prove absence; otherwise run the query.
    if(tables&&requires.some(t=>!tables.has(t))){out.push(`### ${name}`,'TABLE_ABSENT','');continue;}
    try{
      const rows=sanitizeRows(name,JSON.parse(run(['d1','execute','malipang-v5-2','--remote','--json','--command',sql]))[0].results);
      if(name==='migrations_applied')applied=rows.map(r=>r.migration);
      if(name==='tables')tables=new Set(rows.map(r=>r.table_name));
      out.push(...renderTable(name,rows));
    }catch(error){out.push(`### ${name}`,error instanceof SnapshotSanitizerError?error.message:'QUERY_FAILED','');}
  }
  out.push('### migrations_pending_in_this_commit');
  if(applied===null)out.push('UNKNOWN (applied list unavailable)','');
  else{const pending=pendingMigrations(applied,local);out.push(...(pending.length?pending.map(n=>`- ${n}`):['(none)']),'');}
  out.push('### worker_version');
  if(!expectedWorker)out.push('NOT_CHECKED','');
  else if(!/^[0-9a-f]{64}$/.test(expectedWorker))out.push('INVALID_EXPECTED','');
  else{try{out.push(workerVersionCheck(JSON.parse(run(['deployments','status','--json'])),expectedWorker),'');}catch{out.push('QUERY_FAILED','');}}
  return out.join('\n')+'\n';
}

/** True when any section could not be read or was rejected by the sanitizer. */
export function snapshotIncomplete(text){return /^(QUERY_FAILED|INVALID_EXPECTED|SNAPSHOT_SANITIZER_[A-Z_]+|UNKNOWN \(applied list unavailable\))$/m.test(text);}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
  const text=collect();process.stdout.write(text);
  // Print what is safe, then fail the step so an incomplete snapshot is visible.
  if(snapshotIncomplete(text))process.exitCode=1;
}
