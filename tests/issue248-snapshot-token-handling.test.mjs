// Issue 248 A3: the read-only snapshot never puts a bearer token in curl argv or output, keeps it
// in mode-600 header files, and removes its temp dir on success, error and TERM. Runs the real
// script with stub providers (curl/wrangler/jq) and synthetic tokens only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,readdirSync,existsSync,copyFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const SCRIPT='scripts/pr247-readonly-snapshot.sh';
const CF='SYNTHETIC_CF_TOKEN_VALUE',ADMIN='SYNTHETIC_ADMIN_TOKEN_VALUE';
function run({failOn='',termOn='',cf=CF,admin=ADMIN}={}){
 const dir=mkdtempSync(path.join(os.tmpdir(),'mp248-snap-'));
 for(const d of ['bin','tmp','log','repo/node_modules/.bin','repo/scripts'])mkdirSync(path.join(dir,d),{recursive:true});
 copyFileSync(SCRIPT,path.join(dir,'repo',SCRIPT));
 // curl stub: records argv and, for each @header file, its mode and whether it holds a bearer line
 // (never the value); may fail or TERM its parent on a chosen URL.
 writeFileSync(path.join(dir,'bin/curl'),`#!/bin/bash
printf '%s\\n' "$@" >> "$LOG_DIR/curl-argv"
for a in "$@"; do if [[ "$a" == @* ]]; then f="\${a#@}"; printf '%s %s\\n' "$(stat -f %Lp "$f" 2>/dev/null || stat -c %a "$f")" "$(grep -c '^Authorization: Bearer ' "$f")" >> "$LOG_DIR/header-files"; fi; done
url="\${@: -1}"
if [[ -n "\${TERM_ON:-}" && "$url" == *"$TERM_ON"* ]]; then kill -TERM "$PPID"; echo '{"success":true}'; exit 0; fi
if [[ -n "\${FAIL_ON:-}" && "$url" == *"$FAIL_ON"* ]]; then exit 22; fi
echo '{"success":true,"ok":true,"result":[]}'
`,{mode:0o755});
 writeFileSync(path.join(dir,'bin/jq'),'#!/bin/bash\nexit 0\n',{mode:0o755});
 writeFileSync(path.join(dir,'repo/node_modules/.bin/wrangler'),'#!/bin/bash\nprintf "%s\\n" "$@" >> "$LOG_DIR/wrangler-argv"\nfor a in "$@"; do case "$a" in --file=*) echo "{}" > "${a#--file=}";; esac; done\necho "[]"\n',{mode:0o755});
 const r=spawnSync('bash',['--noprofile','--norc',SCRIPT,'A_PRE',path.join(dir,'out.json')],{cwd:path.join(dir,'repo'),encoding:'utf8',timeout:20000,env:{
  PATH:path.join(dir,'bin')+':'+process.env.PATH,TMPDIR:path.join(dir,'tmp'),LOG_DIR:path.join(dir,'log'),FAIL_ON:failOn,TERM_ON:termOn,
  CLOUDFLARE_ACCOUNT_ID:'synthetic-account',CLOUDFLARE_API_TOKEN:cf,MALIPANG_ADMIN_TOKEN:admin,MALIPANG_WORKER_URL:'https://synthetic-worker.example.workers.dev',
  G5_RUN_ID:'1',G5_RUN_ATTEMPT:'1',G5_SHA:'a'.repeat(40),EXPECTED_WORKER_VERSION:'11111111-1111-4111-8111-111111111111',PRIOR_WORKER_VERSION:'22222222-2222-4222-8222-222222222222',COMPLETED_BEFORE:'0',OPEN_FAILED_BEFORE:'0'}});
 const read=f=>existsSync(path.join(dir,'log',f))?readFileSync(path.join(dir,'log',f),'utf8'):'';
 const out={status:r.status,signal:r.signal,output:r.stdout+r.stderr,argv:read('curl-argv')+read('wrangler-argv'),headers:read('header-files').trim().split('\n').filter(Boolean),tmpLeft:readdirSync(path.join(dir,'tmp'))};
 rmSync(dir,{recursive:true,force:true});return out;
}

test('static: every curl sends its bearer token from a header file, never in argv',()=>{
 const s=readFileSync(SCRIPT,'utf8');
 for(const line of s.split('\n').filter(l=>/\bcurl\b/.test(l)&&!l.trim().startsWith('#'))){assert.doesNotMatch(line,/Bearer|TOKEN/,line);assert.match(line,/--header "@\$tmp\/(cf|admin)-header"/,line);}
 assert.equal((s.match(/printf 'Authorization: Bearer %s\\n'/g)||[]).length,2);
 assert.ok(s.indexOf('umask 077')<s.indexOf('tmp="$(mktemp -d)"'),'umask before the temp dir and header files');
 assert.match(s,/trap 'rm -rf "\$tmp"' EXIT\ntrap 'exit 1' HUP INT TERM\n/);
});
test('error after the admin status call: no token in argv or output, header files 600, temp dir removed',()=>{
 const r=run({failOn:'/admin/stable-sync/status'});
 assert.notEqual(r.status,0);
 // Reached both providers: three Cloudflare reads and the admin status read.
 assert.equal(r.headers.length,4,r.output);assert.ok(r.argv.includes('https://synthetic-worker.example.workers.dev/admin/stable-sync/status'));
 for(const h of r.headers)assert.equal(h,'600 1');
 for(const token of [CF,ADMIN]){assert.ok(!r.argv.includes(token),'argv');assert.ok(!r.output.includes(token),'output');}
 assert.deepEqual(r.tmpLeft,[]);
});
test('error on the first Cloudflare read and TERM during a read both remove the temp dir and print no token',()=>{
 for(const opts of [{failOn:'/schedules'},{termOn:'/queues'}]){
  const r=run(opts);assert.notEqual(r.status,0,JSON.stringify(opts));
  for(const token of [CF,ADMIN]){assert.ok(!r.argv.includes(token));assert.ok(!r.output.includes(token));}
  assert.deepEqual(r.tmpLeft,[],JSON.stringify(opts));
 }
});
test('a token containing a newline is refused before any provider call or temp dir',()=>{
 for(const opts of [{cf:CF+'\nX-Injected: 1'},{admin:ADMIN+'\rX'}]){
  const r=run(opts);assert.equal(r.status,2);assert.match(r.output,/NO_GO_TOKEN_FORMAT_/);assert.equal(r.argv,'');assert.deepEqual(r.tmpLeft,[]);
  assert.ok(!r.output.includes('SYNTHETIC_'));
 }
});
