import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const probe=spawnSync(process.env.MP248_JQ_PATH||'jq',['--version'],{encoding:'utf8'});
const hasJq=probe.status===0&&/^jq-/.test(probe.stdout);
if(!hasJq&&(process.env.CI||process.env.MP248_JQ_PATH))throw Error('jq required on CI or when explicitly set');
const opts={skip:hasJq?false:'jq unavailable locally'};
function run(mode,{code='503',body='{"ok":false}',network=false,url='https://synthetic.invalid',token='synthetic-token-never-log'}={}){
 const dir=mkdtempSync(path.join(os.tmpdir(),'mp248-notice-test-'));
 try{
  mkdirSync(path.join(dir,'bin'));
  if(process.env.MP248_JQ_PATH)symlinkSync(process.env.MP248_JQ_PATH,path.join(dir,'bin/jq'));
  writeFileSync(path.join(dir,'response'),body);
  writeFileSync(path.join(dir,'bin/curl'),`#!/bin/bash
set -euo pipefail
out=''; header=''; method=''; url=''
while [[ $# -gt 0 ]]; do
 case "$1" in
   --silent|--show-error) shift;;
   --retry|--connect-timeout|--max-time|--write-out) shift 2;;
   --request) method="$2"; shift 2;;
   --header) header="$2"; shift 2;;
   --output) out="$2"; shift 2;;
   https://*) url="$1"; shift;;
   *) exit 71;;
 esac
done
[[ "$method" == GET && "$url" == https://synthetic.invalid/admin/stable-sync/notice-readiness && "$header" == @* && -n "$out" ]] || exit 72
header_file="$(printf '%s' "$header" | cut -c2-)"
grep -qx 'Authorization: Bearer synthetic-token-never-log' "$header_file" || exit 73
[[ "$MOCK_NETWORK" == 0 ]] || exit 28
cp "$FIXTURE_DIR/response" "$out"
printf '%s' "$MOCK_HTTP"
`,{mode:0o755});
  const r=spawnSync('/bin/bash',[path.join(root,'scripts/issue248-notice-readiness-check.sh'),mode],{
   cwd:dir,encoding:'utf8',timeout:10000,
   env:{...process.env,PATH:path.join(dir,'bin')+':'+process.env.PATH,FIXTURE_DIR:dir,
    MOCK_HTTP:code,MOCK_NETWORK:network?'1':'0',MALIPANG_WORKER_URL:url,MALIPANG_ADMIN_TOKEN:token}
  });return {status:r.status,stdout:r.stdout,stderr:r.stderr};
 }finally{rmSync(dir,{recursive:true,force:true});}
}
test('503 false PRE is indeterminate and explicitly not paused-preimage proof',opts,()=>{
 const r=run('PRE');assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/NOT_READY_OR_PROVIDER_UNAVAILABLE_NOT_PREIMAGE_PROOF/);
});
test('200 true POST is point-in-time only and not CAS authorization',opts,()=>{
 const r=run('POST',{code:'200',body:'{"ok":true}'});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/POINT_IN_TIME_NOT_CAS_AUTHORIZATION/);
});
for(const [name,mode,config] of [
 ['PRE already ready','PRE',{code:'200',body:'{"ok":true}'}],
 ['POST 503 false','POST',{}],['unauthorized','POST',{code:'401',body:'Unauthorized'}],
 ['other provider failure','POST',{code:'500',body:'{"ok":false}'}],
 ['invalid json','POST',{code:'200',body:'no json'}],
 ['wrong boolean','POST',{code:'200',body:'{"ok":"true"}'}],
 ['extra fields','POST',{code:'200',body:'{"ok":true,"extra":1}'}],
 ['multiple json objects','POST',{code:'200',body:'{"ok":false}\n{"ok":true}'}],
 ['network error','POST',{network:true}],
 ['unsafe worker URL','POST',{url:'http://synthetic.invalid'}],
 ['newline credential','POST',{token:'synthetic\nmalformed'}]
])test('reject '+name,opts,()=>{const r=run(mode,config);assert.notEqual(r.status,0);assert.doesNotMatch(r.stdout,/NOTICE_READINESS_TRUE_POINT_IN_TIME/);assert.doesNotMatch(r.stdout+r.stderr,/synthetic-token-never-log/);});
