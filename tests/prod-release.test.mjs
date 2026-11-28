// #299: Production migrate / deploy / rollback_worker. Every refusal must
// happen before a write, and output must carry no ids or Production numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {runOperation,varChanges,fingerprintOf,ReleaseStop,DB,WORKER,BUCKET} from '../scripts/prod-release.mjs';
import {sha256Hex} from '../scripts/prod-ops-snapshot.mjs';
import {HISTORICAL_DAILY_PIN,parseProbeEvidence} from '../scripts/prod-historical-daily-probe.mjs';

const SHA='fdb3cc24e9e440a4bdcaa6842aed5984f56f96c6',S=SHA.slice(0,7);
const V0='d0000000-0000-4000-8000-000000000000',V1='e1111111-1111-4111-8111-111111111111',V2='f2222222-2222-4222-8222-222222222222';
const LOCAL=['0001_init.sql','0023_stable_recovery_admission.sql','0024_next.sql','0061_last.sql'];
const CONFIG={name:WORKER,vars:{APP_ENV:'production',FLAG_A_ENABLED:'false'}};

/** A fake wrangler + Cloudflare API with Production-like state. */
function world({local=LOCAL,claims=[],ledger=LOCAL.slice(0,2),live=V0,liveVars={APP_ENV:'production',FLAG_A_ENABLED:'false'},fail={}}={}){
  const calls=[],r2=new Map(),w={ledger:[...ledger],live,calls,r2,lines:[],sleeps:[],statusFailures:fail.statusFailures??0,deployed:false};
  w.run=(args,opts)=>{
    calls.push(args.join(' '));
    const [a,b]=args;
    if(a==='d1'&&b==='execute'&&args.at(-1).includes('stable_workbook_claims')){if(fail.claim)throw Error('x');return JSON.stringify([{success:true,results:claims}]);}
    if(a==='d1'&&b==='execute'){if(fail.ledger)throw Error('x');return JSON.stringify([{success:true,results:w.ledger.map(migration=>({migration}))}]);}
    if(a==='d1'&&b==='migrations'){assert.equal(opts?.input,'y\n');const pending=local.filter(n=>!w.ledger.includes(n));for(const n of pending.slice(0,fail.applyAfter??pending.length))w.ledger.push(n);if(fail.apply)throw Error('x');return 'private wrangler output '+V1;}
    if(a==='deployments'){if(fail.status)throw Error('x');if(w.deployed&&w.statusFailures>0){w.statusFailures--;throw Error('x');}return JSON.stringify({versions:fail.split?[{version_id:w.live,percentage:90},{version_id:V2,percentage:10}]:[{version_id:w.live,percentage:100}]});}
    if(a==='deploy'&&b==='--dry-run'){if(fail.dryRun)throw Error('x');return '';}
    if(a==='deploy'){w.deployed=true;if(!fail.deployNoChange)w.live=V1;if(fail.deploy)throw Error('x');return 'https://private.example '+V1;}
    if(a==='rollback'){w.deployed=true;if(!fail.rollbackNoChange)w.live=args[1];if(fail.rollback)throw Error('x');return '';}
    if(a==='r2'){const key=args[3],file=args.find(x=>x.startsWith('--file=')).slice(7);
      if(args[2]==='put'){if(fail.r2Put)throw Error('x');r2.set(key,readFileSync(file,'utf8'));return '';}
      if(args[2]==='get'){if(!r2.has(key))throw Error('missing');writeFileSync(file,r2.get(key));return '';}}
    throw Error('unexpected call '+args.join(' '));
  };
  w.api=async path=>{assert.equal(path,`/workers/scripts/${WORKER}/settings`);if(fail.api)return{success:false};return{success:true,result:{bindings:[...Object.entries(liveVars).map(([name,text])=>({type:'plain_text',name,text})),{type:'secret_text',name:'GOOGLE_PRIVATE_KEY_BASE64'}]}};};
  w.go=(op,confirmation,extra={})=>runOperation(op,{run:w.run,api:w.api,sleep:async ms=>{w.sleeps.push(ms);},local,config:extra.config??CONFIG,env:{EXPECTED_SHA:SHA,CONFIRMATION:confirmation,GITHUB_RUN_ID:'44300000001',GITHUB_RUN_ATTEMPT:extra.attempt??'1',...extra.env},say:l=>w.lines.push(l)});
  w.text=()=>w.lines.join('\n');
  w.writes=()=>calls.filter(c=>/^(d1 migrations|deploy$|rollback|r2 object put)/.test(c));
  return w;
}
// Deploy and rollback start with every migration applied.
const dw=(o={})=>world({ledger:LOCAL,...o});
const historicalEvidence=JSON.stringify({receipt:{incidentFingerprint:'1'.repeat(64),archiveIdentityDigest:'2'.repeat(64),
 archiveGridDigest:'3'.repeat(64),approvedDeltaDigest:'4'.repeat(64),liveGridDigest:'5'.repeat(64)},preimageDigest:'6'.repeat(64)});
const historicalOpts={env:{HISTORICAL_DAILY_PROBE:'true',MALIPANG_HISTORICAL_DAILY_PROBE:historicalEvidence}};

test('historical probe release compares and passes only the privately derived pin to Wrangler',async()=>{
 const w=dw(),pin=parseProbeEvidence(historicalEvidence).pin,flag=`--var ${HISTORICAL_DAILY_PIN}:${pin}`;
 assert.equal(await w.go('preflight',`PREFLIGHT ${S}`,historicalOpts),0,w.text());
 assert.ok(w.calls.includes(`deploy --dry-run ${flag}`));
 assert.equal(await w.go('deploy',`DEPLOY ${S} CHANGES ${HISTORICAL_DAILY_PIN}`,historicalOpts),0,w.text());
 assert.ok(w.calls.includes(`deploy ${flag}`));
 assert.ok(w.text().includes(`config_changes: ${HISTORICAL_DAILY_PIN}`));
 assert.ok(!w.text().includes(pin));
});

test('historical probe release rejects missing evidence, pending D1 migrations, and unrelated config drift',async()=>{
 const empty=dw();
 assert.equal(await empty.go('preflight',`PREFLIGHT ${S}`,{env:{HISTORICAL_DAILY_PROBE:'true'}}),1);
 assert.equal(empty.calls.length,0);
 const migration=world();
 assert.equal(await migration.go('preflight',`PREFLIGHT ${S}`,historicalOpts),1);
 assert.equal(migration.writes().length,0);
 const extraMigration=world({ledger:[...LOCAL,'0062_unreviewed.sql']});
 assert.equal(await extraMigration.go('deploy',`DEPLOY ${S} CHANGES ${HISTORICAL_DAILY_PIN}`,historicalOpts),1);
 assert.equal(extraMigration.writes().length,0);
 const drift=dw({liveVars:{...CONFIG.vars,FLAG_A_ENABLED:'true'}});
 assert.equal(await drift.go('deploy',`DEPLOY ${S} CHANGES ${HISTORICAL_DAILY_PIN},FLAG_A_ENABLED`,historicalOpts),1);
 assert.ok(!drift.calls.some(call=>call.startsWith('deploy ')));
 assert.equal(drift.writes().length,0);
});
test('historical audit preflight allows the exact pending 0068 only with unchanged deployed settings',async()=>{
 const prefix=['0001_init.sql','0066_scoped_hold_incident.sql','0067_monthly_report_journal.sql'];
 const audit='0068_issue296_historical_daily_audit.sql',local=[...prefix,audit];
 const pin=parseProbeEvidence(historicalEvidence).pin;
 const liveVars={...CONFIG.vars,[HISTORICAL_DAILY_PIN]:pin};
 const clean=world({local,ledger:prefix.slice(),liveVars});
 assert.equal(await clean.go('preflight',`PREFLIGHT ${S}`,historicalOpts),0,clean.text());
 assert.match(clean.text(),/expected_migrate_confirmation: MIGRATE [a-f0-9]+ FROM 0067 TO 0068/);
 assert.match(clean.text(),/config_changes: NONE/);
 assert.equal(clean.deployed,false);
 assert.ok(!clean.writes().some(call=>call.startsWith('d1 migrations')));
 assert.equal(await clean.go('deploy',`DEPLOY ${S} CHANGES NONE`,historicalOpts),1);
 assert.match(clean.text(),/HISTORICAL_PROBE_LEDGER_MISMATCH/);
 assert.equal(clean.deployed,false);
 assert.equal(await clean.go('migrate',`MIGRATE ${S} FROM 0067 TO 0068`),0,clean.text());
 assert.deepEqual(clean.ledger,local);
 assert.equal(await clean.go('deploy',`DEPLOY ${S} CHANGES NONE`,historicalOpts),0,clean.text());

 for(const vars of [CONFIG.vars,{...liveVars,[HISTORICAL_DAILY_PIN]:'f'.repeat(64)},
   {...liveVars,FLAG_A_ENABLED:'true'},{...liveVars,EXACT_DAILY_SETTLEMENT_ENABLED:'true'}]){
  const drift=world({local,ledger:prefix,liveVars:vars});
  assert.equal(await drift.go('preflight',`PREFLIGHT ${S}`,historicalOpts),1,drift.text());
  assert.match(drift.text(),/HISTORICAL_PROBE_CONFIG_DRIFT/);
  assert.deepEqual(drift.writes(),[]);
 }
 for(const variant of [
   {local,ledger:[prefix[0],prefix[2]]},
   {local,ledger:[prefix[1],prefix[0],prefix[2]]},
   {local,ledger:[...prefix,prefix[2]]},
   {local:[...prefix,'0068_serial_round_evidence.sql'],ledger:prefix},
   {local:[...prefix,audit,'0069_other.sql'],ledger:prefix},
   {local:[...prefix.slice(0,-1),'0067_renamed.sql',audit],ledger:[...prefix.slice(0,-1),'0067_renamed.sql']},
 ]){
  const stale=world({...variant,liveVars});
  assert.equal(await stale.go('preflight',`PREFLIGHT ${S}`,historicalOpts),1,stale.text());
  assert.match(stale.text(),/HISTORICAL_PROBE_LEDGER_MISMATCH/);
  assert.deepEqual(stale.writes(),[]);
 }
});

const noIds=w=>{const t=w.text();for(const id of [V0,V1,V2])assert.equal(t.includes(id),false,t);assert.equal(t.includes('private'),false,t);
  // Only migration names, the short SHA, run ids in an expected confirmation and 64-hex hashes may carry digits.
  assert.equal(t.replace(/\b\d{4}_[a-z0-9_]+\.sql\b/g,'').replace(/\b[0-9a-f]{64}\b/g,'').replace(/_sha256:/g,':').replace(/: (0|1-9|10\+)$/gm,':').replace(/SINGLE_VERSION_100/g,'').replace(/after 3 reads/g,'').replace(/live_version_sha256/g,'').replace(new RegExp(S,'g'),'').replace(/\b(FROM|TO) \d{4}\b/g,'').match(/\d/),null,t);};

test('migrate applies only when the confirmation names the live head and the last file',async()=>{
  const w=world();
  assert.equal(await w.go('migrate',`MIGRATE ${S} FROM 0023 TO 0061`),0,w.text());
  assert.deepEqual(w.ledger,LOCAL);
  assert.match(w.text(),/ledger_head_before: 0023_stable_recovery_admission\.sql/);assert.match(w.text(),/pending_before: 0024_next\.sql 0061_last\.sql/);
  assert.match(w.text(),/pending_after: none/);assert.match(w.text(),/migrate: PASS/);noIds(w);
  assert.equal(w.calls.filter(c=>c.startsWith('d1 migrations apply')).length,1);
  assert.equal(w.calls.find(c=>c.startsWith('d1 migrations')),`d1 migrations apply ${DB} --remote`);
});

test('migrate refuses before applying on a stale or wrong request',async()=>{
  for(const [setup,confirmation,code] of [
    [{},`MIGRATE ${S} FROM 0022 TO 0061`,'CONFIRMATION_MISMATCH'],
    [{},`MIGRATE ${S} FROM 0023 TO 0060`,'CONFIRMATION_MISMATCH'],
    [{},`MIGRATE 0000000 FROM 0023 TO 0061`,'CONFIRMATION_MISMATCH'],
    [{ledger:LOCAL},`MIGRATE ${S} FROM 0061 TO 0061`,'NOTHING_TO_APPLY'],
    [{ledger:[...LOCAL.slice(0,2),'0099_unknown.sql']},`MIGRATE ${S} FROM 0099 TO 0061`,'LEDGER_HAS_MIGRATION_NOT_IN_THIS_COMMIT'],
    [{ledger:['0001_init.sql','0024_next.sql']},`MIGRATE ${S} FROM 0024 TO 0061`,'PENDING_FILE_OLDER_THAN_HEAD'],
    [{ledger:[]},`MIGRATE ${S} FROM 0000 TO 0061`,'LEDGER_EMPTY'],
    [{fail:{ledger:true}},`MIGRATE ${S} FROM 0023 TO 0061`,'LEDGER_UNREADABLE'],
  ]){
    const w=world(setup);assert.equal(await w.go('migrate',confirmation),1);
    assert.match(w.text(),new RegExp(`stop: ${code}`),w.text());assert.deepEqual(w.writes(),[],code);noIds(w);
  }
  const w=world();await w.go('migrate',`MIGRATE ${S} FROM 0022 TO 0061`);assert.match(w.text(),new RegExp(`expected_confirmation: MIGRATE ${S} FROM 0023 TO 0061`));
});

test('migrate that stops midway reads the ledger back and reports what is left',async()=>{
  const w=world({fail:{apply:true,applyAfter:1}});
  assert.equal(await w.go('migrate',`MIGRATE ${S} FROM 0023 TO 0061`),1);
  assert.match(w.text(),/applied_now: 0024_next\.sql/);assert.match(w.text(),/pending_after: 0061_last\.sql/);assert.match(w.text(),/migrate: INCOMPLETE/);
  assert.equal(w.calls.filter(c=>c.startsWith('d1 migrations')).length,1,'never retried');noIds(w);
  // An error after every file applied is still not a PASS.
  const x=world({fail:{apply:true}});assert.equal(await x.go('migrate',`MIGRATE ${S} FROM 0023 TO 0061`),1);assert.match(x.text(),/pending_after: none/);assert.match(x.text(),/INCOMPLETE/);
});

test('var changes compare values without returning them',()=>{
  const live=new Map([['A','1'],['B','x'],['GONE','y']]);
  assert.deepEqual(varChanges(live,{A:'1',B:'z',NEW_ENABLED:'true'}),['B','GONE','NEW_ENABLED']);
  assert.deepEqual(varChanges(new Map([['A','1']]),{A:'1'}),[]);
  assert.throws(()=>varChanges(live,{A:1}),e=>e instanceof ReleaseStop&&e.message==='CONFIG_VARS_INVALID');
  assert.throws(()=>varChanges(live,{'bad name':'1'}),e=>e instanceof ReleaseStop);
});

test('deploy stores the replaced version in R2 before deploying and prints only a hash',async()=>{
  const w=dw();
  assert.equal(await w.go('deploy',`DEPLOY ${S} CHANGES NONE`),0,w.text());
  const firstPut=w.calls.findIndex(c=>c.startsWith('r2 object put')),realDeploy=w.calls.indexOf('deploy');
  assert.ok(firstPut>=0&&firstPut<realDeploy,'record stored before the deploy');
  assert.ok(w.calls.indexOf('deploy --dry-run')<firstPut,'dry run first');
  const record=JSON.parse(w.r2.get(`${BUCKET}/release-versions/44300000001.json`));
  assert.deepEqual(record,{sha:SHA,prior:V0,deployed:V1});
  assert.match(w.text(),/config_changes: NONE/);assert.match(w.text(),new RegExp(`deployed_version_sha256: ${sha256Hex(V1)}`));assert.match(w.text(),/deploy: PASS/);noIds(w);
});

test('deploy confirmation must list exactly the vars that change against the live Worker',async()=>{
  const config={name:WORKER,vars:{APP_ENV:'production',FLAG_A_ENABLED:'true',FLAG_B_ENABLED:'true'}};
  const w=dw();assert.equal(await w.go('deploy',`DEPLOY ${S} CHANGES NONE`,{config}),1);
  assert.match(w.text(),/config_changes: FLAG_A_ENABLED,FLAG_B_ENABLED/);assert.match(w.text(),new RegExp(`expected_confirmation: DEPLOY ${S} CHANGES FLAG_A_ENABLED,FLAG_B_ENABLED`));
  assert.deepEqual(w.writes(),[]);assert.equal(w.text().includes('true'),false,'values are never printed');
  const ok=dw();assert.equal(await ok.go('deploy',`DEPLOY ${S} CHANGES FLAG_A_ENABLED,FLAG_B_ENABLED`,{config}),0,ok.text());
  // A var removed from config would be deleted by wrangler deploy: it must be named too.
  const removed=dw({liveVars:{APP_ENV:'production',FLAG_A_ENABLED:'false',OLD_VAR:'x'}});
  assert.equal(await removed.go('deploy',`DEPLOY ${S} CHANGES NONE`),1);assert.match(removed.text(),/config_changes: OLD_VAR/);assert.deepEqual(removed.writes(),[]);
});

test('deploy refuses before any write when the state is not exactly as expected',async()=>{
  for(const [setup,code,extra] of [
    [{ledger:LOCAL.slice(0,3)},'PENDING_MIGRATIONS'],
    [{fail:{split:true}},'WORKER_NOT_SINGLE_VERSION'],
    [{fail:{status:true}},'WORKER_STATUS_UNREADABLE'],
    [{fail:{api:true}},'LIVE_SETTINGS_UNREADABLE'],
    [{fail:{dryRun:true}},'DRY_RUN_FAILED'],
    [{fail:{r2Put:true}},'RECORD_WRITE_FAILED'],
    [{},'RERUN_NOT_ALLOWED_DISPATCH_A_NEW_RUN',{attempt:'2'}],
    [{},'CONFIG_WORKER_NAME_MISMATCH',{config:{name:'other',vars:{}}}],
  ]){
    const w=dw(setup);assert.equal(await w.go('deploy',`DEPLOY ${S} CHANGES NONE`,extra),1,code);
    assert.match(w.text(),new RegExp(`stop: ${code}`),w.text());
    assert.equal(w.calls.includes('deploy'),false,code);noIds(w);
  }
  const w=dw({ledger:LOCAL.slice(0,3)});await w.go('deploy',`DEPLOY ${S} CHANGES NONE`);assert.match(w.text(),/pending_migrations: 0061_last\.sql/);
});

test('a lost deploy ACK is resolved by reading the live version, never by deploying again',async()=>{
  const changed=dw({fail:{deploy:true}});
  assert.equal(await changed.go('deploy',`DEPLOY ${S} CHANGES NONE`),0);assert.match(changed.text(),/deploy_ack: LOST \(live version changed\)/);
  assert.equal(changed.calls.filter(c=>c==='deploy').length,1);
  const same=dw({fail:{deploy:true,deployNoChange:true}});
  assert.equal(await same.go('deploy',`DEPLOY ${S} CHANGES NONE`),1);assert.match(same.text(),/deploy: FAIL \(live version unchanged after 3 reads\)/);
  assert.equal(same.calls.filter(c=>c==='deploy').length,1);
  const quiet=dw({fail:{deployNoChange:true}});assert.equal(await quiet.go('deploy',`DEPLOY ${S} CHANGES NONE`),1);assert.match(quiet.text(),/deploy: UNKNOWN/);
  // The prior version stays stored even when the follow-up record write fails.
  const rec=dw();
  rec.run=(orig=>(args,o)=>{if(args[0]==='r2'&&args[2]==='put'&&rec.r2.size>=1)throw Error('x');return orig(args,o);})(rec.run);
  assert.equal(await rec.go('deploy',`DEPLOY ${S} CHANGES NONE`),0);assert.match(rec.text(),/rollback_record_update: FAIL/);
  assert.equal(JSON.parse([...rec.r2.values()][0]).prior,V0);
  for(const w of [changed,same,quiet,rec])noIds(w);
});

test('deploy polls the live version up to three times before concluding',async()=>{
  // Status unreadable twice after the deploy, then readable: PASS after waiting.
  const slow=dw({fail:{statusFailures:2}});
  assert.equal(await slow.go('deploy',`DEPLOY ${S} CHANGES NONE`),0,slow.text());assert.deepEqual(slow.sleeps,[10000,10000]);
  assert.equal(slow.calls.filter(c=>c==='deploy').length,1);
  // Never readable: UNKNOWN with the instruction not to deploy again.
  const dark=dw({fail:{statusFailures:9}});
  assert.equal(await dark.go('deploy',`DEPLOY ${S} CHANGES NONE`),1);assert.match(dark.text(),/deploy: UNKNOWN — status unreadable after 3 reads; do not dispatch another deploy/);
  assert.equal(dark.calls.filter(c=>c==='deployments status --json').length,4,'one read before and three after the deploy');
  // Unchanged on every read: three reads, then FAIL/UNKNOWN; never a second deploy.
  const same=dw({fail:{deployNoChange:true}});
  assert.equal(await same.go('deploy',`DEPLOY ${S} CHANGES NONE`),1);assert.match(same.text(),/unchanged after 3 reads/);assert.deepEqual(same.sleeps,[10000,10000]);
  assert.equal(same.calls.filter(c=>c==='deploy').length,1);
  for(const w of [slow,dark,same])noIds(w);
});

test('rollback_worker returns to the recorded prior version only from that run\'s version',async()=>{
  const w=dw();await w.go('deploy',`DEPLOY ${S} CHANGES NONE`);w.lines.length=0;
  assert.equal(await w.go('rollback_worker',`ROLLBACK ${S} BEFORE RUN 44300000001`),0,w.text());
  assert.equal(w.live,V0);assert.ok(w.calls.some(c=>c.startsWith(`rollback ${V0} --yes`)));
  assert.match(w.text(),new RegExp(`live_version_sha256: ${sha256Hex(V0)}`));assert.match(w.text(),/rollback_worker: PASS/);noIds(w);
  // Already back, another deploy since, unknown run, wrong text: refused without a rollback call.
  for(const [prep,confirmation,code] of [
    [()=>{},`ROLLBACK ${S} BEFORE RUN 44300000001`,'ALREADY_AT_PRIOR_VERSION'],
    [x=>{x.live=V2;},`ROLLBACK ${S} BEFORE RUN 44300000001`,'LIVE_VERSION_NOT_FROM_THAT_RUN'],
    [()=>{},`ROLLBACK ${S} BEFORE RUN 1`,'RECORD_UNREADABLE'],
    [()=>{},`ROLLBACK 0000000 BEFORE RUN 44300000001`,'CONFIRMATION_MISMATCH'],
  ]){
    prep(w);const before=w.calls.filter(c=>c.startsWith('rollback')).length;w.lines.length=0;
    assert.equal(await w.go('rollback_worker',confirmation),1);assert.match(w.text(),new RegExp(`stop: ${code}`),w.text());
    assert.equal(w.calls.filter(c=>c.startsWith('rollback')).length,before,code);w.live=V0;
  }
  // A record without the deployed version cannot prove which version to replace.
  const x=dw();x.r2.set(`${BUCKET}/release-versions/44300000001.json`,JSON.stringify({sha:SHA,prior:V0,deployed:null}));x.live=V1;
  assert.equal(await x.go('rollback_worker',`ROLLBACK ${S} BEFORE RUN 44300000001`),1);assert.match(x.text(),/stop: DEPLOYED_VERSION_NOT_RECORDED/);
  const lost=dw();await lost.go('deploy',`DEPLOY ${S} CHANGES NONE`);lost.run=(o=>(a,p)=>{if(a[0]==='rollback'){o(a,p);throw Error('x');}return o(a,p);})(lost.run);lost.lines.length=0;
  assert.equal(await lost.go('rollback_worker',`ROLLBACK ${S} BEFORE RUN 44300000001`),0);assert.match(lost.text(),/rollback_ack: LOST/);
});

test('preflight reads every input and probes R2 without any D1 or Worker write',async()=>{
  const w=world();
  assert.equal(await w.go('preflight',`PREFLIGHT ${S}`),0,w.text());
  assert.match(w.text(),/ledger_head: 0023_stable_recovery_admission\.sql/);assert.match(w.text(),/pending_migrations: 1-9/);
  assert.match(w.text(),new RegExp(`expected_migrate_confirmation: MIGRATE ${S} FROM 0023 TO 0061`));
  assert.match(w.text(),new RegExp(`live_version_sha256: ${sha256Hex(V0)}`));assert.match(w.text(),/config_changes: NONE/);assert.match(w.text(),/dry_run: PASS/);assert.match(w.text(),/rollback_record_probe: PASS/);assert.match(w.text(),/preflight: PASS/);
  assert.equal(w.calls.some(c=>/^(d1 migrations|deploy$|rollback)/.test(c)),false);
  assert.deepEqual([...w.r2.keys()],[`${BUCKET}/release-versions/preflight-44300000001.json`]);
  assert.equal(w.live,V0);assert.deepEqual(w.ledger,LOCAL.slice(0,2));noIds(w);
  for(const [setup,code] of [[{fail:{api:true}},'LIVE_SETTINGS_UNREADABLE'],[{fail:{r2Put:true}},'RECORD_WRITE_FAILED'],[{fail:{split:true}},'WORKER_NOT_SINGLE_VERSION'],[{fail:{dryRun:true}},'DRY_RUN_FAILED']]){
    const x=world(setup);assert.equal(await x.go('preflight',`PREFLIGHT ${S}`),1);assert.match(x.text(),new RegExp(`stop: ${code}`));assert.equal(x.calls.some(c=>/^(d1 migrations|deploy$|rollback)/.test(c)),false);
  }
  const y=world();assert.equal(await y.go('preflight',`PREFLIGHT 0000000`),1);assert.deepEqual(y.calls,[]);
});

const CLAIM={spreadsheet_id:'sheet-synthetic',operation_token:'token-synthetic',notice_stamp:'stamp',notice_identity:'identity',created_at:'2026-11-14T00:00:00.000Z',phase:'OPERATION',review_reason:'STABLE_DAILY_REVIEW',claims:1};
test('review_fingerprint prints only the hash START_REVIEW computes, for exactly one matching claim',async()=>{
  const w=world({claims:[CLAIM]});
  assert.equal(await w.go('review_fingerprint',`FINGERPRINT ${S}`),0,w.text());
  // The operator hashes JSON.stringify([book,token,stamp,identity,created_at,phase,reason]).
  const want=sha256Hex(JSON.stringify(['sheet-synthetic','token-synthetic','stamp','identity','2026-11-14T00:00:00.000Z','OPERATION','STABLE_DAILY_REVIEW']));
  assert.equal(fingerprintOf(CLAIM),want);assert.match(w.text(),new RegExp(`review_fingerprint: ${want}`));
  for(const v of ['sheet-synthetic','token-synthetic','stamp','identity','2026-11-14'])assert.equal(w.text().includes(v),false,v);
  assert.equal(w.calls.every(c=>c.startsWith('d1 execute')),true);assert.equal(w.calls.length,1);
  for(const [claims,code] of [[[],'NOT_EXACTLY_ONE_MATCHING_CLAIM'],[[CLAIM,CLAIM],'NOT_EXACTLY_ONE_MATCHING_CLAIM'],[[{...CLAIM,claims:2}],'NOT_EXACTLY_ONE_MATCHING_CLAIM'],[[{...CLAIM,notice_identity:null}],'CLAIM_FIELD_MISSING']]){
    const x=world({claims});assert.equal(await x.go('review_fingerprint',`FINGERPRINT ${S}`),1);assert.match(x.text(),new RegExp(`stop: ${code}`));assert.doesNotMatch(x.text(),/review_fingerprint: [0-9a-f]/);
  }
  const bad=world({claims:[CLAIM]});assert.equal(await bad.go('review_fingerprint','FINGERPRINT 0000000'),1);assert.deepEqual(bad.calls,[]);
});

test('the fingerprint fields and order match startPrewriteReview and trigger 0031',()=>{
  const op=readFileSync(new URL('../src/admin/continuous-cutover-operator.ts',import.meta.url),'utf8');
  assert.ok(op.includes('JSON.stringify([book,c.operation_token,c.notice_stamp,c.notice_identity,c.created_at,c.phase,c.review_reason])'));
  const src=readFileSync(new URL('../scripts/prod-release.mjs',import.meta.url),'utf8');
  assert.ok(src.includes('JSON.stringify([c.spreadsheet_id,c.operation_token,c.notice_stamp,c.notice_identity,c.created_at,c.phase,c.review_reason])'));
  // The claim lookup uses spreadsheet_id = GOOGLE_SPREADSHEET_ID, so the row's id is the operator's book.
  assert.ok(op.includes("FROM stable_workbook_claims WHERE spreadsheet_id=? AND state='REVIEW' AND phase='OPERATION'"));
  assert.match(readFileSync(new URL('../migrations/0031_continuous_cutover_operator.sql',import.meta.url),'utf8'),/c\.review_reason='STABLE_DAILY_REVIEW'/);
});

test('unknown operations and invalid SHA stop with a fixed code',async()=>{
  const w=world();assert.equal(await w.go('nuke','x'),1);assert.match(w.text(),/## Production release: unknown\n- stop: UNKNOWN_OPERATION/);
  const bad=world();assert.equal(await runOperation('migrate',{run:bad.run,api:bad.api,local:LOCAL,env:{EXPECTED_SHA:'abc',CONFIRMATION:'x'},say:l=>bad.lines.push(l)}),1);assert.match(bad.text(),/stop: EXPECTED_SHA_INVALID/);
});

test('the live wrangler.jsonc parses as the deploy config',()=>{
  const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  assert.equal(config.name,WORKER);
  assert.doesNotThrow(()=>varChanges(new Map(),config.vars));
});

test('release workflow is manual-only, main-only, gated, pinned and scopes the token to the script step',()=>{
  const wf=readFileSync(new URL('../.github/workflows/prod-release-migrate-deploy.yml',import.meta.url),'utf8');
  const on=wf.slice(wf.indexOf('\non:'),wf.indexOf('\npermissions:'));
  assert.match(on,/workflow_dispatch:/);assert.doesNotMatch(on,/\n {2}(push|pull_request|schedule|workflow_run):/);
  assert.match(wf,/if: github\.ref == 'refs\/heads\/main'/);assert.match(wf,/environment: production/);assert.match(wf,/permissions:\n {2}contents: read/);
  assert.match(wf,/npm ci --ignore-scripts/);assert.match(wf,/persist-credentials: false/);assert.match(wf,/group: malipang-release-control/);
  for(const line of wf.split('\n').filter(l=>/uses:/.test(l)))assert.match(line,/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/,line);
  const job=wf.slice(wf.indexOf('\n  release:'),wf.indexOf('\n    steps:'));assert.doesNotMatch(job,/CLOUDFLARE_/,'token must not be set at job level');
  const steps=wf.split('\n      - ').slice(1);
  for(const step of steps){
    const usesToken=/CLOUDFLARE_API_TOKEN/.test(step),runsScript=/node scripts\/prod-release\.mjs/.test(step);
    assert.equal(usesToken,runsScript,step.split('\n')[0]);
    if(/run: .*\|/.test(step))assert.match(step,/shell: bash/);
  }
  // No wrangler call outside the script, so every write goes through its checks.
  assert.doesNotMatch(wf,/npx wrangler|wrangler (d1|deploy|rollback|r2|versions|secret)/);
  assert.match(wf,/\[ "\$EXPECTED_SHA" = "\$GITHUB_SHA" \]/);
  const inputs=[...on.matchAll(/^ {6}([a-z_0-9]+):$/gm)].map(m=>m[1]);
  assert.deepEqual(inputs,['operation','expected_sha','confirmation','historical_daily_probe']);
});

test('the workflow input check pins the confirmation and restricts probe mode to preflight or deploy',()=>{
  const wf=readFileSync(new URL('../.github/workflows/prod-release-migrate-deploy.yml',import.meta.url),'utf8');
  const script=wf.slice(wf.indexOf('set -euo pipefail'),wf.indexOf('      - uses: actions/checkout')).split('\n').map(l=>l.replace(/^ {10}/,'')).join('\n');
  const check=(operation,confirmation,sha=SHA,mode='false')=>{
    const r=JSON.parse(JSON.stringify(process.env));
    return import('node:child_process').then(({spawnSync})=>spawnSync('bash',['-c',script],{env:{...r,EXPECTED_SHA:sha,GITHUB_SHA:SHA,OPERATION:operation,CONFIRMATION:confirmation,HISTORICAL_DAILY_PROBE:mode}}).status);
  };
  return Promise.all([
    check('migrate',`MIGRATE ${S} FROM 0023 TO 0061`).then(s=>assert.equal(s,0)),
    check('preflight',`PREFLIGHT ${S}`).then(s=>assert.equal(s,0)),
    check('preflight',`PREFLIGHT ${S}`,SHA,'true').then(s=>assert.equal(s,0)),
    check('migrate',`MIGRATE ${S} FROM 0023 TO 0061`,SHA,'true').then(s=>assert.notEqual(s,0)),
    check('review_fingerprint',`FINGERPRINT ${S}`).then(s=>assert.equal(s,0)),
    check('preflight',`PREFLIGHT ${S} x`).then(s=>assert.notEqual(s,0)),
    check('review_fingerprint',`PREFLIGHT ${S}`).then(s=>assert.notEqual(s,0)),
    check('deploy',`DEPLOY ${S} CHANGES NONE`).then(s=>assert.equal(s,0)),
    check('deploy',`DEPLOY ${S} CHANGES A_ENABLED,B_VAR`).then(s=>assert.equal(s,0)),
    check('rollback_worker',`ROLLBACK ${S} BEFORE RUN 44300000001`).then(s=>assert.equal(s,0)),
    check('migrate',`DEPLOY ${S} CHANGES NONE`).then(s=>assert.notEqual(s,0)),
    check('deploy',`DEPLOY ${S} CHANGES NONE; rm -rf /`).then(s=>assert.notEqual(s,0)),
    check('deploy',`DEPLOY 0000000 CHANGES NONE`).then(s=>assert.notEqual(s,0)),
    check('migrate',`MIGRATE ${S} FROM 0023 TO 0061`,'0'.repeat(40)).then(s=>assert.notEqual(s,0)),
    check('other','x').then(s=>assert.notEqual(s,0)),
  ]);
});
