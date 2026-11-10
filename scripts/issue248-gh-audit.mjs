// G6b audit writer candidate. Executes only in a reviewed manual GH workflow.
// No D1, Worker configuration, Google Sheets or business-record mutation.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const phases=['01_preimage','02_write_intent','03_write_ack','03_write_ack_unknown','04_readback','05_cas_intent','06_cas_ack','07_post_cas'];
const prior={'02_write_intent':'01_preimage','03_write_ack':'02_write_intent','03_write_ack_unknown':'02_write_intent','04_readback':'03_write_ack','05_cas_intent':'04_readback','06_cas_ack':'05_cas_intent','07_post_cas':'06_cas_ack'};
const fail=x=>{throw Error('NO_GO_'+x)};
const keys=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&JSON.stringify(Object.keys(o).sort())===JSON.stringify([...k].sort());
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const nonce=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{16,128}$/.test(x);
const digest=x=>createHash('sha256').update(x).digest('hex');
export function validateRecord(raw,id){
 if(!nonce(id)||typeof raw!=='string'||Buffer.byteLength(raw)>8192)fail('RECORD_INPUT');let r;try{r=JSON.parse(raw)}catch{fail('RECORD_JSON')}
 if(JSON.stringify(r)!==raw||!keys(r,['schema','id','phase','previous','body'])||r.schema!=='MP248_SUPERVISED_V1'||r.id!==id||!phases.includes(r.phase)||(r.phase==='01_preimage'?r.previous!==null:!hex(r.previous)))fail('RECORD_SHAPE');
 const b=r.body;
 switch(r.phase){
 case '01_preimage':if(!keys(b,['claim','style','nonce','binding','preimageDigest','pausedReceiptDigest','diagnosticRun','diagnosticAttempt','diagnosticSource','diagnosticWorker'])||![b.claim,b.style,b.binding,b.preimageDigest,b.pausedReceiptDigest].every(hex)||!nonce(b.nonce)||!/^[1-9][0-9]{0,15}$/.test(b.diagnosticRun??'')||!/^[1-9][0-9]{0,15}$/.test(b.diagnosticAttempt??'')||!/^[a-f0-9]{40}$/.test(b.diagnosticSource??'')||!/^[a-f0-9-]{30,40}$/.test(b.diagnosticWorker??''))fail('PREIMAGE');break;
 case '02_write_intent':if(!keys(b,['newTime'])||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(b.newTime??''))fail('INTENT');break;
 case '03_write_ack':if(!keys(b,['responseDigest'])||!hex(b.responseDigest))fail('ACK');break;
 case '03_write_ack_unknown':if(!keys(b,['readback'])||!['MATCHED','UNKNOWN'].includes(b.readback))fail('ACK_UNKNOWN');break;
 case '04_readback':if(!keys(b,['readbackDigest','readyNonce','binding','readyReceiptDigest','readiness'])||!hex(b.readbackDigest)||!nonce(b.readyNonce)||!hex(b.binding)||!hex(b.readyReceiptDigest)||b.readiness!=='READY_OBSERVED')fail('READBACK');break;
 case '05_cas_intent':if(!keys(b,['claim','at'])||!hex(b.claim)||typeof b.at!=='string'||!Number.isFinite(Date.parse(b.at))||new Date(b.at).toISOString()!==b.at)fail('CAS_INTENT');break;
 case '06_cas_ack':if(!keys(b,['changes'])||b.changes!==1)fail('CAS_ACK');break;
 case '07_post_cas':if(!keys(b,['finalDigest'])||!hex(b.finalDigest))fail('POST');break;
 }
 return r;
}
export async function writeAuditOnce({id,raw,fetcher,account,token}){
 const r=validateRecord(raw,id);if(typeof fetcher!=='function'||typeof account!=='string'||!/^[a-f0-9]{32}$/.test(account)||typeof token!=='string'||!token)fail('CONFIG');
 const path=`release-control/pr247/g6b/${id}/${r.phase}.json`,base=`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/malipang-private-backups/objects/`,url=key=>base+key.split('/').map(encodeURIComponent).join('/');
 const read=async key=>{let x;try{x=await fetcher(url(key),{method:'GET',headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000),redirect:'error'});}catch{fail('GET_UNKNOWN')}
  if(x.status===404){let e;try{e=await x.json()}catch{fail('GET_UNKNOWN')}if(e?.success!==false||!Array.isArray(e.errors)||!e.errors.some(z=>z.code===10007))fail('GET_UNKNOWN');return null;}
  if(x.status!==200)fail('GET_UNKNOWN');return await x.text();};
 if(await read(path)!==null)fail('KEY_EXISTS');
 const pkey=`release-control/pr247/g6b/${id}/${r.phase==='01_preimage'?'00_paused_provider':prior[r.phase]}.json`,old=await read(pkey);
 if(typeof old!=='string')fail('PRIOR_MISSING');
 if(r.phase==='01_preimage'){
  let p;try{p=JSON.parse(old)}catch{fail('PAUSED_PROOF')}
  if(digest(old)!==r.body.pausedReceiptDigest||p.schema!=='MP248_NOTICE_CALLER_V1'||p.phase!=='PAUSED'||p.audit_id!==id||p.nonce!==r.body.nonce||p.claim_fingerprint!==r.body.claim||p.style_fingerprint!==r.body.style||p.binding!==r.body.binding||p.deploy_run!==r.body.diagnosticRun||p.deploy_attempt!==r.body.diagnosticAttempt||p.diagnostic_source!==r.body.diagnosticSource||p.worker_version!==r.body.diagnosticWorker)fail('PAUSED_PROOF');
 }else if(digest(old)!==r.previous)fail('PRIOR_DIGEST');
 let put;try{put=await fetcher(url(path),{method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'application/octet-stream'},body:raw,signal:AbortSignal.timeout(20000),redirect:'error'});}catch{fail('PUT_UNKNOWN_NO_RETRY')}
 if(put.status!==200)fail('PUT_UNKNOWN_NO_RETRY');let ack;try{ack=await put.json()}catch{fail('PUT_UNKNOWN_NO_RETRY')}
 if(ack?.success!==true||ack.result?.key!==path||typeof ack.result?.etag!=='string'||!/^[A-Za-z0-9_."-]{1,256}$/.test(ack.result.etag))fail('PUT_UNKNOWN_NO_RETRY');
 const returned=await read(path);if(returned!==raw)fail('READBACK_UNKNOWN_NO_RETRY');
 return {key:path,digest:digest(raw),etag:ack.result.etag};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const {GITHUB_EVENT_PATH,CLOUDFLARE_ACCOUNT_ID,CLOUDFLARE_API_TOKEN}=process.env;const event=JSON.parse(readFileSync(GITHUB_EVENT_PATH,'utf8')),id=event?.inputs?.audit_id,encoded=event?.inputs?.record_base64;if(typeof encoded!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)||encoded.length>12000)fail('RECORD_ENCODING');const raw=Buffer.from(encoded,'base64').toString('utf8');if(Buffer.from(raw,'utf8').toString('base64')!==encoded)fail('RECORD_ENCODING');const out=await writeAuditOnce({id,raw,fetcher:fetch,account:CLOUDFLARE_ACCOUNT_ID,token:CLOUDFLARE_API_TOKEN});console.log('MP248_AUDIT_SHA256='+out.digest);console.log('MP248_AUDIT_KEY='+out.key);console.log('MP248_AUDIT_ETAG_B64='+Buffer.from(out.etag,'utf8').toString('base64url'));}catch(e){console.error(typeof e?.message==='string'&&/^NO_GO_[A-Z0-9_]+$/.test(e.message)?e.message:'NO_GO_UNKNOWN');process.exitCode=1;}
}
