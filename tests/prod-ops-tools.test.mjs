import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdtempSync,writeFileSync,chmodSync,existsSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sanitizeRows,SnapshotSanitizerError,QUERIES,collect,countBucket,workerVersionCheck,sha256Hex,pendingMigrations,localMigrations,snapshotIncomplete} from '../scripts/prod-ops-snapshot.mjs';

/** Strip migration file names, range labels and fixed program codes such as
 * GOOGLE_OAUTH_HTTP_429 (a status code, not Production data); nothing numeric may remain. */
const digitsOutsideAllowed=text=>text.replace(/\b\d{4}_[a-z0-9_]+\.sql\b/g,'').replace(/\| [A-Z][A-Z_]*_\d{3} \|/g,'| |').replace(/\| (0|1-9|10\+) \|/g,'| |').replace(/\bd1_migrations\b/g,'').match(/\d/g);

const reject=(query,rows,reason)=>assert.throws(()=>sanitizeRows(query,rows),e=>e instanceof SnapshotSanitizerError&&e.message===`SNAPSHOT_SANITIZER_${reason}`);
const code=c=>`CASE WHEN ${c} IS NULL THEN 'NONE' WHEN ${c} GLOB '*[^A-Z0-9_]*' OR ${c} GLOB '[^A-Z]*' OR length(${c})>64 THEN 'OTHER' ELSE ${c} END`;

test('the snapshot SQL and column allowlists are pinned exactly',()=>{
  // Any change here is a change to what reaches a public log: review it.
  assert.deepEqual(JSON.parse(JSON.stringify(QUERIES)),{
    migrations_applied:{sql:'SELECT name AS migration FROM d1_migrations ORDER BY id',columns:{migration:'migration'}},
    tables:{sql:"SELECT name AS table_name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",columns:{table_name:'table'}},
    abnormal_sync_jobs:{sql:`SELECT entity_type,status,${code('last_error')} AS error_code,count(*) AS n FROM sync_jobs WHERE status IN ('FAILED','REVIEW') GROUP BY 1,2,3 ORDER BY 1,2,3`,columns:{entity_type:'entity',status:'jobStatus',error_code:'code',n:'count'}},
    open_failed_jobs:{sql:"SELECT count(*) AS n FROM failed_jobs WHERE status='OPEN'",columns:{n:'count'}},
    workbook_claims:{sql:`SELECT state,${code('review_reason')} AS reason,count(*) AS n FROM stable_workbook_claims GROUP BY 1,2`,columns:{state:'claimState',reason:'code',n:'count'}},
    abnormal_inbound:{sql:"SELECT status,count(*) AS n FROM inbound_events WHERE status IN ('FAILED','REVIEW') GROUP BY 1 ORDER BY 1",columns:{status:'inboundStatus',n:'count'}},
    recovery_epochs:{sql:"SELECT state,count(*) AS n FROM stable_recovery_epochs GROUP BY 1 ORDER BY 1",columns:{state:'epochState',n:'count'}},
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
  reject('workbook_claims',[{state:'REVIEW',reason:'1597',n:1}],'VALUE');
  reject('recovery_epochs',[{state:'synthetic-epoch-0001',n:1}],'VALUE');reject('recovery_epochs',[{state:'ARMED',n:1,target_key:'exp_1'}],'COLUMNS');
  assert.deepEqual(sanitizeRows('recovery_epochs',[{state:'CLOSED',n:3}]),[{state:'CLOSED',n:3}]);
  reject('open_failed_jobs',[{n:-1}],'VALUE');reject('open_failed_jobs',[{n:1.5}],'VALUE');reject('open_failed_jobs',[{n:'7'}],'VALUE');
  reject('open_failed_jobs',[['x']],'NOT_OBJECT');reject('open_failed_jobs','rows','NOT_ROWS');
  reject('open_failed_jobs',Array.from({length:401},()=>({n:1})),'TOO_MANY_ROWS');
  try{sanitizeRows('workbook_claims',[{state:'REVIEW',reason:'secret value',n:1}]);assert.fail('should throw');}catch(e){assert.equal(String(e.message).includes('secret'),false);}
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

test('collect output has no Production numbers: only migration names and range labels',()=>{
  const calls=[],id='d0000000-0000-4000-8000-000000000000';
  const run=args=>{calls.push(args);
    if(args[0]==='deployments')return JSON.stringify({versions:[{version_id:id,percentage:100}]});
    const sql=args.at(-1);
    if(sql.includes('d1_migrations'))return JSON.stringify([{results:[{migration:'0001_a.sql'},{migration:'0023_stable_recovery_admission.sql'}]}]);
    if(sql.includes('sqlite_master'))return JSON.stringify([{results:[{table_name:'d1_migrations'},{table_name:'sync_jobs'}]}]);
    if(sql.includes('sync_jobs'))return JSON.stringify([{results:[{entity_type:'EXPENSE',status:'REVIEW',error_code:'STABLE_SYNC_REVIEW',n:13},{entity_type:'ATTENDANCE_EVENT',status:'FAILED',error_code:'NONE',n:4},{entity_type:'DAILY_PAYROLL',status:'FAILED',error_code:'GOOGLE_OAUTH_HTTP_429',n:37}]}]);
    if(sql.includes('failed_jobs'))return JSON.stringify([{results:[{n:22}]}]);
    if(sql.includes('stable_workbook_claims'))return JSON.stringify([{results:[{state:'REVIEW',reason:'STABLE_DAILY_REVIEW',n:1}]}]);
    if(sql.includes('stable_recovery_epochs'))return JSON.stringify([{results:[{state:'CLOSED',n:12},{state:'REVIEW',n:1}]}]);
    return JSON.stringify([{results:[{status:'FAILED',n:0}]}]);};
  const text=collect(run,sha256Hex(id),['0001_a.sql','0023_stable_recovery_admission.sql','0024_next.sql']);
  assert.equal(digitsOutsideAllowed(text),null,text);
  assert.match(text,/\| EXPENSE \| REVIEW \| STABLE_SYNC_REVIEW \| 10\+ \|/);assert.match(text,/\| ATTENDANCE_EVENT \| FAILED \| NONE \| 1-9 \|/);assert.match(text,/\| DAILY_PAYROLL \| FAILED \| GOOGLE_OAUTH_HTTP_429 \| 10\+ \|/);assert.equal(text.includes('37'),false);
  assert.match(text,/### open_failed_jobs\n\| n \|\n\|---\|\n\| 10\+ \|/);
  assert.match(text,/### recovery_epochs\n\| state \| n \|\n\|---\|---\|\n\| CLOSED \| 10\+ \|\n\| REVIEW \| 1-9 \|/);
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
