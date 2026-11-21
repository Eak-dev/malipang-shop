// Static structure checks for the Issue 248 nonfinancial release workflow:
// provenance is verified before any dependency install, production secrets are
// scoped to provider steps only, and the release scripts are pinned by content.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const text=readFileSync('.github/workflows/issue248-nonfinancial-guard-release.yml','utf8');
const job=text.slice(text.indexOf('\n  hotfix:\n'));
const jobEnv=job.slice(job.indexOf('\n    env:\n'),job.indexOf('\n    steps:\n'));
// Split the hotfix job into steps (each starts with six spaces and "- ").
const steps=job.slice(job.indexOf('\n    steps:\n')+12).split(/\n(?=      - )/).map(raw=>{
 const name=(raw.match(/^      - (?:name: (.+)|uses: (.+))$/m)||[]).slice(1).find(Boolean)??'';
 const env=raw.match(/\n        env:\n((?:          .+\n?)+)/)?.[1]??'';
 return {name,raw,env};
});
// Executed lines only: comments may mention commands without running them.
const cmds=raw=>raw.split('\n').filter(l=>!l.trim().startsWith('#')).join('\n');
const idx=re=>{const i=steps.findIndex(s=>re.test(s.name));assert.ok(i>=0,'missing step '+re);return i};
const SECRET=/secrets\.|github\.token/;
// An executed npm/npx command (file names such as npm-shrinkwrap.json are not commands).
const NPM_EXEC=/\bnpm\s+(?:ci|install|i|run|exec|rebuild)\b|\bnpx\b/;
const PROVIDER=['Check current Worker, accounting guards and writers (read-only)','Recheck preconditions and deploy once','Verify version, active Queue, flags and D1 after deploy'];

test('job-level env carries no production secret or token; the workflow token is read-only',()=>{
 assert.ok(jobEnv.includes('EXPECTED_SHA:'));assert.doesNotMatch(jobEnv,SECRET);
 assert.match(text,/^permissions: \{contents: read, actions: read\}$/m);
});
test('order: validate inputs, checkout exact SHA, verify provenance, then install, then provider steps',()=>{
 // Nothing else (no action, no command) may run before provenance is verified.
 assert.deepEqual(steps.slice(0,3).map(s=>s.name),['Validate dispatch inputs before checkout (no secrets)','actions/checkout@v4','Verify exact reviewed source before installing dependencies (no production secrets)']);
 const n=idx(/^actions\/setup-node/),i=idx(/^Install reviewed lockfile/);
 assert.ok(2<n&&n<i,'unexpected order');
 for(const name of PROVIDER)assert.ok(steps.findIndex(s=>s.name===name)>i,name);
 // Exactly one step installs dependencies and no earlier step runs npm or npx in any form.
 assert.deepEqual(steps.flatMap((s,k)=>/\bnpm\s+(?:ci|install|i)\b/.test(cmds(s.raw))?[k]:[]),[i]);
 for(const s of steps.slice(0,i))assert.doesNotMatch(cmds(s.raw),NPM_EXEC,s.name||'unnamed step');
 assert.match(steps[i].raw,/\n          npm ci\n/);
});
test('checkout uses the exact expected SHA, never moving main',()=>{
 const c=steps[idx(/^actions\/checkout@v4$/)].raw;
 assert.match(c,/with: \{ref: '\$\{\{ inputs\.expected_sha \}\}', fetch-depth: 0\}/);assert.doesNotMatch(c,/ref: main/);
 assert.match(steps[idx(/^Validate dispatch inputs/)].raw,/test "\$GITHUB_SHA" = "\$EXPECTED_SHA"/);
});
test('provenance is fully verified before npm ci, with only the read-only GitHub token',()=>{
 const p=steps[idx(/^Verify exact reviewed source before installing/)];
 assert.equal(p.env.trim(),'GH_TOKEN: ${{ github.token }}');
 for(const re of [/test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA"/,/git ls-remote origin refs\/heads\/main/,/test "\$\(git rev-parse refs\/review\/pr271\)" = "\$REVIEWED_RUNTIME_SHA"/,/git merge-base --is-ancestor "\$BASE_SHA" HEAD/,/git merge-base --is-ancestor "\$pr_merge" HEAD/,/git diff --quiet "\$REVIEWED_RUNTIME_SHA" HEAD -- src migrations wrangler\.jsonc package\.json package-lock\.json npm-shrinkwrap\.json \.npmrc tsconfig\.json/,/sha256sum --check --strict --status/])assert.match(p.raw,re);
 assert.doesNotMatch(cmds(p.raw),NPM_EXEC);
});
test('install and local checks run without any production secret and prove no reviewed file changed',()=>{
 const i=steps[idx(/^Install reviewed lockfile/)];
 assert.equal(i.env,'');assert.doesNotMatch(i.raw,SECRET);
 const after=i.raw.slice(i.raw.indexOf('npx wrangler deploy --dry-run'));
 assert.match(after,/test -z "\$\(git status --porcelain --untracked-files=no\)"/);
 assert.match(after,/sha256sum --check --strict --status/);
 assert.match(after,/RELEASE_SNAPSHOT_SHA256=/);
 for(const s of steps)if(/npm ci|npm run check|wrangler deploy --dry-run/.test(cmds(s.raw)))assert.doesNotMatch(s.env+s.raw,SECRET,s.name);
});
test('Cloudflare and admin secrets appear only in the three provider steps, each rechecking integrity first',()=>{
 for(const key of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','MALIPANG_ADMIN_TOKEN']){
  const holders=steps.filter(s=>s.env.includes('secrets.'+key)).map(s=>s.name);
  assert.deepEqual(holders,PROVIDER,key);
  assert.equal((text.match(new RegExp('secrets\\.'+key,'g'))||[]).length,3,key);
 }
 // No other secret anywhere, and every secret reference sits in a provider step's env block.
 assert.equal((text.match(/secrets\./g)||[]).length,9);
 for(const s of steps)assert.equal((s.raw.match(/secrets\./g)||[]).length,PROVIDER.includes(s.name)?(s.env.match(/secrets\./g)||[]).length:0,s.name||'unnamed step');
 for(const name of PROVIDER){
  const s=steps.find(x=>x.name===name).raw,first=Math.min(...['npx wrangler','bash "$RUNNER_TEMP/release-snapshot.sh"','curl '].map(t=>s.indexOf(t)).filter(n=>n>=0));
  const status=s.indexOf('test -z "$(git status --porcelain --untracked-files=no)"'),snap=s.indexOf('"$RELEASE_SNAPSHOT_SHA256" "$RUNNER_TEMP/release-snapshot.sh" | sha256sum --check --strict --status');
  assert.ok(status>=0&&snap>=0&&status<first&&snap<first,name);
 }
});
test('both release-script pin lists equal the current file contents',()=>{
 const lists=text.split('\n').filter(l=>l.includes('| sha256sum --check --strict --status')&&l.trim().startsWith("printf '")&&!l.includes('RELEASE_SNAPSHOT_SHA256'));
 assert.equal(lists.length,2);
 for(const l of lists){const body=l.slice(l.indexOf("'")+1,l.lastIndexOf("'")).split('\\n').filter(Boolean);
  assert.equal(body.length,8);
  for(const entry of body){const [hash,file]=entry.split('  ');assert.equal(hash,createHash('sha256').update(readFileSync(file)).digest('hex'),file)}}
});

// ---- step summary claims only what passed (behavioural: the real run blocks with stubbed providers)
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync,symlinkSync,copyFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
// Body of a step's `run: |` block exactly as GitHub hands it to bash.
const runBlock=raw=>{const lines=raw.split('\n'),i=lines.indexOf('        run: |');assert.ok(i>=0,'run block');return lines.slice(i+1).filter(l=>l===''||l.startsWith('          ')).map(l=>l.slice(10)).join('\n')+'\n';};
const SUMMARY=steps.find(s=>/^Incident containment summary/.test(s.name));
const jqProbe=spawnSync(process.env.MP248_JQ_PATH||'jq',['--version'],{encoding:'utf8'});
if(jqProbe.status!==0&&(process.env.CI||process.env.MP248_JQ_PATH))throw new Error('A working jq is required on CI and when MP248_JQ_PATH is set');
const jq={skip:jqProbe.status===0?false:'jq is not installed locally'};
const VERIFIED=/PRECHECK_VERIFIED|DEPLOY_STEP_SUCCEEDED|POSTCHECK_VERIFIED/;
function sandbox(){
 const dir=mkdtempSync(path.join(os.tmpdir(),'mp248-summary-'));for(const d of ['bin','runner','repo/scripts'])mkdirSync(path.join(dir,d),{recursive:true});
 if(process.env.MP248_JQ_PATH)symlinkSync(process.env.MP248_JQ_PATH,path.join(dir,'bin/jq'));
 writeFileSync(path.join(dir,'bin/git'),'#!/bin/bash\nif [[ "$1" == status ]]; then printf "%s" "${GIT_DIRTY:-}"; fi\nexit 0\n',{mode:0o755});
 writeFileSync(path.join(dir,'bin/sha256sum'),"#!/usr/bin/env node\nconst fs=require('fs'),c=require('crypto'),h=p=>c.createHash('sha256').update(fs.readFileSync(p)).digest('hex');let ok=true;\nfor(const line of fs.readFileSync(0,'utf8').split('\\n').filter(Boolean)){const [x,p]=line.split('  ');try{if(h(p)!==x)ok=false}catch{ok=false}}\nprocess.exit(ok?0:1);\n",{mode:0o755});
 const env1=r=>`echo '[{"success":true,"meta":{"changed_db":false,"rows_written":0},"results":[${r}]}]'`;
 writeFileSync(path.join(dir,'bin/npx'),`#!/bin/bash\nprintf '%s\\n' "$*" >> "$STUB_DIR/npx-calls.log"\n[[ "\${NPX_FAIL:-}" == 1 ]] && exit 1\nfor a in "$@"; do case "$a" in\n *"FROM failed_jobs WHERE status='OPEN'"*) ${env1('{"n":0}')}; exit 0;;\n *review_total*) ${env1('{"review_total":1}')}; exit 0;;\n *expired_known*) ${env1('{"claims":0}')}; exit 0;;\nesac; done\nexit 9\n`,{mode:0o755});
 writeFileSync(path.join(dir,'repo/scripts/issue248-nonfinancial-release-guard.mjs'),"import {appendFileSync} from 'node:fs';const m=process.argv[2];if(m==='sql-review'){console.log('SELECT 1 AS review_total');process.exit(0)}if(m==='sql-writers'){console.log('SELECT 0 AS expired_known');process.exit(0)}appendFileSync(process.env.STUB_DIR+'/guard-calls.log','called\\n');if(process.env.GUARD_RESULT)console.log(process.env.GUARD_RESULT);process.exit(Number(process.env.GUARD_EXIT||0));\n");
 writeFileSync(path.join(dir,'bin/curl'),'#!/bin/bash\nprintf "%s\\n" "$*" >> "$STUB_DIR/curl-calls.log"\necho "{}"\n',{mode:0o755});
 writeFileSync(path.join(dir,'runner/release-snapshot.sh'),'#!/bin/bash\nset -euo pipefail\necho called >> "$STUB_DIR/snapshot-calls.log"\nif [[ "${SNAPSHOT_FAIL:-}" == 1 ]]; then echo NO_GO_SYNTHETIC >&2; exit 2; fi\necho "{}" > "$2"\n');
 return dir;
}
function bash(dir,block,extra){
 const file=path.join(dir,'step.sh');writeFileSync(file,block);
 return spawnSync('bash',['--noprofile','--norc','-eo','pipefail',file],{cwd:path.join(dir,'repo'),encoding:'utf8',timeout:20000,
  env:{PATH:path.join(dir,'bin')+':'+process.env.PATH,HOME:dir,STUB_DIR:dir,RUNNER_TEMP:path.join(dir,'runner'),GITHUB_ENV:path.join(dir,'github-env'),GITHUB_STEP_SUMMARY:path.join(dir,'summary.md'),
   BEFORE_WORKER_VERSION:'11111111-1111-4111-8111-111111111111',
   // The provider steps check the Worker URL against the pinned origin first: give them the pinned
   // host and a synthetic token (tests that drift the URL override MALIPANG_WORKER_URL).
   EXPECTED_WORKER_ORIGIN:PINNED_ORIGIN,MALIPANG_WORKER_URL:PINNED_ORIGIN,MALIPANG_ADMIN_TOKEN:'SYNTHETIC_ADMIN_TOKEN_VALUE',RELEASE_SNAPSHOT_SHA256:createHash('sha256').update(readFileSync(path.join(dir,'runner/release-snapshot.sh'))).digest('hex'),...extra}});
}
const PINNED_ORIGIN=/\n      EXPECTED_WORKER_ORIGIN: (\S+)\n/.exec(jobEnv)[1];
const untouched=dir=>['npx-calls.log','guard-calls.log','snapshot-calls.log','curl-calls.log'].every(f=>!existsSync(path.join(dir,f)));
const summaryOf=dir=>existsSync(path.join(dir,'summary.md'))?readFileSync(path.join(dir,'summary.md'),'utf8'):'';

test('summary step: always runs, maps only step outcomes, and drops the unconditional canary claim',()=>{
 assert.deepEqual(PROVIDER.map(n=>steps.find(s=>s.name===n).raw.match(/^        id: (\w+)$/m)?.[1]),['precheck','deploy','postcheck']);
 assert.match(SUMMARY.raw,/^        if: always\(\)$/m);
 assert.equal(SUMMARY.env.trim(),['PRECHECK_OUTCOME: ${{ steps.precheck.outcome }}','DEPLOY_OUTCOME: ${{ steps.deploy.outcome }}','POSTCHECK_OUTCOME: ${{ steps.postcheck.outcome }}'].join('\n          '));
 const block=runBlock(SUMMARY.raw);assert.doesNotMatch(block,/\$\{\{/);assert.doesNotMatch(text,/canary source equals the G7 digest/);
 for(const t of ['G7_HISTORICAL_INTEGRITY_UNKNOWN_OWNER_ACCEPTED','ZERO_ITEM_CANARY_DETAIL_UNKNOWN','ABA UNKNOWN'])assert.ok(block.includes(t),t);
});
test('summary after an early failure, a skipped, cancelled or failed precheck claims nothing verified',()=>{
 for(const [label,outcomes] of [['never reached',{}],['skipped',{PRECHECK_OUTCOME:'skipped',DEPLOY_OUTCOME:'skipped',POSTCHECK_OUTCOME:'skipped'}],['cancelled',{PRECHECK_OUTCOME:'cancelled'}],['precheck failed',{PRECHECK_OUTCOME:'failure',DEPLOY_OUTCOME:'skipped',POSTCHECK_OUTCOME:'skipped'}]]){
  const dir=sandbox();try{const r=bash(dir,runBlock(SUMMARY.raw),outcomes);assert.equal(r.status,0,label);const s=summaryOf(dir);
   assert.doesNotMatch(s,VERIFIED,label);assert.doesNotMatch(s,/PASS/,label);assert.match(s,/PRECHECK_NOT_VERIFIED \(outcome: (not run|skipped|cancelled|failure)\)/,label);
   assert.match(s,/G7_HISTORICAL_INTEGRITY_UNKNOWN_OWNER_ACCEPTED/,label);assert.match(s,/ZERO_ITEM_CANARY_DETAIL_UNKNOWN/,label);
  }finally{rmSync(dir,{recursive:true,force:true})}
 }
 const dir=sandbox();try{bash(dir,runBlock(SUMMARY.raw),{PRECHECK_OUTCOME:'success',DEPLOY_OUTCOME:'failure',POSTCHECK_OUTCOME:'skipped'});const s=summaryOf(dir);
  assert.match(s,/PRECHECK_VERIFIED_AT_CHECK_TIME_NOT_FREEZE/);assert.match(s,/DEPLOY_NOT_CONFIRMED \(outcome: failure\).*UNKNOWN/);assert.doesNotMatch(s,/DEPLOY_STEP_SUCCEEDED|POSTCHECK_VERIFIED/);
 }finally{rmSync(dir,{recursive:true,force:true})}
 const all=sandbox();try{bash(all,runBlock(SUMMARY.raw),{PRECHECK_OUTCOME:'success',DEPLOY_OUTCOME:'success',POSTCHECK_OUTCOME:'success'});const s=summaryOf(all);
  for(const t of ['PRECHECK_VERIFIED','DEPLOY_STEP_SUCCEEDED','POSTCHECK_VERIFIED','ZERO_ITEM_CANARY_DETAIL_UNKNOWN'])assert.ok(s.includes(t),t);
 }finally{rmSync(all,{recursive:true,force:true})}
});
test('real precheck block: only a known guard PASS writes PASS; failures and early stops never do, and the summary follows',jq,()=>{
 const PASS='NONFINANCIAL_RELEASE_PRE_POINT_IN_TIME_PASS_NOT_FREEZE',pre=runBlock(steps.find(s=>s.name===PROVIDER[0]).raw);
 for(const [label,extra,passes,beforeProvider] of [['guard passes',{GUARD_RESULT:PASS},true],['guard rejects',{GUARD_EXIT:'1'},false],['guard output unknown',{GUARD_RESULT:'SOMETHING_ELSE'},false],
  ['snapshot fails',{SNAPSHOT_FAIL:'1'},false],['provider read fails',{NPX_FAIL:'1'},false],['dirty checkout',{GIT_DIRTY:' M src/index.ts'},false,true],['snapshot script changed',{RELEASE_SNAPSHOT_SHA256:'f'.repeat(64)},false,true],['worker URL drifted to another host',{MALIPANG_WORKER_URL:'https://attacker.example'},false,true]]){
  const dir=sandbox();try{
   const r=bash(dir,pre,extra);assert.equal(r.status===0,passes,label+': '+r.stdout+r.stderr);const s=summaryOf(dir);
   assert.equal(s.includes(PASS),passes,label);if(!passes)assert.doesNotMatch(s,/PASS/,label);
   if(beforeProvider)assert.ok(untouched(dir),label+': provider touched');
   if(label==='snapshot fails')assert.ok(!existsSync(path.join(dir,'guard-calls.log')),label);
   bash(dir,runBlock(SUMMARY.raw),{PRECHECK_OUTCOME:passes?'success':'failure',DEPLOY_OUTCOME:'skipped',POSTCHECK_OUTCOME:'skipped'});
   assert.equal(/PRECHECK_VERIFIED/.test(summaryOf(dir)),passes,label);assert.doesNotMatch(summaryOf(dir),/DEPLOY_STEP_SUCCEEDED|POSTCHECK_VERIFIED/,label);
  }finally{rmSync(dir,{recursive:true,force:true})}
 }
});
test('real precheck, real guard, provider-side SQL on a synthetic D1: payroll REVIEW and expired values never reach the runner',jq,()=>{
 const dir=sandbox();try{
  for(const f of ['issue248-nonfinancial-release-guard.mjs','pr247-stage-guard.mjs','issue248-provider-sha256.mjs'])copyFileSync(path.join('scripts',f),path.join(dir,'repo/scripts',f));
  // Synthetic D1 from the real migrations; markers sit in every job field that could leave it.
  const MARKERS=['EMP_SYNTHETIC_PRIVATE','TRACE_SYNTHETIC_PRIVATE','LEASE_SYNTHETIC_PRIVATE','ERROR_SYNTHETIC_PRIVATE'];
  const db=new DatabaseSync(path.join(dir,'d1.db'));
  try{for(const n of readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort())db.exec(readFileSync(path.join('migrations',n),'utf8'));
   const ins=db.prepare('INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,last_error,updated_at,lease_until,lease_token) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
   ins.run('job_payroll_review','DAILY_PAYROLL','EMP_SYNTHETIC_PRIVATE|2026-11-10',1,'TRACE_SYNTHETIC_PRIVATE','REVIEW',3,'ERROR_SYNTHETIC_PRIVATE','2026-11-10T00:00:00.000Z',null,null);
   ins.run('job_payroll_expired','DAILY_PAYROLL','EMP_SYNTHETIC_PRIVATE|2026-11-09',1,'TRACE_SYNTHETIC_PRIVATE_2','PROCESSING',1,'ERROR_SYNTHETIC_PRIVATE','2026-11-01T00:00:00.000Z','2026-11-02T00:00:00.000Z','LEASE_SYNTHETIC_PRIVATE');
   ins.run('job_attendance_review','ATTENDANCE_EVENT','EMP_SYNTHETIC_PRIVATE|event',1,'TRACE_SYNTHETIC_PRIVATE_3','REVIEW',1,'MP248_ATTENDANCE_OUTCOME_UNKNOWN','2026-11-10T23:04:40.739Z','2026-11-10T21:58:50.188Z','LEASE_SYNTHETIC_PRIVATE_2');
  }finally{db.close()}
  // Every d1 execute runs on that file read-only and returns a D1-shaped envelope.
  writeFileSync(path.join(dir,'d1.mjs'),"import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[2],{readOnly:true});process.stdout.write(JSON.stringify([{results:db.prepare(process.argv[3]).all(),success:true,meta:{changed_db:false,rows_written:0}}]));\n");
  writeFileSync(path.join(dir,'bin/npx'),'#!/bin/bash\nprintf "%s\\n" "$*" >> "$STUB_DIR/npx-calls.log"\nfor a in "$@"; do last="$a"; done\nexec node --no-warnings "$STUB_DIR/d1.mjs" "$STUB_DIR/d1.db" "$last"\n',{mode:0o755});
  const r=bash(dir,runBlock(steps.find(s=>s.name===PROVIDER[0]).raw),{ATTENDANCE_REVIEW_EXCEPTION:'OWNER ACCEPTS KNOWN ATTENDANCE REVIEW',EXPIRED_TERMINAL_EXCEPTION:'NONE'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/NO_GO_NONFINANCIAL_RELEASE_KNOWN_JOB_MISSING/);assert.doesNotMatch(summaryOf(dir),/PASS/);
  const calls=readFileSync(path.join(dir,'npx-calls.log'),'utf8');assert.match(calls,/sync_jobs WHERE status='REVIEW'/);assert.match(calls,/expired_known_state/);
  // Nothing the runner holds carries a job value: stdout, stderr, step summary, GITHUB_ENV and every temp file.
  const held=[r.stdout,r.stderr,summaryOf(dir),existsSync(path.join(dir,'github-env'))?readFileSync(path.join(dir,'github-env'),'utf8'):'',...readdirSync(path.join(dir,'runner')).map(f=>readFileSync(path.join(dir,'runner',f),'utf8'))];
  for(const m of MARKERS)for(const x of held)assert.ok(!x.includes(m),'job value reached the runner: '+m);
  const review=JSON.parse(readFileSync(path.join(dir,'runner/hotfix-review-pre.json'),'utf8'));assert.deepEqual(review[0].results[0],{review_total:2,candidates:1,known_job_rows:0,known_exact:0});
  const writers=JSON.parse(readFileSync(path.join(dir,'runner/hotfix-writers.json'),'utf8'));assert.deepEqual(writers[0].results[0],{claims:0,inflight:0,active_or_unbounded_leases:0,staff_processing:0,expired_processing:1,expired_known:0,expired_known_state:0});
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('admin token is sent only to the reviewed Worker origin: checked first in every provider step',()=>{
 const pin=/\n      EXPECTED_WORKER_ORIGIN: (\S+)\n/.exec(jobEnv)?.[1];
 // Same reviewed origin as the canonical runtime audit; not taken from a mutable repository variable.
 assert.equal(pin,'https://malipang-backend-v5-2.eakkachai-dev.workers.dev');
 assert.ok(readFileSync('.github/workflows/runtime-audit.yml','utf8').includes(`base.origin!=='${pin}'`));
 const CHECK='[[ -n "$EXPECTED_WORKER_ORIGIN" && "${MALIPANG_WORKER_URL%/}" == "$EXPECTED_WORKER_ORIGIN" ]] || { echo WORKER_ORIGIN_MISMATCH_NO_TOKEN_SENT; exit 1; }';
 const holders=steps.filter(s=>s.env.includes('secrets.MALIPANG_ADMIN_TOKEN'));
 assert.equal(holders.length,3);
 for(const s of holders){
  assert.match(s.env,/MALIPANG_WORKER_URL: \$\{\{ vars\.MALIPANG_WORKER_URL \}\}/,s.name);
  // The very first command after `set -euo pipefail`, before any provider/network command.
  const lines=cmds(s.raw.slice(s.raw.indexOf('run: |')+6)).split('\n').map(l=>l.trim()).filter(Boolean);
  assert.equal(lines[0],'set -euo pipefail',s.name);assert.equal(lines[1],CHECK,s.name);
 }
 // Behaviour of the exact check line under bash: only the reviewed origin (optionally with one
 // trailing slash) passes; a lookalike host, extra path, userinfo, http, or empty value fails closed.
 const run=url=>spawnSync('bash',['-c','set -euo pipefail\n'+CHECK+'\necho PASS'],{env:{PATH:process.env.PATH,EXPECTED_WORKER_ORIGIN:pin,MALIPANG_WORKER_URL:url},encoding:'utf8'});
 for(const ok of [pin,pin+'/'])assert.equal(run(ok).stdout.trim(),'PASS',ok);
 for(const bad of ['https://attacker.example','https://malipang-backend-v5-2.eakkachai-dev.workers.dev.attacker.example','https://malipang-backend-v5-2.eakkachai-dev.workers.dev/x','https://user@malipang-backend-v5-2.eakkachai-dev.workers.dev','http://malipang-backend-v5-2.eakkachai-dev.workers.dev',pin+'//','']){
  const r=run(bad);assert.notEqual(r.status,0,bad);assert.equal(r.stdout.trim(),'WORKER_ORIGIN_MISMATCH_NO_TOKEN_SENT',bad);
 }
 const empty=spawnSync('bash',['-c','set -euo pipefail\n'+CHECK+'\necho PASS'],{env:{PATH:process.env.PATH,EXPECTED_WORKER_ORIGIN:'',MALIPANG_WORKER_URL:''},encoding:'utf8'});
 assert.notEqual(empty.status,0);
});
test('real run blocks of all three provider steps: a drifted Worker URL stops before any provider, snapshot or curl call; the pinned origin proceeds',()=>{
 for(const name of PROVIDER){
  for(const url of ['https://attacker.example',PINNED_ORIGIN+'.attacker.example',PINNED_ORIGIN+'/x','http://'+PINNED_ORIGIN.slice(8)]){
   const dir=sandbox();try{
    const r=bash(dir,runBlock(steps.find(s=>s.name===name).raw),{MALIPANG_WORKER_URL:url,HOTFIX_OBSERVATION_START:'2026-11-12T00:00:00.000Z',POST_WORKER:'11111111-1111-4111-8111-111111111111'});
    assert.notEqual(r.status,0,name+' '+url);assert.match(r.stdout,/^WORKER_ORIGIN_MISMATCH_NO_TOKEN_SENT$/m,name+' '+url);assert.ok(untouched(dir),name+' '+url+': provider touched');
    assert.ok(!(r.stdout+r.stderr).includes('SYNTHETIC_ADMIN_TOKEN_VALUE'));
   }finally{rmSync(dir,{recursive:true,force:true})}
  }
  const dir=sandbox();try{
   // The stub git prints no ls-remote SHA, so an empty EXPECTED_SHA lets the deploy step reach its snapshot.
   bash(dir,runBlock(steps.find(s=>s.name===name).raw),{EXPECTED_SHA:'',HOTFIX_OBSERVATION_START:'2026-11-12T00:00:00.000Z',POST_WORKER:'11111111-1111-4111-8111-111111111111'});
   assert.ok(!untouched(dir),name+': the pinned origin must reach the (stub) providers');
  }finally{rmSync(dir,{recursive:true,force:true})}
 }
});
