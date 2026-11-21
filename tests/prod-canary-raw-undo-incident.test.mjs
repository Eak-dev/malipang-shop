import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateInputs,verifyState} from '../scripts/prod-canary-raw-undo-incident.mjs';

const sha='a'.repeat(40),valid={EXPECTED_SHA:sha,GITHUB_SHA:sha,GITHUB_REF:'refs/heads/main',GITHUB_RUN_ATTEMPT:'1',RECOVERY_PHASE:'VERIFY',CONFIRMATION:'OWNER APPROVES RAW_UNDO VERIFY aaaaaaa',EXPECTED_WORKER_VERSION_SHA256:'c'.repeat(64),EXTERNAL_WRITERS_FENCED:'true',OWNER_SUPERVISING:'true',CLOUDFLARE_ACCOUNT_ID:'account',CLOUDFLARE_API_TOKEN:'secret',MALIPANG_ADMIN_TOKEN:'secret',MALIPANG_WORKER_URL:'https://example.workers.dev/'};
test('requires exact main, phase, worker version and active owner attestations',()=>{
 assert.equal(validateInputs(valid).phase,'VERIFY');
 for(const [field,value] of Object.entries({GITHUB_SHA:'b'.repeat(40),GITHUB_REF:'refs/heads/other',GITHUB_RUN_ATTEMPT:'2',CONFIRMATION:'',EXPECTED_WORKER_VERSION_SHA256:'bad',EXTERNAL_WRITERS_FENCED:'false',OWNER_SUPERVISING:'false',MALIPANG_WORKER_URL:'https://example.workers.dev/path',RECOVERY_PHASE:'OTHER'}))assert.throws(()=>validateInputs({...valid,[field]:value}),field);
});
test('every phase requires exact durable preimage and readback',()=>{
 const base={canary:'ARMED_UNDO',source:'CANCELLED',version:2,job:'REVIEW',projection:'IN_FLIGHT',notice:null,notice_count:0,claims:1,epochs:1,admissions:1,verified_admissions:0,processing:0,staff:0,unverified_projections:0,unverified_cancellations:1};
 const verified={...base,projection:'VERIFIED',unverified_cancellations:0};
 for(const [phase,before,after] of [
  ['VERIFY',base,verified],['TIME',verified,{...verified,notice:'TIME_IN_FLIGHT',notice_count:1}],
  ['TIME_READBACK',{...verified,notice:'TIME_IN_FLIGHT',notice_count:1},{...verified,notice:'TIME_VERIFIED',notice_count:1}],
  ['PROBE_STATUS',{...verified,notice:'TIME_VERIFIED',notice_count:1},{...verified,notice:'TIME_VERIFIED',notice_count:1}],
  ['STATUS',{...verified,notice:'TIME_VERIFIED',notice_count:1},{...verified,notice:'STATUS_ACKED',notice_count:1}],
  ['COMMIT',{...verified,notice:'STATUS_ACKED',notice_count:1},{...verified,notice:'COMPLETE',notice_count:1,claims:0,admissions:0,verified_admissions:1,job:'PENDING'}]
 ]){
  assert.doesNotThrow(()=>verifyState(phase,[before]));assert.doesNotThrow(()=>verifyState(phase,[after],true));
  assert.throws(()=>verifyState(phase,[{...before,processing:1}]));assert.throws(()=>verifyState(phase,[{...before,notice_count:2}]));
 }
});
test('protected workflow uses one POST and prohibits uncertain retries',()=>{
 const script=readFileSync(new URL('../scripts/prod-canary-raw-undo-incident.mjs',import.meta.url),'utf8'),workflow=readFileSync(new URL('../.github/workflows/prod-canary-raw-undo-incident.yml',import.meta.url),'utf8');
 assert.equal((script.match(/fetch\(base\+'\/admin\/stable-sync\/canary-raw-undo-incident'/g)||[]).length,1);
 assert.match(script,/RAW_UNDO_OUTCOME_UNKNOWN_NO_RETRY/);assert.match(workflow,/environment: production/);assert.match(workflow,/group: malipang-release-control/);assert.doesNotMatch(workflow,/^\s+push:/m);
});
