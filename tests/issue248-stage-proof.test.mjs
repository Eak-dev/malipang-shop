import test from 'node:test';
import assert from 'node:assert/strict';
import {makeStageProof,evidenceDigest,verifyPostProof} from '../scripts/issue248-stage-proof.mjs';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const worker='a9cc50ba-f2f0-4cbe-a261-ff3bb65fc86c',queue='b9b12fe82e6b402291b5d16d2ce61770';
function fixture(){
 const d={review:0,held:0,inflight:0,epoch_total:0,epoch_active:0,admitted_ops:0,review_jobs:0,completed:3296,open_failed:32};
 const snapshot={params:{expectedWorkerVersion:worker},status:{ok:true,claim:null,inFlightProjections:0,recoveryGate:{mode:'UNARMED'},sheetPacing:{mode:'UNARMED'}},cloudflare:{cron:[{cron:'*/5 * * * *'}],queue:{queue_name:'malipang-jobs',queue_id:queue,settings:{delivery_paused:false}},versions:[{version_id:worker,percentage:100}]}};
 const nonce='synthetic_nonce_123456789';
 const intentRaw=JSON.stringify({schema:'MP248_SUPERVISED_V1',id:nonce,phase:'05_cas_intent',previous:'f'.repeat(64),body:{claim:'a'.repeat(64),at:new Date(Date.now()-1000).toISOString()}});
 const intentDigest=createHash('sha256').update(intentRaw).digest('hex');
 const ackRaw=JSON.stringify({schema:'MP248_SUPERVISED_V1',id:nonce,phase:'06_cas_ack',previous:intentDigest,body:{changes:1}});
 return {mode:'POST',nonce,run:'123',attempt:'1',sourceSha:'a'.repeat(40),workerVersion:worker,snapshot,extraD1:[{success:true,meta:{changed_db:false,rows_written:0},results:[d]}],intentRaw,ackRaw,observationStartedAt:new Date().toISOString()};
}
function provenance(){
 const x=fixture(),p=makeStageProof(x),key=`release-control/pr247/g6b-stage/${x.nonce}/${x.run}-${x.attempt}.json`;
 const steps=['Pin reviewed source','Collect provider post-CAS state','Persist evidence and read back'].map(name=>({name,status:'completed',conclusion:'success'}));
 return {raw:JSON.stringify(p),receiptKey:key,markerKey:key,markerDigest:evidenceDigest(p),markerStep:'Persist evidence and read back',expectedSha:x.sourceSha,expectedNonce:x.nonce,expectedIntentDigest:p.intentDigest,expectedAckDigest:p.ackDigest,run:{id:123,run_attempt:1,status:'completed',conclusion:'success',head_sha:x.sourceSha,head_branch:'main',event:'workflow_dispatch',path:'.github/workflows/issue248-post-cas-proof.yml'},jobs:{jobs:[{name:'post-cas-proof',run_id:123,status:'completed',conclusion:'success',steps}]},now:Date.now()};
}
test('verified post-CAS proof has real required evidence structure',()=>{const p=provenance();assert.equal(verifyPostProof(p).status.claim,null);});
for(const [label,mutate] of [
 ['review',x=>x.extraD1[0].results[0].review=1],['held',x=>x.extraD1[0].results[0].held=1],['inflight',x=>x.extraD1[0].results[0].inflight=1],['total epoch',x=>x.extraD1[0].results[0].epoch_total=1],['active epoch',x=>x.extraD1[0].results[0].epoch_active=1],['admitted op',x=>x.extraD1[0].results[0].admitted_ops=1],['review jobs',x=>x.extraD1[0].results[0].review_jobs=1],['new failure',x=>x.extraD1[0].results[0].open_failed=33],['claim',x=>x.snapshot.status.claim={state:'REVIEW'}],['gate',x=>x.snapshot.status.recoveryGate.mode='DISABLED'],['queue',x=>x.snapshot.cloudflare.queue.settings.delivery_paused=true],['worker',x=>x.snapshot.cloudflare.versions[0].version_id='wrong'],['non-read D1',x=>x.extraD1[0].meta.rows_written=1],['unexpected D1 field',x=>x.extraD1[0].results[0].extra='x'],['ack missing',x=>x.ackRaw=''],['ack malformed',x=>x.ackRaw='{}'],['intent drift',x=>x.intentRaw=x.intentRaw.replace('05_cas_intent','05_cas_changed')]
])test(`rejects ${label}`,()=>{const x=fixture();mutate(x);assert.throws(()=>makeStageProof(x),/NO_GO_/);});
for(const [label,mutate] of [
 ['digest',p=>p.markerDigest='0'.repeat(64)],['marker step',p=>p.markerStep='wrong'],['intent digest',p=>p.expectedIntentDigest='0'.repeat(64)],['ack digest',p=>p.expectedAckDigest='0'.repeat(64)],['receipt path',p=>p.receiptKey+='x'],['attempt',p=>p.run.run_attempt=2],['run failure',p=>p.run.conclusion='failure'],['source',p=>p.run.head_sha='0'.repeat(40)],['job step',p=>p.jobs.jobs[0].steps[2].conclusion='failure'],['nonce',p=>p.expectedNonce='different_nonce_123456'],['freshness',p=>p.now+=301000]
])test(`rejects provenance ${label}`,()=>{const p=provenance();mutate(p);assert.throws(()=>verifyPostProof(p),/NO_GO_/);});
test('rejects audit ID mismatch',()=>{const x=fixture();x.nonce='other_audit_id_123456789';assert.throws(()=>makeStageProof(x),/NO_GO_/);});
test('rejects observation begun before intent',()=>{const x=fixture();x.observationStartedAt=new Date(Date.now()-2000).toISOString();assert.throws(()=>makeStageProof(x),/NO_GO_CAS_ORDER/);});
test('rejects CAS acknowledgement from another intent',()=>{const x=fixture();const ack=JSON.parse(x.ackRaw);ack.previous='b'.repeat(64);x.ackRaw=JSON.stringify(ack);assert.throws(()=>makeStageProof(x),/NO_GO_CAS_ACK/);});
test('workflow captures sanitized read-only post-state with exact source and readback',()=>{
 const s=readFileSync('.github/workflows/issue248-post-cas-proof.yml','utf8');
 assert.match(s,/workflow_dispatch:/);assert.match(s,/git ls-remote origin refs\/heads\/main/);
 assert.match(s,/sha256sum --check/);assert.match(s,/mp248-snapshot\.sh/);
 assert.match(s,/status='REVIEW'/);assert.match(s,/MP248_STAGE_PROOF_KEY=/);
 assert.match(s,/wrangler r2 object put/);assert.match(s,/wrangler r2 object get/);assert.match(s,/cmp .*mp248-stage-proof/);
 assert.match(s,/05_cas_intent\.json/);assert.match(s,/06_cas_ack\.json/);assert.match(s,/AS epoch_total/);assert.match(s,/AS admitted_ops/);
 const beforeSteps=s.slice(0,s.indexOf('    steps:'));assert.doesNotMatch(beforeSteps,/secrets\.(?:CLOUDFLARE_API_TOKEN|MALIPANG_ADMIN_TOKEN)/);
 assert.doesNotMatch(s,/wrangler (?:deploy|d1 migrations)|\b(?:DELETE|UPDATE|INSERT)\b/);
});
