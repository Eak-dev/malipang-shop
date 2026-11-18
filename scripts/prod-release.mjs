// Production release operations for .github/workflows/prod-release-migrate-deploy.yml
// (#299). One operation per run, each confirmed by an exact text that is
// derived from the live state, so a stale or mistyped request stops before it
// writes anything:
//   migrate          MIGRATE <sha7> FROM <ledger head prefix> TO <last file prefix>
//   deploy           DEPLOY <sha7> CHANGES <sorted var names that change | NONE>
//   rollback_worker  ROLLBACK <sha7> BEFORE RUN <deploy run id>
// The repository is public. Output is limited to fixed status lines, migration
// file names, var names (already public in wrangler.jsonc) and SHA-256 hashes
// of Worker version ids. Wrangler output, version ids, URLs and var values are
// never printed. The version a deploy replaced is stored in the private R2
// bucket before the deploy, so rollback_worker can name it exactly.
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {localMigrations,pendingMigrations,sha256Hex} from './prod-ops-snapshot.mjs';

export const DB='malipang-v5-2',WORKER='malipang-backend-v5-2',BUCKET='malipang-private-backups',RECORD_PREFIX='release-versions/';
const MIGRATION=/^\d{4}_[a-z0-9_]{1,80}\.sql$/;
const VERSION_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VAR_NAME=/^[A-Z][A-Z0-9_]{0,63}$/;
const RUN_ID=/^[1-9][0-9]{0,19}$/;

/** A refusal with a fixed code; nothing from the input or tools is echoed. */
export class ReleaseStop extends Error{constructor(code){super(code);this.name='ReleaseStop';}}
const stop=code=>{throw new ReleaseStop(code);};
const short=sha=>{if(!/^[0-9a-f]{40}$/.test(sha??''))stop('EXPECTED_SHA_INVALID');return sha.slice(0,7);};

export function readLedger(run){
  let out;try{out=JSON.parse(run(['d1','execute',DB,'--remote','--json','--command','SELECT name AS migration FROM d1_migrations ORDER BY id']));}catch{stop('LEDGER_UNREADABLE');}
  const rows=out?.[0]?.results;
  if(out?.[0]?.success===false||!Array.isArray(rows))stop('LEDGER_UNREADABLE');
  const names=rows.map(r=>r?.migration);
  if(names.some(n=>typeof n!=='string'||!MIGRATION.test(n)))stop('LEDGER_UNREADABLE');
  return names;
}

/** The only live version when it serves 100%; anything else stops. */
export function liveVersion(run){
  let status;try{status=JSON.parse(run(['deployments','status','--json']));}catch{stop('WORKER_STATUS_UNREADABLE');}
  const versions=Array.isArray(status?.versions)?status.versions:[];
  if(versions.length!==1||versions[0]?.percentage!==100||!VERSION_ID.test(versions[0]?.version_id??''))stop('WORKER_NOT_SINGLE_VERSION');
  return versions[0].version_id;
}

/** Sorted names of vars that a deploy of `configVars` would add, remove or
 * change, compared with the plain-text vars of the live Worker. Values are
 * compared, never returned. */
export function varChanges(live,configVars){
  if(!configVars||typeof configVars!=='object'||Array.isArray(configVars))stop('CONFIG_VARS_INVALID');
  for(const [k,v] of Object.entries(configVars))if(!VAR_NAME.test(k)||typeof v!=='string')stop('CONFIG_VARS_INVALID');
  for(const k of live.keys())if(!VAR_NAME.test(k))stop('LIVE_VARS_INVALID');
  const names=new Set([...live.keys(),...Object.keys(configVars)]);
  return [...names].filter(k=>live.get(k)!==configVars[k]).sort();
}

export async function liveVars(api){
  let body;try{body=await api(`/workers/scripts/${WORKER}/settings`);}catch{stop('LIVE_SETTINGS_UNREADABLE');}
  const bindings=body?.result?.bindings;
  if(body?.success!==true||!Array.isArray(bindings))stop('LIVE_SETTINGS_UNREADABLE');
  const vars=new Map();
  for(const b of bindings)if(b?.type==='plain_text'){if(typeof b.name!=='string'||typeof b.text!=='string')stop('LIVE_SETTINGS_UNREADABLE');vars.set(b.name,b.text);}
  return vars;
}

function withTemp(fn){const dir=mkdtempSync(join(tmpdir(),'release-'));try{return fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}}
const recordKey=runId=>{if(!RUN_ID.test(runId??''))stop('RUN_ID_INVALID');return `${BUCKET}/${RECORD_PREFIX}${runId}.json`;};

/** Writes the record, reads it back and compares, so a stored rollback target
 * is proven before the deploy that needs it. */
export function putRecord(run,runId,record){
  const key=recordKey(runId),text=JSON.stringify(record);
  withTemp(dir=>{
    const file=join(dir,'record.json'),back=join(dir,'back.json');writeFileSync(file,text,{mode:0o600});
    try{run(['r2','object','put',key,`--file=${file}`,'--remote']);run(['r2','object','get',key,`--file=${back}`,'--remote']);}catch{stop('RECORD_WRITE_FAILED');}
    let same=false;try{same=readFileSync(back,'utf8')===text;}catch{}
    if(!same)stop('RECORD_WRITE_FAILED');
  });
}
export function getRecord(run,runId){
  const key=recordKey(runId);
  return withTemp(dir=>{
    const file=join(dir,'record.json');let record;
    try{run(['r2','object','get',key,`--file=${file}`,'--remote']);record=JSON.parse(readFileSync(file,'utf8'));}catch{stop('RECORD_UNREADABLE');}
    if(!record||typeof record!=='object'||!VERSION_ID.test(record.prior??'')||record.deployed!==null&&!VERSION_ID.test(record.deployed??''))stop('RECORD_UNREADABLE');
    return record;
  });
}

export function migrate({run,sha,confirmation,local,say}){
  const s=short(sha),applied=readLedger(run);
  if(!applied.length)stop('LEDGER_EMPTY');
  if(applied.some(n=>!local.includes(n)))stop('LEDGER_HAS_MIGRATION_NOT_IN_THIS_COMMIT');
  const head=applied.at(-1),pending=pendingMigrations(applied,local);
  say(`- ledger_head_before: ${head}`);
  if(!pending.length)stop('NOTHING_TO_APPLY');
  // D1 applies in file order; an unapplied file older than the head is a gap.
  if(pending.some(n=>n<=head))stop('PENDING_FILE_OLDER_THAN_HEAD');
  const want=`MIGRATE ${s} FROM ${head.slice(0,4)} TO ${local.at(-1).slice(0,4)}`;
  if(confirmation!==want){say(`- expected_confirmation: ${want}`);stop('CONFIRMATION_MISMATCH');}
  say(`- pending_before: ${pending.join(' ')}`);
  let failed=false;
  try{run(['d1','migrations','apply',DB,'--remote'],{input:'y\n'});}catch{failed=true;}
  // Always read the ledger back: an error may still have applied some files.
  const after=readLedger(run),left=pendingMigrations(after,local);
  say(`- applied_now: ${pending.filter(n=>after.includes(n)).join(' ')||'none'}`);
  say(`- pending_after: ${left.join(' ')||'none'}`);
  if(failed||left.length){say('- migrate: INCOMPLETE — follow the runbook section for a migration that stopped midway; do not rerun blindly');return 1;}
  say(`- ledger_head_after: ${after.at(-1)}`);say('- migrate: PASS');return 0;
}

export async function deploy({run,api,sha,confirmation,local,config,runId,attempt,say}){
  const s=short(sha);
  // A rerun would record the first attempt's new version as the rollback target.
  if(attempt!=='1')stop('RERUN_NOT_ALLOWED_DISPATCH_A_NEW_RUN');
  recordKey(runId);
  if(config?.name!==WORKER)stop('CONFIG_WORKER_NAME_MISMATCH');
  const pending=pendingMigrations(readLedger(run),local);
  if(pending.length){say(`- pending_migrations: ${pending.join(' ')}`);stop('PENDING_MIGRATIONS');}
  const prior=liveVersion(run),changes=varChanges(await liveVars(api),config.vars);
  say(`- config_changes: ${changes.join(',')||'NONE'}`);
  const want=`DEPLOY ${s} CHANGES ${changes.join(',')||'NONE'}`;
  if(confirmation!==want){say(`- expected_confirmation: ${want}`);stop('CONFIRMATION_MISMATCH');}
  try{run(['deploy','--dry-run']);}catch{stop('DRY_RUN_FAILED');}
  putRecord(run,runId,{sha,prior,deployed:null});
  say('- rollback_record: STORED');
  let ackLost=false;try{run(['deploy']);}catch{ackLost=true;}
  let after;try{after=liveVersion(run);}catch{say('- deploy: UNKNOWN — read the live version (snapshot) before any further action');return 1;}
  if(after===prior){say(ackLost?'- deploy: FAIL (live version unchanged)':'- deploy: UNKNOWN (command returned but live version unchanged)');return 1;}
  try{putRecord(run,runId,{sha,prior,deployed:after});say('- rollback_record_update: STORED');}
  catch{say('- rollback_record_update: FAIL — the prior version is stored, but rollback_worker will refuse this run until the record names the deployed version');}
  if(ackLost)say('- deploy_ack: LOST (live version changed)');
  say(`- deployed_version_sha256: ${sha256Hex(after)}`);say('- deploy: PASS');return 0;
}

export function rollbackWorker({run,sha,confirmation,say}){
  const s=short(sha),m=/^ROLLBACK ([0-9a-f]{7}) BEFORE RUN ([1-9][0-9]{0,19})$/.exec(confirmation??'');
  if(!m||m[1]!==s)stop('CONFIRMATION_MISMATCH');
  const record=getRecord(run,m[2]),live=liveVersion(run);
  if(live===record.prior)stop('ALREADY_AT_PRIOR_VERSION');
  if(record.deployed===null)stop('DEPLOYED_VERSION_NOT_RECORDED');
  if(live!==record.deployed)stop('LIVE_VERSION_NOT_FROM_THAT_RUN');
  let ackLost=false;try{run(['rollback',record.prior,'--yes',`--message=rollback before release run ${m[2]}`]);}catch{ackLost=true;}
  let after;try{after=liveVersion(run);}catch{say('- rollback_worker: UNKNOWN — read the live version before any further action');return 1;}
  if(after!==record.prior){say(`- rollback_worker: ${ackLost?'FAIL':'UNKNOWN'} (live version is not the recorded prior version)`);return 1;}
  if(ackLost)say('- rollback_ack: LOST (live version is the recorded prior version)');
  say(`- live_version_sha256: ${sha256Hex(after)}`);say('- rollback_worker: PASS');return 0;
}

function wrangler(args,{input}={}){return execFileSync('npx',['wrangler',...args],{encoding:'utf8',input,stdio:[input===undefined?'ignore':'pipe','pipe','ignore'],maxBuffer:32*1024*1024});}
async function cloudflare(path){
  const res=await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}${path}`,{headers:{Authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`},signal:AbortSignal.timeout(20000)});
  return res.json();
}

export async function runOperation(op,{run=wrangler,api=cloudflare,env=process.env,local=localMigrations(),config,say=line=>process.stdout.write(line+'\n')}={}){
  say(`## Production release: ${['migrate','deploy','rollback_worker'].includes(op)?op:'unknown'}`);
  const base={run,sha:env.EXPECTED_SHA,confirmation:env.CONFIRMATION,say};
  try{
    if(op==='migrate')return migrate({...base,local});
    if(op==='deploy')return await deploy({...base,api,local,config:config??JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8')),runId:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT});
    if(op==='rollback_worker')return rollbackWorker(base);
    stop('UNKNOWN_OPERATION');
  }catch(error){say(`- stop: ${error instanceof ReleaseStop?error.message:'UNEXPECTED_ERROR'}`);return 1;}
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
  process.exitCode=await runOperation(process.env.RELEASE_OPERATION);
}
