import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export const HISTORICAL_DAILY_PIN='EXACT_DAILY_HISTORICAL_RECEIPT_SHA256';
const hex64=/^[a-f0-9]{64}$/;
const versionId=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fields=['incidentFingerprint','archiveIdentityDigest','archiveGridDigest','approvedDeltaDigest','liveGridDigest'];
const heldStages=new Set([
 'CONFIG','HISTORICAL_RECEIPT','INCIDENT','SOURCE','NOTICE','GRID','SNAPSHOT','LEGACY',
 'FORMAT','POSTIMAGE','ACCOUNTING','CARRIER','REPORT','FINAL_READS','PREIMAGE',
]);
const hash=value=>createHash('sha256').update(value).digest('hex');
const validHash=value=>typeof value==='string'&&hex64.test(value);
const fail=code=>{throw Error(code)};

class UnverifiedProbeResult extends Error{
 constructor(status,result){
  const http=Number.isInteger(status)&&status>=100&&status<=599?` HTTP_${status}`:'';
  const held=status===409&&result?.ok===false&&result.outcome==='HELD'&&heldStages.has(result.stage);
  super('PROBE_RESULT_UNVERIFIED'+http+(held?` STAGE_${result.stage}`:''));
 }
}

export function parseProbeEvidence(raw){
 if(typeof raw!=='string'||raw.length>2000)return null;
 let value;try{value=JSON.parse(raw)}catch{return null;}
 const {receipt,preimageDigest}=value??{};
 if(!value||Object.keys(value).length!==2||!validHash(preimageDigest)||
  !receipt||Object.keys(receipt).length!==fields.length||!fields.every(key=>validHash(receipt[key])))return null;
 const pin=hash(JSON.stringify(['issue296-exact-daily-historical-receipt-v1',...fields.map(key=>receipt[key])]));
 return {receipt,preimageDigest,pin};
}

export async function runHistoricalDailyProbe(env=process.env,send=fetch){
 const sha=env.EXPECTED_SHA??'';
 if(!/^[a-f0-9]{40}$/.test(sha)||sha!==env.GITHUB_SHA||env.GITHUB_REF!=='refs/heads/main'||
  env.GITHUB_RUN_ATTEMPT!=='1'||env.CONFIRMATION!==`OWNER APPROVES HISTORICAL DAILY PROBE ${sha.slice(0,7)}`||
  env.EXTERNAL_WRITERS_FENCED!=='true'||env.OWNER_SUPERVISING!=='true'||
  !validHash(env.EXPECTED_WORKER_VERSION_SHA256))fail('PROBE_INPUT_INVALID');
 const evidence=parseProbeEvidence(env.MALIPANG_HISTORICAL_DAILY_PROBE);
 if(!evidence||!env.MALIPANG_ADMIN_TOKEN||!env.CLOUDFLARE_ACCOUNT_ID||!env.CLOUDFLARE_API_TOKEN)fail('PROBE_ENV_INVALID');
 let url;try{url=new URL(env.MALIPANG_WORKER_URL)}catch{fail('PROBE_URL_INVALID');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')fail('PROBE_URL_INVALID');

 const {receipt,preimageDigest,pin}=evidence;
 const before=async()=>{
  const cf='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)+
   '/workers/scripts/malipang-backend-v5-2/deployments?per_page=1';
  let data;
  try{
   const response=await send(cf,{method:'GET',headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN},
    redirect:'error',signal:AbortSignal.timeout(30000)});
   if(response.ok)data=await response.json();
  }catch{}
  const versions=data?.success===true?data.result?.deployments?.[0]?.versions:null;
  const id=versions?.[0]?.version_id;
  if(versions?.length!==1||versions[0].percentage!==100||!versionId.test(id??'')||
   hash(id)!==env.EXPECTED_WORKER_VERSION_SHA256)fail('PROBE_WORKER_CHANGED');
  return id;
 };
 const worker=await before(),fingerprint=receipt.incidentFingerprint;
 let result,status,ok=false;
 try{
  const response=await send(new URL('/admin/stable-sync/exact-daily-settlement',url),{method:'POST',
   headers:{authorization:'Bearer '+env.MALIPANG_ADMIN_TOKEN,'content-type':'application/json',
    'x-malipang-expected-worker-version':worker},redirect:'error',signal:AbortSignal.timeout(240000),
   body:JSON.stringify({action:'PROBE',fingerprint,historicalReceipt:receipt})});
  status=response.status;
  ok=response.ok;
  if(ok||status===409)result=await response.json();
 }catch{}
 if(!ok||result?.ok!==true||result.outcome!=='MATCHED'||result.servedVersion!==worker||
  result.fingerprint!==fingerprint||result.historicalReceiptDigest!==pin||
  result.preimageDigest!==preimageDigest)throw new UnverifiedProbeResult(status,result);
 await before();
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
 try{await runHistoricalDailyProbe();console.log('HISTORICAL_DAILY_PROBE: MATCHED; WORKER_VERSION_MATCH; EVIDENCE_MATCH');}
 catch(error){
  const allowed=error instanceof UnverifiedProbeResult||/^PROBE_[A-Z_]+$/.test(error?.message??'');
  console.error(allowed?error.message:'PROBE_FAILED');
  process.exitCode=1;
 }
}
