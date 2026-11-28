import {createHash} from 'node:crypto';
import {appendFileSync,readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {requireVerifiedBackup} from './prod-monthly-report.mjs';

const phases=['PROBE','SETTLE','HANDOVER_ONE','INSPECT_HANDOVER','READBACK','READ_HISTORICAL','FINISH_PILOT','RUN_SERIAL','RECOVER_ROUND','DISCOVER_ROUND','READ_ROUND','HOLD_RESERVED','CLOSE_MOCK_ROUND'];
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest=/^[a-f0-9]{64}$/;
const recordedTime=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)&&Number.isFinite(Date.parse(value));
const mutating=phase=>['SETTLE','HANDOVER_ONE','RUN_SERIAL','RECOVER_ROUND','HOLD_RESERVED','CLOSE_MOCK_ROUND'].includes(phase);
function stop(code){throw Error(code);}
export function pilotInputs(env){
  const phase=env.PILOT_PHASE;
  if(!phases.includes(phase)||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_RUN_ATTEMPT!=='1'||
    !/^[a-f0-9]{40}$/.test(env.EXPECTED_SHA)||env.EXPECTED_SHA!==env.GITHUB_SHA||
    !digest.test(env.EXPECTED_WORKER_VERSION_SHA256))stop('PILOT_INPUT_INVALID');
  if(['RECOVER_ROUND','READ_ROUND','HOLD_RESERVED','CLOSE_MOCK_ROUND'].includes(phase)&&!uuid.test(env.PILOT_ROUND_ID||''))stop('PILOT_INPUT_INVALID');
  if(!env.CLOUDFLARE_ACCOUNT_ID||!env.CLOUDFLARE_API_TOKEN||!env.MALIPANG_ADMIN_TOKEN)stop('PILOT_AUTH_UNAVAILABLE');
  if(mutating(phase)&&(!/^[1-9][0-9]{0,19}$/.test(env.BACKUP_RUN_ID||'')||!env.GITHUB_TOKEN||
    env.OWNER_SUPERVISING!=='true'||env.EXTERNAL_WRITERS_FENCED!=='true'))stop('PILOT_PREFLIGHT_MISSING');
  const base=new URL(env.MALIPANG_WORKER_URL);
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/')stop('PILOT_URL_INVALID');
  if((phase==='CLOSE_MOCK_ROUND'||phase==='RUN_SERIAL'&&env.PILOT_LOCAL_MOCK==='true')&&(env.PILOT_LOCAL_MOCK!=='true'||!['localhost','127.0.0.1','[::1]'].includes(base.hostname)))stop('PILOT_INPUT_INVALID');
  return {phase,base:base.origin};
}

const pending=`SELECT j.job_id FROM sync_jobs j JOIN expense_events e
  ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version
  JOIN continuous_daily_post_cutover_expenses p ON p.expense_id=e.expense_id
  JOIN continuous_daily_cutovers c ON c.spreadsheet_id=p.spreadsheet_id AND c.state='ACTIVE'
  WHERE j.status='PENDING' AND j.attempt_count=0 AND j.lease_token IS NULL AND j.lease_until IS NULL
    AND (j.next_attempt_at IS NULL OR j.next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    AND e.status='CONFIRMED' AND e.version=1 AND substr(e.transaction_date,1,7)=strftime('%Y-%m','now','+7 hours')`;
const queueOrder=' ORDER BY j.updated_at,j.entity_key';
const candidates=pending+" AND NOT EXISTS(SELECT 1 FROM admin_audit WHERE action='ISSUE296_PAUSED_NOTICE_HANDOVER')"+queueOrder+' LIMIT 1';
const serialCandidates=pending+" AND length(e.transaction_date)=10 AND date(e.transaction_date,'+0 days')=e.transaction_date"+queueOrder;
const reserved="SELECT entity_key AS job_id,reason AS fingerprint FROM admin_audit WHERE action='ISSUE296_PAUSED_NOTICE_HANDOVER' LIMIT 2";

const rootAction='ISSUE296_PAUSED_NOTICE_HANDOVER';
const successorAction='ISSUE296_SERIAL_EXPENSE_HANDOVER';
const serialAudit=`SELECT id,action,entity_key AS job_id,reason AS fingerprint,
  json_extract(before_json,'$.book') AS book,json_extract(before_json,'$.predecessorJobId') AS predecessor,
  json_extract(before_json,'$.proof') AS proof,json_extract(after_json,'$.version') AS version,
  json_extract(after_json,'$.roundId') AS round_id,json_extract(after_json,'$.epoch') AS epoch_id,
  json_extract(after_json,'$.attestationNonce') AS attestation_nonce
  FROM admin_audit WHERE action IN ('${rootAction}','${successorAction}')`;

// Reconstruct one immutable chain. Creation timestamps cannot identify a committed
// successor after response loss and cannot distinguish forks or disconnected links.
function orderedChain(audits,version,historical=false){
  if(!audits.length)return [];
  const roots=audits.filter(row=>row.action===rootAction);
  if(roots.length!==1)stop('PILOT_SERIAL_CHAIN_UNVERIFIED');
  const root=roots[0],children=new Map(),jobs=new Set();
  if(!root.book||!digest.test(root.fingerprint))stop('PILOT_SERIAL_CHAIN_UNVERIFIED');
  for(const row of audits){
    if(!uuid.test(row.job_id)||jobs.has(row.job_id)||!uuid.test(row.version)||!historical&&row.version!==version||
      row.book!==root.book||row.fingerprint!==root.fingerprint)stop('PILOT_SERIAL_CHAIN_UNVERIFIED');
    jobs.add(row.job_id);
    if(row===root)continue;
    if(row.action!==successorAction||!uuid.test(row.predecessor)||!digest.test(row.proof)||
      row.id!=='issue296:serial:'+row.predecessor||children.has(row.predecessor))stop('PILOT_SERIAL_CHAIN_UNVERIFIED');
    children.set(row.predecessor,row);
  }
  const chain=[root];
  while(children.has(chain.at(-1).job_id)){
    const previous=chain.at(-1).job_id;
    chain.push(children.get(previous));
    children.delete(previous);
  }
  if(children.size)stop('PILOT_SERIAL_CHAIN_UNVERIFIED');
  return chain;
}

export async function runNormalPilot(env,fetchImpl=fetch,sleep=delay,mockCoordinator,identityStore){
  const {phase,base}=pilotInputs(env);
  const localMockRun=phase==='RUN_SERIAL'&&env.PILOT_LOCAL_MOCK==='true',localScopeBound=localMockRun||phase==='CLOSE_MOCK_ROUND'||phase==='RUN_SERIAL'&&env.PILOT_ROUND_MODE==='true';
  const localScope=()=>JSON.stringify([env.PILOT_PHASE,env.PILOT_ROUND_ID,env.PILOT_LOCAL_MOCK,env.PILOT_LOCAL_IDENTITY,env.PILOT_ROUND_MODE,env.MALIPANG_WORKER_URL,env.GITHUB_REF,env.GITHUB_RUN_ATTEMPT,env.GITHUB_SHA,env.EXPECTED_SHA,env.EXPECTED_WORKER_VERSION_SHA256,env.BACKUP_RUN_ID,env.GITHUB_TOKEN,env.OWNER_SUPERVISING,env.EXTERNAL_WRITERS_FENCED,env.CLOUDFLARE_ACCOUNT_ID,env.CLOUDFLARE_API_TOKEN,env.MALIPANG_ADMIN_TOKEN]);
  const initialLocalScope=localScope(),assertLocalScope=()=>{if(localScopeBound&&localScope()!==initialLocalScope)stop('PILOT_MOCK_SCOPE_CHANGED');};
  const checkLocalAfterDispatch=()=>{if(localScopeBound&&localScope()!==initialLocalScope)stop('PILOT_RESPONSE_UNKNOWN_NO_RETRY');};
  if(mutating(phase))await requireVerifiedBackup(env,fetchImpl);
  const cfg=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  const db=cfg.d1_databases?.find(x=>x.binding==='DB'&&x.database_name==='malipang-v5-2');
  if(!uuid.test(db?.database_id||'')||cfg.name!=='malipang-backend-v5-2')stop('PILOT_BINDINGS_INVALID');
  const cf=async(path,sql)=>{
    const response=await fetchImpl('https://api.cloudflare.com/client/v4/accounts/'+env.CLOUDFLARE_ACCOUNT_ID+path,{
      method:sql?'POST':'GET',headers:{Authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'Content-Type':'application/json'},
      body:sql?JSON.stringify({sql}):undefined,redirect:'error',signal:AbortSignal.timeout(30000)
    });
    if(!response.ok)stop('PILOT_CLOUDFLARE_UNAVAILABLE');
    const data=await response.json();
    if(data.success!==true)stop('PILOT_CLOUDFLARE_UNVERIFIED');
    return data.result;
  };
  const rows=async sql=>{
    const result=await cf('/d1/database/'+db.database_id+'/query',sql);
    if(result?.length!==1||result[0]?.success!==true||!Array.isArray(result[0]?.results))stop('PILOT_D1_UNVERIFIED');
    return result[0].results;
  };
  const deployments=await cf('/workers/scripts/'+cfg.name+'/deployments?per_page=2');
  const versions=deployments.deployments?.[0]?.versions, version=versions?.[0]?.version_id;
  if(versions?.length!==1||versions[0].percentage!==100||!uuid.test(version)||
    createHash('sha256').update(version).digest('hex')!==env.EXPECTED_WORKER_VERSION_SHA256)stop('PILOT_WORKER_CHANGED');
  const request=async(route,body,expected)=>{
    let response,out;
    try{
      response=await fetchImpl(base+'/admin/stable-sync/'+route,{
        method:'POST',headers:{Authorization:'Bearer '+env.MALIPANG_ADMIN_TOKEN,'Content-Type':'application/json','x-malipang-expected-worker-version':version},
        body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(['FINISH_STATUS','FINISH_PROGRESS'].includes(body.action)?15000:240000)
      });
      out=await response.json();
    }catch{stop('PILOT_RESPONSE_UNKNOWN_NO_RETRY');}
    if(out?.servedVersion!==version||!response.ok||out.ok!==true||!expected.includes(out.outcome)){
      if(body.action==='FINISH_STATUS'&&out?.servedVersion===version&&out.ok===false&&out.outcome==='UNVERIFIED')stop('PILOT_FINISH_UNVERIFIED');
      const allowed=['CONFIG','INCIDENT','SOURCE','NOTICE','GRID','SNAPSHOT','LEGACY','FORMAT','POSTIMAGE','ACCOUNTING','CARRIER','REPORT','FINAL_READS','PREIMAGE','SETTLEMENT','READBACK'];
      if(out?.servedVersion===version&&allowed.includes(out.stage))stop('PILOT_RESULT_UNVERIFIED_AT_'+out.stage);
      stop('PILOT_RESULT_UNVERIFIED_NO_RETRY');
    }
    return out;
  };
  const incident=(body,success)=>request('exact-daily-settlement',body,[success]);
  const takeover=(body,success)=>request('normal-expense-pilot',body,success);
  const readback=identity=>request('normal-pilot-readback',{action:'READBACK',...identity},['MATCHED']);
  if(phase==='HOLD_RESERVED'){
    const roundId=env.PILOT_ROUND_ID,round=await request('serial-round-recovery',{action:'READ',roundId},['OPEN']);
    if(!digest.test(round.fingerprint||'')||!Array.isArray(round.members)||!round.members.length||!uuid.test(round.members[0]))stop('PILOT_ROUND_UNVERIFIED');
    // A lost response is unknown. Never send the hold again automatically;
    // use READ/RECOVER and inspect durable evidence before any further action.
    try{await request('serial-round-recovery',{action:'HOLD_RESERVED',roundId,jobId:round.members[0],fingerprint:round.fingerprint,ownerSupervising:true,externalWritersFenced:true},['RECONCILIATION_REQUIRED']);}
    catch(error){error.serialProgress={roundId,jobId:round.members[0]};throw error;}
    return {outcome:'PILOT_HOLD_RECONCILIATION_REQUIRED',roundId,jobId:round.members[0]};
  }
  if(phase==='DISCOVER_ROUND'){
    const state=await request('serial-round-recovery',{action:'LIST_RECENT'},['RECENT_ROUNDS']);
    if(!Array.isArray(state.rounds)||state.rounds.length>20||state.rounds.some(r=>!uuid.test(r.roundId)||!['OPEN','CLOSED'].includes(r.state)||!Number.isSafeInteger(r.selectedCount)||r.selectedCount<0||r.selectedCount>100))stop('PILOT_ROUND_UNVERIFIED');
    return {outcome:'PILOT_OPEN_ROUNDS_READ',rounds:state.rounds.map(r=>({roundId:r.roundId,state:r.state,selected:r.selectedCount}))};
  }
  const mockRound=result=>{
    const labels={PARKED:'MOCK_ATTESTED_HANDOFF',VERIFIED:'VERIFIED_RECEIPT',NOT_STARTED:'MOCK_NEVER_STARTED',RECONCILE:'UNVERIFIED'};
    if(result.mockOracleAndFenceOnly!==true||result.recordedResultsAreCurrentProviderProof!==false||result.readRevalidatesRecordedIntegrity!==false||
      !Number.isSafeInteger(result.selected)||result.selected<1||result.selected>100||!Array.isArray(result.results)||result.results.length!==result.selected||!Array.isArray(result.receipts)||!Array.isArray(result.members)||result.members.length!==result.selected||result.members.some(x=>!uuid.test(x))||new Set(result.members).size!==result.selected||
      result.results.some(x=>!x||!uuid.test(x.jobId)||!Object.hasOwn(labels,x.category)||labels[x.category]!==x.evidence||x.successorJobId!==null&&!uuid.test(x.successorJobId))||
      new Set(result.results.map(x=>x.jobId)).size!==result.selected)stop('PILOT_ROUND_UNVERIFIED');
    const members=new Set(result.results.map(x=>x.jobId));
    const parked=result.results.filter(x=>x.category==='PARKED'),verified=result.results.filter(x=>x.category==='VERIFIED');
    if(result.members.some(x=>!members.has(x))||parked.length!==1||parked[0].jobId!==result.members[0]||parked[0].successorJobId!==result.members[1]||verified.length>1||verified.length===1&&verified[0].jobId!==result.members[1]||result.results.some(x=>x.category!=='PARKED'&&x.successorJobId!==null)||result.receipts.length!==verified.length||result.receipts.some(x=>!x||!uuid.test(x.jobId))||new Set(result.receipts.map(x=>x.jobId)).size!==result.receipts.length)stop('PILOT_ROUND_UNVERIFIED');
    if(result.results.some(x=>x.category==='VERIFIED'&&result.receipts.filter(v=>v.jobId===x.jobId&&v.proofAlgorithm==='pilot-finish-v2'&&uuid.test(v.workerVersion||'')&&digest.test(v.proof||'')&&recordedTime(v.verifiedAt)).length!==1))stop('PILOT_ROUND_UNVERIFIED');
    return {outcome:'PILOT_MOCK_ROUND_RECORDED',selected:result.selected,jobs:result.results.map(x=>({jobId:x.jobId,category:x.category,successorJobId:x.successorJobId}))};
  };
  if(phase==='CLOSE_MOCK_ROUND'){
    const roundId=env.PILOT_ROUND_ID;let result;
    try{
    assertLocalScope();const saved=await request('serial-round-recovery',{action:'READ',roundId},['OPEN','CLOSED']);checkLocalAfterDispatch();
    if(saved.outcome==='CLOSED')return mockRound(saved);
    if(!mockCoordinator||typeof mockCoordinator.proveQuiescence!=='function')stop('PILOT_MOCK_QUIESCENCE_REQUIRED');
    let proof;try{proof=await mockCoordinator.proveQuiescence({roundId,workerVersion:version});}catch{stop('PILOT_MOCK_QUIESCENCE_REQUIRED');}
    assertLocalScope();
    if(!proof||proof.state!=='QUIESCENT_FENCED'||proof.roundId!==roundId||proof.workerVersion!==version||!digest.test(proof.fenceDigest||'')||!Number.isSafeInteger(proof.fenceGeneration)||proof.fenceGeneration<1||!uuid.test(proof.nonce||''))stop('PILOT_MOCK_QUIESCENCE_REQUIRED');
    // Read-only binding of the synthetic oracle statement to the exact durable
    // handoff and unrevoked fence. The Worker rechecks inside the close CAS.
    const bound=await rows(`SELECT h.round_id,h.worker_version,h.nonce,h.fence_digest,h.fence_generation FROM serial_pilot_attested_handoffs h JOIN serial_pilot_rounds r ON r.round_id=h.round_id AND r.state='OPEN' JOIN serial_pilot_oracle_fence f ON f.spreadsheet_id=h.spreadsheet_id AND f.fence_digest=h.fence_digest AND f.generation=h.fence_generation WHERE h.round_id='${roundId}' AND NOT EXISTS(SELECT 1 FROM serial_pilot_oracle_revocations v WHERE v.spreadsheet_id=f.spreadsheet_id AND v.fence_digest=f.fence_digest AND v.fence_generation=f.generation)`);checkLocalAfterDispatch();
    if(bound.length!==1||bound[0].round_id!==roundId||bound[0].worker_version!==version||bound[0].nonce!==proof.nonce||bound[0].fence_digest!==proof.fenceDigest||bound[0].fence_generation!==proof.fenceGeneration)stop('PILOT_MOCK_QUIESCENCE_REQUIRED');
    assertLocalScope();try{result=await request('serial-round-recovery',{action:'CLOSE_MOCK_PARKED',roundId,ownerSupervising:true,externalWritersFenced:true},['CLOSED']);checkLocalAfterDispatch();}
    catch(error){checkLocalAfterDispatch();try{result=await request('serial-round-recovery',{action:'READ',roundId},['CLOSED']);checkLocalAfterDispatch();}catch{checkLocalAfterDispatch();error.serialProgress={roundId};throw error;}}
    return mockRound(result);
    }catch(error){const failure=error instanceof Error?error:Error('PILOT_UNKNOWN_NO_RETRY');failure.serialProgress={roundId};throw failure;}
  }
  const readRecordedRound=result=>{
    if(result.mockOracleAndFenceOnly===true)return mockRound(result);
    if(result.recordedResultsAreCurrentProviderProof!==false||result.readRevalidatesRecordedIntegrity!==false||
      !Number.isSafeInteger(result.selected)||result.selected<1||result.selected>100||!Array.isArray(result.results)||result.results.length!==result.selected||
      !Array.isArray(result.receipts)||result.receipts.length!==result.selected||
      result.results.some(x=>!x||!uuid.test(x.jobId)||x.category!=='VERIFIED'||x.evidence!=='VERIFIED_RECEIPT'||x.successorJobId!==null&&!uuid.test(x.successorJobId))||
      result.receipts.some(x=>!x||!uuid.test(x.jobId)||!uuid.test(x.workerVersion)||!digest.test(x.proof)||x.proofAlgorithm!=='pilot-finish-v2'||!recordedTime(x.verifiedAt)))stop('PILOT_ROUND_UNVERIFIED');
    const receipts=new Map(result.receipts.map(x=>[x.jobId,x]));
    if(receipts.size!==result.selected||new Set(result.results.map(x=>x.jobId)).size!==result.selected||result.results.some(x=>!receipts.has(x.jobId)||x.successorJobId!==null&&(x.successorJobId===x.jobId||!receipts.has(x.successorJobId))))stop('PILOT_ROUND_UNVERIFIED');
    if(result.members!==undefined){
      if(!Array.isArray(result.members)||result.members.length!==result.selected||new Set(result.members).size!==result.selected||
        result.members.some(id=>!receipts.has(id)))stop('PILOT_ROUND_UNVERIFIED');
      const links=new Map(result.results.map(x=>[x.jobId,x.successorJobId]));
      if(result.members.some((id,i)=>links.get(id)!==(result.members[i+1]??null)))stop('PILOT_ROUND_UNVERIFIED');
    }
    return {outcome:'PILOT_ROUND_RECORDED_READ_ONLY',recordedResultsAreCurrentProviderProof:false,readRevalidatesRecordedIntegrity:false,
      jobs:result.results.map(x=>({jobId:x.jobId,successorJobId:x.successorJobId,verifiedAt:receipts.get(x.jobId).verifiedAt,workerVersion:receipts.get(x.jobId).workerVersion}))};
  };
  if(phase==='READ_ROUND'){
    const result=await request('serial-round-recovery',{action:'READ',roundId:env.PILOT_ROUND_ID},['CLOSED']);
    return readRecordedRound(result);
  }
  if(phase==='RECOVER_ROUND'){
    const roundId=env.PILOT_ROUND_ID;
    // A prior close may still be in flight. A new invocation reads the same
    // durable round but cannot infer quiescence from one OPEN observation.
    const result=await request('serial-round-recovery',{action:'READ',roundId},['OPEN','CLOSED']);
    if(result.outcome==='CLOSED'&&(result.mockOracleAndFenceOnly===true||Array.isArray(result.results)&&result.results.some(x=>x?.category==='VERIFIED'))){
      return readRecordedRound(result);
    }
    if(result.outcome==='OPEN'&&(!Array.isArray(result.members)||!Array.isArray(result.observations))){
      const error=Error('PILOT_ROUND_TRANSITION_NEEDS_RECONCILIATION');error.serialProgress={roundId};throw error;
    }
    const items=result.outcome==='OPEN'?result.members.map(jobId=>({jobId,successorJobId:null,category:'RECONCILE',evidence:'UNVERIFIED'})):result.results;
    if(!Number.isSafeInteger(result.selected)||result.selected<0||result.selected>100||!Array.isArray(items)||items.length!==result.selected||
      items.some(x=>!x||x.category!=='RECONCILE'||x.evidence!=='UNVERIFIED'||!uuid.test(x.jobId)||
        x.successorJobId!==null&&!uuid.test(x.successorJobId)))stop('PILOT_ROUND_UNVERIFIED');
    if(result.observationsAreProof!==false||result.observationsAtomicWithRound!==false||!recordedTime(result.observedAt)||!Array.isArray(result.observations)||result.observations.length!==result.selected||
      result.observations.some(x=>!x||!uuid.test(x.jobId)||![null,'PENDING','PROCESSING','COMPLETED','FAILED','REVIEW'].includes(x.jobState)||
        ![null,'SERIAL_PILOT_B_REVIEW','SERIAL_EXPIRED_PROVIDER_UNCERTAIN'].includes(x.holdReason)||
        ![null,0,1].includes(x.provenanceVersion)||(x.provenanceVersion===null?x.leaseGeneration!==null:!Number.isSafeInteger(x.leaseGeneration)||x.leaseGeneration<0)||
        ![null,'ARMED','COMPLETE','REVIEW','CLOSED'].includes(x.epochState)||![null,'HELD','REVIEW'].includes(x.workbookClaimStateGlobal)||
        ![null,'UNKNOWN','PILOT_RESERVED','PILOT_TAKEN','SERIAL_PILOT_ADOPTED','SERIAL_CONTINUATION','SERIAL_FINAL_RELEASE'].includes(x.workbookClaimPhaseGlobal??null)||![null,'UNKNOWN','SHEETS_MUTATION_OUTCOME_UNKNOWN','SERIAL_FINAL_COMPLETION_NOT_READY','SERIAL_CONTINUATION_UNVERIFIED','SERIAL_CONTINUATION_FENCE_UNVERIFIED','ATTESTED_PILOT_RELEASE_UNVERIFIED','PILOT_TAKE_PREIMAGE','PILOT_TAKE_UNCERTAIN'].includes(x.workbookClaimReasonGlobal??null)||
        !['NO_CLAIM','EXACT_EPOCH_OPERATION','UNKNOWN'].includes(x.claimRelationship)||!Number.isSafeInteger(x.admittedOperations)||x.admittedOperations<0||
        !Number.isSafeInteger(x.verifiedStages)||x.verifiedStages<0||!Number.isSafeInteger(x.unresolvedStages)||x.unresolvedStages<0))stop('PILOT_ROUND_UNVERIFIED');
    const observations=new Map(result.observations.map(x=>[x.jobId,x]));
    if(observations.size!==result.selected||new Set(items.map(x=>x.jobId)).size!==result.selected||items.some(x=>!observations.has(x.jobId)))stop('PILOT_ROUND_UNVERIFIED');
    if(result.outcome==='CLOSED'&&result.members!==undefined){
      if(!Array.isArray(result.members)||result.members.length!==result.selected||new Set(result.members).size!==result.selected||
        result.members.some(id=>!observations.has(id))||items.some(x=>x.successorJobId!==null&&x.successorJobId!==result.members[result.members.indexOf(x.jobId)+1]))stop('PILOT_ROUND_UNVERIFIED');
    }
    const progress={roundId,selected:result.selected,observedAt:result.observedAt,
      jobs:items.map(x=>{const o=observations.get(x.jobId);return {jobId:x.jobId,successorJobId:x.successorJobId,jobState:o.jobState,holdReason:o.holdReason,provenanceVersion:o.provenanceVersion,leaseGeneration:o.leaseGeneration,epochState:o.epochState,workbookClaimStateGlobal:o.workbookClaimStateGlobal,workbookClaimPhaseGlobal:o.workbookClaimPhaseGlobal??null,workbookClaimReasonGlobal:o.workbookClaimReasonGlobal??null,claimRelationship:o.claimRelationship,admittedOperations:o.admittedOperations,verifiedStages:o.verifiedStages,unresolvedStages:o.unresolvedStages};})};
    if(result.outcome==='OPEN'){
      const chain=result.reservationChain;
      if(chain!==undefined&&chain?.status!=='UNKNOWN'){
        if(chain?.status!=='OBSERVED'||!Array.isArray(chain.jobIds)||chain.jobIds.length>items.length||
          chain.jobIds.some((id,i)=>id!==items[i].jobId)||
          (chain.jobIds.length===0?chain.workerVersion!==null:!uuid.test(chain.workerVersion)))stop('PILOT_ROUND_UNVERIFIED');
        progress.reservationChain={jobIds:chain.jobIds,workerVersion:chain.workerVersion};
        for(const [i,id] of chain.jobIds.entries()){
          const job=progress.jobs[i],obs=observations.get(id);
          job.successorJobId=chain.jobIds[i+1]??null;
          if(['DAILY','EXPENSE_RAW','DETAIL'].includes(obs.lastVerifiedStageCandidate)&&obs.lastVerifiedStageMayTie===true&&
            recordedTime(obs.lastVerifiedAt)){
            job.lastVerifiedStageCandidate=obs.lastVerifiedStageCandidate;
            job.lastVerifiedAt=obs.lastVerifiedAt;
          }
        }
      }
      const error=Error('PILOT_ROUND_TRANSITION_NEEDS_RECONCILIATION');
      error.serialProgress={...progress,openRound:true};
      throw error;
    }
    return {outcome:result.selected===0?'PILOT_ROUND_EMPTY':'PILOT_ROUND_RECONCILIATION_REQUIRED',selected:progress.selected,observedAt:progress.observedAt,jobs:progress.jobs};
  }
  const finish=async(jobId,fingerprint,serial=false,progressAware=false)=>{
    const identity=serial?{jobId,fingerprint}:undefined;
    const status=()=>takeover({action:'FINISH_STATUS',jobId,fingerprint},
      ['NOT_STARTED','IN_PROGRESS','JOB_REVIEW','JOB_FAILED','JOB_COMPLETE','UNVERIFIED']);
    // Observe one identity throughout. No provider writes, enrollment or replay in this loop.
    let oldProofs=[],idle=0,scopeProof;const deadline=Date.now()+120*60000,limit=progressAware?120:16;
    for(let observation=0;observation<limit;observation++){
      if(progressAware&&Date.now()>=deadline)stop('PILOT_ROUND_TIME_BUDGET');
      const snapshot=await status(), current=snapshot.outcome;
      if(progressAware&&Date.now()>=deadline)stop('PILOT_ROUND_TIME_BUDGET');
      if(current==='JOB_COMPLETE'){
        if(typeof snapshot.proof!=='string'||!digest.test(snapshot.proof))stop('PILOT_FINAL_PROOF_UNVERIFIED');
        try{await readback(identity);}catch{stop('PILOT_JOB_COMPLETE_DAILY_UNVERIFIED');}
        if(progressAware&&Date.now()>=deadline)stop('PILOT_ROUND_TIME_BUDGET');
        const after=await status();
        if(progressAware&&Date.now()>=deadline)stop('PILOT_ROUND_TIME_BUDGET');
        if(after.outcome!=='JOB_COMPLETE'||after.proof!==snapshot.proof)stop('PILOT_FINAL_STATE_CHANGED');
        return after.proof;
      }
      if(current==='JOB_REVIEW'||current==='JOB_FAILED'){
        let daily='UNVERIFIED';
        try{await readback(identity);daily='MATCHED';}catch{/* The queue outcome still requires follow-up. */}
        stop('PILOT_'+current+'_DAILY_'+daily);
      }
      if(current!=='IN_PROGRESS')stop('PILOT_FINISH_'+current);
      if(progressAware){
        const progress=await takeover({action:'FINISH_PROGRESS',jobId,fingerprint},['PROGRESS']);
        if(!Number.isSafeInteger(progress.verifiedStages)||progress.verifiedStages<0||!Array.isArray(progress.stageProofs)||
          progress.stageProofs.length!==progress.verifiedStages||progress.stageProofs.some(x=>!digest.test(x))||new Set(progress.stageProofs).size!==progress.stageProofs.length||!digest.test(progress.scopeProof))stop('PILOT_PROGRESS_UNVERIFIED');
        if(scopeProof&&scopeProof!==progress.scopeProof)stop('PILOT_PROGRESS_CHANGED');scopeProof=progress.scopeProof;
        const currentProofs=new Set(progress.stageProofs);
        if(oldProofs.some(x=>!currentProofs.has(x)))stop('PILOT_PROGRESS_CHANGED');
        idle=progress.stageProofs.length>oldProofs.length?0:idle+1;oldProofs=progress.stageProofs;
        if(idle>=15)stop('PILOT_OBSERVATION_TIMEOUT_IN_PROGRESS');
        if(Date.now()>=deadline)stop('PILOT_ROUND_TIME_BUDGET');
      }
      if(observation<limit-1)await sleep(progressAware?Math.min(60000,Math.max(0,deadline-Date.now())):60000);
    }
    stop(progressAware?'PILOT_ROUND_TIME_BUDGET':'PILOT_OBSERVATION_TIMEOUT_IN_PROGRESS');
  };
  if(phase==='READBACK'){
    await readback();
    return 'PILOT_DAILY_D1_MATCHED';
  }
  const readChain=async(historical=false)=>orderedChain(await rows(serialAudit),version,historical);
  if(phase==='READ_HISTORICAL'){
    const tip=(await readChain(true)).at(-1);
    if(!tip)stop('PILOT_FINISH_NOT_STARTED');
    await request('normal-pilot-readback',{action:'READ_HISTORICAL',jobId:tip.job_id,fingerprint:tip.fingerprint},['MATCHED_READ_ONLY']);
    return 'PILOT_HISTORICAL_DAILY_MATCHED_READ_ONLY';
  }
  if(phase==='FINISH_PILOT'){
    const tip=(await readChain()).at(-1);
    if(!tip)stop('PILOT_FINISH_NOT_STARTED');
    await finish(tip.job_id,tip.fingerprint,true);
    return 'PILOT_JOB_COMPLETE_DAILY_MATCHED';
  }
  if(phase==='INSPECT_HANDOVER'){
    const audit=await rows(reserved);
    if(audit.length===0)return 'PILOT_NO_HANDOVER_RECORDED';
    if(audit.length!==1||!uuid.test(audit[0].job_id)||!digest.test(audit[0].fingerprint))stop('PILOT_AUDIT_UNVERIFIED');
    const result=await takeover({action:phase,jobId:audit[0].job_id,fingerprint:audit[0].fingerprint},['RESERVED','ADOPTED','STAGE_VERIFIED','HELD']);
    return 'PILOT_'+result.outcome;
  }
  const inspectOriginal=async()=>{
    const state=await incident({action:'INSPECT'},'INSPECTED');
    if(!digest.test(state.fingerprint))stop('PILOT_INCIDENT_UNVERIFIED');
    if(state.proofKind==='HISTORICAL')stop('PILOT_HISTORICAL_SETTLEMENT_REQUIRES_HANDOVER_APPROVAL');
    return state;
  };
  const settleOriginal=async(state,probeOnly)=>{
    const {fingerprint}=state;
    if(state.projectionState==='VERIFIED'&&digest.test(state.preimageDigest))return {label:'PILOT_ORIGINAL_ALREADY_SETTLED',preimageDigest:state.preimageDigest};
    if(state.projectionState!=='IN_FLIGHT'||state.preimageDigest!==null)stop('PILOT_ORIGINAL_UNVERIFIED');
    const proof=await incident({action:'PROBE',fingerprint},'MATCHED');
    if(proof.fingerprint!==fingerprint||!digest.test(proof.preimageDigest))stop('PILOT_PROOF_UNVERIFIED');
    if(probeOnly)return {label:'PILOT_ORIGINAL_MATCHED',preimageDigest:proof.preimageDigest};
    assertLocalScope();try{
      const saved=await incident({action:'SETTLE',fingerprint,preimageDigest:proof.preimageDigest,
        externalWritersFenced:true,ownerSupervising:true},'SETTLED');
      checkLocalAfterDispatch();
      if(saved.fingerprint!==fingerprint||saved.preimageDigest!==proof.preimageDigest)stop('PILOT_SETTLEMENT_UNKNOWN_NO_RETRY');
    }catch(error){
      // INSPECT authenticates the exact original REVIEW job, OPEN failure and stored preimage.
      // Positive proof can close the run even if the SETTLE acknowledgment was lost.
      checkLocalAfterDispatch();const after=await incident({action:'INSPECT'},'INSPECTED');checkLocalAfterDispatch();
      if(after.proofKind==='HISTORICAL'||after.projectionState!=='VERIFIED'||after.fingerprint!==fingerprint||after.preimageDigest!==proof.preimageDigest)throw error;
    }
    return {label:'PILOT_ORIGINAL_SETTLED_JOB_HELD',preimageDigest:proof.preimageDigest};
  };
  const reserveFirst=async(jobId,fingerprint,preimageDigest,roundId)=>{
    assertLocalScope();try{
      await takeover({action:'HANDOVER_ONE',jobId,fingerprint,preimageDigest,
        externalWritersFenced:true,ownerSupervising:true,...(roundId?{roundId}:{})},['RESERVED']);
      checkLocalAfterDispatch();
    }catch(error){
      checkLocalAfterDispatch();const audit=await rows(reserved);checkLocalAfterDispatch();
      if(audit.length!==1||audit[0].job_id!==jobId||audit[0].fingerprint!==fingerprint)throw error;
      if(roundId){const root=(await readChain())[0];checkLocalAfterDispatch();if(root?.job_id!==jobId||root.fingerprint!==fingerprint||root.round_id!==roundId)throw error;}
    }
  };
  if(phase==='RUN_SERIAL'){
    const localMock=localMockRun,mockStable=()=>localMock&&localScope()===initialLocalScope&&env.PILOT_ROUND_MODE==='true'&&new URL(env.MALIPANG_WORKER_URL).origin===base&&['localhost','127.0.0.1','[::1]'].includes(new URL(base).hostname);
    if(localMock&&(!mockStable()||!mockCoordinator||typeof mockCoordinator.prepare!=='function'||typeof mockCoordinator.reserve!=='function'||typeof mockCoordinator.inspect!=='function'))stop('PILOT_MOCK_COORDINATOR_UNAVAILABLE');
    if(env.PILOT_ROUND_MODE==='true'){
      // Experimental round mode is local-only until a durable cross-machine
      // identity/dispatch gate is approved. Claim the identity before SETTLE
      // or OPEN; no absent D1 read permits creating a replacement identity.
      if(env.PILOT_LOCAL_IDENTITY!=='true'||!['localhost','127.0.0.1','[::1]'].includes(new URL(base).hostname)||!identityStore||typeof identityStore.claim!=='function')stop('PILOT_DURABLE_IDENTITY_REQUIRED');
      assertLocalScope();const books=await rows("SELECT spreadsheet_id FROM continuous_daily_cutovers WHERE state='ACTIVE'");checkLocalAfterDispatch();
      if(books.length!==1||typeof books[0].spreadsheet_id!=='string'||!books[0].spreadsheet_id)stop('PILOT_DURABLE_IDENTITY_UNVERIFIED');
      const scopeDigest=createHash('sha256').update(JSON.stringify([db.database_id,books[0].spreadsheet_id,version,env.EXPECTED_SHA,base,initialLocalScope])).digest('hex');
      let identity;try{identity=await identityStore.claim(scopeDigest);}catch{stop('PILOT_DURABLE_IDENTITY_UNVERIFIED');}
      assertLocalScope();
      if(!identity||!['FRESH','EXISTING'].includes(identity.state)||!uuid.test(identity.roundId||''))stop('PILOT_DURABLE_IDENTITY_UNVERIFIED');
      if(identity.state==='EXISTING'){
        // A previous request may be absent now but still in flight. This read
        // is diagnostic only and never authorizes another SETTLE or OPEN.
        try{await request('serial-round-recovery',{action:'READ',roundId:identity.roundId},['OPEN','CLOSED']);checkLocalAfterDispatch();}catch{checkLocalAfterDispatch();}
        const error=Error('PILOT_ROUND_IDENTITY_NEEDS_RECONCILIATION');error.serialProgress={roundId:identity.roundId};throw error;
      }
      const open=await request('serial-round-recovery',{action:'LIST_OPEN'},['OPEN_ROUNDS']);
      if(!Array.isArray(open.rounds)||open.rounds.length>1)stop('PILOT_ROUND_UNVERIFIED');
      const chain=await readChain(),tip=chain.at(-1);
      let roundId=open.rounds[0]?.roundId,plan,fingerprint,preimageDigest;
      const recoveredOpen=!!roundId;
      if(roundId){
        if(!uuid.test(roundId))stop('PILOT_ROUND_UNVERIFIED');
        const saved=await request('serial-round-recovery',{action:'READ',roundId},['OPEN']);
        if(!digest.test(saved.fingerprint)||!Array.isArray(saved.members)||saved.members.length!==saved.selected||saved.members.length>100||
          saved.members.some(id=>!uuid.test(id))||new Set(saved.members).size!==saved.members.length)stop('PILOT_ROUND_UNVERIFIED');
        plan=saved.members;fingerprint=saved.fingerprint;
        if(chain.some((row,index)=>row.round_id!==roundId||row.fingerprint!==fingerprint||row.job_id!==plan[index]))stop('PILOT_ROUND_CHAIN_UNVERIFIED');
      }else{
        if(tip)stop('PILOT_ROUND_LINEAGE_UNVERIFIED');
        plan=(await rows(serialCandidates)).map(row=>row.job_id);
        if(plan.some(id=>!uuid.test(id))||new Set(plan).size!==plan.length||plan.length>100)stop('PILOT_SERIAL_SELECTION_UNVERIFIED');
        if(plan.length===0){
          roundId=identity.roundId;
          assertLocalScope();try{await request('serial-round-recovery',{action:'OPEN_EMPTY',roundId,ownerSupervising:true,externalWritersFenced:true},['OPEN']);checkLocalAfterDispatch();}
          catch(error){checkLocalAfterDispatch();const saved=await request('serial-round-recovery',{action:'READ',roundId},['OPEN']);checkLocalAfterDispatch();if(saved.selected!==0||!Array.isArray(saved.members)||saved.members.length!==0||saved.fingerprint!=='0'.repeat(64))throw error;}
          assertLocalScope();try{await request('serial-round-recovery',{action:'CLOSE_UNVERIFIED',roundId},['CLOSED']);checkLocalAfterDispatch();}
          catch(error){checkLocalAfterDispatch();const saved=await request('serial-round-recovery',{action:'READ',roundId},['CLOSED']);checkLocalAfterDispatch();if(saved.selected!==0||!Array.isArray(saved.results)||saved.results.length!==0)throw error;}
          return {outcome:'PILOT_ROUND_EMPTY',selected:0};
        }
        const state=await inspectOriginal(),settled=await settleOriginal(state,false);
        fingerprint=state.fingerprint;preimageDigest=settled.preimageDigest;roundId=identity.roundId;
        const body={action:'OPEN_INITIAL',roundId,fingerprint,preimageDigest,jobs:plan,ownerSupervising:true,externalWritersFenced:true};
        assertLocalScope();try{await request('serial-round-recovery',body,['OPEN']);checkLocalAfterDispatch();}
        catch(error){
          checkLocalAfterDispatch();const saved=await request('serial-round-recovery',{action:'READ',roundId},['OPEN']);checkLocalAfterDispatch();
          if(saved.fingerprint!==fingerprint||JSON.stringify(saved.members)!==JSON.stringify(plan))throw error;
        }
      }
      if(plan.length===0){if(recoveredOpen){const error=Error('PILOT_ROUND_TRANSITION_NEEDS_RECONCILIATION');error.serialProgress={roundId};throw error;}assertLocalScope();await request('serial-round-recovery',{action:'CLOSE_UNVERIFIED',roundId},['CLOSED']);checkLocalAfterDispatch();return {outcome:'PILOT_ROUND_EMPTY',selected:0};}
      if(localMock&&plan.length<2)stop('PILOT_ROUND_UNVERIFIED');
      if(!tip){
        if(recoveredOpen){const error=Error('PILOT_HANDOVER_NEEDS_RECONCILIATION');error.serialProgress={roundId};throw error;}
        if(!preimageDigest){const state=await inspectOriginal();if(state.fingerprint!==fingerprint)stop('PILOT_ROUND_UNVERIFIED');preimageDigest=(await settleOriginal(state,false)).preimageDigest;}
        await reserveFirst(plan[0],fingerprint,preimageDigest,roundId);
      }
      if(localMock){
        if(!mockStable())stop('PILOT_MOCK_SCOPE_CHANGED');
        const predecessorJobId=plan[0],successorJobId=plan[1];
        try{
        let intent;
        if(!tip){
          assertLocalScope();
          try{await request('serial-round-recovery',{action:'HOLD_RESERVED',roundId,jobId:predecessorJobId,fingerprint,ownerSupervising:true,externalWritersFenced:true},['RECONCILIATION_REQUIRED']);checkLocalAfterDispatch();}
          catch(error){
            checkLocalAfterDispatch();const held=await request('serial-round-recovery',{action:'READ',roundId},['OPEN']);checkLocalAfterDispatch();
            if(!Array.isArray(held.observations)||held.observations.filter(x=>x.jobId===predecessorJobId&&x.jobState==='REVIEW'&&x.holdReason==='SERIAL_PILOT_B_REVIEW').length!==1)throw error;
          }
          if(!mockStable())stop('PILOT_MOCK_SCOPE_CHANGED');
          intent=await mockCoordinator.prepare({roundId,predecessorJobId,successorJobId,workerVersion:version,fingerprint});
          if(!mockStable()||!intent||intent.roundId!==roundId||intent.predecessorJobId!==predecessorJobId||intent.successorJobId!==successorJobId||intent.workerVersion!==version||!uuid.test(intent.nonce||'')||!digest.test(intent.payloadDigest||'')||!digest.test(intent.claimDigest||''))stop('PILOT_MOCK_HANDOFF_UNVERIFIED');
          // This injected test coordinator is never supplied by the CLI. The
          // mutation is attempted once; even a lost response cannot trigger a
          // second signature or reservation in this invocation.
          assertLocalScope();try{await mockCoordinator.reserve(intent);checkLocalAfterDispatch();}catch{checkLocalAfterDispatch();/* Reconcile the exact durable edge below. */}
        }else if(tip.job_id!==successorJobId){
          // A restarted process cannot prove that an earlier transfer request
          // is not still in flight merely because no edge is visible once.
          stop('PILOT_MOCK_HANDOFF_NEEDS_RECONCILIATION');
        }
        if(!mockStable())stop('PILOT_MOCK_SCOPE_CHANGED');
        const current=await readChain(),edge=current.at(-1);
        if(current.length!==2||edge?.job_id!==successorJobId||edge.predecessor!==predecessorJobId||edge.round_id!==roundId||edge.fingerprint!==fingerprint||!uuid.test(edge.attestation_nonce||'')||typeof edge.epoch_id!=='string'||!edge.epoch_id.startsWith('normal_pilot296_')||!digest.test(edge.proof||''))stop('PILOT_MOCK_HANDOFF_UNVERIFIED');
        const expected={roundId,predecessorJobId,successorJobId,workerVersion:version,nonce:edge.attestation_nonce,payloadDigest:edge.proof,epochId:edge.epoch_id};
        if(intent&&(intent.nonce!==expected.nonce||intent.payloadDigest!==expected.payloadDigest))stop('PILOT_MOCK_HANDOFF_UNVERIFIED');
        const evidence=await mockCoordinator.inspect(expected);
        if(!mockStable()||!evidence||evidence.outcome!=='RESERVATION_RECORDED'||Object.entries(expected).some(([key,value])=>evidence[key]!==value)||!digest.test(evidence.claimDigest||'')||intent&&intent.claimDigest!==evidence.claimDigest)stop('PILOT_MOCK_HANDOFF_UNVERIFIED');
        const proof=await finish(successorJobId,fingerprint,true,true);
        const matchingReceipt=saved=>saved.fingerprint===fingerprint&&JSON.stringify(saved.members)===JSON.stringify(plan)&&Array.isArray(saved.receipts)&&saved.receipts.filter(x=>x.jobId===successorJobId).length===1&&saved.receipts.some(x=>x.jobId===successorJobId&&x.proof===proof&&x.workerVersion===version&&x.proofAlgorithm==='pilot-finish-v2');
        if(tip){
          // A previous process may have sent RECORD before dying. An absent
          // receipt once does not prove that request cannot still commit.
          // A matching receipt is historical evidence, not permission to replay.
          const saved=await request('serial-round-recovery',{action:'READ',roundId},['OPEN']);checkLocalAfterDispatch();
          if(!matchingReceipt(saved))stop('PILOT_MOCK_RECEIPT_NEEDS_RECONCILIATION');
          // Even with a receipt, CLOSE may already be in flight from the
          // interrupted process. OPEN once does not authorize resending it.
          stop('PILOT_ROUND_CLOSE_NEEDS_RECONCILIATION');
        }else{
          assertLocalScope();
          try{await takeover({action:'RECORD_VERIFIED',jobId:successorJobId,fingerprint,roundId,proof,externalWritersFenced:true,ownerSupervising:true},['RECORDED']);checkLocalAfterDispatch();}
          catch(error){checkLocalAfterDispatch();const saved=await request('serial-round-recovery',{action:'READ',roundId},['OPEN']);checkLocalAfterDispatch();if(!matchingReceipt(saved))throw error;}
        }
        if(!mockStable())stop('PILOT_MOCK_SCOPE_CHANGED');
        let closed;try{closed=await request('serial-round-recovery',{action:'CLOSE_MOCK_PARKED',roundId,ownerSupervising:true,externalWritersFenced:true},['CLOSED']);checkLocalAfterDispatch();}
        catch(error){checkLocalAfterDispatch();try{closed=await request('serial-round-recovery',{action:'READ',roundId},['CLOSED']);checkLocalAfterDispatch();}catch{checkLocalAfterDispatch();throw error;}}
        return mockRound(closed);
        }catch(error){const failure=error instanceof Error?error:Error('PILOT_MOCK_HANDOFF_UNVERIFIED');failure.serialProgress={roundId,jobId:predecessorJobId,successorJobId};throw failure;}
      }
      const start=tip?plan.indexOf(tip.job_id):0;
      if(start<0)stop('PILOT_ROUND_CHAIN_UNVERIFIED');
      const deadline=Date.now()+5*60*60*1000;
      for(let index=start;index<plan.length;index++){
        const jobId=plan[index],proof=await finish(jobId,fingerprint,true,true),nextJobId=plan[index+1];
        const exactReceipt=saved=>saved.fingerprint===fingerprint&&JSON.stringify(saved.members)===JSON.stringify(plan)&&Array.isArray(saved.receipts)&&saved.receipts.filter(x=>x.jobId===jobId).length===1&&saved.receipts.some(x=>x.jobId===jobId&&x.proof===proof&&x.workerVersion===version&&x.proofAlgorithm==='pilot-finish-v2');
        if(tip&&index===start){
          // The interrupted process may already have sent RECORD. A single
          // missing readback cannot establish that the prior request ended.
          const saved=await request('serial-round-recovery',{action:'READ',roundId},['OPEN']);
          if(!exactReceipt(saved)){const error=Error('PILOT_RECEIPT_NEEDS_RECONCILIATION');error.serialProgress={roundId};throw error;}
          // ADVANCE/CLOSE could already be in flight from the prior process.
          const error=Error('PILOT_ROUND_TRANSITION_NEEDS_RECONCILIATION');error.serialProgress={roundId};throw error;
        }else{
          try{await takeover({action:'RECORD_VERIFIED',jobId,fingerprint,roundId,proof,externalWritersFenced:true,ownerSupervising:true},['RECORDED']);}
          catch(error){
            const saved=await request('serial-round-recovery',{action:'READ',roundId},['OPEN']);
            if(!exactReceipt(saved))throw error;
          }
        }
        if(!nextJobId)break;
        if(Date.now()>=deadline)stop('PILOT_SERIAL_TIME_BUDGET');
        try{await takeover({action:'ADVANCE_ONE',jobId,fingerprint,proof,nextJobId,roundId,externalWritersFenced:true,ownerSupervising:true},['RESERVED']);}
        catch(error){const last=(await readChain()).at(-1);if(last?.job_id!==nextJobId||last.predecessor!==jobId||last.proof!==proof||last.fingerprint!==fingerprint||last.round_id!==roundId)throw error;}
      }
      if(env.PILOT_CLOSE_VERIFIED!=='true')stop('PILOT_ROUND_REQUIRES_RECONCILIATION');
      let closed;
      try{closed=await request('serial-round-recovery',{action:'CLOSE_VERIFIED',roundId,ownerSupervising:true,externalWritersFenced:true},['CLOSED']);}
      catch(error){try{closed=await request('serial-round-recovery',{action:'READ',roundId},['CLOSED']);}catch{throw error;}}
      if(closed.selected!==plan.length||!Array.isArray(closed.results)||closed.results.length!==plan.length||
        plan.some((jobId,index)=>closed.results.filter(x=>x.jobId===jobId&&x.category==='VERIFIED'&&x.evidence==='VERIFIED_RECEIPT'&&x.successorJobId===(plan[index+1]??null)).length!==1))stop('PILOT_ROUND_UNVERIFIED');
      return {outcome:'PILOT_ROUND_FINISHED_VERIFIED',verified:plan.length,remaining:0};
    }
    const chain=await readChain(),tip=chain.at(-1);
    const selected=(await rows(serialCandidates)).map(row=>row.job_id);
    if(selected.some(id=>!uuid.test(id))||new Set(selected).size!==selected.length)stop('PILOT_SERIAL_SELECTION_UNVERIFIED');
    const admitted=new Set(chain.map(row=>row.job_id));
    // The current tip may already be COMPLETED or in REVIEW and absent from pending.
    // New arrivals after selection are outside this protected invocation.
    const plan=[...(tip?[tip.job_id]:[]),...selected.filter(id=>!admitted.has(id))];
    let verified=0;
    if(plan.length===0)return {outcome:'PILOT_SERIAL_FINISHED',verified,remaining:0};
    try{
      let fingerprint=tip?.fingerprint;
      if(!tip){
        const state=await inspectOriginal();
        fingerprint=state.fingerprint;
        const saved=await settleOriginal(state,false);
        await reserveFirst(plan[0],fingerprint,saved.preimageDigest);
      }
      // Leave time for an in-flight request and the final sanitized summary before
      // the 6-hour Actions limit. A later RUN_SERIAL first reconciles the recorded tip.
      const advanceDeadline=Date.now()+5*60*60*1000;
      for(const [index,jobId] of plan.entries()){
        const proof=await finish(jobId,fingerprint,true);
        verified++;
        const nextJobId=plan[index+1];
        if(!nextJobId)break;
        if(Date.now()>=advanceDeadline)stop('PILOT_SERIAL_TIME_BUDGET');
        try{
          await takeover({action:'ADVANCE_ONE',jobId,fingerprint,proof,nextJobId,
            externalWritersFenced:true,ownerSupervising:true},['RESERVED']);
        }catch(error){
          // Only the exact durable edge proves that this attempted reservation committed.
          // A different tip, even if also complete, does not authorize another advance.
          const last=(await readChain()).at(-1);
          if(last?.job_id!==nextJobId||last.predecessor!==jobId||last.proof!==proof||last.fingerprint!==fingerprint)throw error;
        }
      }
      return {outcome:'PILOT_SERIAL_FINISHED',verified,remaining:0};
    }catch(error){
      error.serialProgress={verified,remaining:plan.length-verified};
      throw error;
    }
  }
  const state=await inspectOriginal();
  if(phase==='HANDOVER_ONE'){
    if(state.projectionState!=='VERIFIED'||!digest.test(state.preimageDigest))stop('PILOT_ORIGINAL_UNVERIFIED');
    const found=await rows(candidates);
    if(found.length!==1||!uuid.test(found[0].job_id))stop('PILOT_NO_EXACT_CANDIDATE');
    await reserveFirst(found[0].job_id,state.fingerprint,state.preimageDigest);
    await finish(found[0].job_id,state.fingerprint);
    return 'PILOT_JOB_COMPLETE_DAILY_MATCHED';
  }
  return (await settleOriginal(state,phase==='PROBE')).label;
}

export function describeResult(phase,label){
  if(label==='PILOT_HOLD_RECONCILIATION_REQUIRED')return 'พักรายการใน REVIEW และคง claim ไว้ ต้องกระทบยอดต่อ ยังไม่ได้ยืนยัน provider หยุดและยังไม่มีสิทธิ์จองรายการถัดไป';
  if(phase==='HOLD_RESERVED')return 'ผลพักยังไม่ชัด อ่านรอบเดิมและตรวจหลักฐานก่อนดำเนินการต่อ ห้ามส่งคำขอพักซ้ำหรือจองรายการถัดไปจากผลนี้';
  if(label==='PILOT_ROUND_RECORDED_READ_ONLY')return 'อ่านผลที่บันทึกไว้ ณ เวลาตรวจเท่านั้น ไม่ได้ตรวจหลักฐานซ้ำหรือยืนยันสถานะชีตปัจจุบัน และไม่ได้ให้สิทธิ์จองต่อ';
  if(label==='PILOT_ROUND_FINISHED_VERIFIED')return 'ปิดรอบพร้อมหลักฐานยืนยันทุกงาน ณ เวลาตรวจ ภายใต้การกันผู้เขียนอื่น';
  if(label==='PILOT_HISTORICAL_DAILY_MATCHED_READ_ONLY')return 'อ่านแถวรายวันย้อนหลังตรงกับ D1 การอ่านนี้ไม่ได้ยืนยันผลจบงานหรือให้สิทธิ์จองรายการถัดไป';
  if(phase==='READ_HISTORICAL')return 'หลักฐานย้อนหลังไม่ครบหรืออ่านเทียบไม่ได้ ตรวจ audit, snapshot, epoch, admission และ journal เดิมก่อนกระทบยอด; ยังไม่ให้สิทธิ์จองรายการถัดไป';
  if(phase==='RECOVER_ROUND'&&label==='PILOT_ROUND_EMPTY')return 'จบรอบที่มีชุดงานว่าง ไม่ได้ยืนยันสถานะคิวงานอื่น';
  if(label==='PILOT_MOCK_ROUND_RECORDED')return 'ผลรอบจำลองภายใต้ oracle และ fence จำลอง ไม่ยืนยันสถานะชีตปัจจุบันหรือให้สิทธิ์เขียน';
  if(phase==='DISCOVER_ROUND'&&label==='PILOT_OPEN_ROUNDS_READ')return 'อ่านรอบล่าสุดจาก D1 แล้ว รอบที่พบยังต้องตรวจหลักฐานก่อนดำเนินการ';
  if(phase==='RECOVER_ROUND'&&label==='PILOT_ROUND_RECONCILIATION_REQUIRED')return 'อ่านผลรอบที่บันทึกไว้ ทุกงานยังรอกระทบยอด และไม่ได้ปล่อยสิทธิ์เขียน';
  if(phase==='RECOVER_ROUND'&&label==='PILOT_ROUND_TRANSITION_NEEDS_RECONCILIATION')return 'รอบยัง OPEN และคำขอปิดเดิมอาจยังไม่สิ้นสุด ตรวจหลักฐานรอบเดิมและห้ามส่งคำขอปิดซ้ำจากการอ่านครั้งเดียว';
  if(phase==='RUN_SERIAL'&&['PILOT_DURABLE_IDENTITY_REQUIRED','PILOT_DURABLE_IDENTITY_UNVERIFIED'].includes(label))return 'ไม่มี identity store ที่เชื่อถือได้หรือสถานะ marker ไม่ชัด ห้ามสร้างรอบใหม่จาก LIST_OPEN ว่าง; เก็บ directory เดิมและตรวจหลักฐานก่อนดำเนินการ';
  if(phase==='RUN_SERIAL'&&label==='PILOT_ROUND_IDENTITY_NEEDS_RECONCILIATION')return 'พบ identity เดิม แต่สถานะรอบหรือคำขอก่อนหน้าอาจยังไม่ชัด ตรวจ roundId และหลักฐานเดิม; ห้ามสร้างรอบใหม่หรือส่งคำขอซ้ำจากการอ่านครั้งเดียว';
  if(phase==='RUN_SERIAL'&&['PILOT_HANDOVER_NEEDS_RECONCILIATION','PILOT_RECEIPT_NEEDS_RECONCILIATION','PILOT_MOCK_RECEIPT_NEEDS_RECONCILIATION','PILOT_ROUND_TRANSITION_NEEDS_RECONCILIATION','PILOT_ROUND_CLOSE_NEEDS_RECONCILIATION'].includes(label))return 'รอบเดิมยัง OPEN และคำขอก่อนหน้าอาจยังไม่สิ้นสุด ตรวจ round, audit, claim และ receipt เดิม; ห้ามส่ง RECORD, HANDOVER, ADVANCE หรือ CLOSE ซ้ำจากการอ่านครั้งเดียว';
  if(phase==='RUN_SERIAL')return label==='PILOT_SERIAL_FINISHED'?'ตรวจครบชุดงานที่เลือกสำหรับรอบนี้แล้ว':'รอบต่อเนื่องหยุดตามเหตุด้านล่าง ตรวจงานและหลักฐานเดิมก่อนตัดสินใจ; ผลอ่านอย่างเดียวไม่ให้สิทธิ์ส่งซ้ำ';
  if(label==='PILOT_JOB_COMPLETE_DAILY_MATCHED')return 'งานทดลองเสร็จ 1 รายการ รอบคิวปิดแล้ว และแถวรายวันตรงกับ D1';
  if(label==='PILOT_JOB_COMPLETE_DAILY_UNVERIFIED')return 'พบงานและรอบคิวปิดแล้ว แต่ยังยืนยันแถวรายวันกับ D1 ไม่ได้ ใช้ FINISH_PILOT ตรวจงานล่าสุดก่อนขยาย';
  if(label==='PILOT_ORIGINAL_SETTLED_JOB_HELD'||label==='PILOT_ORIGINAL_ALREADY_SETTLED')
    return 'จบการตรวจ DAILY ของรายการเดิม ผลเขียนได้รับการยืนยัน งานเดิมพัก 1 รายการใน REVIEW ตามที่อนุมัติ';
  if(label==='PILOT_ORIGINAL_MATCHED')return 'ตรวจพบหลักฐาน DAILY ตรงกัน ขั้นบันทึก SETTLE ยังต้องตรวจแยก';
  if(phase==='SETTLE'||phase==='PROBE')return 'รอบนี้ยังยืนยันผลเดิมไม่ครบ ตรวจขั้นที่รายงานและหลักฐาน D1 ก่อนพิจารณาครั้งถัดไป';
  if(label==='PILOT_OBSERVATION_TIMEOUT_IN_PROGRESS')return 'หมดรอบติดตาม งานยังทำต่อได้ในคิว ใช้ FINISH_PILOT เพื่อตรวจผลต่อ';
  if(label.startsWith('PILOT_JOB_REVIEW_')||label.startsWith('PILOT_JOB_FAILED_')){
    const row=label.endsWith('_MATCHED')?'แถวรายวันตรงกับ D1':'ยังยืนยันแถวรายวันไม่ได้';
    return 'งานทดลองยังไม่สำเร็จ 1 รายการ '+row+' ผู้ดูแลตรวจเหตุใน sync_jobs และ failed_jobs ของงานทดลองก่อนดำเนินการต่อ';
  }
  if(label==='PILOT_FINISH_NOT_STARTED'||label==='PILOT_NO_HANDOVER_RECORDED')return 'ยังไม่มีหลักฐานการจองงานทดลอง';
  if(phase==='HANDOVER_ONE'||phase==='FINISH_PILOT')return 'ยังยืนยันผลจบงานทดลองไม่ได้ ตรวจหลักฐานการส่งมอบและใช้ FINISH_PILOT เพื่อติดตามงานที่จองไว้';
  return 'ผลของขั้นตรวจที่เลือกแสดงในรหัสด้านล่าง';
}

export function summarize(phase,label,progress,path){
    if(path)appendFileSync(path,
      describeResult(phase,label)+'\n\n`'+label+'`\n'+
      (phase==='HOLD_RESERVED'&&uuid.test(progress?.roundId||'')&&uuid.test(progress?.jobId||'')?`\nรอบ ${progress.roundId} · รายการ ${progress.jobId}\n`:'')+
      (['RUN_SERIAL','RECOVER_ROUND','CLOSE_MOCK_ROUND'].includes(phase)&&uuid.test(progress?.roundId||'')&&!(phase==='RUN_SERIAL'&&uuid.test(progress?.jobId||'')&&uuid.test(progress?.successorJobId||''))?`\nรอบ ${progress.roundId} · อ่านหลักฐานเดิมและอย่าส่งซ้ำจนกระทบยอด\n`:'')+
      (phase==='RUN_SERIAL'&&uuid.test(progress?.roundId||'')&&uuid.test(progress?.jobId||'')&&uuid.test(progress?.successorJobId||'')?`\nรอบ ${progress.roundId} · B ${progress.jobId} · C ${progress.successorJobId}\nอ่านรอบเดิมและตรวจ hold, handoff, claim และ journal ก่อนทำต่อ; ห้ามจองหรือส่งซ้ำเมื่อผลไม่ชัด\n`:'')+
      (progress&&Number.isSafeInteger(progress.verified)&&Number.isSafeInteger(progress.remaining)?`\nยืนยันในรอบนี้ ${progress.verified} รายการ · ในชุดที่เลือกยังยืนยันไม่ครบ ${progress.remaining} รายการ\n`:'')+
      (progress?.openRound&&progress.reservationChain?(
        progress.reservationChain.jobIds.length
          ? `\nประวัติจองใน D1 (Worker ${progress.reservationChain.workerVersion}): ${progress.reservationChain.jobIds.join(' → ')} ติดตามงานปลายสายด้วยการอ่านหลักฐานเดิม\n`
          : '\nยังไม่พบประวัติจองที่ตรงกับรอบนี้ คำขอเดิมอาจยังดำเนินอยู่\n'):'')+
      (progress?.jobs&&label==='PILOT_MOCK_ROUND_RECORDED'?`\nผลจำลอง: ${progress.jobs.map(x=>`${x.jobId}: ${x.category} → ${x.successorJobId??'ไม่มีรายการถัดไป'}`).join(', ')}\n`:
       progress?.jobs&&label==='PILOT_ROUND_RECORDED_READ_ONLY'?`\nผลที่บันทึกไว้: ${progress.jobs.map(x=>`${x.jobId} → ${x.successorJobId??'ไม่มีรายการถัดไป'} (เวลาตรวจ ${x.verifiedAt}, Worker ${x.workerVersion})`).join(', ')}\n`:
       progress?.jobs?`\nรายการที่ต้องตรวจ: ${progress.jobs.map(x=>`${x.jobId} → ${x.successorJobId??(progress.openRound?(progress.reservationChain?'ยังยืนยันการจองถัดไปไม่ได้':'ยังไม่ตรวจสายการจอง'):'ยังไม่พบการจองถัดไป')} (job ${x.jobState??'ไม่พบ'}, เหตุพัก ${x.holdReason??'ไม่ระบุ'}, ประวัติ lease ${x.provenanceVersion===1?`generation ${x.leaseGeneration}`:'UNKNOWN'}, epoch ${x.epochState??'ไม่พบ'}, claim ทั้งไฟล์ ${x.workbookClaimStateGlobal??'ไม่พบ'} / phase ${x.workbookClaimPhaseGlobal??'ไม่พบ'} / เหตุ ${x.workbookClaimReasonGlobal??'ไม่พบ'}, ความสัมพันธ์ claim ${x.claimRelationship}, operation ที่ยังไม่ยืนยัน ${x.admittedOperations}, ขั้น VERIFIED ${x.verifiedStages}${x.lastVerifiedStageCandidate?`, ขั้นที่พบ ณ เวลาล่าสุด ${x.lastVerifiedStageCandidate} ${x.lastVerifiedAt} (อาจมีหลายขั้นเวลาเดียวกัน)`:''}, ขั้นไม่ชัด ${x.unresolvedStages})`).join(', ')}\nข้อมูลอ่านเมื่อ ${progress.observedAt} แยกจาก snapshot รอบและไม่ใช่ proof; version 1/generation ยังไม่ได้ตรวจ marker และ trigger; generation 0 และ NO_CLAIM ไม่พิสูจน์ว่าไม่เคยรับ lease หรือ provider สิ้นสุด และไม่ให้สิทธิ์ C ตรวจ journal ใน D1 ตามคู่มือก่อนดำเนินการต่อ\n`:'')+
      (progress?.jobs?.some(x=>x.holdReason==='SERIAL_EXPIRED_PROVIDER_UNCERTAIN')?'\nผล provider ยังไม่ชัด ต้องกระทบยอด claim ทั้งไฟล์และ journal ก่อนทำต่อ ห้ามส่งซ้ำ\n':'')+
      (progress?.rounds?`\n${progress.rounds.length?progress.rounds.map(r=>`รอบ ${r.roundId}: ${r.state}, ${r.selected} รายการ`).join('\n'):'ไม่พบรอบล่าสุด'}\n`:''));
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  runNormalPilot(process.env).then(result=>{
    const label=result.outcome??result;
    console.log(label);summarize(process.env.PILOT_PHASE,label,result.outcome?result:undefined,process.env.GITHUB_STEP_SUMMARY);
  }).catch(error=>{
    const label=/^(PILOT|MONTHLY)_[A-Z_]+$/.test(error?.message||'')?error.message:'PILOT_UNKNOWN_NO_RETRY';
    console.error(label);
    summarize(process.env.PILOT_PHASE,label,error.serialProgress,process.env.GITHUB_STEP_SUMMARY);
    process.exitCode=1;
  });
}
