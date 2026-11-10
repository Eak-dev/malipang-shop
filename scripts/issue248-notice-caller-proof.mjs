import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const hex=x=>typeof x==='string' && /^[0-9a-f]{64}$/.test(x);
const nonce=x=>typeof x==='string' && /^[A-Za-z0-9_-]{16,128}$/.test(x);
export function checkDiagnostic({mode,expectedNonce,response,claim=null,style=null,readyTime=null}) {
 if (!['PAUSED','READY'].includes(mode)||!nonce(expectedNonce)||!response||Object.keys(response).sort().join(',')!=='binding,claim_fingerprint,mode,nonce,ok,style_fingerprint'||response.ok!==true||response.mode!==mode||response.nonce!==expectedNonce||!hex(response.claim_fingerprint)||!hex(response.style_fingerprint)||!hex(response.binding)) throw Error('DIAGNOSTIC_RESPONSE_INVALID');
 if(mode==='READY'&&(!hex(claim)||!hex(style)||response.claim_fingerprint!==claim||response.style_fingerprint!==style||typeof readyTime!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(readyTime)))throw Error('READY_AUDIT_MISMATCH');
 const calculated=hash(['MP248_ORIGINAL_NOTICE_V1',mode,expectedNonce,response.claim_fingerprint,response.style_fingerprint,mode==='READY'?'NORMAL':null,mode==='READY'?readyTime:null]);
 if(response.binding!==calculated)throw Error('DIAGNOSTIC_BINDING_INVALID');return response;
}
export function checkAudit({id,paused,audit1,audit2,source,worker,deployRun,deployAttempt,callerRun,callerAttempt,callerSource,nowMillis=Date.now()}) {
 if(!nonce(id)||!paused||paused.schema!=='MP248_NOTICE_CALLER_V1'||paused.phase!=='PAUSED'||paused.audit_id!==id||paused.diagnostic_source!==source||paused.worker_version!==worker||paused.deploy_run!==deployRun||paused.deploy_attempt!==deployAttempt||paused.caller_run!==callerRun||paused.caller_attempt!==callerAttempt||paused.caller_source_sha!==callerSource||!nonce(paused.nonce)||!hex(paused.claim_fingerprint)||!hex(paused.style_fingerprint)||!hex(paused.binding))throw Error('PAUSED_RECEIPT_INVALID');
 checkDiagnostic({mode:'PAUSED',expectedNonce:paused.nonce,response:{ok:true,mode:'PAUSED',nonce:paused.nonce,claim_fingerprint:paused.claim_fingerprint,style_fingerprint:paused.style_fingerprint,binding:paused.binding}});
 if(!audit1||audit1.schema!=='MP248_SUPERVISED_V1'||audit1.id!==id||audit1.phase!=='01_preimage'||audit1.previous!==null||audit1.body?.pausedReceiptDigest!==hash(paused)||audit1.body.claim!==paused.claim_fingerprint||audit1.body.style!==paused.style_fingerprint||audit1.body.nonce!==paused.nonce||audit1.body.binding!==paused.binding||audit1.body.diagnosticRun!==deployRun||audit1.body.diagnosticAttempt!==deployAttempt||audit1.body.diagnosticSource!==source||audit1.body.diagnosticWorker!==worker)throw Error('PREIMAGE_AUDIT_INVALID');
 if(!audit2||audit2.schema!=='MP248_SUPERVISED_V1'||audit2.id!==id||audit2.phase!=='02_write_intent'||audit2.previous!==hash(audit1)||typeof audit2.body?.newTime!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(audit2.body.newTime))throw Error('WRITE_INTENT_INVALID');
 const stamp=audit2.body.newTime, ms=Date.parse(stamp.replace(' ','T')+'+07:00');
 if(!Number.isFinite(ms)||new Date(ms+7*3600000).toISOString().slice(0,19)!==stamp.replace(' ','T')||!Number.isFinite(nowMillis)||ms>nowMillis+30000||nowMillis-ms>300000)throw Error('READY_TIME_STALE_OR_INVALID');
 return {claim:paused.claim_fingerprint,style:paused.style_fingerprint,readyTime:stamp,originalNonce:paused.nonce};
}
