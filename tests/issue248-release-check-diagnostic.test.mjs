// Issue 248 diagnostic: the Ubuntu reproduction uses no production environment or secret, tests an exact
// pinned SHA checked out separately from the tool, uploads nothing, records an exit code per part, and its
// summary carries only safe test facts. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,copyFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const W=readFileSync('.github/workflows/issue248-release-check-diagnostic.yml','utf8');
const steps=W.split(/\n(?=      - )/).slice(1).map(raw=>({raw,name:/^      - (?:name|uses): (.*)$/m.exec(raw)?.[1]??''}));
const step=prefix=>{const s=steps.find(x=>x.name.startsWith(prefix));assert.ok(s,prefix);return s.raw;};
const runBlock=raw=>{const lines=raw.split('\n'),i=lines.findIndex(l=>l==='        run: |');assert.ok(i>=0);return lines.slice(i+1).filter(l=>l===''||l.startsWith('          ')).map(l=>l.slice(10)).join('\n')+'\n';};

test('workflow: no production environment, secret, credential persistence, upload or provider call',()=>{
 assert.doesNotMatch(W,/secrets\.|environment:|upload-artifact|wrangler|curl |api\.cloudflare|github\.token|GH_TOKEN/);
 assert.match(W,/^permissions: \{contents: read\}$/m);assert.equal((W.match(/persist-credentials: false/g)||[]).length,2);
});
test('two checkouts: the pinned source in subject/, this diagnostic commit in tool/; the tool is always run from tool/',()=>{
 const sha=/DIAG_SHA: ([0-9a-f]{40})/.exec(W)[1];
 assert.match(step('Checkout pinned source under test'),new RegExp(`ref: '${sha}', path: subject`));
 const tool=step('Checkout diagnostic tool');assert.match(tool,/path: tool/);assert.doesNotMatch(tool,/ref:/);
 assert.match(W,/TOOL: \$\{\{ github\.workspace \}\}\/tool\/scripts\/issue248-tap-safe-summary\.mjs/);
 assert.match(step('Exact SHA'),/test "\$\(git -C subject rev-parse HEAD\)" = "\$DIAG_SHA"\n\s+test -f "\$TOOL"/);
 for(const n of ['Install, typecheck','Tests A','Tests B'])assert.match(step(n),/working-directory: subject/,n);
 assert.doesNotMatch(W,/node scripts\/issue248-tap-safe-summary/);assert.equal((W.match(/node "\$TOOL" /g)||[]).length,3);
 assert.match(W,/cache-dependency-path: subject\/package-lock\.json/);
});
test('real paths and per-part exits: subject without the tool, one failing test, a failing build; the verdict fails and lists each part',()=>{
 const ws=mkdtempSync(path.join(os.tmpdir(),'mp248-diag-'));
 try{
  for(const d of ['subject/tests','tool/scripts','bin','runner'])mkdirSync(path.join(ws,d),{recursive:true});
  copyFileSync('scripts/issue248-tap-safe-summary.mjs',path.join(ws,'tool/scripts/issue248-tap-safe-summary.mjs'));
  writeFileSync(path.join(ws,'subject/tests/pass.test.mjs'),"import test from 'node:test';test('synthetic passing case',()=>{});\n");
  writeFileSync(path.join(ws,'subject/tests/fail.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';test('synthetic failing case',()=>{assert.equal(1,2,'SECRET_MESSAGE');});\n");
  // npm stub: ci and typecheck succeed, build:test fails (exit 2).
  writeFileSync(path.join(ws,'bin/npm'),'#!/bin/bash\ncase "$*" in "ci") exit 0;; "run typecheck") exit 0;; "run build:test") exit 2;; esac\nexit 9\n',{mode:0o755});
  assert.equal(existsSync(path.join(ws,'subject/scripts/issue248-tap-safe-summary.mjs')),false);
  const env={PATH:path.join(ws,'bin')+':'+process.env.PATH,RUNNER_TEMP:path.join(ws,'runner'),GITHUB_STEP_SUMMARY:path.join(ws,'summary.md'),
   TOOL:path.join(ws,'tool/scripts/issue248-tap-safe-summary.mjs'),PARTS:path.join(ws,'runner/parts.env')};
  writeFileSync(env.PARTS,'');
  const run=(name,cwd)=>spawnSync('bash',['--noprofile','--norc','-c',runBlock(step(name))],{cwd,env,encoding:'utf8'});
  for(const n of ['Install, typecheck','Tests A','Tests B'])run(n,path.join(ws,'subject'));
  const v=run('Verdict per part',ws);
  const summary=readFileSync(env.GITHUB_STEP_SUMMARY,'utf8');
  assert.notEqual(v.status,0,'verdict must fail when any part failed');
  for(const [p,x] of [['NPM_CI','0'],['TYPECHECK','0'],['BUILD_TEST','2'],['TESTS_A','1'],['SUMMARY_A','0'],['TESTS_B','1'],['SUMMARY_B','0'],['SUMMARY_DIFF','0']])assert.match(summary,new RegExp(`- ${p}: ${x}\\n`),p);
  assert.match(summary,/### A: tests=2 pass=1 fail=1/);assert.match(summary,/NOT_OK fail\.test\.mjs:1 synthetic failing case/);assert.match(summary,/Failing only with the release environment \(0\)/);
  assert.ok(!summary.includes('SECRET_MESSAGE'));
  // A part that never ran is reported NOT_RUN and fails the verdict.
  writeFileSync(env.PARTS,'NPM_CI_EXIT=0\n');writeFileSync(env.GITHUB_STEP_SUMMARY,'');const v2=run('Verdict per part',ws);
  assert.notEqual(v2.status,0);assert.match(readFileSync(env.GITHUB_STEP_SUMMARY,'utf8'),/- TESTS_A: NOT_RUN/);
  // All parts 0: the verdict passes.
  writeFileSync(env.PARTS,['NPM_CI','TYPECHECK','BUILD_TEST','TESTS_A','SUMMARY_A','TESTS_B','SUMMARY_B','SUMMARY_DIFF'].map(p=>p+'_EXIT=0').join('\n')+'\n');assert.equal(run('Verdict per part',ws).status,0);
 }finally{rmSync(ws,{recursive:true,force:true})}
});
const TAP=`TAP version 13
ok 1 - passes cleanly
  ---
  duration_ms: 5.1
  ...
not ok 2 - fails with ghp_SYNTHETICTOKEN123 and ${'d'.repeat(40)} in its title
  ---
  duration_ms: 15020.4
  location: '/home/runner/work/x/tests/a.test.mjs:12:1'
  failureType: 'testCodeFailure'
  error: |-
    SECRET_ASSERTION_MESSAGE Bearer SYNTHETIC_BEARER_VALUE
  code: 'ERR_ASSERTION'
  stack: |-
    SECRET_STACK_FRAME
  ...
# stdout line SECRET_STDOUT
ok 3 - skipped one # SKIP no network
# tests 3
# pass 1
# fail 1
# skipped 1
`;
function summarize(...args){const d=mkdtempSync(path.join(os.tmpdir(),'mp248-tap-'));try{const files=args.slice(1).map((t,i)=>{const f=path.join(d,i+'.tap');writeFileSync(f,t);return f;});
 return spawnSync(process.execPath,['scripts/issue248-tap-safe-summary.mjs',args[0],...files],{encoding:'utf8'});}finally{rmSync(d,{recursive:true,force:true})}}
test('summary: counts and failing titles with location, duration, type and code only; messages, stacks and output never printed',()=>{
 const r=summarize('B',TAP);assert.equal(r.status,0,r.stderr);
 assert.match(r.stdout,/### B: tests=3 pass=1 fail=1 skipped=1/);
 assert.match(r.stdout,/- NOT_OK a\.test\.mjs:12 fails with <redacted> and <hex> in its title \| 15020ms \| testCodeFailure \| ERR_ASSERTION/);
 for(const s of ['SECRET_ASSERTION_MESSAGE','SYNTHETIC_BEARER_VALUE','SECRET_STACK_FRAME','SECRET_STDOUT','ghp_SYNTHETIC','d'.repeat(40)])assert.ok(!r.stdout.includes(s),s);
});
test('diff: titles failing only in the release-environment run',()=>{
 const plain=TAP.replace('not ok 2','ok 2'),r=summarize('DIFF',plain,TAP);
 assert.match(r.stdout,/### Failing only with the release environment \(1\)/);assert.match(r.stdout,/a\.test\.mjs:12 fails with <redacted>/);
 assert.match(summarize('DIFF',TAP,TAP).stdout,/\(0\)/);
});
