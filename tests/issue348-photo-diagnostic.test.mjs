import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import fs,{readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {summarize} from '../scripts/issue348-photo-diagnostic-summary.mjs';

const guard=fileURLToPath(new URL('../scripts/issue348-guard-photo-fetch.mjs',import.meta.url));
const line=fields=>`    # ${JSON.stringify({id:'photo-07',provider:'openai',accepted:false,validationCode:'TIMESTAMP_FIELDS_MISSING',clockPresent:true,overlayPresent:true,timestampPresent:false,gpsPresent:false,...fields})}`;

test('summary prints only an exact allowlisted diagnostic of the named case',()=>{
  const tap=['TAP version 13','# Subtest: photo-07','    # photoDate=2000-01-02 SECRETPLACE',line({}),'    not ok 1 - photo-07'].join('\n');
  assert.equal(summarize(tap,'photo-07'),'photo-07 provider=openai validationCode=TIMESTAMP_FIELDS_MISSING accepted=false clockPresent=true overlayPresent=true timestampPresent=false gpsPresent=false');
  assert.equal(summarize(tap,'photo-01'),null,'another case has no diagnostic');
  assert.equal(summarize(tap,'../x'),null,'case id is validated');
});

test('summary refuses extra keys, wrong types, unlisted values or duplicates',()=>{
  const bad=[
    line({photoDate:'2000-01-02'}),
    line({timestampPresent:'true'}),
    line({validationCode:'gps missing'}),
    line({provider:'SECRET-host'}),
    [line({}),line({})].join('\n'),
    '    # {not json}',
    '',
  ];
  for(const tap of bad)assert.equal(summarize(tap,'photo-07'),null,tap.slice(0,80));
  const reordered=`    # ${JSON.stringify({provider:'openai',id:'photo-07',accepted:false,validationCode:'OK',clockPresent:true,overlayPresent:true,timestampPresent:false,gpsPresent:false})}`;
  assert.equal(summarize(reordered,'photo-07'),null,'key order is part of the shape');
});

test('fetch guard limited to one case rejects every other image before any request',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'photo-guard-'));
  try{
    const bytes=id=>Buffer.from(`synthetic-${id}`);
    const sha=value=>createHash('sha256').update(value).digest('hex');
    const clock={cases:['photo-01','photo-07'].map(id=>({id,sha256:sha(bytes(id)),receivedAt:'2000-01-01T00:00:00.000Z'}))};
    const slips={cases:[{id:'kbank-kplus',sha256:sha(bytes('kbank-kplus'))}]};
    await writeFile(path.join(root,'clock.json'),JSON.stringify(clock));
    await writeFile(path.join(root,'slip.json'),JSON.stringify(slips));
    const run=(only,id)=>spawnSync(process.execPath,['--import',guard,'-e',
      `fetch('https://malipang-backend-v5-2.eakkachai-dev.workers.dev/admin/vision/evaluate?provider=openai&model=gpt-4.1-mini',{method:'POST',body:Buffer.from(${JSON.stringify(`synthetic-${id}`)})}).then(()=>process.exit(3),e=>{console.log(e.message);process.exit(2);})`],
      {env:{PATH:process.env.PATH,MALIPANG_CLOCK_PRIVATE_MANIFEST:path.join(root,'clock.json'),MALIPANG_BANK_SLIP_PRIVATE_MANIFEST:path.join(root,'slip.json'),...(only===undefined?{}:{ISSUE348_ONLY_CASE:only})},encoding:'utf8',timeout:20000});
    for(const id of ['photo-01','kbank-kplus']){
      const r=run('photo-07',id);
      assert.equal(r.status,2,id);
      assert.match(r.stdout,/outside approved scope/,id);
    }
    for(const only of ['photo-99','','kbank-kplus']){
      const r=run(only,'photo-07');
      assert.notEqual(r.status,0,`ISSUE348_ONLY_CASE=${JSON.stringify(only)}`);
      assert.match(r.stderr,/not a known clock case/);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('the photo-07 workflow cannot run from a pull request and prints no raw TAP',()=>{
  const wf=readFileSync(new URL('../.github/workflows/issue348-photo07-diagnostic.yml',import.meta.url),'utf8');
  const on=wf.slice(wf.indexOf('\non:'),wf.indexOf('\npermissions:'));
  assert.match(on,/^\non:\n  workflow_dispatch:\n/,'manual dispatch only');
  assert.doesNotMatch(on,/pull_request|push:|schedule|workflow_run/,'no automatic trigger');
  assert.match(wf,/if: github\.repository == 'Eak-dev\/malipang-shop' && github\.ref == 'refs\/heads\/main' && github\.sha == inputs\.expected_main_sha && github\.run_attempt == 1/);
  assert.match(wf,/environment: production/);
  assert.match(wf,/ISSUE348_ONLY_CASE=photo-07/);assert.match(wf,/MALIPANG_CLOCK_DIAGNOSTIC_CASE=photo-07/);
  // The slip manifest path is exported only because the fetch guard reads it; no slip test runs.
  assert.doesNotMatch(wf,/bank-slip-photo-fixtures|clock-photos,bank-slips/,'no slip evaluation');
  // Raw TAP stays on the runner: it is only filtered by sed to the case status or by the summary script.
  for(const line of wf.split('\n').filter(l=>l.includes('.tap')))assert.match(line,/> "\$(ISSUE348_SCRATCH|scratch)\/[a-z]+\.tap"|grep -q|sed -nE 's\/\^\[\[:space:\]\]\*\(not ok\|ok\) \[0-9\]\+ - \(photo-07\)\$\/\\1 \\2\/p'|issue348-photo-diagnostic-summary\.mjs/,line.trim());
  assert.doesNotMatch(wf,/\bcat\b|actions\/upload-artifact|tee /,'no dump or artifact');
});

test('verdict passes only a clean run that rejected photo-07 for missing overlay date and time',async()=>{
  const {verdict}=await import('../scripts/issue348-photo-diagnostic-summary.mjs');
  const expected=line({});
  assert.equal(verdict(expected,'photo-07',0),'PASS EXPECTED_REJECTION');
  assert.equal(verdict(expected,'photo-07',1),'FAIL TEST_FAILED');
  assert.equal(verdict(expected,'photo-07',-1),'FAIL TEST_FAILED','an unreadable exit code never passes');
  assert.equal(verdict(expected+'\nISSUE348_TRANSPORT_OUTCOME_UNKNOWN','photo-07',0),'FAIL TRANSPORT_OUTCOME_UNKNOWN','an unknown transport outcome is never a rejection');
  assert.equal(verdict('','photo-07',0),'FAIL DIAGNOSTIC_UNAVAILABLE');
  assert.equal(verdict(line({accepted:true,validationCode:'OK'}),'photo-07',0),'FAIL ACCEPTED');
  assert.equal(verdict(line({timestampPresent:true,validationCode:'GPS_MISSING'}),'photo-07',1),'FAIL TIMESTAMP_PRESENT');
  assert.equal(verdict(line({validationCode:'TIMESTAMP_MISSING',overlayPresent:false}),'photo-07',0),'FAIL OTHER_REJECTION_CODE','a no-overlay rejection is reported, not passed');
});

test('summary CLI exits non-zero unless the verdict passes',()=>{
  const cli=fileURLToPath(new URL('../scripts/issue348-photo-diagnostic-summary.mjs',import.meta.url));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'photo-verdict-'));
  try{
    const run=(tap,exit)=>{const f=path.join(dir,'live.tap');fs.writeFileSync(f,tap);return spawnSync(process.execPath,[cli,f,'photo-07','--test-exit',exit],{encoding:'utf8'});};
    let r=run(line({}),'0');assert.equal(r.status,0);assert.match(r.stdout,/verdict: PASS EXPECTED_REJECTION/);
    r=run(line({}),'1');assert.equal(r.status,1);assert.match(r.stdout,/verdict: FAIL TEST_FAILED/);
    r=run(line({accepted:true,validationCode:'OK'}),'0');assert.equal(r.status,1);
    r=run('nothing here','0');assert.equal(r.status,1);assert.match(r.stdout,/diagnostic unavailable\nverdict: FAIL DIAGNOSTIC_UNAVAILABLE/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
