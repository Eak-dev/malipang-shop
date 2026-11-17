import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdtempSync,writeFileSync,chmodSync,existsSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sanitizeRows,SnapshotSanitizerError,QUERIES,collect,safeVersionId,safePercentage} from '../scripts/prod-ops-snapshot.mjs';

const reject=(rows,reason)=>assert.throws(()=>sanitizeRows(rows),e=>e instanceof SnapshotSanitizerError&&e.message===`SNAPSHOT_SANITIZER_${reason}`);

test('sanitizer accepts counts, codes, ISO days and migration names',()=>{
  const rows=[{entity_type:'EXPENSE',status:'PENDING',error_code:'NONE',n:3,oldest_day:'2026-11-04',newest_day:'2026-11-16'},{name:'0023_stable_recovery_admission.sql',total_count:0}];
  assert.deepEqual(sanitizeRows(rows),rows);
});

test('sanitizer rejects any number outside a count column, including amounts and versions',()=>{
  reject([{status:'CONFIRMED',amount_satang:159725}],'NUMBER_OUTSIDE_COUNT');
  reject([{status:'CONFIRMED',total_satang:1}],'NUMBER_OUTSIDE_COUNT');
  reject([{status:'CONFIRMED',max_version:3}],'NUMBER_OUTSIDE_COUNT');
  reject([{id:12,name:'0012_x.sql'}],'NUMBER_OUTSIDE_COUNT');
});

test('sanitizer rejects free text, numeric-looking strings and identifiers in code columns',()=>{
  reject([{status:'1597.25'}],'CODE_VALUE');
  reject([{status:'Synthetic store'}],'CODE_VALUE');
  reject([{status:'exp_0123456789'}],'CODE_VALUE');
  reject([{line_user:'U0123456789abcdef0123456789abcdef'}],'CODE_VALUE');
  reject([{newest_day:'2026-11-16T10:00:00Z'}],'DAY_VALUE');
  reject([{name:'../secret'}],'NAME_VALUE');
});

test('sanitizer rejects bad counts, odd shapes and oversized results without echoing values',()=>{
  reject([{n:-1}],'COUNT_VALUE');reject([{n:1.5}],'COUNT_VALUE');reject([{n:'7'}],'COUNT_VALUE');
  reject([{'Amount':1}],'COLUMN_NAME');reject([['x']],'NOT_OBJECT');reject('rows','NOT_ROWS');
  reject(Array.from({length:401},()=>({n:1})),'TOO_MANY_ROWS');
  try{sanitizeRows([{status:'secret value 123'}]);assert.fail('should throw');}catch(e){assert.equal(String(e.message).includes('secret'),false);}
});

test('snapshot queries contain no amount column, hardcoded amount or row identifier',()=>{
  const sql=QUERIES.map(([,q])=>q).join('\n');
  for(const word of ['amount','satang','description','line_user_id','expense_id','message_id','159725','166800','sum('])assert.equal(sql.toLowerCase().includes(word),false,word);
});

test('collect prints sanitized tables and withholds unsafe provider fields',()=>{
  const calls=[];
  const run=args=>{calls.push(args);if(args[0]==='deployments')return JSON.stringify({versions:[{version_id:'d0000000-0000-4000-8000-000000000000',percentage:100},{version_id:'not-a-uuid',percentage:'x'}]});
    if(args.at(-1).includes('expense_events'))return JSON.stringify([{results:[{status:'CONFIRMED',n:2,amount_satang:999}]}]);
    return JSON.stringify([{results:[{status:'OPEN',n:1}]}]);};
  const text=collect(run,()=>'2026-11-17T00:00:00.000Z');
  assert.match(text,/### expense_status\nSNAPSHOT_SANITIZER_NUMBER_OUTSIDE_COUNT/);
  assert.equal(text.includes('999'),false);
  assert.match(text,/version d0000000-0000-4000-8000-000000000000 at 100%/);assert.match(text,/version WITHHELD at WITHHELD%/);
  assert.equal(calls.every(a=>a[0]==='deployments'||a.includes('--remote')&&a.includes('--json')),true);
  assert.equal(calls.some(a=>a.includes('migrations')&&a.includes('apply')),false);
  assert.equal(safeVersionId(undefined),'WITHHELD');assert.equal(safePercentage(101),'WITHHELD');
});

test('ops workflow is manual-only, main-only, gated and scopes the token to wrangler steps',()=>{
  const wf=readFileSync(new URL('../.github/workflows/prod-ops-readonly.yml',import.meta.url),'utf8');
  const on=wf.slice(wf.indexOf('\non:'),wf.indexOf('\npermissions:'));
  assert.match(on,/workflow_dispatch:/);assert.doesNotMatch(on,/\n {2}(push|pull_request|schedule|workflow_run):/);
  assert.match(wf,/if: github\.ref == 'refs\/heads\/main'/);assert.match(wf,/environment: production/);
  assert.match(wf,/npm ci --ignore-scripts/);assert.match(wf,/persist-credentials: false/);
  const job=wf.slice(wf.indexOf('\n  ops:'),wf.indexOf('\n    steps:'));
  assert.doesNotMatch(job,/CLOUDFLARE_/,'token must not be set at job level');
  const steps=wf.split('\n      - ').slice(1);
  for(const step of steps){const usesToken=/CLOUDFLARE_API_TOKEN/.test(step),runsWrangler=/prod-ops-(snapshot|backup-rehearsal)/.test(step);assert.equal(usesToken,runsWrangler,step.split('\n')[0]);}
  assert.match(wf,/\[ "\$EXPECTED_SHA" = "\$GITHUB_SHA" \]/);assert.match(wf,/READ PRODUCTION \$\{EXPECTED_SHA:0:7\}/);assert.match(wf,/WRITE BACKUP/);
  assert.doesNotMatch(wf,/wrangler (deploy|d1 migrations apply|versions deploy|rollback)/);
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
    assert.match(r.stdout,/backup_upload: SKIPPED/);assert.match(r.stdout,/integrity_after: ok/);assert.match(r.stdout,/fk_violations_after: 0/);
    assert.doesNotMatch(r.stdout,/smoke_[a-z_A-Z]+: FAIL/);assert.match(r.stdout,/smoke_failed_job_insert: PASS/);
    assert.equal(readFileSync(log,'utf8').includes('r2 object'),false,'no R2 call without the flag');
    assert.equal(r.stdout.includes('synthetic'),false,'row data never printed');
    assert.equal(run({BACKUP_TO_R2:'yes'}).status,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
