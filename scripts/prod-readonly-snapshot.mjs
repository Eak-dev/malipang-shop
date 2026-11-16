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
 ['claim_detail',"SELECT state,coalesce(phase,'-') AS phase,CASE WHEN review_reason IS NULL THEN '-' WHEN review_reason GLOB '*[^A-Z0-9_]*' THEN 'OTHER' ELSE review_reason END AS review_reason,substr(created_at,1,16) AS created_min,substr(updated_at,1,16) AS updated_min FROM stable_workbook_claims"],
 ['cutover',"SELECT state,coalesce(substr(activated_at,1,16),'-') AS activated_min FROM stable_sync_cutover"],
 ['projection_writes',"SELECT projection,state,count(*) AS n,substr(max(updated_at),1,10) AS newest_day FROM stable_projection_writes GROUP BY 1,2"],
 ['pre_cutover_sources',"SELECT entity_type,count(*) AS n FROM stable_pre_cutover_sources GROUP BY 1"],
 ['recovery_tables',"SELECT (SELECT count(*) FROM stable_recovery_epochs) AS epochs,(SELECT count(*) FROM stable_recovery_operations) AS operations,(SELECT count(*) FROM stable_sheet_busy_backoffs) AS backoffs"],
 ['expense_recent_by_channel',"SELECT substr(created_at,1,10) AS day,CASE WHEN message_id GLOB '[0-9]*' THEN 'LINE_NUMERIC' WHEN substr(message_id,1,4) GLOB '*[^a-zA-Z_]*' THEN 'MIXED' ELSE substr(message_id,1,4) END AS id_kind,status,count(*) AS n,sum(amount_satang) AS total_satang FROM expense_events WHERE created_at>='2026-11-10' GROUP BY 1,2,3 ORDER BY 1,2,3"],
 ['expense_jobs_open',`SELECT j.status,j.entity_version,e.status AS expense_status,substr(j.updated_at,1,10) AS day,${code.replaceAll('last_error','j.last_error')} AS error_code,count(*) AS n,sum(j.attempt_count) AS attempts FROM sync_jobs j LEFT JOIN expense_events e ON e.expense_id=j.entity_key WHERE j.entity_type='EXPENSE' AND j.status<>'COMPLETED' GROUP BY 1,2,3,4,5 ORDER BY 4,1`],
 ['failed_open',"SELECT queue_name,substr(created_at,1,10) AS day,count(*) AS n FROM failed_jobs WHERE status='OPEN' GROUP BY 1,2 ORDER BY 2"],
 ['target_references',"SELECT e.amount_satang,(SELECT count(*) FROM expense_document_links l WHERE l.expense_id=e.expense_id) AS links,(SELECT count(*) FROM expense_document_cases c WHERE c.expense_id=e.expense_id) AS cases,(SELECT count(*) FROM expense_audit_log a WHERE a.expense_id=e.expense_id) AS audits,(SELECT count(*) FROM sheet_row_index r WHERE r.entity_key=e.expense_id) AS row_index,(SELECT count(*) FROM stable_projection_writes w WHERE w.entity_id=e.expense_id) AS projections,(SELECT count(*) FROM stable_pre_cutover_sources s WHERE s.entity_id=e.expense_id) AS pre_cutover,(SELECT count(*) FROM inbound_events i WHERE i.message_id=e.message_id) AS inbound,(SELECT count(*) FROM expense_document_links l2 WHERE l2.document_id IN (SELECT document_id FROM expense_document_links l3 WHERE l3.expense_id=e.expense_id) AND l2.expense_id<>e.expense_id) AS shared_doc_links FROM expense_events e WHERE e.amount_satang IN (159725,166800)"],
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
out.push('### queues');
for(const q of ['malipang-jobs','malipang-jobs-dlq','malipang-continuous-notice-phases']){
 try{
  const text=wrangler(['queues','info',q]);
  const nums=[...text.matchAll(/^\s*([A-Za-z ]{3,40}):\s*(\d+|true|false)\s*$/gm)].map(m=>`${m[1].trim().replaceAll(' ','_')}=${m[2]}`);
  out.push(`- ${q}: ${nums.length?nums.join(' '):'NO_NUMERIC_FIELDS'}`);
 }catch{out.push(`- ${q}: QUERY_FAILED`);}
}
out.push('');
out.push('### backups');
try{
 const info=JSON.parse(wrangler(['r2','bucket','info','malipang-private-backups','--json']));
 out.push(`- object_count: ${cell(Number(info.object_count??info.objectCount))}`,`- bucket_size: ${cell(String(info.bucket_size??info.payloadSize??'-').replaceAll(' ',''))}`,'');
}catch{out.push('QUERY_FAILED','');}
process.stdout.write(out.join('\n')+'\n');
