// Read-only Production snapshot. Emits aggregates only: every SELECT below
// returns counts, code constants or schema/migration names. Raw provider
// output and error text are never printed because the repository is public.
import {execFileSync} from 'node:child_process';

const SAFE=/^[A-Za-z0-9_.:\-]{1,80}$/;
const cell=v=>v===null||v===undefined?'-':typeof v==='number'&&Number.isFinite(v)?String(v):typeof v==='string'&&SAFE.test(v)?v:'REDACTED';
const wrangler=args=>execFileSync('npx',['wrangler',...args],{encoding:'utf8',stdio:['ignore','pipe','ignore'],maxBuffer:32*1024*1024});
const code="CASE WHEN last_error IS NULL THEN '-' WHEN last_error GLOB '*[^A-Z0-9_]*' THEN 'OTHER' ELSE last_error END";
const queries=[
 ['migrations','SELECT id,name FROM d1_migrations ORDER BY id'],
 ['tables',"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"],
 ['workbook_claims',"SELECT state,count(*) AS n FROM stable_workbook_claims GROUP BY state"],
 ['sync_jobs',`SELECT entity_type,status,${code} AS error_code,count(*) AS n,max(entity_version) AS max_version,substr(min(updated_at),1,10) AS oldest_day,substr(max(updated_at),1,10) AS newest_day FROM sync_jobs WHERE status NOT IN ('COMPLETED') GROUP BY 1,2,3 ORDER BY 1,2,3`],
 ['sync_jobs_completed',"SELECT entity_type,count(*) AS n,substr(max(updated_at),1,10) AS newest_day FROM sync_jobs WHERE status='COMPLETED' GROUP BY 1"],
 ['failed_jobs',"SELECT status,count(*) AS n FROM failed_jobs GROUP BY status"],
 ['inbound',"SELECT status,count(*) AS n FROM inbound_events GROUP BY status"],
 ['expense_status',"SELECT status,count(*) AS n,max(version) AS max_version FROM expense_events GROUP BY status"],
 ['target_amounts',"SELECT amount_satang,status,version,count(*) AS n,substr(max(coalesce(updated_at,created_at)),1,10) AS last_day FROM expense_events WHERE amount_satang IN (159725,166800) GROUP BY 1,2,3"],
 ['target_sync_jobs',`SELECT e.amount_satang,j.entity_version,j.status,${code.replaceAll('last_error','j.last_error')} AS error_code,count(*) AS n FROM sync_jobs j JOIN expense_events e ON e.expense_id=j.entity_key AND j.entity_type='EXPENSE' WHERE e.amount_satang IN (159725,166800) GROUP BY 1,2,3,4`],
];
const out=[`## Read-only Production snapshot`,`- Collected at: ${new Date().toISOString()}`,`- Source SHA: ${process.env.GITHUB_SHA??'unknown'}`,''];
for(const [name,sql] of queries){
 out.push(`### ${name}`);
 try{
  const rows=JSON.parse(wrangler(['d1','execute','malipang-v5-2','--remote','--json','--command',sql]))[0].results;
  if(!Array.isArray(rows)||rows.length>400)throw Error();
  if(!rows.length){out.push('(no rows)','');continue;}
  const keys=Object.keys(rows[0]).filter(k=>SAFE.test(k));
  out.push(`| ${keys.join(' | ')} |`,`|${keys.map(()=>'---').join('|')}|`,...rows.map(r=>`| ${keys.map(k=>cell(r[k])).join(' | ')} |`),'');
 }catch{out.push('QUERY_FAILED','');}
}
out.push('### worker_deployment');
try{
 const status=JSON.parse(wrangler(['deployments','status','--json']));
 out.push(`- created_on: ${cell(status.created_on)}`,`- source: ${cell(status.source)}`,...(status.versions??[]).map(v=>`- version ${cell(v.version_id)} at ${cell(v.percentage)}%`),'');
}catch{out.push('QUERY_FAILED','');}
out.push('### worker_versions_recent');
try{
 const versions=JSON.parse(wrangler(['versions','list','--json'])).slice(-6);
 out.push(...versions.map(v=>`- #${cell(v.number)} ${cell(v.id)} created ${cell(v.metadata?.created_on)} source ${cell(v.metadata?.source)} trigger ${cell(v.annotations?.['workers/triggered_by'])}`),'');
}catch{out.push('QUERY_FAILED','');}
process.stdout.write(out.join('\n')+'\n');
