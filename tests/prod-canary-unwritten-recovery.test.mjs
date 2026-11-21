import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateInputs,verifyPhase,verifyPreflight,safeProbeDiagnostic} from '../scripts/prod-canary-unwritten-recovery.mjs';

const sha='a'.repeat(40),valid={EXPECTED_SHA:sha,GITHUB_SHA:sha,GITHUB_REF:'refs/heads/main',GITHUB_RUN_ATTEMPT:'1',RECOVERY_PHASE:'TIME',CONFIRMATION:'OWNER APPROVES INCIDENT TIME aaaaaaa',EXPECTED_WORKER_VERSION_SHA256:'c'.repeat(64),EXTERNAL_WRITERS_FENCED:'true',OWNER_SUPERVISING:'true',CLOUDFLARE_ACCOUNT_ID:'account',CLOUDFLARE_API_TOKEN:'secret',MALIPANG_ADMIN_TOKEN:'secret',MALIPANG_WORKER_URL:'https://example.workers.dev/'};
test('requires pinned main, exact incident approval, Worker hash and owner attestations',()=>{
 assert.equal(validateInputs(valid).phase,'TIME');
 for(const [field,value] of Object.entries({GITHUB_SHA:'b'.repeat(40),GITHUB_REF:'refs/heads/other',GITHUB_RUN_ATTEMPT:'2',CONFIRMATION:'',EXPECTED_WORKER_VERSION_SHA256:'x',EXTERNAL_WRITERS_FENCED:'false',OWNER_SUPERVISING:'false',MALIPANG_WORKER_URL:'https://example.workers.dev/path',RECOVERY_PHASE:'STEP'}))assert.throws(()=>validateInputs({...valid,[field]:value}),field);
});
test('phase preimage and readback are exact and cannot advance another phase',()=>{
 assert.doesNotThrow(()=>verifyPhase('PROBE',[]));assert.doesNotThrow(()=>verifyPhase('PROBE',[],true));assert.throws(()=>verifyPhase('PROBE',[{state:'TIME_ACKED'}]));
 for(const [phase,before,after] of [['TIME',null,'TIME_ACKED'],['STATUS','TIME_ACKED','STATUS_ACKED'],['COMMIT','STATUS_ACKED','COMPLETE']]){
  assert.doesNotThrow(()=>verifyPhase(phase,before?[{state:before}]:[]));assert.doesNotThrow(()=>verifyPhase(phase,[{state:after}],true));
  assert.throws(()=>verifyPhase(phase,[{state:'TIME_IN_FLIGHT'}]));assert.throws(()=>verifyPhase(phase,[{state:'STATUS_IN_FLIGHT'}],true));
 }
});
test('preflight requires one exact fenced incident and no active work',()=>{
 const status={incident:1,claims:1,epochs:1,admissions:1,processing:0,staff:0,projections:0,cancellations:0};assert.doesNotThrow(()=>verifyPreflight([status]));
 for(const key of Object.keys(status))assert.throws(()=>verifyPreflight([{...status,[key]:status[key]+1}]),key);
 assert.throws(()=>verifyPreflight([{...status,processing:null}]));assert.throws(()=>verifyPreflight([]));
});
test('manual protected path pins phase, uses one POST and never retries uncertain outcomes',()=>{
 const script=readFileSync(new URL('../scripts/prod-canary-unwritten-recovery.mjs',import.meta.url),'utf8'),workflow=readFileSync(new URL('../.github/workflows/prod-canary-unwritten-recovery.yml',import.meta.url),'utf8');
 assert.equal((script.match(/fetch\(base\+'\/admin\/stable-sync\/canary-unwritten-recovery'/g)||[]).length,1);
 assert.match(script,/INCIDENT_OUTCOME_UNKNOWN_NO_RETRY/);assert.match(script,/verifyPhase\(phase/);
 assert.match(workflow,/environment: production/);assert.match(workflow,/group: malipang-release-control/);assert.match(workflow,/Assert latest remote main has not moved/);assert.doesNotMatch(workflow,/^\s+push:/m);
});
test('probe diagnostics are strictly allowlisted and never print provider content',()=>{
 assert.equal(safeProbeDiagnostic({ok:false,diagnostic:{stage:'REPORT_HEALTH',reason:'REPORT_HEALTH_FORMULA'}}),'INCIDENT_PROBE_REPORT_HEALTH_REPORT_HEALTH_FORMULA');
 assert.equal(safeProbeDiagnostic({ok:false,diagnostic:{stage:'NOTICE_INITIAL',reason:'SHEETS_HTTP_403'}}),'INCIDENT_PROBE_NOTICE_INITIAL_SHEETS_HTTP_403');
 assert.equal(safeProbeDiagnostic({ok:false,diagnostic:{stage:'NOTICE_INITIAL',reason:'private provider detail'}}),null);
 assert.equal(safeProbeDiagnostic({ok:false,diagnostic:{stage:'SECRET',reason:'CHECK_FAILED'}}),null);
});
