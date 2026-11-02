import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {makeSyntheticSheetFixture,verifyFormulaBundle} from '../scripts/owner-correction-synthetic-sheet.mjs';

const expected=['รายวัน','V52_EXPENSE_RAW','รายละเอียดการซื้อ','97_EXPENSE_CLEAN','04_OWNER_MONTH_CLOSE','35_EXPENSE_FLOW_CHECK'];
const draftBundle=()=>({month:Array(14).fill('=0'),clean:"='รายวัน'!U5:U3421",flow:["='รายวัน'!U5:U3421",...Array(367).fill('=0')]});
test('offline fixture contains fixed synthetic data and every required verifier sheet',()=>{
  const fixture=makeSyntheticSheetFixture();assert.equal(fixture.kind,'LOCAL_SYNTHETIC_FIXTURE');assert.equal(fixture.safeForRemote,false);assert.equal(fixture.formulaStatus,'PLACEHOLDER_NOT_VERIFIER_READY');
  assert.deepEqual(fixture.create.sheets.map(s=>s.properties.title),expected);
  assert.equal(fixture.create.sheets.find(s=>s.properties.title==='รายวัน').properties.gridProperties.rowCount,4500);
  const data=JSON.stringify(fixture);assert.match(data,/exp_uat_synthetic/);assert.match(data,/SYNTHETIC UAT EXPENSE/);assert.doesNotMatch(data,/https?:\/\/|IMPORTRANGE|IMPORTDATA|IMPORTXML|IMPORTHTML|GOOGLEFINANCE|HYPERLINK|scriptId|permissions/);
  assert.ok(fixture.outstanding.includes('LIVE_SHARING_AND_SCRIPT_INSPECTION'));assert.ok(fixture.outstanding.includes('FORMULA_CONTENT_PRIVACY_REVIEW'));
});
test('synthetic input cannot inject business rows, extra fields, external formulas or unknown formula fingerprints',()=>{
  const invalid=[null,{}, {...draftBundle(),businessRows:['private']}, {...draftBundle(),month:Array(13).fill('=0')}, {...draftBundle(),clean:'=IMPORTRANGE("https://example.test/a","A1")'}, {...draftBundle(),clean:'=0'},draftBundle()];
  for(const b of invalid)assert.equal(verifyFormulaBundle(b),false);
  assert.throws(()=>makeSyntheticSheetFixture({...draftBundle(),rows:['not allowed']}),/FORMULA_BUNDLE_NOT_VERIFIED/);
});
test('output is private, local-only and never overwrites an existing file',()=>{
  const dir=mkdtempSync(join(tmpdir(),'malipang-uat-fixture-test-'));try{
    const output=join(dir,'fixture.json'),args=['scripts/owner-correction-synthetic-sheet.mjs','--output',output],cwd=new URL('../',import.meta.url);
    let run=spawnSync(process.execPath,args,{cwd,encoding:'utf8'});assert.equal(run.status,0);const written=JSON.parse(readFileSync(output,'utf8'));assert.equal(written.safeForRemote,false);assert.equal(statSync(output).mode&0o777,0o600);assert.doesNotMatch(run.stdout,/exp_uat_synthetic|token|private/i);
    const saved=readFileSync(output,'utf8');run=spawnSync(process.execPath,args,{cwd,encoding:'utf8'});assert.notEqual(run.status,0);assert.equal(readFileSync(output,'utf8'),saved);
    const bad=join(dir,'untrusted.json'),blocked=join(dir,'blocked.json');writeFileSync(bad,JSON.stringify({...draftBundle(),businessRows:['do not copy']}));run=spawnSync(process.execPath,[...args.slice(0,-1),blocked,'--formula-only-bundle',bad],{cwd,encoding:'utf8'});assert.notEqual(run.status,0);assert.equal(existsSync(blocked),false);assert.doesNotMatch(run.stderr,/do not copy/);
  }finally{rmSync(dir,{recursive:true,force:true})}
});
