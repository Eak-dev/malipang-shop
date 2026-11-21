import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const jqProbe=spawnSync(process.env.MP248_JQ_PATH||'jq',['--version'],{encoding:'utf8'});
const hasJq=jqProbe.status===0 && /^jq-/.test(jqProbe.stdout);
if(!hasJq&&(process.env.CI||process.env.MP248_JQ_PATH))throw Error('jq required in CI or when explicitly set');
const opts={skip:hasJq?false:'jq is not installed locally'};
const main='a'.repeat(40),g5='0d1dda77f3a0e5cfaec1872cb588b59dddfe5bdf';
const queue='b9b12fe82e6b402291b5d16d2ce61770',previous='310192aa-8a04-4b61-8a72-4455231b3339';
const baseline={release:'PR247',run_id:'42802512915',state:'VERIFIED_COMPLETED',expected_sha:g5,
  prior_worker_version:previous,queue_was_active:true,queue_id:queue};

function run({receipt=baseline,afterReceipt=receipt,failSnapshot=0,driftMain=false}={}) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'mp248-g6a-recheck-'));
  try{
    mkdirSync(path.join(dir,'bin'));mkdirSync(path.join(dir,'node_modules/.bin'),{recursive:true});
    if(process.env.MP248_JQ_PATH)symlinkSync(process.env.MP248_JQ_PATH,path.join(dir,'bin/jq'));
    writeFileSync(path.join(dir,'receipt.json'),JSON.stringify(receipt));
    writeFileSync(path.join(dir,'receipt-after.json'),JSON.stringify(afterReceipt));
    writeFileSync(path.join(dir,'bin/git'),`#!/bin/bash
set -euo pipefail
if [[ "$1" == rev-parse && "$2" == HEAD ]]; then
  printf '%s\\n' "$TEST_MAIN"
elif [[ "$1" == ls-remote && "$2" == origin && "$3" == refs/heads/main ]]; then
  if [[ "$DRIFT_MAIN" == 1 && -f "$FIXTURE_DIR/slept" ]]; then printf '%040d\\trefs/heads/main\\n' 0; else printf '%s\\trefs/heads/main\\n' "$TEST_MAIN"; fi
else exit 71; fi
`,{mode:0o755});
    writeFileSync(path.join(dir,'bin/sleep'),`#!/bin/bash
set -euo pipefail
[[ "$#" == 1 && "$1" == 360 ]] || exit 72
touch "$FIXTURE_DIR/slept"
printf '%s\\n' "$1" >> "$FIXTURE_DIR/events"
`,{mode:0o755});
    writeFileSync(path.join(dir,'bin/bash'),`#!/bin/bash
set -euo pipefail
[[ "$#" == 3 && "$1" == scripts/pr247-readonly-snapshot.sh && "$2" == A_POST ]] || exit 73
[[ "$G5_SHA" == 0d1dda77f3a0e5cfaec1872cb588b59dddfe5bdf && "$G5_RUN_ID" == 42802512915 && "$G5_RUN_ATTEMPT" == 1 ]] || exit 74
[[ "$PRIOR_WORKER_VERSION" == 1ac8cdf0-3b4c-414b-a77e-5e1ecddbd597 && "$EXPECTED_WORKER_VERSION" == e26b593e-7fa5-4492-a62f-5a0c68f3533f ]] || exit 75
[[ "$COMPLETED_BEFORE" == 3296 && "$OPEN_FAILED_BEFORE" == 32 ]] || exit 76
if [[ -f "$FIXTURE_DIR/slept" ]]; then n=2; else n=1; fi
printf 'snapshot-%s\\n' "$n" >> "$FIXTURE_DIR/events"
if [[ "$FAIL_SNAPSHOT" == "$n" ]]; then exit 77; fi
printf '{}\\n' > "$3"
`,{mode:0o755});
    writeFileSync(path.join(dir,'node_modules/.bin/wrangler'),`#!/bin/bash
set -euo pipefail
[[ "$#" == 6 && "$1" == r2 && "$2" == object && "$3" == get && "$4" == malipang-private-backups/release-control/pr247/42802512915-1.json && "$5" == --file=* && "$6" == --remote ]] || exit 78
target="$(printf '%s' "$5" | cut -c8-)"
if [[ -f "$FIXTURE_DIR/slept" ]]; then cp "$FIXTURE_DIR/receipt-after.json" "$target"; else cp "$FIXTURE_DIR/receipt.json" "$target"; fi
printf 'receipt\\n' >> "$FIXTURE_DIR/events"
`,{mode:0o755});
    const result=spawnSync('/bin/bash',[path.join(root,'scripts/issue248-g6a-incident-recheck.sh')],{
      cwd:dir,encoding:'utf8',timeout:20000,env:{...process.env,
        PATH:path.join(dir,'bin')+':'+process.env.PATH,FIXTURE_DIR:dir,TEST_MAIN:main,EXPECTED_MAIN_SHA:main,
        CLOUDFLARE_ACCOUNT_ID:'synthetic',CLOUDFLARE_API_TOKEN:'synthetic',MALIPANG_ADMIN_TOKEN:'synthetic',
        MALIPANG_WORKER_URL:'https://synthetic.invalid',FAIL_SNAPSHOT:String(failSnapshot),DRIFT_MAIN:driftMain?'1':'0'}});
    let events='';try{events=readFileSync(path.join(dir,'events'),'utf8')}catch{}
    return {status:result.status,stdout:result.stdout,stderr:result.stderr,events};
  }finally{rmSync(dir,{recursive:true,force:true});}
}
test('two A_POST rechecks use actual historical baseline and 360s interval',opts,()=>{
  const r=run();assert.equal(r.status,0,r.stderr);assert.equal(r.events,'receipt\nsnapshot-1\n360\nreceipt\nsnapshot-2\n');
  assert.match(r.stdout,/G6A_INCIDENT_READONLY_REVALIDATION_OBSERVED/);
  assert.match(r.stdout,/original failed workflow remains failed/);
});
for(const [name,config] of [
  ['invalid G5 state',{receipt:{...baseline,state:'PAUSE_INTENT'}}],
  ['wrong G5 run',{receipt:{...baseline,run_id:'42'}}],
  ['wrong G5 sha',{receipt:{...baseline,expected_sha:'b'.repeat(40)}}],
  ['wrong G5 queue',{receipt:{...baseline,queue_id:'different'}}],
  ['wrong previous worker',{receipt:{...baseline,prior_worker_version:'other'}}],
  ['first A_POST failure',{failSnapshot:1}],
  ['second A_POST failure',{failSnapshot:2}],
  ['main changes during wait',{driftMain:true}],
  ['receipt changes during wait',{afterReceipt:{...baseline,other:'new'}}]
])test('reject '+name,opts,()=>{const r=run(config);assert.notEqual(r.status,0,r.stdout);assert.doesNotMatch(r.stdout,/G6A_INCIDENT_READONLY_REVALIDATION_OBSERVED/);});
