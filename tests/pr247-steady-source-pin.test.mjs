import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const checker=fileURLToPath(new URL('../scripts/pr247-steady-config-check.mjs',import.meta.url));
function git(dir,...args){return execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()}
function setup(t){const dir=mkdtempSync(path.join(os.tmpdir(),'mp248-g8-pin-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));git(dir,'init','-q');git(dir,'config','user.name','Synthetic Test');git(dir,'config','user.email','fixture@example.invalid');mkdirSync(path.join(dir,'src'));
 const write=(p,x)=>writeFileSync(path.join(dir,p),x);
 write('wrangler.jsonc',JSON.stringify({vars:{OTHER:'same'}}));write('src/index.ts','reviewed original\n');git(dir,'add','.');git(dir,'commit','-qm','config baseline');const config=git(dir,'rev-parse','HEAD');
 write('src/index.ts','reviewed diagnostic\n');write('wrangler.jsonc',JSON.stringify({vars:{OTHER:'same',STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true'}}));git(dir,'add','.');git(dir,'commit','-qm','reviewed diagnostic');const source=git(dir,'rev-parse','HEAD');
 write('wrangler.jsonc',JSON.stringify({vars:{OTHER:'same',STABLE_RECOVERY_GATE_ENABLED:'false',STABLE_SHEETS_PACING_ENABLED:'true'}}));git(dir,'add','.');git(dir,'commit','-qm','g8 candidate');return {dir,config,source,write};}
function sourceCheck(dir,source){return spawnSync('bash',['-c','git cat-file -e "${PIN}^{commit}" && git merge-base --is-ancestor "$PIN" HEAD && git diff --quiet "$PIN" HEAD -- src migrations package.json package-lock.json tsconfig.json'],{cwd:dir,env:{...process.env,PIN:source}}).status}
function configCheck(dir,config){return spawnSync(process.execPath,[checker],{cwd:dir,env:{...process.env,CONFIG_BASELINE_SHA:config},encoding:'utf8'})}

test('different immutable reviewed source and original config baselines both pass',t=>{const x=setup(t);assert.equal(sourceCheck(x.dir,x.source),0);assert.equal(configCheck(x.dir,x.config).status,0);assert.notEqual(configCheck(x.dir,x.source).status,0)});
test('changed runtime source or wrong base fails source pin',t=>{const x=setup(t);x.write('src/index.ts','unexpected change\n');git(x.dir,'add','.');git(x.dir,'commit','-qm','drift');assert.notEqual(sourceCheck(x.dir,x.source),0);assert.notEqual(sourceCheck(x.dir,'0'.repeat(40)),0)});
test('unrelated configuration drift fails original config baseline',t=>{const x=setup(t);x.write('wrangler.jsonc',JSON.stringify({vars:{OTHER:'different',STABLE_RECOVERY_GATE_ENABLED:'false',STABLE_SHEETS_PACING_ENABLED:'true'}}));assert.notEqual(configCheck(x.dir,x.config).status,0)});
