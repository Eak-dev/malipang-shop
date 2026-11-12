// Issue 248 hotfix-only G7 canary-digest exception. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyStage,REVIEW_STAMP,G5_PREVIOUS_WORKER,MIGRATION} from '../scripts/pr247-stage-guard.mjs';
import {verifyZeroEvidence} from '../scripts/pr247-g7-zero-proof.mjs';
import {canarySourceDigest,canarySourceSql,selftestSql,verifySelftest,EXPENSE_COLUMNS,RESULT_COLUMNS,SELFTEST_DIGEST,SELFTEST_ROW} from '../scripts/issue248-canary-source-digest.mjs';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
import {DatabaseSync} from 'node:sqlite';
const h=x=>createHash('sha256').update(x).digest('hex');

// ---- provider-side digest: one read-only statement, no expense column leaves D1
const KEY='exp_synthetic';
// Sensitive-looking synthetic markers: they must never appear in the statement result.
const PII=['U_SYNTHETIC_PRIVATE_LINE_ID','m_SYNTHETIC_PRIVATE_MESSAGE','SYNTHETIC_PRIVATE_DESCRIPTION','emp_SYNTHETIC_PRIVATE'];
function canaryDb(overrides={}){
 const db=expenseSqlite();
 const row={expense_id:KEY,message_id:PII[1],line_user_id:PII[0],description:PII[2]+' "q" \\ ทิป 😀\n\t\u0001 ',amount_satang:500,payment_key:'CASH',source_wallet:'SHOP_BANK',category:'tip',transaction_date:'2026-11-10',status:'CONFIRMED',created_at:'2026-11-10T00:00:00.000Z',version:1,submitted_by_employee_id:PII[3],...overrides};
 const cols=Object.keys(row);db.sqlite.prepare(`INSERT INTO expense_events(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...Object.values(row));
 return db;
}
const run=(db,key=KEY,version=1)=>{const x=db.sqlite.prepare(canarySourceSql(key,version)).get();return {x,rows:[{success:true,meta:{changed_db:false,rows_written:0},results:[{...x}]}]};};
// Independent re-statement of the Worker formula; tests/issue248-g7-canary-worker-parity.test.mjs uses the compiled Worker.
const restated=db=>h(JSON.stringify({expense:db.sqlite.prepare(`SELECT e.* FROM expense_events e WHERE expense_id='${KEY}'`).get(),links:[],documents:[],items:[]}));

test('one ASCII statement returns only revision, counts and digests, and the digest equals the Worker formula',()=>{
 const db=canaryDb();try{
  const sql=canarySourceSql(KEY,1);assert.match(sql,/^[\x20-\x7e]+$/);assert.ok(!sql.includes(';'),'single statement');
  assert.ok(sql.includes(`json_object(${EXPENSE_COLUMNS.map(c=>`'${c}',e.${c}`).join(',')})`),'table column order');
  assert.deepEqual(Object.keys(SELFTEST_ROW),EXPENSE_COLUMNS);
  // The provider self-test must keep covering every JSON escaping and value class the canary can hold.
  const st=JSON.stringify(SELFTEST_ROW);
  for(const c of ['\\"','\\\\','\\n','\\t','\\r','\\b','\\f','\\u0001','\\u001f','\u007f','ทดสอบ','😀','\u2028','\u2029',':null',':9007199254740991'])assert.ok(st.includes(c),'self-test covers '+JSON.stringify(c));
  assert.equal(SELFTEST_DIGEST,'9c894694f9066c4d3bf3deb0917e01e6ae7b471298bac1383b6af7cd739b55b5');
  const {x,rows}=run(db);assert.deepEqual(Object.keys(x),RESULT_COLUMNS);
  for(const p of PII)assert.ok(!JSON.stringify(x).includes(p),'private value left the statement');
  assert.equal(x.selftest,SELFTEST_DIGEST);assert.equal(x.digest,restated(db));
  assert.deepEqual(canarySourceDigest(rows,{targetKey:KEY,targetVersion:1,epochRevision:x.rev}),{digest:restated(db),revision:x.rev,itemCount:0,documentCount:0,linkCount:0});
  assert.throws(()=>canarySourceSql("exp_x' OR 1=1",1),/TARGET/);assert.throws(()=>canarySourceSql(KEY,0),/TARGET/);
 }finally{db.close()}
});
test('a source write bumps the revision; a cancelled, other-version or missing canary fails closed; ABA stays invisible',()=>{
 const db=canaryDb();try{
  const {x}=run(db),epoch=x.rev;
  db.sqlite.exec(`UPDATE expense_events SET amount_satang=501 WHERE expense_id='${KEY}'`);
  const moved=run(db);assert.notEqual(moved.x.digest,x.digest);
  assert.throws(()=>canarySourceDigest(moved.rows,{targetKey:KEY,targetVersion:1,epochRevision:epoch}),/NO_GO_CANARY_SOURCE_REVISION_MOVED/);
  // Change-and-revert restores the digest; only the revision moved, so a current digest is no proof of no ABA.
  db.sqlite.exec(`UPDATE expense_events SET amount_satang=500 WHERE expense_id='${KEY}'`);
  const reverted=run(db);assert.equal(reverted.x.digest,x.digest);assert.equal(reverted.x.rev,epoch+2);
  const other=run(db,KEY,2);assert.throws(()=>canarySourceDigest(other.rows,{targetKey:KEY,targetVersion:2,epochRevision:other.x.rev}),/ROW_COUNT/);
  const missing=run(db,'exp_missing');assert.throws(()=>canarySourceDigest(missing.rows,{targetKey:'exp_missing',targetVersion:1,epochRevision:missing.x.rev}),/ROW_COUNT/);
  db.sqlite.exec(`UPDATE expense_events SET status='CANCELLED' WHERE expense_id='${KEY}'`);
  const cancelled=run(db);assert.equal(cancelled.x.digest,null);assert.throws(()=>canarySourceDigest(cancelled.rows,{targetKey:KEY,targetVersion:1,epochRevision:cancelled.x.rev}),/ROW_COUNT/);
 }finally{db.close()}
});
test('a linked document yields no digest; schema drift fails to compile; oversize yields no digest',()=>{
 const db=canaryDb();try{
  db.sqlite.exec(`INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,created_at,expense_id) VALUES('doc_synthetic','m_doc_synthetic','U_doc_synthetic','RECEIPT','CONFIRMED','2026-11-10T00:00:00.000Z','${KEY}')`);
  const r=run(db);assert.equal(r.x.documents,1);assert.equal(r.x.digest,null);
  assert.throws(()=>canarySourceDigest(r.rows,{targetKey:KEY,targetVersion:1,epochRevision:r.x.rev}),/NO_GO_CANARY_SOURCE_SHAPE/);
 }finally{db.close()}
 const big=canaryDb({description:'x'.repeat(256001)});try{const r=run(big);assert.equal(r.x.digest,null);assert.throws(()=>canarySourceDigest(r.rows,{targetKey:KEY,targetVersion:1,epochRevision:r.x.rev}),/NO_GO_CANARY_SOURCE_DIGEST/);}finally{big.close()}
 const drift=canaryDb();try{drift.sqlite.exec('ALTER TABLE expense_events ADD COLUMN synthetic_extra TEXT');assert.throws(()=>drift.sqlite.prepare(canarySourceSql(KEY,1)),/same number of result columns/);}finally{drift.close()}
});
test('table-free provider self-test reads no table and verifies only the exact synthetic digest',()=>{
 const sql=selftestSql();assert.match(sql,/^[\x20-\x7e]+$/);
 // Every FROM names one of its own CTEs; running on an empty database below proves no table is read.
 for(const t of [...sql.matchAll(/\bFROM\s+([a-z_]+)/g)].map(m=>m[1]))assert.ok(['selftest_row','sha_k','sha_selftest_msg','sha_selftest_pad','sha_selftest'].includes(t),'reads only its own CTEs: '+t);
 const empty=new DatabaseSync(':memory:');let row;try{row=empty.prepare(sql).get();}finally{empty.close()}
 const env=x=>[{success:true,meta:{changed_db:false,rows_written:0},results:[x]}];
 assert.equal(verifySelftest(env({...row})),true);
 assert.throws(()=>verifySelftest(env({selftest:'0'.repeat(64)})),/NO_GO_CANARY_SOURCE_PROVIDER_SELFTEST$/);
 for(const rows of [[],[...env(row),...env(row)],env({...row,extra:1}),[{...env(row)[0],meta:{changed_db:true,rows_written:0}}]])assert.throws(()=>verifySelftest(rows),/NO_GO_CANARY_SOURCE_EVIDENCE$/);
});
test('provider format or semantics mismatch stops: envelope shape, columns, self-test and write-shaped meta',()=>{
 const db=canaryDb();let base;try{base=run(db);}finally{db.close()}
 const target={targetKey:KEY,targetVersion:1,epochRevision:base.x.rev},env=x=>[{success:true,meta:{changed_db:false,rows_written:0},results:[x]}];
 assert.equal(canarySourceDigest(env({...base.x}),target).digest,base.x.digest);
 const {digest,...withoutDigest}=base.x;
 for(const [label,rows,code] of [
  ['six legacy envelopes',[...env(base.x),...env(base.x),...env(base.x),...env(base.x),...env(base.x),...env(base.x)],'EVIDENCE'],['no envelope',[],'EVIDENCE'],
  ['two rows',[{...env(base.x)[0],results:[base.x,base.x]}],'EVIDENCE'],['write-shaped meta',[{...env(base.x)[0],meta:{changed_db:true,rows_written:1}}],'EVIDENCE'],
  ['failed envelope',[{...env(base.x)[0],success:false}],'EVIDENCE'],['extra column',env({...base.x,line_user_id:PII[0]}),'EVIDENCE'],['missing column',env(withoutDigest),'EVIDENCE'],
  ['reordered columns',env(Object.fromEntries(Object.entries(base.x).reverse())),'EVIDENCE'],['self-test differs',env({...base.x,selftest:'0'.repeat(64)}),'PROVIDER_SELFTEST'],
  ['revision not an integer',env({...base.x,rev:'7'}),'REVISION'],['counts not integers',env({...base.x,items:null}),'EVIDENCE'],['digest malformed',env({...base.x,digest:'A'.repeat(64)}),'DIGEST']])
  assert.throws(()=>canarySourceDigest(rows,target),new RegExp('NO_GO_CANARY_SOURCE_'+code+'$'),label);
 assert.ok(digest);assert.throws(()=>canarySourceDigest(env(base.x),{...target,epochRevision:-1}),/EPOCH_REVISION/);
});

// ---- stage guard: strict by default, exception only when explicitly enabled
const G5_SHA='0d1dda77f3a0e5cfaec1872cb588b59dddfe5bdf',G5_WORKER='reviewed-g5-version-placeholder',NEW='synthetic-new-version';
const DIGEST='a'.repeat(64);
function zeroStage(mode='B_POST'){const post=mode==='B_POST';return structuredClone({
 g5:{release:'PR247',state:'VERIFIED_COMPLETED',expected_sha:G5_SHA,prior_worker_version:G5_PREVIOUS_WORKER,queue_was_active:true,queue_id:'q'},
 params:{g5Sha:G5_SHA,expectedWorkerVersion:post?NEW:G5_WORKER,priorWorkerVersion:G5_WORKER,completedBefore:3296,openFailedBefore:32},
 cloudflare:{cron:[{cron:'*/5 * * * *'}],versions:[{version_id:post?NEW:G5_WORKER,percentage:100}],queue:{queue_name:'malipang-jobs',queue_id:'q',settings:{delivery_paused:false}}},
 d1:{migration:MIGRATION,recovery_tables:4,review:0,review_all:0,held:0,inflight:0,epoch_total:1,epoch_active:0,epoch_complete:1,unverified_ops:0,verified_ops:2,completed:3296,open_failed:32,review_jobs:0,stale_held:0,unleased_inflight:0,canary_jobs_completed:1,canary_daily:1,canary_raw:1,canary_detail:0},
 status:{ok:true,inFlightProjections:0,claim:null,recoveryGate:post?{mode:'DISABLED'}:{mode:'OPT_IN',state:'COMPLETE'},sheetPacing:{mode:'OPT_IN'}},
 epoch:{epoch_found:1,epoch_state:'COMPLETE',epoch_created_at:'2020-01-01T00:01:10.000Z',epoch_updated_at:'2020-01-01T00:01:50.000Z',unverified_ops:0,verified_ops:2,job_completed:1,daily:1,raw:1,detail:0,source_matches:1,source_revision:86,cutover_active:1,pre_cutover_count:0,integrity_triggers:27,epoch_immutability_triggers:2,epoch_active_unique:1,source_item_count:0,source_document_count:0,source_link_count:0,journal_total:2,detail_any:0,
  source_current_digest:DIGEST,source_bracket_revision:86,source_current_items:0,source_current_documents:0,source_current_links:0},
 receipt:{schema:'MP248_G7_RECEIPT_V3_ZERO_ITEM_RISK_ACCEPTED',state:'OWNER_VERIFIED',epoch_id:'syntheticEpoch01',g5_sha:G5_SHA,g6a_worker_version:G5_WORKER,expected_detail_count:0,detail_coverage:'NOT_EXERCISED_ZERO_ITEMS',owner_accepted_detail_coverage_risk:true,no_detail_rows_verified:true,g7_canary_verified:true,provider_readback_verified:true,no_duplicate_stable_ids:true,owner_approved_g8:true,source_snapshot_digest:DIGEST,source_revision:67,
  monitoring_coverage:'PARTIAL_PROJECT_UNBOUND',monitoring_project:'malipang-backend',gcp_quotas_checked:false,gcp_429_delta:null,gcp_ingestion_lag_ms:null,owner_accepted_429_observability_risk:true,limited_observed_429:false,observation_source:'GCP_UI_UNBOUND_AND_WORKER_LOGS_PARTIAL',monitoring_window_start:'2020-01-01T00:00:00.000Z',canary_started_at:'2020-01-01T00:01:00.000Z',canary_completed_at:'2020-01-01T00:02:00.000Z',monitoring_window_end:'2020-01-01T00:03:00.000Z',observed_at:'2020-01-01T00:05:00.000Z'}
})}
const ON={canaryDigestException:true};
test('historical receipt revision 67 with current revision 86 passes only with the explicit B_POST hotfix option',()=>{
 assert.deepEqual(verifyStage('B_POST',zeroStage('B_POST'),ON),{ok:true,mode:'B_POST'});
 for(const mode of ['B_PRE','B_POST'])assert.throws(()=>verifyStage(mode,zeroStage(mode)),/NO_GO_CANARY_JOURNAL/); // default strict equality
 for(const mode of ['A_PRE','A_POST','B_PRE'])assert.throws(()=>verifyStage(mode,zeroStage('B_PRE'),ON),/NO_GO_CANARY_EXCEPTION_SCOPE/);
 const e=zeroStage();e.epoch.source_revision=67;e.epoch.source_bracket_revision=67;assert.deepEqual(verifyStage('B_POST',e),{ok:true,mode:'B_POST'});
});
test('exception rejects digest, bracket, count, revision or receipt drift and never mutates evidence',()=>{
 for(const [label,f] of [['digest changed',e=>e.epoch.source_current_digest='f'.repeat(64)],['digest missing',e=>delete e.epoch.source_current_digest],['bracket differs from epoch revision',e=>e.epoch.source_bracket_revision=87],['current item exists',e=>e.epoch.source_current_items=1],['current link exists',e=>e.epoch.source_current_links=1],['current document exists',e=>e.epoch.source_current_documents=1],['revision behind receipt',e=>{e.epoch.source_revision=66;e.epoch.source_bracket_revision=66}],['other historical receipt',e=>e.receipt.source_revision=68],['receipt digest differs',e=>e.receipt.source_snapshot_digest='b'.repeat(64)]]){
  const e=zeroStage(),copy=structuredClone(e);f(e);const before=structuredClone(e);
  assert.throws(()=>verifyStage('B_POST',e,ON),/NO_GO_CANARY_JOURNAL/,label);assert.deepEqual(e,before,label);assert.equal(copy.receipt.source_revision,67);
 }
});

// ---- zero-proof: strict by default, exception only when explicitly enabled
const nonce='c'.repeat(48),epochId='g7_'+nonce,sourceSha='b'.repeat(40),traceV='trace_synthetic',prefix=`release-control/pr247/g7/arm-audit/${nonce}`;
function zeroProof(){
 const intent={schema:'MP248_G7_ARM_INTENT_ZERO_LOCAL_V1',epoch:epochId,workbookHash:'b8df793b7aafbedea3b9eb42c3bf4d4a8098bef8b91a8a6d5ea6d50fc6e5602f',targetKeyHash:h(KEY),traceHash:h(traceV),sourceVersion:1,sourceSnapshotDigest:DIGEST,sourceRevision:67,targetCreatedAt:'2020-01-01T00:01:00.000Z',selectionSince:'2020-01-01T00:00:00.000Z',itemCount:0,providerHash:'e'.repeat(64),issuedAt:'2020-01-01T00:02:00.000Z',legacyScan:'NO_EXACT_CANDIDATE_RESIDUAL_UNKNOWN',gcp429Coverage:'PARTIAL_UNKNOWN',gcp429Delta:null,ownerAccepted429ObservabilityRisk:true,auditMode:'R2_SINGLE_WRITER_NONCONDITIONAL_OWNER_RISK_ACCEPTED'};
 const intentRaw=JSON.stringify(intent),outcomeRaw=JSON.stringify({schema:'MP248_G7_ARM_OUTCOME_LOCAL_V1',epoch:epochId,intentHash:h(intentRaw),status:'ARM_ACKNOWLEDGED',classification:'PRESENT_MATCHING'});
 const run=(id,phase,dig)=>({run:{id:Number(id),run_attempt:1,status:'completed',conclusion:'success',head_sha:sourceSha,head_branch:'main',event:'workflow_dispatch',path:'.github/workflows/issue248-g7-audit-writer.yml'},jobs:{jobs:[{id:Number(id)+1,run_id:Number(id),name:'audit-write',status:'completed',conclusion:'success',steps:[{name:'Pin reviewed source',status:'completed',conclusion:'success',number:5},{name:'Write one scoped audit object and verify',status:'completed',conclusion:'success',number:6}]}]},log:`MP248_G7_AUDIT_SHA256=${dig}\nMP248_G7_AUDIT_KEY=${prefix}-${phase}.json\n`});
 return {receipt:{schema:'MP248_G7_RECEIPT_V3_ZERO_ITEM_RISK_ACCEPTED',epoch_id:epochId,source_snapshot_digest:DIGEST,source_revision:67,arm_audit_nonce:nonce,arm_intent_sha256:h(intentRaw),arm_outcome_sha256:h(outcomeRaw),arm_intent_run_id:'123',arm_outcome_run_id:'456',arm_workflow_source_sha:sourceSha},intentRaw,outcomeRaw,
  epoch:{target_key:KEY,target_trace:traceV,target_version:1,source_revision:86,epoch_immutability_triggers:2,epoch_active_unique:1,source_current_digest:DIGEST,source_bracket_revision:86,source_current_items:0,source_current_documents:0,source_current_links:0},runEvidence:[run('123','intent',h(intentRaw)),run('456','outcome',h(outcomeRaw))]};
}
test('zero-proof keeps strict equality by default and binds the current canary digest with the explicit exception',()=>{
 assert.throws(()=>verifyZeroEvidence(zeroProof()),/NO_GO_G7_ZERO_D1_BINDING/);
 assert.equal(verifyZeroEvidence({...zeroProof(),canaryDigestException:true}),true);
 for(const f of [x=>x.epoch.source_current_digest='f'.repeat(64),x=>x.epoch.source_bracket_revision=87,x=>{x.epoch.source_revision=66;x.epoch.source_bracket_revision=66},x=>x.epoch.source_current_items=1]){
  const x=zeroProof();f(x);assert.throws(()=>verifyZeroEvidence({...x,canaryDigestException:true}),/NO_GO_G7_ZERO_D1_BINDING/);
 }
});
import {readFileSync} from 'node:fs';
test('exception is reachable only from the hotfix release path',()=>{
 const stage=readFileSync('scripts/pr247-stage-guard.mjs','utf8'),cli=stage.slice(stage.indexOf('// CLI:'));
 assert.doesNotMatch(cli,/canaryDigestException/); // stage guard CLI stays strict
 assert.match(readFileSync('scripts/issue248-nonfinancial-release-guard.mjs','utf8'),/stage\('B_POST',masked,\{canaryDigestException:true\}\)/);
 const flows=['production-pr247-steady-gate-off-pacing-on.yml','issue248-terminal-hold-hotfix-release.yml'].map(n=>readFileSync('.github/workflows/'+n,'utf8'));
 for(const w of flows)assert.doesNotMatch(w,/MP248_G7_CANARY_DIGEST_EXCEPTION/);
 const w=readFileSync('.github/workflows/issue248-nonfinancial-guard-release.yml','utf8');
 assert.match(w,/test "\$MP248_G7_CANARY_DIGEST_EXCEPTION" = 'OWNER ACCEPTS G7 SOURCE REVISION ADVANCED HISTORICAL INTEGRITY UNKNOWN'/);
 assert.match(w,/G7_HISTORICAL_INTEGRITY_UNKNOWN_OWNER_ACCEPTED/);
 assert.match(w,/git diff --quiet "\$REVIEWED_RUNTIME_SHA" HEAD -- src migrations wrangler\.jsonc package\.json package-lock\.json npm-shrinkwrap\.json \.npmrc tsconfig\.json\n/);
 assert.match(w,/sha256sum --check --strict --status/);
});
