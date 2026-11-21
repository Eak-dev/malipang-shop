// RUNNER-SIDE REVIEW CANDIDATE. Caller must prove exact GitHub run/attempt,
// source and receipt digest. Never pass tokens as arguments or log snapshots.
import {readFileSync,writeFileSync} from 'node:fs';
import {makeStageProof} from './issue248-stage-proof.mjs';
try{
 const {STAGE_NONCE,GITHUB_RUN_ID,GITHUB_RUN_ATTEMPT,GITHUB_SHA,EXPECTED_WORKER_VERSION,RUNNER_TEMP}=process.env;
 const snapshot=JSON.parse(readFileSync(`${RUNNER_TEMP}/mp248-snapshot.json`,'utf8'));
 const extraD1=JSON.parse(readFileSync(`${RUNNER_TEMP}/mp248-stage-d1.json`,'utf8'));
 const intentRaw=readFileSync(`${RUNNER_TEMP}/mp248-cas-intent.json`,'utf8');
 const ackRaw=readFileSync(`${RUNNER_TEMP}/mp248-cas-ack.json`,'utf8');
 const observationStartedAt=readFileSync(`${RUNNER_TEMP}/mp248-observation-started.txt`,'utf8').trim();
 const proof=makeStageProof({mode:'POST',nonce:STAGE_NONCE,run:GITHUB_RUN_ID,attempt:GITHUB_RUN_ATTEMPT,sourceSha:GITHUB_SHA,workerVersion:EXPECTED_WORKER_VERSION,snapshot,extraD1,intentRaw,ackRaw,observationStartedAt});
 const raw=JSON.stringify(proof);writeFileSync(`${RUNNER_TEMP}/mp248-stage-proof.json`,raw,{mode:0o600,flag:'wx'});
 console.log('MP248_STAGE_PROOF_PREPARED');
}catch{console.error('NO_GO_STAGE_PROOF');process.exitCode=1;}
