// Read-only Cloudflare isolation checks. This is not a UAT execution or an
// authorization to deploy. LINE/Sheets Worker-secret bindings cannot be
// verified through the Cloudflare settings API; they remain NOT_PROVEN.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const namePattern=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const configKeys=['uatWorker','uatDatabase','uatQueue','uatDeadLetterQueue','uatEvidenceBucket'];
const settingsBinding=(settings,name,type)=>{
  const matches=(settings?.bindings||[]).filter(b=>b.name===name&&b.type===type);
  return matches.length===1?matches[0]:null;
};
const value=(settings,name)=>settingsBinding(settings,name,'plain_text')?.text;

/** Validate observed resources only. `blocked` cannot be overridden by config. */
export function evaluateIsolation({config,productionConfig,productionSettings,uatSettings,databases,queues,consumers}){
  const checks=[];
  const check=(name,ok)=>checks.push({name,status:ok?'PASS':'FAIL'});
  const validConfig=configKeys.every(k=>typeof config?.[k]==='string'&&namePattern.test(config[k])&&!/replace|placeholder/i.test(config[k]));
  check('UAT_CONFIG_COMPLETE',validConfig);
  const prodDb=settingsBinding(productionSettings,'DB','d1'),testDb=settingsBinding(uatSettings,'DB','d1');
  const prodQueue=settingsBinding(productionSettings,'JOB_QUEUE','queue'),testQueue=settingsBinding(uatSettings,'JOB_QUEUE','queue');
  const prodBucket=settingsBinding(productionSettings,'EVIDENCE','r2_bucket'),testBucket=settingsBinding(uatSettings,'EVIDENCE','r2_bucket');
  const configuredDb=productionConfig?.d1_databases?.find(d=>d.binding==='DB'),configuredQueue=productionConfig?.queues?.producers?.find(q=>q.binding==='JOB_QUEUE'),configuredBucket=productionConfig?.r2_buckets?.find(b=>b.binding==='EVIDENCE');
  const d1=Array.isArray(databases)?databases.filter(x=>x.name===config?.uatDatabase):[];
  const q=Array.isArray(queues)?queues.filter(x=>x.queue_name===config?.uatQueue):[],dlq=Array.isArray(queues)?queues.filter(x=>x.queue_name===config?.uatDeadLetterQueue):[];
  const prodDbId=prodDb?.database_id||prodDb?.id,testDbId=testDb?.database_id||testDb?.id;
  check('PRODUCTION_BASELINE_MATCHES',!!(productionConfig?.name&&prodDbId&&prodDbId===configuredDb?.database_id&&prodQueue?.queue_name===configuredQueue?.queue&&prodBucket?.bucket_name===configuredBucket?.bucket_name));
  check('WORKER_DISTINCT',!!(validConfig&&productionConfig?.name&&config.uatWorker!==productionConfig.name&&Array.isArray(uatSettings?.bindings)));
  check('UAT_RUNTIME_CONFIG',value(uatSettings,'APP_ENV')==='uat'&&value(uatSettings,'RUNTIME_MODE')==='shadow'&&value(uatSettings,'SHADOW_LINE_OUTPUT')==='true');
  check('D1_DISTINCT',!!(validConfig&&d1.length===1&&d1[0].uuid&&testDbId===d1[0].uuid&&testDbId!==prodDbId));
  const prodDlq=productionConfig?.queues?.consumers?.find(x=>x.queue===configuredQueue?.queue)?.dead_letter_queue;
  check('QUEUE_DISTINCT',!!(validConfig&&q.length===1&&dlq.length===1&&q[0].queue_id&&dlq[0].queue_id&&q[0].queue_id!==dlq[0].queue_id&&testQueue?.queue_name===config.uatQueue&&![prodQueue?.queue_name,prodDlq].includes(config.uatQueue)&&![prodQueue?.queue_name,prodDlq,config.uatQueue].includes(config.uatDeadLetterQueue)));
  check('QUEUE_CONSUMERS_ISOLATED',!!(Array.isArray(consumers?.main)&&Array.isArray(consumers?.dlq)&&consumers.main.length===1&&consumers.dlq.length===1&&consumers.main[0].script===config?.uatWorker&&consumers.main[0].dead_letter_queue===config?.uatDeadLetterQueue&&consumers.dlq[0].script===config?.uatWorker));
  check('EVIDENCE_BUCKET_DISTINCT',!!(validConfig&&prodBucket?.bucket_name&&testBucket?.bucket_name===config.uatEvidenceBucket&&testBucket.bucket_name!==prodBucket.bucket_name));
  for(const name of ['LINE_WORKER_SECRET_BINDING_ISOLATION','SHEETS_WORKER_SECRET_BINDING_ISOLATION','SYNTHETIC_USERS_AND_DATA','ISOLATED_SERVICE_UAT'])checks.push({name,status:'NOT_PROVEN'});
  return {ready:false,checks};
}

/** Calls only Cloudflare GET endpoints, using a supplied request transport. */
export async function inspectCloudflare({config,productionConfig,request}){
  const invalid=configKeys.some(k=>typeof config?.[k]!=='string'||!namePattern.test(config[k])||/replace|placeholder/i.test(config[k]));
  if(invalid||!namePattern.test(productionConfig?.name||''))return evaluateIsolation({config,productionConfig});
  const [productionSettings,uatSettings,databases,queues]=await Promise.all([
    request(`/workers/scripts/${encodeURIComponent(productionConfig.name)}/settings`),request(`/workers/scripts/${encodeURIComponent(config.uatWorker)}/settings`),
    request('/d1/database'),request('/queues')
  ]);
  const main=Array.isArray(queues)?queues.find(q=>q.queue_name===config.uatQueue):null,dlq=Array.isArray(queues)?queues.find(q=>q.queue_name===config.uatDeadLetterQueue):null;
  const [mainConsumers,dlqConsumers]=await Promise.all([main?.queue_id?request(`/queues/${encodeURIComponent(main.queue_id)}/consumers`):null,dlq?.queue_id?request(`/queues/${encodeURIComponent(dlq.queue_id)}/consumers`):null]);
  return evaluateIsolation({config,productionConfig,productionSettings,uatSettings,databases,queues,consumers:{main:mainConsumers,dlq:dlqConsumers}});
}

async function main(){
  const path=process.argv[2];if(!path){process.stderr.write('Usage: node scripts/owner-correction-uat-preflight.mjs <uat-config.json>\n');process.exitCode=2;return;}
  const token=process.env.CLOUDFLARE_API_TOKEN,account=process.env.CLOUDFLARE_ACCOUNT_ID;
  if(!token||!account||!/^[a-f0-9]{32}$/i.test(account)){process.stderr.write('Cloudflare read credentials are missing or invalid.\n');process.exitCode=2;return;}
  try{
    const [config,productionConfig]=await Promise.all([readFile(path,'utf8').then(JSON.parse),readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8').then(JSON.parse)]);
    const request=async endpoint=>{
      const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${endpoint}`,{method:'GET',headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error('API_READ_FAILED');const body=await response.json();if(!body.success||body.result_info?.total_pages>1)throw Error('API_READ_INCOMPLETE');return body.result;
    };
    const result=await inspectCloudflare({config,productionConfig,request});process.stdout.write(JSON.stringify(result,null,2)+'\n');process.exitCode=result.ready?0:1;
  }catch{process.stderr.write('Preflight could not verify Cloudflare resources; no readiness is granted.\n');process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
