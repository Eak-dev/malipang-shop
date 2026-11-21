import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateInputs,verifyState} from '../scripts/prod-canary-action.mjs';

const sha='a'.repeat(40), id='exp_canary_'+'b'.repeat(32);
const valid={EXPECTED_SHA:sha,GITHUB_SHA:sha,GITHUB_REF:'refs/heads/main',CANARY_ACTION:'PREPARE',CONFIRMATION:'OWNER APPROVES PREPARE aaaaaaa',EXPECTED_WORKER_VERSION_SHA256:'c'.repeat(64),EXTERNAL_WRITERS_FENCED:'true',OWNER_SUPERVISING:'true',CLOUDFLARE_ACCOUNT_ID:'account',CLOUDFLARE_API_TOKEN:'secret',MALIPANG_ADMIN_TOKEN:'secret',MALIPANG_WORKER_URL:'https://example.workers.dev/'};
const cutover=[{state:'ACTIVE'}],op=[{state:'COMPLETE'}],attempts=['VIEWS','DAILY_J','REPORTS'].map(stage=>({stage,state:'VERIFIED'}));
test('requires pinned main, explicit action approval, Worker hash and both owner attestations',()=>{
 assert.equal(validateInputs(valid).action,'PREPARE');
 for(const [field,value] of Object.entries({GITHUB_SHA:'b'.repeat(40),GITHUB_REF:'refs/heads/other',CONFIRMATION:'',EXPECTED_WORKER_VERSION_SHA256:'x',EXTERNAL_WRITERS_FENCED:'false',OWNER_SUPERVISING:'false',MALIPANG_WORKER_URL:'https://example.workers.dev/path',CANARY_ACTION:'ABORT'}))assert.throws(()=>validateInputs({...valid,[field]:value}),field);
});
test('requires released cutover, exact synthetic identity and the expected state',()=>{
 assert.doesNotThrow(()=>verifyState('PREPARE',[],cutover,op,attempts));
 assert.doesNotThrow(()=>verifyState('CONFIRM',[{state:'DRAFT',expense_id:id}],cutover,op,attempts));
 assert.throws(()=>verifyState('PREPARE',[{state:'DRAFT',expense_id:id}],cutover,op,attempts));
 assert.throws(()=>verifyState('CONFIRM',[{state:'DRAFT',expense_id:'exp_real'}],cutover,op,attempts));
 assert.throws(()=>verifyState('CONFIRM',[{state:'CONFIRMED',expense_id:id}],cutover,op,attempts));
 assert.throws(()=>verifyState('CONFIRM',[{state:'DRAFT',expense_id:id}],[],op,attempts));
 assert.throws(()=>verifyState('CONFIRM',[{state:'DRAFT',expense_id:id}],cutover,op,attempts.slice(1)));
 assert.throws(()=>verifyState('CONFIRM',[{state:'CONFIRMED',expense_id:id}],cutover,op,attempts,true,'exp_canary_'+'d'.repeat(32)));
});
test('async duplicate may advance before post-read; reconciliation is constrained',()=>{
 assert.doesNotThrow(()=>verifyState('ARM_DUPLICATE',[{state:'DUPLICATE_SEEN',expense_id:id}],cutover,op,attempts,true,id));
 assert.doesNotThrow(()=>verifyState('RECONCILE_CONFIRM',[{state:'CONFIRMING',expense_id:id}],cutover,op,attempts));
 assert.throws(()=>verifyState('RECONCILE_UNDO',[{state:'DUPLICATE_VERIFIED',expense_id:id}],cutover,op,attempts));
});
test('manual protected one-shot path has no retry or secret output',()=>{
 const script=readFileSync(new URL('../scripts/prod-canary-action.mjs',import.meta.url),'utf8');
 const workflow=readFileSync(new URL('../.github/workflows/prod-canary-action.yml',import.meta.url),'utf8');
 assert.equal((script.match(/fetch\(base\+'\/admin\/stable-sync\/continuous-canary'/g)||[]).length,1);
 assert.match(script,/CANARY_OUTCOME_UNKNOWN_NO_RETRY/);
 assert.match(workflow,/environment: production/);
 assert.match(workflow,/group: malipang-release-control/);
 assert.match(workflow,/Assert latest remote main has not moved/);
 assert.doesNotMatch(workflow,/^\s+push:/m);
});
