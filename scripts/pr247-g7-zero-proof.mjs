// Issue #248: verify private zero-item canary evidence for G8. Read-only only.
// CLI emits a single status; GH logs and D1 target/trace stay in process memory.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const AUDIT_WRITER_SHA256='58d1a9ec864990ea3d2b8f08bdfce22278391a81b82aa54829d800731233cd76',AUDIT_WORKFLOW_SHA256='28c76e67e3ea53a5d5c568845aebb5f24cb9b8c1c9a6126b423e2ec6f21feab0';
const fail=x=>{throw Error('NO_GO_G7_ZERO_'+x)};
const hash=x=>createHash('sha256').update(x).digest('hex');
const hex=(x,n=64)=>typeof x==='string'&&x.length===n&&/^[a-f0-9]+$/.test(x);
const digit=x=>typeof x==='string'&&/^[1-9][0-9]{0,15}$/.test(x);
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&JSON.stringify(Object.keys(o).sort())===JSON.stringify([...keys].sort());
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const parse=raw=>{if(typeof raw!=='string'||Buffer.byteLength(raw)>8192)fail('FORMAT');let o;try{o=JSON.parse(raw)}catch{fail('FORMAT')}if(JSON.stringify(o)!==raw)fail('CANONICAL');return o};
function marker(raw,name){if(typeof raw!=='string'||raw.length>4000000)fail('GH_LOG');const re=new RegExp('\\b'+name+'=([^\\s]+)','g'),found=[...raw.matchAll(re)];if(found.length!==1)fail('GH_MARKER');return found[0][1]}
function checkRun(ev,runId,sourceSha,key,digest){
 const r=ev?.run,j=ev?.jobs?.jobs;if(!r||String(r.id)!==runId||r.run_attempt!==1||r.status!=='completed'||r.conclusion!=='success'||r.head_sha!==sourceSha||r.head_branch!=='main'||r.event!=='workflow_dispatch'||r.path!=='.github/workflows/issue248-g7-audit-writer.yml'||!Array.isArray(j)||j.length!==1||j[0].name!=='audit-write'||String(j[0].run_id)!==runId||j[0].status!=='completed'||j[0].conclusion!=='success'||!Array.isArray(j[0].steps))fail('GH_RUN');
 const pins=j[0].steps.filter(s=>s.name==='Pin reviewed source'&&s.status==='completed'&&s.conclusion==='success');const steps=j[0].steps.filter(s=>s.name==='Write one scoped audit object and verify'&&s.status==='completed'&&s.conclusion==='success');if(pins.length!==1||steps.length!==1||!Number.isSafeInteger(steps[0].number)||steps[0].number<1||!Number.isSafeInteger(j[0].id))fail('GH_STEP');
 if(marker(ev.log,'MP248_G7_AUDIT_SHA256')!==digest||marker(ev.log,'MP248_G7_AUDIT_KEY')!==key)fail('GH_MARKER');
}
// Hotfix-only exception (see pr247-stage-guard.mjs canaryDigestExceptionHolds); default is strict.
// The CLI enables it only with BOTH the owner phrase in env and the explicit flag
// that pr247-readonly-snapshot.sh passes solely in B_POST after the bracketed read.
export const CANARY_DIGEST_EXCEPTION='OWNER ACCEPTS G7 SOURCE REVISION ADVANCED HISTORICAL INTEGRITY UNKNOWN';
const revisionHolds=(epoch,intent,exception)=>exception!==true?epoch.source_revision===intent.sourceRevision:
 intent.sourceRevision===67&&integer(epoch.source_revision)&&epoch.source_revision>=intent.sourceRevision&&epoch.source_bracket_revision===epoch.source_revision&&epoch.source_current_digest===intent.sourceSnapshotDigest&&epoch.source_current_items===0&&epoch.source_current_documents===0&&epoch.source_current_links===0;
export function verifyZeroEvidence({receipt:r,intentRaw,outcomeRaw,epoch,runEvidence,canaryDigestException=false}){
 if(!r||r.schema!=='MP248_G7_RECEIPT_V3_ZERO_ITEM_RISK_ACCEPTED'||!hex(r.arm_audit_nonce,48)||!hex(r.arm_intent_sha256)||!hex(r.arm_outcome_sha256)||!hex(r.arm_workflow_source_sha,40)||!digit(r.arm_intent_run_id)||!digit(r.arm_outcome_run_id)||r.arm_intent_run_id===r.arm_outcome_run_id||!hex(r.source_snapshot_digest)||!integer(r.source_revision)||!Array.isArray(runEvidence)||runEvidence.length!==2)fail('RECEIPT');
 const intent=parse(intentRaw),outcome=parse(outcomeRaw);if(hash(intentRaw)!==r.arm_intent_sha256||hash(outcomeRaw)!==r.arm_outcome_sha256)fail('DIGEST');
 const fields=['schema','epoch','workbookHash','targetKeyHash','traceHash','sourceVersion','sourceSnapshotDigest','sourceRevision','targetCreatedAt','selectionSince','itemCount','providerHash','issuedAt','legacyScan','gcp429Coverage','gcp429Delta','ownerAccepted429ObservabilityRisk','auditMode'];
 if(!exact(intent,fields)||intent.schema!=='MP248_G7_ARM_INTENT_ZERO_LOCAL_V1'||intent.epoch!==r.epoch_id||!/^g7_[a-f0-9]{48}$/.test(intent.epoch??'')||intent.workbookHash!=='b8df793b7aafbedea3b9eb42c3bf4d4a8098bef8b91a8a6d5ea6d50fc6e5602f'||![intent.targetKeyHash,intent.traceHash,intent.sourceSnapshotDigest,intent.providerHash].every(x=>hex(x))||!integer(intent.sourceVersion)||intent.sourceVersion<1||!integer(intent.sourceRevision)||intent.sourceRevision!==r.source_revision||intent.sourceSnapshotDigest!==r.source_snapshot_digest||intent.itemCount!==0||![intent.selectionSince,intent.targetCreatedAt,intent.issuedAt].every(iso)||Date.parse(intent.selectionSince)>Date.parse(intent.targetCreatedAt)||Date.parse(intent.targetCreatedAt)>Date.parse(intent.issuedAt)||intent.legacyScan!=='NO_EXACT_CANDIDATE_RESIDUAL_UNKNOWN'||intent.gcp429Coverage!=='PARTIAL_UNKNOWN'||intent.gcp429Delta!==null||intent.ownerAccepted429ObservabilityRisk!==true||intent.auditMode!=='R2_SINGLE_WRITER_NONCONDITIONAL_OWNER_RISK_ACCEPTED')fail('INTENT');
 if(!exact(outcome,['schema','epoch','intentHash','status','classification'])||outcome.schema!=='MP248_G7_ARM_OUTCOME_LOCAL_V1'||outcome.epoch!==r.epoch_id||outcome.intentHash!==r.arm_intent_sha256||outcome.status!=='ARM_ACKNOWLEDGED'||outcome.classification!=='PRESENT_MATCHING')fail('OUTCOME');
 if(!epoch||typeof epoch.target_key!=='string'||!epoch.target_key||typeof epoch.target_trace!=='string'||!epoch.target_trace||!integer(epoch.target_version)||epoch.target_version!==intent.sourceVersion||!revisionHolds(epoch,intent,canaryDigestException)||hash(epoch.target_key)!==intent.targetKeyHash||hash(epoch.target_trace)!==intent.traceHash||epoch.epoch_immutability_triggers!==2||epoch.epoch_active_unique!==1)fail('D1_BINDING');
 const prefix=`release-control/pr247/g7/arm-audit/${r.arm_audit_nonce}`;
 checkRun(runEvidence[0],r.arm_intent_run_id,r.arm_workflow_source_sha,prefix+'-intent.json',r.arm_intent_sha256);checkRun(runEvidence[1],r.arm_outcome_run_id,r.arm_workflow_source_sha,prefix+'-outcome.json',r.arm_outcome_sha256);
 return true;
}
function gh(args,isLog=false){try{return execFileSync('gh',['api','--hostname','github.com',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:4_000_000,timeout:20000});}catch{fail(isLog?'GH_LOG_READ_UNKNOWN':'GH_API_READ_UNKNOWN');}}
function readRun(runId){
 const base=`repos/Eak-dev/malipang-shop/actions/runs/${runId}/attempts/1`,run=JSON.parse(gh([base])),jobs=JSON.parse(gh([base+'/jobs?per_page=100']));
 if(!Array.isArray(jobs.jobs)||jobs.total_count!==1||jobs.jobs.length!==1||!Number.isSafeInteger(jobs.jobs[0]?.id))fail('GH_JOB');
 const step=jobs.jobs[0].steps?.filter(x=>x.name==='Write one scoped audit object and verify');if(step?.length!==1||!Number.isSafeInteger(step[0].number)||step[0].number<1)fail('GH_STEP');
 // gh otherwise refuses step logs containing terminal escape sequences. The
 // output stays in memory and only strictly validated markers leave this path.
 const log=gh(['--allow-escape-sequences',`repos/Eak-dev/malipang-shop/actions/jobs/${jobs.jobs[0].id}/steps/${step[0].number}/logs`],true);return {run,jobs,log};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{
 const [receiptPath,intentPath,outcomePath,epochPath,...extra]=process.argv.slice(2);if(![receiptPath,intentPath,outcomePath,epochPath].every(x=>typeof x==='string'&&x))fail('ARGS');
 const canaryDigestException=extra.length===1&&extra[0]==='--canary-digest-exception-b-post';if(extra.length>1||extra.length===1&&!canaryDigestException||canaryDigestException&&process.env.MP248_G7_CANARY_DIGEST_EXCEPTION!==CANARY_DIGEST_EXCEPTION)fail('ARGS');
 const receipt=JSON.parse(readFileSync(receiptPath,'utf8')),intentRaw=readFileSync(intentPath,'utf8'),outcomeRaw=readFileSync(outcomePath,'utf8'),e=JSON.parse(readFileSync(epochPath,'utf8'));
 if(!digit(receipt.arm_intent_run_id)||!digit(receipt.arm_outcome_run_id)||!hex(receipt.arm_workflow_source_sha,40)||!Array.isArray(e)||e.length!==1||e[0]?.success!==true||!Array.isArray(e[0]?.results)||e[0].results.length!==1)fail('INPUT');
 execFileSync('git',['merge-base','--is-ancestor',receipt.arm_workflow_source_sha,'HEAD'],{stdio:'ignore',timeout:20000});for(const [path,want] of [['scripts/issue248-g7-audit.mjs',AUDIT_WRITER_SHA256],['.github/workflows/issue248-g7-audit-writer.yml',AUDIT_WORKFLOW_SHA256]]){const raw=execFileSync('git',['show',receipt.arm_workflow_source_sha+':'+path],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:20000});if(hash(raw)!==want)fail('SOURCE_PIN');}verifyZeroEvidence({receipt,intentRaw,outcomeRaw,epoch:e[0].results[0],runEvidence:[readRun(receipt.arm_intent_run_id),readRun(receipt.arm_outcome_run_id)],canaryDigestException});console.log('G7_ZERO_PROVIDER_PROVENANCE_VERIFIED');
 }catch(e){console.error(typeof e?.message==='string'&&/^NO_GO_[A-Z0-9_]+$/.test(e.message)?e.message:'NO_GO_G7_ZERO_EVIDENCE_UNKNOWN');process.exitCode=1;}}
