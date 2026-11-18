import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdtempSync,writeFileSync,chmodSync,existsSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sanitizeRows,SnapshotSanitizerError,QUERIES,collect,countBucket,workerVersionCheck,sha256Hex,pendingMigrations,localMigrations,snapshotIncomplete} from '../scripts/prod-ops-snapshot.mjs';

/** Strip migration file names, range labels and fixed program codes such as
 * GOOGLE_OAUTH_HTTP_429 (a status code, not Production data); nothing numeric may remain. */
const digitsOutsideAllowed=text=>text.replace(/\b\d{4}_[a-z0-9_]+\.sql\b/g,'').replace(/\| [A-Z][A-Z_]*_\d{3} \|/g,'| |').replace(/\| (0|1-9|10\+) \|/g,'| |').replace(/\bd1_migrations\b/g,'').match(/\d/g);

const reject=(query,rows,reason)=>assert.throws(()=>sanitizeRows(query,rows),e=>e instanceof SnapshotSanitizerError&&e.message===`SNAPSHOT_SANITIZER_${reason}`);
const code=c=>`CASE WHEN ${c} IS NULL THEN 'NONE' WHEN ${c} GLOB '*[^A-Z0-9_]*' OR ${c} GLOB '[^A-Z]*' OR length(${c})>64 THEN 'OTHER' ELSE ${c} END`;
const claimToken=a=>`CASE WHEN EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=${a}.spreadsheet_id AND c.operation_token=${a}.operation_token AND c.state='REVIEW') THEN 'REVIEW_CLAIM' ELSE 'OTHER' END`;

test('the snapshot SQL and column allowlists are pinned exactly',()=>{
  // Any change here is a change to what reaches a public log: review it.
  assert.deepEqual(JSON.parse(JSON.stringify(QUERIES)),{
    migrations_applied:{sql:'SELECT name AS migration FROM d1_migrations ORDER BY id',columns:{migration:'migration'}},
    tables:{sql:"SELECT name AS table_name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",columns:{table_name:'table'}},
    abnormal_sync_jobs:{sql:`SELECT entity_type,status,${code('last_error')} AS error_code,count(*) AS n FROM sync_jobs WHERE status IN ('FAILED','REVIEW') GROUP BY 1,2,3 ORDER BY 1,2,3`,columns:{entity_type:'entity',status:'jobStatus',error_code:'code',n:'count'}},
    open_failed_jobs:{sql:"SELECT count(*) AS n FROM failed_jobs WHERE status='OPEN'",columns:{n:'count'}},
    workbook_claims:{sql:`SELECT state,${code('phase')} AS phase,${code('review_reason')} AS reason,CASE WHEN notice_stamp IS NOT NULL AND notice_identity IS NOT NULL THEN 'YES' ELSE 'NO' END AS notice,count(*) AS n FROM stable_workbook_claims GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`,columns:{state:'claimState',phase:'code',reason:'code',notice:'yesNo',n:'count'},requires:['stable_workbook_claims']},
    abnormal_inbound:{sql:"SELECT status,count(*) AS n FROM inbound_events WHERE status IN ('FAILED','REVIEW') GROUP BY 1 ORDER BY 1",columns:{status:'inboundStatus',n:'count'}},
    recovery_epochs:{sql:"SELECT state,count(*) AS n FROM stable_recovery_epochs GROUP BY 1 ORDER BY 1",columns:{state:'epochState',n:'count'},requires:['stable_recovery_epochs']},
    processing_sync_jobs:{sql:"SELECT count(*) AS n FROM sync_jobs WHERE status='PROCESSING'",columns:{n:'count'}},
    processing_staff_outbox:{sql:"SELECT count(*) AS n FROM staff_config_sync_outbox WHERE status='PROCESSING'",columns:{n:'count'},requires:['staff_config_sync_outbox']},
    projection_writes:{sql:`SELECT p.state,${claimToken('p')} AS token_scope,count(*) AS n FROM stable_projection_writes p GROUP BY 1,2 ORDER BY 1,2`,columns:{state:'writeState',token_scope:'tokenScope',n:'count'},requires:['stable_projection_writes','stable_workbook_claims']},
    cancellation_writes:{sql:`SELECT p.state,${claimToken('p')} AS token_scope,count(*) AS n FROM stable_expense_cancellation_writes p GROUP BY 1,2 ORDER BY 1,2`,columns:{state:'writeState',token_scope:'tokenScope',n:'count'},requires:['stable_expense_cancellation_writes','stable_workbook_claims']},
    recovery_operations:{sql:"SELECT o.state,CASE WHEN EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.operation_token=o.operation_token AND c.state='REVIEW') THEN 'REVIEW_CLAIM' ELSE 'OTHER' END AS token_scope,count(*) AS n FROM stable_recovery_operations o GROUP BY 1,2 ORDER BY 1,2",columns:{state:'recoveryOpState',token_scope:'tokenScope',n:'count'},requires:['stable_recovery_operations','stable_workbook_claims']},
    cutover_operator:{sql:"SELECT state,count(*) AS n FROM continuous_cutover_operator GROUP BY 1 ORDER BY 1",columns:{state:'operatorState',n:'count'},requires:['continuous_cutover_operator']},
    report_cutover_attempts:{sql:"SELECT stage,state,count(*) AS n FROM continuous_report_cutover_attempts GROUP BY 1,2 ORDER BY 1,2",columns:{stage:'reportStage',state:'writeState',n:'count'},requires:['continuous_report_cutover_attempts']},
  });
  assert.equal(Object.isFrozen(QUERIES),true);
});

test('snapshot SQL reads no amount, identifier, description, normal-work count or date',()=>{
  const sql=Object.values(QUERIES).map(q=>q.sql).join('\n').toLowerCase();
  for(const word of ['amount','satang','description','line_user_id','expense_id','message_id','entity_key','trace_id','sum(','updated_at','created_at','expense_events',"'completed'","'pending'",'159725','166800'])assert.equal(sql.includes(word),false,word);
});

test('sanitizer accepts only the allowlisted columns and value kinds for each query',()=>{
  const rows=[{entity_type:'EXPENSE',status:'REVIEW',error_code:'STABLE_SYNC_REVIEW',n:1}];
  assert.deepEqual(sanitizeRows('abnormal_sync_jobs',rows),rows);
  assert.deepEqual(sanitizeRows('migrations_applied',[{migration:'0023_stable_recovery_admission.sql'}]),[{migration:'0023_stable_recovery_admission.sql'}]);
  reject('nope',[],'UNKNOWN_QUERY');
});

test('sanitizer blocks the bypasses found in review',()=>{
  // An amount aliased as a count column of another query, or an extra column.
  reject('abnormal_sync_jobs',[{entity_type:'EXPENSE',status:'REVIEW',error_code:'NONE',n:1,amount_n:159725}],'COLUMNS');
  reject('open_failed_jobs',[{total_n:5}],'COLUMNS');
  // An id or amount returned under an allowed name.
  reject('migrations_applied',[{migration:'12'}],'VALUE');
  reject('migrations_applied',[{migration:159725}],'VALUE');
  reject('tables',[{table_name:'exp_0123'.toUpperCase()}],'VALUE');
  // A per-row date under any column.
  reject('abnormal_inbound',[{status:'2026-11-16',n:1}],'VALUE');
  // Free upper-case text where a fixed status set is required.
  reject('abnormal_sync_jobs',[{entity_type:'SYNTHETIC_STORE_NAME',status:'REVIEW',error_code:'NONE',n:1}],'VALUE');
  reject('abnormal_sync_jobs',[{entity_type:'EXPENSE',status:'COMPLETED',error_code:'NONE',n:1}],'VALUE');
  reject('workbook_claims',[{state:'REVIEW',phase:'OPERATION',reason:'1597',notice:'YES',n:1}],'VALUE');
  reject('workbook_claims',[{state:'REVIEW',phase:'OPERATION',reason:'NONE',notice:'synthetic-stamp',n:1}],'VALUE');
  reject('workbook_claims',[{state:'REVIEW',phase:'OPERATION',reason:'NONE',notice:'YES',n:1,operation_token:'tok'}],'COLUMNS');
  // A token, entity id or free state where a fixed set is required.
  reject('projection_writes',[{state:'VERIFIED',token_scope:'synthetic-token-0001',n:1}],'VALUE');
  reject('projection_writes',[{state:'exp_1',token_scope:'OTHER',n:1}],'VALUE');
  reject('cancellation_writes',[{state:'VERIFIED',token_scope:'OTHER',n:1,entity_id:'exp_1'}],'COLUMNS');
  reject('recovery_operations',[{state:'REVIEW',token_scope:'OTHER',n:1}],'VALUE');
  reject('cutover_operator',[{state:'DONE',n:1}],'VALUE');
  reject('report_cutover_attempts',[{stage:'VIEWS',state:'VERIFIED',n:1,manifest_digest:'a'}],'COLUMNS');
  reject('processing_sync_jobs',[{n:1,job_id:'j1'}],'COLUMNS');
  assert.deepEqual(sanitizeRows('cutover_operator',[{state:'RELEASING',n:1}]),[{state:'RELEASING',n:1}]);
  reject('recovery_epochs',[{state:'synthetic-epoch-0001',n:1}],'VALUE');reject('recovery_epochs',[{state:'ARMED',n:1,target_key:'exp_1'}],'COLUMNS');
  assert.deepEqual(sanitizeRows('recovery_epochs',[{state:'CLOSED',n:3}]),[{state:'CLOSED',n:3}]);
  reject('open_failed_jobs',[{n:-1}],'VALUE');reject('open_failed_jobs',[{n:1.5}],'VALUE');reject('open_failed_jobs',[{n:'7'}],'VALUE');
  reject('open_failed_jobs',[['x']],'NOT_OBJECT');reject('open_failed_jobs','rows','NOT_ROWS');
  reject('open_failed_jobs',Array.from({length:401},()=>({n:1})),'TOO_MANY_ROWS');
  try{sanitizeRows('workbook_claims',[{state:'REVIEW',phase:'OPERATION',reason:'secret value',notice:'YES',n:1}]);assert.fail('should throw');}catch(e){assert.equal(String(e.message).includes('secret'),false);}
});

test('pending migrations are those in this commit that D1 has not applied',()=>{
  assert.deepEqual(pendingMigrations(['0001_a.sql','0002_b.sql'],['0001_a.sql','0002_b.sql','0003_c.sql']),['0003_c.sql']);
  const local=localMigrations();assert.ok(local.length>0);assert.equal(local.every(n=>/^\d{4}_[a-z0-9_]+\.sql$/.test(n)),true);
});

test('counts become range labels and the Worker id is only compared',()=>{
  assert.deepEqual([0,1,9,10,9999].map(countBucket),['0','1-9','1-9','10+','10+']);
  assert.throws(()=>countBucket(-1));assert.throws(()=>countBucket(1.5));
  const id='d0000000-0000-4000-8000-000000000000',other='e0000000-0000-4000-8000-000000000000',h=sha256Hex(id);
  assert.match(h,/^[0-9a-f]{64}$/);assert.notEqual(h,id);
  assert.equal(workerVersionCheck({versions:[{version_id:id,percentage:100}]},h),'MATCH');
  assert.equal(workerVersionCheck({versions:[{version_id:id,percentage:90},{version_id:other,percentage:10}]},h),'MISMATCH');
  assert.equal(workerVersionCheck({versions:[{version_id:other,percentage:100}]},h),'MISMATCH');
  assert.equal(workerVersionCheck({versions:[]},''),'NOT_CHECKED');
  // The raw id is not accepted as the expected value.
  assert.equal(workerVersionCheck({versions:[{version_id:id,percentage:100}]},id),'INVALID_EXPECTED');
  assert.equal(workerVersionCheck({},'A'.repeat(64)),'INVALID_EXPECTED');
});

const ALL_TABLES=['d1_migrations','sync_jobs','failed_jobs','inbound_events','stable_workbook_claims','stable_recovery_epochs','staff_config_sync_outbox','stable_projection_writes','stable_expense_cancellation_writes','stable_recovery_operations','continuous_cutover_operator','continuous_report_cutover_attempts'];

test('a section whose table is missing prints TABLE_ABSENT without running its query',()=>{
  const ran=[];
  const run=present=>args=>{const sql=args.at(-1);ran.push(sql);
    if(sql.includes('sqlite_master'))return present===null?'not json':JSON.stringify([{results:present.map(table_name=>({table_name}))}]);
    if(sql.includes('d1_migrations'))return JSON.stringify([{results:[]}]);
    return JSON.stringify([{results:sql.startsWith('SELECT count(*)')?[{n:0}]:[]}]);};
  const text=collect(run(ALL_TABLES.filter(t=>!['continuous_cutover_operator','stable_expense_cancellation_writes'].includes(t))),'',[]);
  assert.match(text,/### cutover_operator\nTABLE_ABSENT/);assert.match(text,/### cancellation_writes\nTABLE_ABSENT/);
  assert.equal(ran.some(s=>s.includes('FROM continuous_cutover_operator')||s.includes('FROM stable_expense_cancellation_writes')),false);
  assert.match(text,/### recovery_epochs\n\(no rows\)/);
  // Absence is a state of the database, not an incomplete snapshot.
  assert.equal(snapshotIncomplete(text),false);
  // Without a table list, absence is not assumed: the query runs.
  ran.length=0;const unknown=collect(run(null),'',[]);
  assert.match(unknown,/### tables\nQUERY_FAILED/);assert.equal(unknown.includes('TABLE_ABSENT'),false);
  assert.equal(ran.some(s=>s.includes('FROM continuous_cutover_operator')),true);
});

test('every snapshot query runs on the schema the migrations build and classifies claim tokens',()=>{
  const dir=new URL('../migrations/',import.meta.url),names=readdirSync(dir).filter(n=>/^\d{4}_.*\.sql$/.test(n)).sort();
  const build=upto=>{const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE)');for(const n of names.filter(n=>Number(n.slice(0,4))<=upto)){db.exec(readFileSync(new URL(n,dir),'utf8'));db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(n);}return db;};
  const runOn=db=>args=>args[0]==='deployments'?'{}':JSON.stringify([{results:db.prepare(args.at(-1)).all().map(r=>({...r}))}]);
  const db=build(9999),digest='a'.repeat(64);
  db.exec(`INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,notice_stamp,notice_identity,created_at,updated_at,phase,review_reason) VALUES('sheet-synthetic','tok-review','REVIEW','stamp','identity','now','now','OPERATION','STABLE_DAILY_REVIEW');
INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-synthetic','sheet-synthetic','COMPLETE','EXPENSE','e0',1,'now','now');
INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at,verified_at) VALUES('tok-review','epoch-synthetic','ADMITTED','now',NULL),('tok-other','epoch-synthetic','VERIFIED','now','now');`);
  const text=collect(runOn(db),'',names);
  assert.equal(snapshotIncomplete(text),false,text);assert.equal(text.includes('TABLE_ABSENT'),false,text);
  assert.match(text,/### recovery_operations\n\| state \| token_scope \| n \|\n\|---\|---\|---\|\n\| ADMITTED \| REVIEW_CLAIM \| 1-9 \|\n\| VERIFIED \| OTHER \| 1-9 \|/);
  assert.match(text,/\| REVIEW \| OPERATION \| STABLE_DAILY_REVIEW \| YES \| 1-9 \|/);
  assert.match(text,/### migrations_pending_in_this_commit\n\(none\)/);
  assert.equal(digitsOutsideAllowed(text),null,text);
  assert.equal(text.includes('tok-'),false);assert.equal(text.includes('sheet-synthetic'),false);assert.equal(text.includes(digest),false);
  // Production's ledger before the continuous tables: those sections are absent, the rest still read.
  const early=collect(runOn(build(23)),'',names);
  for(const name of ['cancellation_writes','cutover_operator','report_cutover_attempts'])assert.match(early,new RegExp(`### ${name}\\nTABLE_ABSENT`));
  assert.match(early,/### recovery_epochs\n\(no rows\)/);assert.match(early,/### projection_writes\n\(no rows\)/);
  assert.equal(snapshotIncomplete(early),false,early);
});

test('collect output has no Production numbers: only migration names and range labels',()=>{
  const calls=[],id='d0000000-0000-4000-8000-000000000000';
  const run=args=>{calls.push(args);
    if(args[0]==='deployments')return JSON.stringify({versions:[{version_id:id,percentage:100}]});
    const sql=args.at(-1);
    if(sql.includes('d1_migrations'))return JSON.stringify([{results:[{migration:'0001_a.sql'},{migration:'0023_stable_recovery_admission.sql'}]}]);
    if(sql.includes('sqlite_master'))return JSON.stringify([{results:ALL_TABLES.map(table_name=>({table_name}))}]);
    if(sql.includes("status='PROCESSING'"))return JSON.stringify([{results:[{n:0}]}]);
    if(sql.includes('FROM stable_projection_writes'))return JSON.stringify([{results:[{state:'IN_FLIGHT',token_scope:'REVIEW_CLAIM',n:2},{state:'VERIFIED',token_scope:'OTHER',n:40}]}]);
    if(sql.includes('FROM stable_recovery_operations'))return JSON.stringify([{results:[{state:'VERIFIED',token_scope:'OTHER',n:11}]}]);
    if(/FROM (stable_expense_cancellation_writes|continuous_cutover_operator|continuous_report_cutover_attempts)/.test(sql))return JSON.stringify([{results:[]}]);
    if(sql.includes('sync_jobs'))return JSON.stringify([{results:[{entity_type:'EXPENSE',status:'REVIEW',error_code:'STABLE_SYNC_REVIEW',n:13},{entity_type:'ATTENDANCE_EVENT',status:'FAILED',error_code:'NONE',n:4},{entity_type:'DAILY_PAYROLL',status:'FAILED',error_code:'GOOGLE_OAUTH_HTTP_429',n:37}]}]);
    if(sql.includes('failed_jobs'))return JSON.stringify([{results:[{n:22}]}]);
    if(sql.includes('FROM stable_workbook_claims'))return JSON.stringify([{results:[{state:'REVIEW',phase:'OPERATION',reason:'STABLE_DAILY_REVIEW',notice:'YES',n:1}]}]);
    if(sql.includes('stable_recovery_epochs'))return JSON.stringify([{results:[{state:'CLOSED',n:12},{state:'REVIEW',n:1}]}]);
    return JSON.stringify([{results:[{status:'FAILED',n:0}]}]);};
  const text=collect(run,sha256Hex(id),['0001_a.sql','0023_stable_recovery_admission.sql','0024_next.sql']);
  assert.equal(digitsOutsideAllowed(text),null,text);
  assert.match(text,/\| EXPENSE \| REVIEW \| STABLE_SYNC_REVIEW \| 10\+ \|/);assert.match(text,/\| ATTENDANCE_EVENT \| FAILED \| NONE \| 1-9 \|/);assert.match(text,/\| DAILY_PAYROLL \| FAILED \| GOOGLE_OAUTH_HTTP_429 \| 10\+ \|/);assert.equal(text.includes('37'),false);
  assert.match(text,/### open_failed_jobs\n\| n \|\n\|---\|\n\| 10\+ \|/);
  assert.match(text,/### recovery_epochs\n\| state \| n \|\n\|---\|---\|\n\| CLOSED \| 10\+ \|\n\| REVIEW \| 1-9 \|/);
  assert.match(text,/### workbook_claims\n\| state \| phase \| reason \| notice \| n \|\n\|---\|---\|---\|---\|---\|\n\| REVIEW \| OPERATION \| STABLE_DAILY_REVIEW \| YES \| 1-9 \|/);
  assert.match(text,/### processing_sync_jobs\n\| n \|\n\|---\|\n\| 0 \|/);
  assert.match(text,/### projection_writes\n\| state \| token_scope \| n \|\n\|---\|---\|---\|\n\| IN_FLIGHT \| REVIEW_CLAIM \| 1-9 \|\n\| VERIFIED \| OTHER \| 10\+ \|/);
  assert.match(text,/### cutover_operator\n\(no rows\)/);assert.equal(text.includes('TABLE_ABSENT'),false);
  assert.match(text,/### migrations_pending_in_this_commit\n- 0024_next\.sql/);
  assert.match(text,/### worker_version\nMATCH/);assert.equal(text.includes(id),false);assert.equal(text.includes(sha256Hex(id)),false);
  assert.match(collect(run,id,[]),/### worker_version\nINVALID_EXPECTED/);
  assert.equal(snapshotIncomplete(text),false);
  assert.equal(calls.every(a=>a[0]==='deployments'||a.includes('--remote')&&a.includes('--json')),true);
  assert.equal(calls.some(a=>a.includes('apply')),false);
  // No expected id: the deployment API is not called and nothing is echoed.
  const before=calls.length;const unchecked=collect(run,'',['0001_a.sql','0023_stable_recovery_admission.sql']);
  assert.match(unchecked,/### worker_version\nNOT_CHECKED/);assert.equal(calls.slice(before).some(a=>a[0]==='deployments'),false);
  // A rejected section is replaced by a code and marks the snapshot incomplete.
  const bad=collect(a=>a[0]==='deployments'?'{}':a.at(-1).includes('inbound_events')?JSON.stringify([{results:[{status:'FAILED',n:2,amount_satang:999}]}]):'[{"results":[]}]','',[]);
  assert.match(bad,/### abnormal_inbound\nSNAPSHOT_SANITIZER_COLUMNS/);assert.equal(bad.includes('999'),false);assert.equal(snapshotIncomplete(bad),true);
});

test('ops workflow is manual-only, main-only, gated, pinned and scopes the token to wrangler steps',()=>{
  const wf=readFileSync(new URL('../.github/workflows/prod-ops-readonly.yml',import.meta.url),'utf8');
  const on=wf.slice(wf.indexOf('\non:'),wf.indexOf('\npermissions:'));
  assert.match(on,/workflow_dispatch:/);assert.doesNotMatch(on,/\n {2}(push|pull_request|schedule|workflow_run):/);
  assert.match(wf,/if: github\.ref == 'refs\/heads\/main'/);assert.match(wf,/environment: production/);
  // Same group as the release workflow: an export blocks D1 and must never overlap a migrate or deploy.
  assert.match(wf,/concurrency:\n {2}group: malipang-release-control\n {2}cancel-in-progress: false/);
  assert.match(readFileSync(new URL('../.github/workflows/prod-release-migrate-deploy.yml',import.meta.url),'utf8'),/concurrency:\n {2}group: malipang-release-control\n {2}cancel-in-progress: false/);
  assert.match(wf,/npm ci --ignore-scripts/);assert.match(wf,/persist-credentials: false/);
  for(const line of wf.split('\n').filter(l=>/uses:/.test(l)))assert.match(line,/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/,line);
  const job=wf.slice(wf.indexOf('\n  ops:'),wf.indexOf('\n    steps:'));
  assert.doesNotMatch(job,/CLOUDFLARE_/,'token must not be set at job level');
  const steps=wf.split('\n      - ').slice(1);
  for(const step of steps){
    const usesToken=/CLOUDFLARE_API_TOKEN/.test(step),runsWrangler=/prod-ops-(snapshot|backup-rehearsal)/.test(step);
    assert.equal(usesToken,runsWrangler,step.split('\n')[0]);
    if(/run: .*\|/.test(step))assert.match(step,/shell: bash/,`piped step needs pipefail: ${step.split('\n')[0]}`);
  }
  assert.match(wf,/\[ "\$EXPECTED_SHA" = "\$GITHUB_SHA" \]/);assert.match(wf,/READ PRODUCTION \$\{EXPECTED_SHA:0:7\}/);assert.match(wf,/WRITE BACKUP/);
  assert.doesNotMatch(wf,/wrangler (deploy|d1 migrations apply|versions deploy|rollback)/);
  assert.match(wf,/blocks other database requests/);assert.match(wf,/EXPECTED_WORKER_VERSION_SHA256/);
  // Every input reaches an env block printed in the public log: only non-sensitive ones are allowed.
  const inputs=[...wf.slice(wf.indexOf('    inputs:'),wf.indexOf('\npermissions:')).matchAll(/^ {6}([a-z_0-9]+):$/gm)].map(m=>m[1]);
  assert.deepEqual(inputs,['operation','expected_sha','confirmation','write_backup','expected_worker_version_sha256']);
  assert.doesNotMatch(wf,/expected_worker_version[^_]/);
  for(const step of wf.split('\n      - ').slice(1))assert.doesNotMatch(step,/inputs\.expected_worker_version\b(?!_sha256)/,'no raw Worker id input in any step env');
});

const hasSqlite=spawnSync('sqlite3',['-version']).status===0;
test('rehearsal skips R2 unless explicitly enabled, restores the copy and passes all smoke inserts',{skip:!hasSqlite&&'sqlite3 not installed'},()=>{
  const dir=mkdtempSync(join(tmpdir(),'ops-rehearsal-')),bin=join(dir,'bin'),rt=join(dir,'rt'),seed=join(dir,'seed.sqlite'),log=join(dir,'npx.log');
  try{
    execFileSync('mkdir',['-p',bin,rt]);
    execFileSync('sqlite3',[seed,'CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);']);
    const migrations=readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>/^\d{4}_.*\.sql$/.test(f)).sort();
    for(const f of migrations.filter(f=>Number(f.slice(0,4))<=23)){execFileSync('sqlite3',[seed],{input:readFileSync(new URL(`../migrations/${f}`,import.meta.url))});execFileSync('sqlite3',[seed,`INSERT INTO d1_migrations(name) VALUES('${f}')`]);}
    execFileSync('sqlite3',[seed,`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('e1','m1','u','synthetic',100,'transfer','SHOP_BANK','c','2026-11-15','CONFIRMED','2026-11-15',1);
INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,created_at) VALUES('d1','dm1','u','RECEIPT','CONFIRMED','2026-11-15');
INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('j1','EXPENSE','e1',1,'t','PENDING','now');
INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,created_at,updated_at) VALUES('f1','malipang-jobs','t','EXPENSE:e1:1','{}','X','OPEN','now','now');
INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at,phase,review_reason) VALUES('book','tok','REVIEW','now','now','OPERATION','STABLE_DAILY_REVIEW');
INSERT INTO stable_projection_writes VALUES('book','EXPENSE','e0','DAILY',1,'daily',1,'${'a'.repeat(64)}','tok','VERIFIED','now');`]);
    writeFileSync(join(bin,'npx'),`#!/bin/bash\necho "$*" >> '${log}'\nfor a in "$@"; do case $a in --output=*) sqlite3 '${seed}' .dump > "\${a#--output=}";; esac; done\n`);
    if(spawnSync('sha256sum',['--version']).status!==0)writeFileSync(join(bin,'sha256sum'),'#!/bin/bash\nshasum -a 256 "$@"\n');
    if(spawnSync('stat',['-c','%s','/dev/null']).status!==0)writeFileSync(join(bin,'stat'),'#!/bin/bash\n/usr/bin/stat -f %z "$3"\n');
    for(const f of ['npx','sha256sum','stat'])if(existsSync(join(bin,f)))chmodSync(join(bin,f),0o755);
    const run=extra=>spawnSync('bash',[new URL('../scripts/prod-ops-backup-rehearsal.sh',import.meta.url).pathname],{encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`,RUNNER_TEMP:rt,CLOUDFLARE_ACCOUNT_ID:'synthetic',CLOUDFLARE_API_TOKEN:'synthetic',GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'0'.repeat(40),...extra}});
    const r=run({});
    assert.equal(r.status,0,r.stdout+r.stderr);
    assert.match(r.stdout,/backup_upload: SKIPPED/);assert.match(r.stdout,/integrity_after: PASS/);assert.match(r.stdout,/foreign_keys_after: PASS/);
    assert.doesNotMatch(r.stdout,/smoke_[a-z_A-Z]+: FAIL/);assert.match(r.stdout,/smoke_failed_job_insert: PASS/);
    assert.equal(digitsOutsideAllowed(r.stdout),null,r.stdout);assert.match(r.stdout,/migrations_applied_on_copy: 0024_/);assert.match(r.stdout,/preexisting_rows_unchanged: PASS/);assert.match(r.stdout,/smoke_all: PASS/);
    assert.equal(readFileSync(log,'utf8').includes('r2 object'),false,'no R2 call without the flag');
    assert.equal(r.stdout.includes('synthetic'),false,'row data never printed');
    assert.deepEqual(readdirSync(rt),[],'all dumps and scratch files removed on success');
    assert.equal(run({BACKUP_TO_R2:'yes'}).status,1);
    // A failure midway (restore of an unreadable dump) still removes every file.
    writeFileSync(join(bin,'npx'),`#!/bin/bash\nfor a in "$@"; do case $a in --output=*) echo 'not sql' > "\${a#--output=}";; esac; done\n`);chmodSync(join(bin,'npx'),0o755);
    const broken=spawnSync('bash',[new URL('../scripts/prod-ops-backup-rehearsal.sh',import.meta.url).pathname],{encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`,RUNNER_TEMP:rt,CLOUDFLARE_ACCOUNT_ID:'synthetic',CLOUDFLARE_API_TOKEN:'synthetic',GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'0'.repeat(40)}});
    assert.notEqual(broken.status,0);assert.deepEqual(readdirSync(rt),[],'all files removed after a failure');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
