import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {PersonalProjectionRuntimeJournal}=require('../dist/sheets/personal-projection-runtime-journal.js');
class Statement{constructor(db,sql){this.db=db;this.sql=sql;this.args=[]}bind(...args){this.args=args;return this}async first(){return this.db.prepare(this.sql).get(...this.args)??null}async run(){return{meta:{changes:Number(this.db.prepare(this.sql).run(...this.args).changes)}}}}
class D1{constructor(db){this.db=db}prepare(sql){return new Statement(this.db,sql)}}
function fixture(){
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(x=>/^\d+.*\.sql$/.test(x)).sort())db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  db.exec(`INSERT INTO owner_personal_transactions(personal_use_id,message_id,line_user_id,transaction_type,description,amount_satang,source_wallet,transaction_date,status,created_at,updated_at,version) VALUES('personal_fixture','msg','line','PERSONAL_USE','fixture',10000,'SHOP_BANK','2026-10-01','CONFIRMED','then','now',2);
    INSERT INTO personal_projection_cutovers(spreadsheet_id,sheet_name,generation,state,admission_watermark,activated_at) VALUES('book','personal','generation_123','ACTIVE',0,'now');
    INSERT INTO personal_legacy_writer_gates(spreadsheet_id,sheet_name,generation,state,updated_at) VALUES('book','personal','generation_123','HOLD','now');
    INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,lease_until,lease_token) VALUES('job','PERSONAL_USE','personal_fixture',2,'synthetic','PROCESSING',1,'now','9999-01-01T00:00:00.000Z','lease_token_123456'); INSERT INTO personal_projection_generation_jobs VALUES('book','generation_123','personal_fixture',2,1,'IN_FLIGHT',NULL,'generation_token_123','9999-01-01T00:00:00.000Z','now','now')`);
  const env={DB:new D1(db),RUNTIME_MODE:'production',PERSONAL_STABLE_PROJECTION_ENABLED:'true',PERSONAL_GENERATION_WORKER_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book',SHEET_PERSONAL_USE_RAW:'personal',SHEET_EXPENSE_RAW:'raw',SHEET_EXPENSE_DAILY:'daily'},job={kind:'SHEETS_SYNC',entityType:'PERSONAL_USE',entityKey:'personal_fixture',entityVersion:2,traceId:'synthetic'};
  return{db,env,job,journal:new PersonalProjectionRuntimeJournal(env,job,'lease_token_123456',{generation:'generation_123',revision:1,token:'generation_token_123'}),close(){db.close()}};
}
test('personal outer intent uses revision, cutover and lease, never a stored row',async()=>{
  const f=fixture();try{const c=await f.journal.context();assert.ok(c);const token=await f.journal.begin(c);assert.ok(token);assert.equal(await f.journal.canDispatch(token,c),true);
    assert.equal(f.db.prepare(`PRAGMA table_info(personal_projection_runtime_intents)`).all().some(r=>/row_number|row_index/.test(r.name)),false);
    assert.equal(await f.journal.hold(token,c),true);assert.equal(await f.journal.canDispatch(token,c),false);assert.equal(await f.journal.begin(c),null);
  }finally{f.close();}
});
test('edit-and-revert changes the guarded revision and prevents dispatch',async()=>{
  const f=fixture();try{const c=await f.journal.context(),token=await f.journal.begin(c);f.db.exec(`UPDATE owner_personal_transactions SET description='changed'; UPDATE owner_personal_transactions SET description='fixture'`);assert.equal(await f.journal.canDispatch(token,c),false);assert.equal(await f.journal.hold(token,c),true);}finally{f.close();}
});
test('older restored source revision is held when a newer observation exists in another generation',async()=>{
  const f=fixture();try{const c=await f.journal.context(),token=await f.journal.begin(c);f.db.prepare(`INSERT INTO personal_projection_generation_observations VALUES('book','prior_generation','personal_fixture',2,?,'PENDING',NULL,'run',1,'now')`).run(c.revision+1);assert.equal(await f.journal.context(),null);assert.equal(await f.journal.canDispatch(token,c),false);}finally{f.close();}
});
test('missing trigger, new unique index, missing foreign-key enforcement, lease, gate and old mapping fail closed',async()=>{
  for(const sql of [`CREATE UNIQUE INDEX unexpected_daily_witness_index ON daily_recovery_identity_witnesses(baseline_sha256)`,`DROP TRIGGER daily_registry_block_existing`,`UPDATE personal_projection_generation_jobs SET lease_until='2000-01-01T00:00:00.000Z'`,`DROP TRIGGER personal_projection_before_update`,`CREATE UNIQUE INDEX future_personal_unique ON owner_personal_transactions(description)`,`PRAGMA foreign_keys=OFF`,`UPDATE sync_jobs SET lease_until='2000-01-01T00:00:00.000Z'`,`UPDATE personal_legacy_writer_gates SET state='OPEN'`,`UPDATE personal_projection_cutovers SET generation='changed_generation'`,`INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES('personal','personal_fixture',4)`]){
    const f=fixture();try{const c=await f.journal.context(),token=await f.journal.begin(c);f.db.exec(sql);assert.equal(await f.journal.canDispatch(token,c),false);}finally{f.close();}
  }
});
test('pre-cutover admissions and unresolved prior jobs cannot begin',async()=>{
  const f=fixture();try{f.db.exec(`UPDATE personal_projection_cutovers SET admission_watermark=999`);assert.equal(await f.journal.context(),null);f.db.exec(`UPDATE personal_projection_cutovers SET admission_watermark=0; INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('old','PERSONAL_USE','personal_fixture',1,'synthetic','REVIEW',1,'now')`);assert.equal(await f.journal.context(),null);}finally{f.close();}
});
test('cancelled records cannot begin or dispatch until cancellation semantics exist',async()=>{
  const f=fixture();try{const c=await f.journal.context(),token=await f.journal.begin(c);f.db.exec(`UPDATE owner_personal_transactions SET status='CANCELLED'`);assert.equal(await f.journal.context(),null);assert.equal(await f.journal.canDispatch(token,c),false);}finally{f.close();}
});
test('lost intent acknowledgement cannot be retried automatically',async()=>{
  const f=fixture();try{const c=await f.journal.context(),prepare=f.env.DB.prepare.bind(f.env.DB);let lost=false;
    f.env.DB.prepare=sql=>{const statement=prepare(sql);if(!sql.includes('INSERT INTO personal_projection_runtime_intents'))return statement;return{bind(...args){const bound=statement.bind(...args);return{async run(){const out=await bound.run();if(!lost){lost=true;throw Error('synthetic lost acknowledgment')}return out;}}}};};
    await assert.rejects(f.journal.begin(c),/lost acknowledgment/);assert.equal(f.db.prepare('SELECT state FROM personal_projection_runtime_intents').get().state,'IN_FLIGHT');assert.equal(await f.journal.begin(c),null);
  }finally{f.close();}
});
test('disabled feature never creates an intent',async()=>{const f=fixture();try{f.env.PERSONAL_STABLE_PROJECTION_ENABLED='false';await assert.rejects(f.journal.context(),/DISABLED/);assert.equal(f.db.prepare('SELECT count(*) n FROM personal_projection_runtime_intents').get().n,0);}finally{f.close();}});
test('generation lease is mandatory and every fence rechecks expiry and competing attempts',async()=>{
  const f=fixture();try{
    const noLease=new PersonalProjectionRuntimeJournal(f.env,f.job,'lease_token_123456');await assert.rejects(noLease.context(),/LEASE_REQUIRED/);
    const c=await f.journal.context(),token=await f.journal.begin(c);
    f.db.exec("UPDATE personal_projection_generation_jobs SET lease_token='another_token_123'");assert.equal(await f.journal.canDispatch(token,c),false);
    f.db.exec("UPDATE personal_projection_generation_jobs SET lease_token='generation_token_123'; INSERT INTO personal_projection_generation_jobs VALUES('book','older_generation','personal_fixture',1,1,'REVIEW','UNKNOWN',NULL,NULL,'now','now')");assert.equal(await f.journal.canDispatch(token,c),false);
  }finally{f.close();}
});
test('later generation job evidence blocks the journal even when observations are absent',async()=>{
  const f=fixture();try{const c=await f.journal.context(),token=await f.journal.begin(c);f.db.exec("INSERT INTO personal_projection_generation_jobs VALUES('book','older_generation','personal_fixture',2,2,'SUPERSEDED',NULL,NULL,NULL,'now','now')");assert.equal(await f.journal.context(),null);assert.equal(await f.journal.canDispatch(token,c),false);}finally{f.close();}
});
test('separate per-sheet locks fail closed when configured tabs alias',async()=>{for(const pair of ['raw','daily','detail']){const f=fixture();try{if(pair==='raw')f.env.SHEET_PERSONAL_USE_RAW='raw';if(pair==='daily')f.env.SHEET_PERSONAL_USE_RAW='daily';if(pair==='detail')f.env.SHEET_PURCHASE_DETAILS='personal';await assert.rejects(f.journal.context(),/PROJECTION_DISABLED/);assert.equal(f.db.prepare('SELECT count(*) n FROM personal_projection_runtime_intents').get().n,0);}finally{f.close();}}});
