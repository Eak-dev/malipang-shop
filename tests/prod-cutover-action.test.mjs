import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateInputs,verifyReadiness,allowedActions,expectedBefore} from '../scripts/prod-cutover-action.mjs';

const sha='a'.repeat(40),hash='b'.repeat(64);
const valid=(action='PRECHECK')=>({
 EXPECTED_SHA:sha,GITHUB_SHA:sha,GITHUB_REF:'refs/heads/main',CUTOVER_ACTION:action,
 CONFIRMATION:'OWNER APPROVES '+action+' '+sha.slice(0,7),
 EXPECTED_WORKER_VERSION_SHA256:hash,
 CLOUDFLARE_ACCOUNT_ID:'cf-account',CLOUDFLARE_API_TOKEN:'test-secret',
 MALIPANG_ADMIN_TOKEN:'test-admin',MALIPANG_WORKER_URL:'https://example.workers.dev/',
 EXTERNAL_WRITERS_FENCED:'true',PROVIDER_OUTCOME_REVIEWED:'true',OWNER_SUPERVISING:'true'
});
const review=[{state:'REVIEW',phase:'OPERATION',review_reason:'STABLE_DAILY_REVIEW'}],held=[{state:'HELD'}],op=[{state:'HELD'}];
const stages=(...xs)=>xs.map(stage=>({stage,state:'VERIFIED'}));
const zero={projections:0,cancellations:0,epochs:0,recovery:0,processing:0,staff:0,claim_writes:0,claim_cancels:0};
test('manual only, exact immutable commit and action confirmation',()=>{
 assert.equal(allowedActions.length,8);
 assert.equal(validateInputs(valid()).action,'PRECHECK');
 assert.throws(()=>validateInputs({...valid(),GITHUB_REF:'refs/heads/dev'}),/CUTOVER_SHA_GUARD/);
 assert.throws(()=>validateInputs({...valid(),GITHUB_SHA:'b'.repeat(40)}),/CUTOVER_SHA_GUARD/);
 assert.throws(()=>validateInputs({...valid(),CONFIRMATION:'OWNER APPROVES PRECHECK aaaaaaa ' }),/CUTOVER_CONFIRMATION_INVALID/);
 assert.throws(()=>validateInputs(valid('INVALID')),/CUTOVER_ACTION_INVALID/);
});
test('every data-writing stage needs owner attestations',()=>{
 for(const action of allowedActions.filter(x=>x!=='PRECHECK')){
  assert.equal(validateInputs(valid(action)).action,action);
  for(const field of ['EXTERNAL_WRITERS_FENCED','PROVIDER_OUTCOME_REVIEWED','OWNER_SUPERVISING'])assert.throws(()=>validateInputs({...valid(action),[field]:'false'}),/CUTOVER_OWNER_ATTESTATION_MISSING/);
 }
 assert.equal(validateInputs({...valid(),EXTERNAL_WRITERS_FENCED:'false'}).action,'PRECHECK');
});
test('rejects invalid worker hash, missing credentials and unsafe URLs',()=>{
 assert.throws(()=>validateInputs({...valid(),EXPECTED_WORKER_VERSION_SHA256:'z'}),/CUTOVER_VERSION_HASH_INVALID/);
 assert.throws(()=>validateInputs({...valid(),MALIPANG_ADMIN_TOKEN:''}),/CUTOVER_CREDENTIALS_MISSING/);
 assert.throws(()=>validateInputs({...valid(),MALIPANG_WORKER_URL:'http://bad.workers.dev/'}),/CUTOVER_URL_INVALID/);
 assert.throws(()=>validateInputs({...valid(),MALIPANG_WORKER_URL:'https://bad.workers.dev/redirect'}),/CUTOVER_URL_INVALID/);
});
test('precheck and start review must find one original claim and no operator',()=>{
 assert.doesNotThrow(()=>verifyReadiness('PRECHECK',review,[],[],[],zero));
 assert.doesNotThrow(()=>verifyReadiness('START_REVIEW',review,[],[],[],zero));
 assert.throws(()=>verifyReadiness('PRECHECK',held,op,[],[],zero),/CUTOVER_START_NOT_READY/);
 assert.throws(()=>verifyReadiness('START_REVIEW',review,[],[],[],{...zero,processing:1}),/CUTOVER_UNRESOLVED_D1/);
});
test('operator stages require exact previous verified stages and held claim',()=>{
 for(const action of ['VIEWS','DAILY_J','REPORTS','ACTIVATE','RELEASE']){
  const prior=stages(...expectedBefore[action]);
  const active=action==='RELEASE'?[{state:'ACTIVE'}]:[];
  assert.doesNotThrow(()=>verifyReadiness(action,held,op,prior,active,zero),action);
  assert.throws(()=>verifyReadiness(action,held,op,prior.concat({stage:'EXTRA',state:'VERIFIED'}),active,zero),/CUTOVER_STAGES_NOT_READY/);
  assert.throws(()=>verifyReadiness(action,held,op,prior,action==='RELEASE'?[]:[{state:'ACTIVE'}],zero),/CUTOVER_ACTIVE_STATE_INVALID/);
 }
});
test('single no-retry guarded POST, protected workflow credentials and runlock',()=>{
 const script=readFileSync(new URL('../scripts/prod-cutover-action.mjs',import.meta.url),'utf8');
 const workflow=readFileSync(new URL('../.github/workflows/prod-cutover-action.yml',import.meta.url),'utf8');
 assert.equal((script.match(/fetch\(base\+'\/admin\/stable-sync\/continuous-cutover'/g)||[]).length,1);
 assert.match(script,/CUTOVER_OUTCOME_UNKNOWN_NO_RETRY/);
 assert.match(script,/redirect:'error'/);
 assert.match(workflow,/environment: production/);
 assert.match(workflow,/group: malipang-release-control/);
 assert.match(workflow,/Assert latest remote main has not moved/);
 assert.match(workflow,/CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
 assert.match(workflow,/MALIPANG_ADMIN_TOKEN: \$\{\{ secrets\.MALIPANG_ADMIN_TOKEN \}\}/);
 assert.match(workflow,/MALIPANG_CUTOVER_RECEIPTS: \$\{\{ secrets\.MALIPANG_CUTOVER_RECEIPTS \}\}/);
 assert.doesNotMatch(workflow,/^\s+push:/m);
});

test('one-shot RECONCILE_VIEWS accepts only REVIEW with a single VIEWS IN_FLIGHT',()=>{
 const claim=[{state:'REVIEW',phase:'OPERATION',review_reason:'CONTINUOUS_CUTOVER_REVIEW'}];
 const operator=[{state:'REVIEW'}],attempt=[{stage:'VIEWS',state:'IN_FLIGHT'}];
 assert.doesNotThrow(()=>verifyReadiness('RECONCILE_VIEWS',claim,operator,attempt,[],zero));
 assert.throws(()=>verifyReadiness('RECONCILE_VIEWS',claim,operator,[{stage:'VIEWS',state:'VERIFIED'}],[],zero),/CUTOVER_VIEWS_RECOVERY_NOT_READY/);
 assert.throws(()=>verifyReadiness('RECONCILE_VIEWS',claim,[{state:'HELD'}],attempt,[],zero),/CUTOVER_VIEWS_RECOVERY_NOT_READY/);
 assert.throws(()=>verifyReadiness('RECONCILE_VIEWS',claim,operator,attempt,[],{...zero,processing:1}),/CUTOVER_UNRESOLVED_D1/);
});
