import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseProbeEvidence,runHistoricalDailyProbe} from '../scripts/prod-historical-daily-probe.mjs';

const sha='a'.repeat(40),version='11111111-2222-3333-4444-555555555555';
const digest=n=>String(n).repeat(64);
const receipt={incidentFingerprint:digest(1),archiveIdentityDigest:digest(2),archiveGridDigest:digest(3),
 approvedDeltaDigest:digest(4),liveGridDigest:digest(5)};
const expectedHash=createHash('sha256').update(JSON.stringify(['issue296-exact-daily-historical-receipt-v1',
 ...Object.values(receipt)])).digest('hex');
const evidence=JSON.stringify({receipt,preimageDigest:digest(6)});
const env={EXPECTED_SHA:sha,GITHUB_SHA:sha,GITHUB_REF:'refs/heads/main',GITHUB_RUN_ATTEMPT:'1',
 CONFIRMATION:'OWNER APPROVES HISTORICAL DAILY PROBE '+sha.slice(0,7),EXTERNAL_WRITERS_FENCED:'true',
 OWNER_SUPERVISING:'true',EXPECTED_WORKER_VERSION_SHA256:createHash('sha256').update(version).digest('hex'),
 CLOUDFLARE_ACCOUNT_ID:'account',CLOUDFLARE_API_TOKEN:'cf-test',MALIPANG_ADMIN_TOKEN:'admin-test',
 MALIPANG_WORKER_URL:'https://worker.example',MALIPANG_HISTORICAL_DAILY_PROBE:evidence};

function world({secondVersion=version,response={},status=200,workerResponse}={}){
 const calls=[];let deployments=0;
 const send=async (url,options)=>{
  calls.push({url:String(url),options});
  if(String(url).includes('api.cloudflare.com')){
   const id=deployments++===0?version:secondVersion;
   return Response.json({success:true,result:{deployments:[{versions:[{version_id:id,percentage:100}]}]}});
  }
  return workerResponse??Response.json({ok:true,outcome:'MATCHED',fingerprint:receipt.incidentFingerprint,
   servedVersion:version,historicalReceiptDigest:expectedHash,preimageDigest:digest(6),...response},{status});
 };
 return {calls,send};
}

test('incident-only release parses exactly a hash-only receipt and preserves canonical field order',()=>{
 assert.deepEqual(parseProbeEvidence(evidence),{receipt,preimageDigest:digest(6),pin:expectedHash});
 assert.equal(parseProbeEvidence(JSON.stringify({receipt:{...receipt,extra:'private'},preimageDigest:digest(6)})),null);
 assert.equal(parseProbeEvidence(JSON.stringify({receipt,preimageDigest:'bad'})),null);
});

test('operator reports only HTTP status and an allowlisted HELD stage',async()=>{
 const cases=[
  {status:409,response:{ok:false,outcome:'HELD',stage:'NOTICE',payload:'private'},diagnostic:' HTTP_409 STAGE_NOTICE'},
  {status:409,response:{ok:false,outcome:'HELD',stage:'NOTICE\nprivate'},diagnostic:' HTTP_409'},
  {status:409,response:{stage:'CONFIG'},diagnostic:' HTTP_409'},
  {status:503,response:{ok:false,outcome:'HELD',stage:'NOTICE'},diagnostic:' HTTP_503'},
  {workerResponse:new Response('private',{status:409}),diagnostic:' HTTP_409'},
  {response:{preimageDigest:digest(9)},diagnostic:' HTTP_200'},
 ];
 for(const {diagnostic,...options} of cases){
  const w=world(options);
  await assert.rejects(runHistoricalDailyProbe(env,w.send),{message:'PROBE_RESULT_UNVERIFIED'+diagnostic});
  assert.deepEqual(w.calls.map(c=>c.options.method),['GET','POST']);
 }
});

test('workflow CLI logs the bounded diagnostic on stderr and exits unsuccessfully',()=>{
 const fake=`globalThis.fetch=async url=>String(url).includes('api.cloudflare.com')
  ?Response.json({success:true,result:{deployments:[{versions:[{version_id:${JSON.stringify(version)},percentage:100}]}]}})
  :Response.json({ok:false,outcome:'HELD',stage:'POSTIMAGE',payload:'private-payload-marker',fingerprint:'private-fingerprint-marker'},{status:409});`;
 const script=fileURLToPath(new URL('../scripts/prod-historical-daily-probe.mjs',import.meta.url));
 const result=spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(fake),script],{env,encoding:'utf8'});
 assert.equal(result.status,1);
 assert.equal(result.stdout,'');
 assert.equal(result.stderr,'PROBE_RESULT_UNVERIFIED HTTP_409 STAGE_POSTIMAGE\n');
});

test('operator workflow uses Production approval, shared release exclusion and a failing pipeline',()=>{
 const workflow=readFileSync(new URL('../.github/workflows/prod-historical-daily-probe.yml',import.meta.url),'utf8');
 assert.match(workflow,/workflow_dispatch:/);
 assert.match(workflow,/group: malipang-release-control\s+cancel-in-progress: false/);
 assert.match(workflow,/if: github\.ref == 'refs\/heads\/main'[\s\S]+environment: production/);
 assert.match(workflow,/- name: Read the held DAILY incident\s+shell: bash[\s\S]+run: node scripts\/prod-historical-daily-probe\.mjs \| tee/);
 assert.match(workflow,/MALIPANG_HISTORICAL_DAILY_PROBE: \$\{\{ secrets\.MALIPANG_HISTORICAL_DAILY_PROBE \}\}/);
 assert.doesNotMatch(workflow,/inputs\.(receipt|fingerprint|preimageDigest)\b/);
});

test('operator sends only one historical PROBE between exact live-version reads',async()=>{
 const w=world();await runHistoricalDailyProbe(env,w.send);
 assert.deepEqual(w.calls.map(c=>c.options.method),['GET','POST','GET']);
 const r=w.calls[1];
 assert.equal(r.url,'https://worker.example/admin/stable-sync/exact-daily-settlement');
 assert.equal(r.options.headers['x-malipang-expected-worker-version'],version);
 assert.equal(r.options.redirect,'error');
 assert.deepEqual(JSON.parse(r.options.body),{action:'PROBE',fingerprint:receipt.incidentFingerprint,historicalReceipt:receipt});
});

test('operator rejects wrong authority or Worker before dispatch, and never retries a mismatched proof',async()=>{
 for(const bad of [{GITHUB_SHA:'b'.repeat(40)},{OWNER_SUPERVISING:'false'},{GITHUB_RUN_ATTEMPT:'2'}]){
  const w=world();await assert.rejects(runHistoricalDailyProbe({...env,...bad},w.send),/PROBE_INPUT_INVALID/);
  assert.equal(w.calls.length,0);
 }
 const wrongWorker=world();
 await assert.rejects(runHistoricalDailyProbe({...env,EXPECTED_WORKER_VERSION_SHA256:digest(9)},wrongWorker.send),/PROBE_WORKER_CHANGED/);
 assert.equal(wrongWorker.calls.length,1);
 const wrongProof=world({response:{preimageDigest:digest(9)}});
 await assert.rejects(runHistoricalDailyProbe(env,wrongProof.send),/PROBE_RESULT_UNVERIFIED/);
 assert.equal(wrongProof.calls.length,2);
 const drift=world({secondVersion:'22222222-2222-3333-4444-555555555555'});
 await assert.rejects(runHistoricalDailyProbe(env,drift.send),/PROBE_WORKER_CHANGED/);
 assert.equal(drift.calls.length,3);
});
