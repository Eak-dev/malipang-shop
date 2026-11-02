import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {evaluateIsolation,inspectCloudflare} from '../scripts/owner-correction-uat-preflight.mjs';

const fixture=()=>{
  const config={uatWorker:'worker-uat',uatDatabase:'db-uat',uatQueue:'queue-uat',uatDeadLetterQueue:'dlq-uat',uatEvidenceBucket:'bucket-uat'};
  const productionConfig={name:'worker-prod',d1_databases:[{binding:'DB',database_id:'prod-id'}],queues:{producers:[{binding:'JOB_QUEUE',queue:'queue-prod'}],consumers:[{queue:'queue-prod',dead_letter_queue:'dlq-prod'}]},r2_buckets:[{binding:'EVIDENCE',bucket_name:'bucket-prod'}]};
  const binding=(name,type,extra)=>({name,type,...extra});
  const productionSettings={bindings:[binding('DB','d1',{database_id:'prod-id'}),binding('JOB_QUEUE','queue',{queue_name:'queue-prod'}),binding('EVIDENCE','r2_bucket',{bucket_name:'bucket-prod'})]};
  const uatSettings={bindings:[binding('DB','d1',{database_id:'uat-id'}),binding('JOB_QUEUE','queue',{queue_name:'queue-uat'}),binding('EVIDENCE','r2_bucket',{bucket_name:'bucket-uat'}),binding('APP_ENV','plain_text',{text:'uat'}),binding('RUNTIME_MODE','plain_text',{text:'shadow'}),binding('SHADOW_LINE_OUTPUT','plain_text',{text:'true'})]};
  const databases=[{name:'db-prod',uuid:'prod-id'},{name:'db-uat',uuid:'uat-id'}],queues=[{queue_name:'queue-uat',queue_id:'uat-q'},{queue_name:'dlq-uat',queue_id:'uat-dlq'}];
  const consumers={main:[{script:'worker-uat',dead_letter_queue:'dlq-uat'}],dlq:[{script:'worker-uat'}]};
  return {config,productionConfig,productionSettings,uatSettings,databases,queues,consumers};
};
const check=(result,name)=>result.checks.find(c=>c.name===name)?.status;

test('Cloudflare fixtures can pass resource checks but cannot claim LINE, Sheets or live UAT proof',()=>{
  const result=evaluateIsolation(fixture());assert.equal(result.ready,false);
  for(const name of ['PRODUCTION_BASELINE_MATCHES','WORKER_DISTINCT','UAT_RUNTIME_CONFIG','D1_DISTINCT','QUEUE_DISTINCT','QUEUE_CONSUMERS_ISOLATED','EVIDENCE_BUCKET_DISTINCT'])assert.equal(check(result,name),'PASS',name);
  for(const name of ['LINE_WORKER_SECRET_BINDING_ISOLATION','SHEETS_WORKER_SECRET_BINDING_ISOLATION','SYNTHETIC_USERS_AND_DATA','ISOLATED_SERVICE_UAT'])assert.equal(check(result,name),'NOT_PROVEN',name);
});
test('production overlap, wrong worker consumers, unsafe runtime and duplicate resources fail closed',()=>{
  const cases=[
    ['WORKER_DISTINCT',x=>x.config.uatWorker='worker-prod'],
    ['D1_DISTINCT',x=>x.uatSettings.bindings.find(b=>b.name==='DB').database_id='prod-id'],
    ['QUEUE_DISTINCT',x=>x.uatSettings.bindings.find(b=>b.name==='JOB_QUEUE').queue_name='queue-prod'],
    ['QUEUE_CONSUMERS_ISOLATED',x=>x.consumers.main[0].script='worker-prod'],
    ['QUEUE_CONSUMERS_ISOLATED',x=>x.consumers.main[0].dead_letter_queue='dlq-prod'],
    ['EVIDENCE_BUCKET_DISTINCT',x=>x.uatSettings.bindings.find(b=>b.name==='EVIDENCE').bucket_name='bucket-prod'],
    ['UAT_RUNTIME_CONFIG',x=>x.uatSettings.bindings.find(b=>b.name==='APP_ENV').text='production'],
    ['PRODUCTION_BASELINE_MATCHES',x=>x.productionSettings.bindings.find(b=>b.name==='DB').database_id='changed-id'],
    ['D1_DISTINCT',x=>x.databases.push({...x.databases[1]})]
  ];
  for(const [name,mutate] of cases){const input=fixture();mutate(input);const result=evaluateIsolation(input);assert.equal(check(result,name),'FAIL',name);assert.equal(result.ready,false);}
});
test('missing or placeholder configuration is rejected without any remote request',async()=>{
  const example=JSON.parse(readFileSync(new URL('../config/owner-correction-uat.example.json',import.meta.url),'utf8'));let calls=0;
  const result=await inspectCloudflare({config:example,productionConfig:fixture().productionConfig,request:async()=>{calls++;throw Error('unexpected')}});
  assert.equal(check(result,'UAT_CONFIG_COMPLETE'),'FAIL');assert.equal(result.ready,false);assert.equal(calls,0);
  assert.doesNotMatch(JSON.stringify(example),/token|secret|private.key|spreadsheet.id/i);
});
test('the inspector reads only the expected paths using sanitized simulated results',async()=>{
  const f=fixture(),called=[],answers={'/workers/scripts/worker-prod/settings':f.productionSettings,'/workers/scripts/worker-uat/settings':f.uatSettings,'/d1/database':f.databases,'/queues':f.queues,'/queues/uat-q/consumers':f.consumers.main,'/queues/uat-dlq/consumers':f.consumers.dlq};
  const result=await inspectCloudflare({config:f.config,productionConfig:f.productionConfig,request:async path=>{called.push(path);assert.ok(Object.hasOwn(answers,path));return answers[path]}});
  assert.equal(called.length,6);assert.equal(check(result,'QUEUE_CONSUMERS_ISOLATED'),'PASS');assert.equal(result.ready,false);
  assert.doesNotMatch(JSON.stringify(result),/uat-id|prod-id|worker-uat|queue-prod/);
});
test('the CLI keeps credentials private and refuses placeholder configuration without network',()=>{
  const secret='synthetic-sensitive-token',account='0'.repeat(32);
  const run=spawnSync(process.execPath,['scripts/owner-correction-uat-preflight.mjs','config/owner-correction-uat.example.json'],{cwd:new URL('../',import.meta.url),env:{...process.env,CLOUDFLARE_API_TOKEN:secret,CLOUDFLARE_ACCOUNT_ID:account},encoding:'utf8',timeout:5000});
  assert.equal(run.status,1);assert.doesNotMatch(run.stdout+run.stderr,new RegExp(`${secret}|${account}`));assert.match(run.stdout,/UAT_CONFIG_COMPLETE/);assert.match(run.stdout,/NOT_PROVEN/);
});
