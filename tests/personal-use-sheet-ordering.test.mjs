import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';

const require=createRequire(import.meta.url);
const sheetsClient=require('../dist/sheets/client.js');
const originalFormulaRead=sheetsClient.batchGetSheetFormulaValues;
test.beforeEach(()=>{sheetsClient.batchGetSheetFormulaValues=async()=>[[],[]];});
test.afterEach(()=>{sheetsClient.batchGetSheetFormulaValues=originalFormulaRead;});
const {SheetsHttpError,SheetsMutationOutcomeUnknownError,isAmbiguousSheetsMutationStatus}=sheetsClient;
const {GOOGLE_SHEETS_MAX_SERVER_PROCESSING_MS,PERSONAL_USE_AMBIGUITY_MARGIN_MS,claimSheetSyncJob,syncJob}=require('../dist/sheets/sync.js');
const {reconcileSheets}=require('../dist/admin/reconcile-sheets.js');
const {recoverPendingSheetJobs}=require('../dist/db/repositories.js');
const {OperationTimeoutError}=require('../dist/shared/async.js');
const googleAuth=require('../dist/sheets/google-auth.js');
const {personalCanonicalMigrations}=require('../dist/sheets/personal-legacy-writer-gate.js');
const worker=require('../dist/index.js').default;
const migration=name=>readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
const migrationNames=readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>/^\d+.*\.sql$/.test(name)).sort();
const plain=value=>JSON.parse(JSON.stringify(value));

class SqliteD1Statement{
  constructor(owner,sql){this.owner=owner;this.sql=sql;this.args=[];}
  bind(...args){this.args=args;return this;}
  async first(){const row=this.owner.sqlite.prepare(this.sql).get(...this.args)??null;if(this.owner.afterFirst)await this.owner.afterFirst(this.sql,this.args,row);return row;}
  async all(){return{results:this.owner.sqlite.prepare(this.sql).all(...this.args),meta:{changes:0}};}
  async run(){if(/^\s*SELECT\b/i.test(this.sql))return{results:this.owner.sqlite.prepare(this.sql).all(...this.args),meta:{changes:0}};const result=this.owner.sqlite.prepare(this.sql).run(...this.args);return{meta:{changes:Number(result.changes)}};}
}

class SqliteD1{
  constructor(sqlite){this.sqlite=sqlite;this.afterFirst=null;}
  prepare(sql){return new SqliteD1Statement(this,sql);}
  async batch(statements){
    this.sqlite.exec('BEGIN IMMEDIATE');
    try{
      const results=[];
      for(const statement of statements)results.push(await statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    }catch(error){this.sqlite.exec('ROLLBACK');throw error;}
  }
}

function deferred(){
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return{promise,resolve};
}

function harness(){
  const sqlite=new DatabaseSync(':memory:');
  for(const name of migrationNames)sqlite.exec(migration(name));
  sqlite.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT UNIQUE,applied_at TEXT)');for(const name of personalCanonicalMigrations.filter(n=>Number(n.slice(0,4))<=44))sqlite.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);sqlite.exec("INSERT INTO personal_legacy_writer_gates VALUES('book','V52_PERSONAL_USE_RAW','generation_1','OPEN','now'); INSERT INTO personal_legacy_writer_gates VALUES('fixture','V52_PERSONAL_USE_RAW','generation_1','OPEN','now')");
  const id='personal_ordering_fixture',now='2026-09-06T00:00:00.000Z';
  sqlite.prepare(`INSERT INTO owner_personal_transactions(personal_use_id,message_id,line_user_id,transaction_type,description,amount_satang,source_wallet,transaction_date,status,trace_id,submitted_by_employee_id,branch_id,reviewed_by_employee_id,approved_at,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,'message_ordering_fixture','line_owner','PERSONAL_USE','sanitized ordering fixture',100,'SHOP_BANK','2026-09-06','CONFIRMED','trace_ordering','OWN001','B001','OWN001',now,now,now,2);
  sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token) VALUES(?,?,?,?,?,'PENDING',0,?,?,NULL,NULL)`).run('sync_ordering_v2','PERSONAL_USE',id,2,'trace_ordering_v2',now,now);
  const DB=new SqliteD1(sqlite),queued=[];
  const env={DB,SHEETS_SYNC_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book',SHEET_PERSONAL_USE_RAW:'V52_PERSONAL_USE_RAW',JOB_QUEUE:{async send(body,options={}){queued.push({body,...options});},async sendBatch(messages){queued.push(...messages);}}};
  return{sqlite,DB,env,queued,id,close(){sqlite.close();}};
}

function configureBootstrap(h){Object.assign(h.env,{SHEET_ATTENDANCE_RAW:'attendance',SHEET_DAILY_PAYROLL:'daily_payroll',SHEET_WEEKLY_PAYROLL:'weekly_payroll',SHEET_WAGE_HISTORY:'wage',SHEET_SHIFT_SCHEDULE:'shifts',SHEET_OT_REQUESTS:'ot',SHEET_EXPENSE_RAW:'expense',SHEET_PERSONAL_USE_RAW:'V52_PERSONAL_USE_RAW',SHEET_PURCHASE_DETAILS:'details',SHEET_SYSTEM_LOG:'system'});}
function job(id,version){return{kind:'SHEETS_SYNC',entityType:'PERSONAL_USE',entityKey:id,entityVersion:version,traceId:`trace_ordering_v${version}`};}
function cancelAtVersionThree(h,{enqueue=true}={}){
  h.sqlite.prepare(`UPDATE owner_personal_transactions SET status='CANCELLED',updated_at=?,version=3 WHERE personal_use_id=?`).run('2026-09-06T00:01:00.000Z',h.id);
  if(enqueue)h.sqlite.prepare(`INSERT OR IGNORE INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token) VALUES(?,?,?,?,?,'PENDING',0,?,?,NULL,NULL)`).run('sync_ordering_v3','PERSONAL_USE',h.id,3,'trace_ordering_v3','2026-09-06T00:01:00.000Z','2026-09-06T00:01:00.000Z');
}
function syncRows(h){return plain(h.sqlite.prepare(`SELECT entity_version,status,attempt_count FROM sync_jobs WHERE entity_type='PERSONAL_USE' AND entity_key=? ORDER BY entity_version`).all(h.id));}
function expireLease(h,version){h.sqlite.prepare(`UPDATE sync_jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE entity_type='PERSONAL_USE' AND entity_key=? AND entity_version=?`).run(h.id,version);}
const sheetEntityTypes=['PERSONAL_USE','EXPENSE','ATTENDANCE_EVENT','DAILY_PAYROLL','WEEKLY_PAYROLL','WAGE_HISTORY','SHIFT_SCHEDULE','OT_REQUEST','SYSTEM_LOG'];

test('occupied or partial personal-use row fails closed without writing',async()=>{
  const h=harness(),writes=[];
  try{
    sheetsClient.batchGetSheetFormulaValues=async()=>[[['other_personal_id']],[['other_personal_id','PERSONAL_USE']]];
    await withSheetWriter(async(_env,data)=>writes.push(data),async()=>{
      assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW');
      assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW');
    });
    assert.equal(writes.length,0);
    assert.deepEqual(plain(h.sqlite.prepare('SELECT status,last_error FROM sync_jobs WHERE entity_key=?').get(h.id)),{status:'REVIEW',last_error:'PERSONAL_USE_SHEET_ROW_COLLISION'});
  }finally{h.close();}
});

test('collision is visible in failed jobs and forced reconcile cannot reset the review hold',async()=>{
  const h=harness(),calls={acks:0,retries:0};
  try{
    sheetsClient.batchGetSheetFormulaValues=async()=>[[['other_personal_id']],[['other_personal_id','PERSONAL_USE']]];
    await withSheetWriter(async()=>assert.fail('collision must not write'),async()=>{
      const message={body:job(h.id,2),attempts:1,ack(){calls.acks++},retry(){calls.retries++}};
      await worker.queue({queue:'malipang-jobs',messages:[message]},h.env,{});
      assert.equal(calls.acks,1);assert.equal(calls.retries,0);
      assert.deepEqual(plain(h.sqlite.prepare('SELECT status,error FROM failed_jobs').get()),{status:'OPEN',error:'SHEETS_SYNC_REVIEW_REQUIRED'});
      const {enqueueSheetSyncBatch}=require('../dist/db/repositories.js');
      await enqueueSheetSyncBatch(h.env,[job(h.id,2)],true);
      assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs WHERE entity_key=?').get(h.id).status,'REVIEW');
      assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW');
    });
  }finally{h.close();}
});

test('an unresolved review holds later versions of each sheet entity type',async()=>{
  for(const entityType of sheetEntityTypes){
    const h=harness(),writes=[];
    try{
      h.sqlite.prepare(`DELETE FROM sync_jobs`).run();
      const insert=h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token) VALUES(?,?,?,?,?,?,0,?,?,NULL,NULL)`);
      const now='2026-09-06T00:00:00.000Z';
      insert.run('review_v2',entityType,h.id,2,'trace','REVIEW',now,null);
      const later={kind:'SHEETS_SYNC',entityType,entityKey:h.id,entityVersion:3,traceId:'trace_v3'};
      await withSheetWriter(async(_env,data)=>writes.push(data),async()=>{
        assert.equal(await syncJob(h.env,later),'REVIEW');
        assert.equal(await syncJob(h.env,later),'REVIEW');
      });
      assert.equal(writes.length,0);
      assert.deepEqual(plain(h.sqlite.prepare(`SELECT status,last_error,attempt_count FROM sync_jobs WHERE entity_type=? AND entity_key=? AND entity_version=3`).get(entityType,h.id)),{status:'REVIEW',last_error:'SHEET_SYNC_ENTITY_REVIEW_HOLD',attempt_count:0});
      assert.equal(typeof await claimSheetSyncJob(h.env,{...later,entityKey:'unrelated_fixture'}),'string');
    }finally{h.close();}
  }
});

test('recovery and forced enqueue quarantine expired sheet writers and surface review',async()=>{
  const {enqueueSheetSyncBatch}=require('../dist/db/repositories.js');
  for(const entityType of sheetEntityTypes){
    const h=harness();
    try{
      h.sqlite.prepare(`DELETE FROM sync_jobs`).run();
      const old={kind:'SHEETS_SYNC',entityType,entityKey:h.id,entityVersion:2,traceId:'trace_expired'};
      const next={...old,entityVersion:3,traceId:'trace_next'};
      assert.equal(typeof await claimSheetSyncJob(h.env,old),'string');
      h.sqlite.prepare(`UPDATE sync_jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE entity_type=?`).run(entityType);
      await enqueueSheetSyncBatch(h.env,[old],true);
      assert.equal(h.sqlite.prepare(`SELECT status FROM sync_jobs WHERE entity_type=?`).get(entityType).status,'PROCESSING');
      assert.equal(await claimSheetSyncJob(h.env,old),null);
      assert.equal(await claimSheetSyncJob(h.env,next),null);
      assert.equal(typeof await claimSheetSyncJob(h.env,{...next,entityKey:'unrelated_fixture'}),'string');
      await recoverPendingSheetJobs(h.env,0);
      const held=plain(h.sqlite.prepare(`SELECT status,last_error FROM sync_jobs WHERE entity_type=? AND entity_version=2`).get(entityType));
      assert.deepEqual(held,{status:'REVIEW',last_error:'SHEET_SYNC_EXPIRED_OWNER_REVIEW'});
      assert.equal(h.sqlite.prepare(`SELECT COUNT(*) count FROM failed_jobs WHERE status='OPEN' AND error='SHEETS_SYNC_REVIEW_REQUIRED'`).get().count,1);
      assert.equal(await syncJob(h.env,next),'REVIEW');
      await enqueueSheetSyncBatch(h.env,[old],true);
      assert.equal(h.sqlite.prepare(`SELECT status FROM sync_jobs WHERE entity_type=? AND entity_version=2`).get(entityType).status,'REVIEW');
    }finally{h.close();}
  }
});

test('recovery finds eligible work beyond 200 older active, null-lease and delayed jobs',async()=>{
  const h=harness();
  try{
    h.sqlite.prepare(`DELETE FROM sync_jobs`).run();
    const insert=h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token) VALUES(?,'EXPENSE',?,1,?,?,0,?,?,?,?)`);
    for(let i=0;i<220;i++){
      insert.run(`active_${i}`,`active_${i}`,`trace_active_${i}`,'PROCESSING','2000-01-01T00:00:00.000Z',null,'2999-01-01T00:00:00.000Z','fixture');
      insert.run(`delayed_${i}`,`delayed_${i}`,`trace_delayed_${i}`,'PENDING','2000-01-01T00:00:00.000Z','2999-01-01T00:00:00.000Z',null,null);
    }
    insert.run('null_lease','null_lease','trace_null','PROCESSING','2000-01-01T00:00:00.000Z',null,null,'fixture');
    insert.run('eligible','eligible','trace_eligible','PENDING','2001-01-01T00:00:00.000Z','2001-01-01T00:00:00.000Z',null,null);
    assert.equal(await recoverPendingSheetJobs(h.env,0),1);
    assert.deepEqual(h.queued.map(message=>message.body.entityKey),['eligible']);
    assert.deepEqual(plain(h.sqlite.prepare(`SELECT status,last_error FROM sync_jobs WHERE entity_key='null_lease'`).get()),{status:'REVIEW',last_error:'SHEET_SYNC_EXPIRED_OWNER_REVIEW'});
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) count FROM failed_jobs WHERE trace_id='trace_null' AND status='OPEN'`).get().count,1);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) count FROM sync_jobs WHERE entity_key LIKE 'active_%' AND status='PROCESSING'`).get().count,220);
  }finally{h.close();}
});

test('disabled generic enqueue persists unique outbox entries and recovers them after re-enable',async()=>{
  const h=harness(),{enqueueSheetSyncBatchDetailed}=require('../dist/db/repositories.js');
  try{
    h.sqlite.prepare(`DELETE FROM sync_jobs`).run();h.env.SHEETS_SYNC_ENABLED='false';
    const wage={kind:'SHEETS_SYNC',entityType:'WAGE_HISTORY',entityKey:'wage_fixture',entityVersion:1,traceId:'trace_wage'};
    const daily={kind:'SHEETS_SYNC',entityType:'DAILY_PAYROLL',entityKey:'staff_fixture|2026-09-06',entityVersion:2,traceId:'trace_daily'};
    const result=await enqueueSheetSyncBatchDetailed(h.env,[wage,daily,wage]);
    assert.deepEqual(result,{enqueued:0,held:0,disabled:2});
    await enqueueSheetSyncBatchDetailed(h.env,[wage,daily]);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) count FROM sync_jobs`).get().count,2);
    assert.equal(h.queued.length,0);
    h.sqlite.prepare(`UPDATE sync_jobs SET updated_at='2000-01-01T00:00:00.000Z',next_attempt_at='2000-01-01T00:00:00.000Z'`).run();h.env.SHEETS_SYNC_ENABLED='true';
    assert.equal(await recoverPendingSheetJobs(h.env,0),2);
    assert.deepEqual(new Set(h.queued.map(message=>message.body.entityType)),new Set(['WAGE_HISTORY','DAILY_PAYROLL']));
  }finally{h.close();}
});

test('ambiguous wage-history write holds subsequent versions without another write',async()=>{
  const h=harness(),writes=[];
  const now='2026-09-06T00:00:00.000Z';
  try{
    h.env.SHEET_WAGE_HISTORY='wage_fixture';
    h.sqlite.prepare(`INSERT INTO employees(employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,status,updated_at) VALUES('staff_fixture','Fixture','user_fixture','08:00','17:00','ACTIVE',?)`).run(now);
    h.sqlite.prepare(`INSERT INTO employee_wage_history VALUES('wage_fixture','staff_fixture',50000,'2026-09-01',NULL,'TEST','',1,?,?)`).run(now,now);
    const first={kind:'SHEETS_SYNC',entityType:'WAGE_HISTORY',entityKey:'wage_fixture',entityVersion:1,traceId:'trace_wage_v1'};
    await withSheetWriter(async(_env,data)=>{writes.push(data);throw new SheetsMutationOutcomeUnknownError(new Error('response lost after apply'));},async()=>{
      assert.equal(await syncJob(h.env,first),'REVIEW');
      assert.equal(await syncJob(h.env,{...first,entityVersion:2,traceId:'trace_wage_v2'}),'REVIEW');
      await recoverPendingSheetJobs(h.env,0);
      assert.equal(await syncJob(h.env,first),'REVIEW');
    });
    assert.equal(writes.length,1);
    assert.deepEqual(plain(h.sqlite.prepare(`SELECT status,last_error FROM sync_jobs WHERE entity_type='WAGE_HISTORY' AND entity_key='wage_fixture' AND entity_version=1`).get()),{status:'REVIEW',last_error:'SHEETS_MUTATION_OUTCOME_UNKNOWN'});
  }finally{h.close();}
});

test('a writer completing after quarantine cannot report success or clear the review hold',async()=>{
  const h=harness(),started=deferred(),release=deferred(),now='2026-09-06T00:00:00.000Z';
  try{
    h.env.SHEET_WAGE_HISTORY='wage_fixture';
    h.sqlite.prepare(`INSERT INTO employees(employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,status,updated_at) VALUES('staff_fixture','Fixture','user_fixture','08:00','17:00','ACTIVE',?)`).run(now);
    h.sqlite.prepare(`INSERT INTO employee_wage_history VALUES('wage_fixture','staff_fixture',50000,'2026-09-01',NULL,'TEST','',1,?,?)`).run(now,now);
    const first={kind:'SHEETS_SYNC',entityType:'WAGE_HISTORY',entityKey:'wage_fixture',entityVersion:1,traceId:'trace_wage_v1'};
    await withSheetWriter(async()=>{started.resolve();await release.promise;},async()=>{
      const writing=syncJob(h.env,first);await started.promise;
      h.sqlite.prepare(`UPDATE sync_jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE entity_type='WAGE_HISTORY' AND entity_key='wage_fixture'`).run();
      await recoverPendingSheetJobs(h.env,0);
      release.resolve();
      assert.equal(await writing,'REVIEW');
      assert.equal(await syncJob(h.env,{...first,entityVersion:2}),'REVIEW');
      assert.equal(h.sqlite.prepare(`SELECT status FROM sync_jobs WHERE entity_type='WAGE_HISTORY' AND entity_version=1`).get().status,'REVIEW');
    });
  }finally{release.resolve();h.close();}
});

test('personal-use row is safe only for a blank row or the same identity',async()=>{
  const h=harness();
  try{
    const {assertPersonalUseSheetRowSafe}=require('../dist/sheets/sync.js');
    sheetsClient.batchGetSheetFormulaValues=async()=>[[],[]];
    await assertPersonalUseSheetRowSafe(h.env,'V52_PERSONAL_USE_RAW',2,h.id);
    sheetsClient.batchGetSheetFormulaValues=async()=>[[[h.id]],[[h.id,'PERSONAL_USE']]];
    await assertPersonalUseSheetRowSafe(h.env,'V52_PERSONAL_USE_RAW',2,h.id);
    sheetsClient.batchGetSheetFormulaValues=async()=>[[[h.id]],[[h.id,'=SUM(1,1)']]];
    await assert.rejects(assertPersonalUseSheetRowSafe(h.env,'V52_PERSONAL_USE_RAW',2,h.id),/FORMULA_CONFLICT/);
    sheetsClient.batchGetSheetFormulaValues=async()=>[[],[['','=1+1']]];
    await assert.rejects(assertPersonalUseSheetRowSafe(h.env,'V52_PERSONAL_USE_RAW',2,h.id),/FORMULA_CONFLICT/);
    sheetsClient.batchGetSheetFormulaValues=async()=>[[[],[h.id]],[[]]];
    await assert.rejects(assertPersonalUseSheetRowSafe(h.env,'V52_PERSONAL_USE_RAW',2,h.id),/IDENTITY_COLLISION/);
    sheetsClient.batchGetSheetFormulaValues=async()=>[[]];
    await assert.rejects(assertPersonalUseSheetRowSafe(h.env,'V52_PERSONAL_USE_RAW',2,h.id),/READBACK_INCOMPLETE/);
    h.sqlite.prepare('INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES(?,?,?)').run('V52_PERSONAL_USE_RAW','other_id',2);
    await assert.rejects(assertPersonalUseSheetRowSafe(h.env,'V52_PERSONAL_USE_RAW',2,h.id),/D1_ROW_COLLISION/);
  }finally{h.close();}
});
async function withSheetWriter(write,run){const original=sheetsClient.batchWriteValues;sheetsClient.batchWriteValues=async(env,data,beforeMutationDispatch)=>{if(beforeMutationDispatch)await beforeMutationDispatch();return write(env,data);};try{return await run();}finally{sheetsClient.batchWriteValues=original;}}
async function withSheetsTransport(fetchImpl,run,authImpl=async()=>"test-token"){const originalFetch=globalThis.fetch,originalAuth=googleAuth.getGoogleAccessToken;googleAuth.getGoogleAccessToken=authImpl;globalThis.fetch=fetchImpl;try{return await run();}finally{globalThis.fetch=originalFetch;googleAuth.getGoogleAccessToken=originalAuth;}}
async function withConsoleErrorMuted(run){const original=console.error;console.error=()=>{};try{return await run();}finally{console.error=original;}}

test('PERSONAL_USE inversion cannot leave an older projection after the latest D1 version',async()=>{
  const h=harness(),olderWriteStarted=deferred(),releaseOlderWrite=deferred();
  const sheet={row:null,writes:[]};
  const write=async(_env,data)=>{
    const values=data[0].values[0],version=Number(values[14]);
    if(version===2){olderWriteStarted.resolve();await releaseOlderWrite.promise;}
    sheet.row=[...values];sheet.writes.push({status:String(values[6]),version});
  };
  try{
    await withSheetWriter(write,async()=>{
      const older=syncJob(h.env,job(h.id,2));
      await olderWriteStarted.promise;
      cancelAtVersionThree(h);
      const latestAttempt=await syncJob(h.env,job(h.id,3));
      assert.equal(latestAttempt,'BUSY','the latest version must retry while an older version owns the entity lease');
      releaseOlderWrite.resolve();
      await older;
      assert.equal(await syncJob(h.env,job(h.id,3)),'PROCESSED');
      assert.deepEqual(sheet.row?.slice(6,7).concat(sheet.row?.slice(14)),['CANCELLED',3]);
    });
  }finally{
    releaseOlderWrite.resolve();h.close();
  }
});

test('stale PERSONAL_USE delivery is a no-op after the latest projection is committed',async()=>{
  const h=harness(),writes=[];
  try{
    cancelAtVersionThree(h);
    await withSheetWriter(async(_env,data)=>{writes.push(data[0]);},async()=>{
      assert.equal(await syncJob(h.env,job(h.id,3)),'PROCESSED');
      assert.equal(await syncJob(h.env,job(h.id,2)),'IGNORED');
    });
    assert.equal(writes.length,1);
    assert.equal(writes[0].values[0][6],'CANCELLED');
    assert.equal(writes[0].values[0][14],3);
    assert.deepEqual(syncRows(h),[
      {entity_version:2,status:'COMPLETED',attempt_count:1},
      {entity_version:3,status:'COMPLETED',attempt_count:1}
    ]);
  }finally{h.close();}
});

test('duplicate delivery of one PERSONAL_USE version performs one Sheet write',async()=>{
  const h=harness(),writeStarted=deferred(),releaseWrite=deferred(),writes=[];
  try{
    await withSheetWriter(async(_env,data)=>{writes.push(data[0]);writeStarted.resolve();await releaseWrite.promise;},async()=>{
      const first=syncJob(h.env,job(h.id,2));
      await writeStarted.promise;
      const duplicate=await syncJob(h.env,job(h.id,2));
      assert.equal(duplicate,'IGNORED');
      releaseWrite.resolve();
      assert.equal(await first,'PROCESSED');
    });
    assert.equal(writes.length,1);
    assert.deepEqual(syncRows(h),[{entity_version:2,status:'COMPLETED',attempt_count:1}]);
  }finally{releaseWrite.resolve();h.close();}
});

test('active older PERSONAL_USE lease makes the latest version retry without stealing the lease',async()=>{
  const h=harness(),writes=[];
  try{
    const oldLease=await claimSheetSyncJob(h.env,job(h.id,2));
    assert.equal(typeof oldLease,'string');
    cancelAtVersionThree(h);
    await withSheetWriter(async(_env,data)=>{writes.push(data[0]);},async()=>{
      assert.equal(await syncJob(h.env,job(h.id,3)),'BUSY');
      assert.equal(writes.length,0);
      h.sqlite.prepare(`UPDATE sync_jobs SET status='COMPLETED',lease_until=NULL,lease_token=NULL WHERE entity_type='PERSONAL_USE' AND entity_key=? AND entity_version=2`).run(h.id);
      assert.equal(await syncJob(h.env,job(h.id,3)),'PROCESSED');
    });
    assert.equal(writes.length,1);
    assert.equal(writes[0].values[0][14],3);
  }finally{h.close();}
});

test('queue replaces a busy PERSONAL_USE delivery without exhausting retry or DLQ budget',async()=>{
  const h=harness(),calls={acks:0,retries:[]};
  try{
    assert.equal(typeof await claimSheetSyncJob(h.env,job(h.id,2)),'string');
    cancelAtVersionThree(h);
    const message={body:job(h.id,3),attempts:5,ack(){calls.acks+=1;},retry(options){calls.retries.push(options);}};
    await worker.queue({queue:'malipang-jobs',messages:[message]},h.env,{});
    assert.equal(calls.acks,1);
    assert.deepEqual(calls.retries,[]);
    assert.equal(h.queued.length,1);
    assert.equal(h.queued[0].delaySeconds,30);
    assert.deepEqual(h.queued[0].body,job(h.id,3));
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) count FROM failed_jobs`).get().count,0);
    assert.deepEqual(syncRows(h),[
      {entity_version:2,status:'PROCESSING',attempt_count:1},
      {entity_version:3,status:'PENDING',attempt_count:0}
    ]);
  }finally{h.close();}
});

test('an ambiguous same-version delivery is acknowledged and remains in review',async()=>{
  const h=harness(),firstCalls={acks:0,retries:[]},redeliveryCalls={acks:0,retries:[]};
  try{
    const firstMessage={body:job(h.id,2),attempts:1,ack(){firstCalls.acks+=1;},retry(options){firstCalls.retries.push(options);}};
    await withSheetWriter(async()=>{throw new SheetsMutationOutcomeUnknownError(new OperationTimeoutError('Google Sheets mutation',15000));},async()=>{
      await withConsoleErrorMuted(()=>worker.queue({queue:'malipang-jobs',messages:[firstMessage]},h.env,{}));
    });
    assert.equal(firstCalls.acks,1);
    assert.deepEqual(firstCalls.retries,[]);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) count FROM failed_jobs WHERE status='OPEN'`).get().count,1);
    const message={body:job(h.id,2),attempts:5,ack(){redeliveryCalls.acks+=1;},retry(options){redeliveryCalls.retries.push(options);}};
    await worker.queue({queue:'malipang-jobs',messages:[message]},h.env,{});
    assert.equal(redeliveryCalls.acks,1);
    assert.deepEqual(redeliveryCalls.retries,[]);
    assert.equal(h.queued.length,0);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) count FROM failed_jobs WHERE status='OPEN'`).get().count,1);
  }finally{h.close();}
});

test('current version remains retryable when its blocking writer finishes during claim resolution',async()=>{
  const h=harness();
  try{
    assert.equal(typeof await claimSheetSyncJob(h.env,job(h.id,2)),'string');
    cancelAtVersionThree(h);
    h.DB.afterFirst=async sql=>{
      if(sql.startsWith('SELECT * FROM owner_personal_transactions')){
        h.DB.afterFirst=null;
        h.sqlite.prepare(`UPDATE sync_jobs SET status='COMPLETED',lease_until=NULL,lease_token=NULL WHERE entity_type='PERSONAL_USE' AND entity_key=? AND entity_version=2`).run(h.id);
      }
    };
    assert.equal(await syncJob(h.env,job(h.id,3)),'BUSY');
    assert.deepEqual(syncRows(h),[
      {entity_version:2,status:'COMPLETED',attempt_count:1},
      {entity_version:3,status:'PENDING',attempt_count:0}
    ]);
  }finally{h.close();}
});

test('latest-version fence immediately before the external write rejects a newly stale projection',async()=>{
  const h=harness(),writes=[];
  try{
    h.DB.afterFirst=async(sql,_args,row)=>{
      if(sql.startsWith('SELECT row_number FROM sheet_row_index')&&row){
        h.DB.afterFirst=null;
        cancelAtVersionThree(h);
      }
    };
    await withSheetWriter(async(_env,data)=>{writes.push(data[0]);},async()=>{
      assert.equal(await syncJob(h.env,job(h.id,2)),'IGNORED');
    });
    assert.equal(writes.length,0);
    assert.deepEqual(syncRows(h),[
      {entity_version:2,status:'COMPLETED',attempt_count:1},
      {entity_version:3,status:'PENDING',attempt_count:0}
    ]);
  }finally{h.close();}
});

test('client timeout before a late remote write keeps the newer projection fenced',async()=>{
  const h=harness(),oldRequestStarted=deferred(),releaseOldRemoteWrite=deferred(),oldRemoteWriteApplied=deferred();
  const sheet={row:null,writes:[]};
  try{
    await withSheetWriter(async(_env,data)=>{
      const values=[...data[0].values[0]],version=Number(values[14]);
      if(version===2){
        oldRequestStarted.resolve();
        void releaseOldRemoteWrite.promise.then(()=>{
          sheet.row=values;sheet.writes.push(version);oldRemoteWriteApplied.resolve();
        });
        throw new SheetsMutationOutcomeUnknownError(new OperationTimeoutError('Google Sheets mutation',15000));
      }
      sheet.row=values;sheet.writes.push(version);
    },async()=>{
      assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW');
      await oldRequestStarted.promise;
      const ambiguous=plain(h.sqlite.prepare(`SELECT status,lease_until,lease_token,next_attempt_at,last_error FROM sync_jobs WHERE entity_type='PERSONAL_USE' AND entity_key=? AND entity_version=2`).get(h.id));
      assert.equal(ambiguous.status,'REVIEW');
      assert.equal(typeof ambiguous.lease_token,'string');
      assert.equal(ambiguous.next_attempt_at,null);
      assert.match(ambiguous.last_error,/^SHEETS_MUTATION_OUTCOME_UNKNOWN:/);
      assert.ok(Date.parse(ambiguous.lease_until)-Date.now()>GOOGLE_SHEETS_MAX_SERVER_PROCESSING_MS,'the renewed lease must outlive the provider processing bound');
      cancelAtVersionThree(h);
      assert.equal(await syncJob(h.env,job(h.id,3)),'REVIEW');
      releaseOldRemoteWrite.resolve();
      await oldRemoteWriteApplied.promise;
      assert.deepEqual(sheet.writes,[2]);
      assert.equal(await syncJob(h.env,job(h.id,3)),'REVIEW');
      expireLease(h,2);
      await recoverPendingSheetJobs(h.env,0);
      assert.equal(await syncJob(h.env,job(h.id,3)),'REVIEW');
      assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW');
      assert.deepEqual(sheet.writes,[2]);
    });
  }finally{releaseOldRemoteWrite.resolve();h.close();}
});

test('network disconnect after remote acceptance retains the same per-entity fence',async()=>{
  const h=harness(),releaseRemoteWrite=deferred(),remoteWriteApplied=deferred(),sheet={row:null,writes:[]};
  try{
    await withSheetWriter(async(_env,data)=>{
      const values=[...data[0].values[0]],version=Number(values[14]);
      if(version===2){
        void releaseRemoteWrite.promise.then(()=>{sheet.row=values;sheet.writes.push(version);remoteWriteApplied.resolve();});
        throw new SheetsMutationOutcomeUnknownError(new TypeError('network connection lost after request acceptance'));
      }
      sheet.row=values;sheet.writes.push(version);
    },async()=>{
      assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW');
      cancelAtVersionThree(h);
      assert.equal(await syncJob(h.env,job(h.id,3)),'REVIEW');
      releaseRemoteWrite.resolve();await remoteWriteApplied.promise;
      assert.deepEqual(sheet.writes,[2]);
      expireLease(h,2);
      assert.equal(await syncJob(h.env,job(h.id,3)),'REVIEW');
      assert.deepEqual(sheet.writes,[2]);
      assert.equal(sheet.row[14],2);
    });
  }finally{releaseRemoteWrite.resolve();h.close();}
});

test('ambiguity fence includes a configured client timeout before the provider bound',async()=>{
  const h=harness(),clientTimeoutMs=20*60*1000,started=Date.now();h.env.EXTERNAL_API_TIMEOUT_MS=String(clientTimeoutMs);
  try{
    await withSheetWriter(async()=>{throw new SheetsMutationOutcomeUnknownError(new OperationTimeoutError('Google Sheets mutation',clientTimeoutMs));},async()=>{
      assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW');
    });
    const lease=String(h.sqlite.prepare(`SELECT lease_until FROM sync_jobs WHERE entity_type='PERSONAL_USE' AND entity_key=? AND entity_version=2`).get(h.id).lease_until);
    assert.ok(Date.parse(lease)-started>=clientTimeoutMs+GOOGLE_SHEETS_MAX_SERVER_PROCESSING_MS+PERSONAL_USE_AMBIGUITY_MARGIN_MS);
  }finally{h.close();}
});

test('cold OAuth completes before the final CAS renews the mutation fence',async()=>{
  const h=harness(),authStarted=deferred(),releaseAuth=deferred(),order=[];
  const clientTimeoutMs=20*60*1000,requiredFenceMs=clientTimeoutMs+GOOGLE_SHEETS_MAX_SERVER_PROCESSING_MS+PERSONAL_USE_AMBIGUITY_MARGIN_MS;
  h.env.GOOGLE_SPREADSHEET_ID='fixture';h.env.EXTERNAL_API_TIMEOUT_MS=String(clientTimeoutMs);
  let dispatchLeaseUntil='';
  try{
    await withSheetsTransport(async()=>{
      order.push('sheet-dispatch');
      dispatchLeaseUntil=String(h.sqlite.prepare(`SELECT lease_until FROM sync_jobs WHERE entity_type='PERSONAL_USE' AND entity_key=? AND entity_version=2`).get(h.id).lease_until);
      return new Response('{}',{status:200});
    },async()=>{
      const syncing=syncJob(h.env,job(h.id,2));
      await authStarted.promise;
      const preAuthLeaseUntil=String(h.sqlite.prepare(`SELECT lease_until FROM sync_jobs WHERE entity_type='PERSONAL_USE' AND entity_key=? AND entity_version=2`).get(h.id).lease_until);
      assert.ok(Date.parse(preAuthLeaseUntil)-Date.now()<requiredFenceMs,'the long mutation fence must not start before cold OAuth finishes');
      releaseAuth.resolve();
      assert.equal(await syncing,'PROCESSED');
    },async()=>{order.push('oauth-start');authStarted.resolve();await releaseAuth.promise;order.push('oauth-complete');return'test-token';});
    assert.deepEqual(order,['oauth-start','oauth-complete','sheet-dispatch']);
    assert.ok(Date.parse(dispatchLeaseUntil)-Date.now()>=requiredFenceMs-2000,'the post-auth lease must cover the full mutation timeout and provider bound');
  }finally{releaseAuth.resolve();h.close();}
});

test('lease expiry during cold OAuth prevents mutation dispatch after ownership is lost',async()=>{
  const h=harness(),authStarted=deferred(),releaseAuth=deferred();h.env.GOOGLE_SPREADSHEET_ID='fixture';
  let sheetDispatches=0;
  try{
    await withSheetsTransport(async()=>{sheetDispatches+=1;return new Response('{}',{status:200});},async()=>{
      const syncing=syncJob(h.env,job(h.id,2));
      await authStarted.promise;
      expireLease(h,2);
      releaseAuth.resolve();
      assert.equal(await syncing,'BUSY');
      assert.equal(sheetDispatches,0,'the expired writer must not reach fetch');
      assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW');
    },async()=>{authStarted.resolve();await releaseAuth.promise;return'test-token';});
    assert.equal(sheetDispatches,0);
  }finally{releaseAuth.resolve();h.close();}
});

test('version advance during cold OAuth releases the undispatched stale lease for N+1',async()=>{
  const h=harness(),authStarted=deferred(),releaseAuth=deferred();h.env.GOOGLE_SPREADSHEET_ID='fixture';
  const dispatchedVersions=[];
  try{
    await withSheetsTransport(async(_url,init)=>{dispatchedVersions.push(Number(JSON.parse(String(init.body)).data[0].values[0][14]));return new Response('{}',{status:200});},async()=>{
      const syncing=syncJob(h.env,job(h.id,2));
      await authStarted.promise;
      cancelAtVersionThree(h);
      releaseAuth.resolve();
      assert.equal(await syncing,'IGNORED');
      const superseded=plain(h.sqlite.prepare(`SELECT status,lease_until,lease_token FROM sync_jobs WHERE entity_type='PERSONAL_USE' AND entity_key=? AND entity_version=2`).get(h.id));
      assert.deepEqual(superseded,{status:'COMPLETED',lease_until:null,lease_token:null});
      assert.deepEqual(dispatchedVersions,[],'the superseded pre-auth snapshot must never reach fetch');
      assert.equal(await syncJob(h.env,job(h.id,3)),'PROCESSED','N+1 must write without waiting for the old 15-minute lease');
    },async()=>{authStarted.resolve();await releaseAuth.promise;return'test-token';});
    assert.deepEqual(dispatchedVersions,[3]);
    assert.equal(h.sqlite.prepare(`SELECT version FROM owner_personal_transactions WHERE personal_use_id=?`).get(h.id).version,3);
  }finally{releaseAuth.resolve();h.close();}
});

test('superseded cleanup never clears a lease reclaimed after the final CAS rejection',async()=>{
  const h=harness(),original=sheetsClient.batchWriteValues,reclaimedToken='reclaimed-by-another-worker';
  try{
    sheetsClient.batchWriteValues=async(_env,_data,beforeMutationDispatch)=>{
      cancelAtVersionThree(h);
      try{await beforeMutationDispatch();assert.fail('the stale final CAS must reject');}
      catch(error){
        h.sqlite.prepare(`UPDATE sync_jobs SET status='PROCESSING',lease_token=?,lease_until='2999-01-01T00:00:00.000Z' WHERE entity_type='PERSONAL_USE' AND entity_key=? AND entity_version=2`).run(reclaimedToken,h.id);
        throw error;
      }
    };
    assert.equal(await syncJob(h.env,job(h.id,2)),'BUSY');
    const reclaimed=plain(h.sqlite.prepare(`SELECT status,lease_token,lease_until FROM sync_jobs WHERE entity_type='PERSONAL_USE' AND entity_key=? AND entity_version=2`).get(h.id));
    assert.deepEqual(reclaimed,{status:'PROCESSING',lease_token:reclaimedToken,lease_until:'2999-01-01T00:00:00.000Z'});
  }finally{sheetsClient.batchWriteValues=original;h.close();}
});

test('definitive Sheet rejection uses normal failed-job retry instead of ambiguity quarantine',async()=>{
  const h=harness(),writes=[];
  try{
    await withSheetWriter(async(_env,data)=>{
      const version=Number(data[0].values[0][14]);
      if(version===2)throw new SheetsHttpError(400,'Sheets HTTP 400: invalid range');
      writes.push(version);
    },async()=>{
      await assert.rejects(syncJob(h.env,job(h.id,2)),/HTTP 400/);
      const failed=plain(h.sqlite.prepare(`SELECT status,lease_until,lease_token,last_error FROM sync_jobs WHERE entity_type='PERSONAL_USE' AND entity_key=? AND entity_version=2`).get(h.id));
      assert.equal(failed.status,'FAILED');
      assert.equal(failed.lease_until,null);
      assert.equal(failed.lease_token,null);
      assert.doesNotMatch(failed.last_error,/^SHEETS_MUTATION_OUTCOME_UNKNOWN:/);
      cancelAtVersionThree(h);
      assert.equal(await syncJob(h.env,job(h.id,3)),'PROCESSED');
    });
    assert.deepEqual(writes,[3]);
  }finally{h.close();}
});

test('only no-response, timeout-class and server-side errors are ambiguous Sheet mutations',()=>{
  assert.equal(isAmbiguousSheetsMutationStatus(408),true);
  assert.equal(isAmbiguousSheetsMutationStatus(500),true);
  assert.equal(isAmbiguousSheetsMutationStatus(503),true);
  assert.equal(isAmbiguousSheetsMutationStatus(400),false);
  assert.equal(isAmbiguousSheetsMutationStatus(403),false);
  assert.equal(isAmbiguousSheetsMutationStatus(429),false);
  assert.equal(isAmbiguousSheetsMutationStatus(600),false);
});

test('Sheets mutation transport wraps timeout, disconnect and 5xx but leaves definitive 4xx classified',async()=>{
  const env={GOOGLE_SPREADSHEET_ID:'fixture',EXTERNAL_API_TIMEOUT_MS:'5'},data=[{range:"'fixture'!A2:A2",values:[[1]]}];
  await withSheetsTransport((_url,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true})),async()=>{
    await assert.rejects(sheetsClient.batchWriteValues(env,data),error=>error instanceof SheetsMutationOutcomeUnknownError&&error.cause instanceof OperationTimeoutError);
  });
  await withSheetsTransport(async()=>{throw new TypeError('connection reset');},async()=>{
    await assert.rejects(sheetsClient.batchWriteValues(env,data),error=>error instanceof SheetsMutationOutcomeUnknownError&&error.cause instanceof TypeError);
  });
  await withSheetsTransport(async()=>new Response('temporary failure',{status:503}),async()=>{
    await assert.rejects(sheetsClient.batchWriteValues(env,data),error=>error instanceof SheetsMutationOutcomeUnknownError&&error.cause instanceof SheetsHttpError);
  });
  await withSheetsTransport(async()=>new Response('invalid range',{status:400}),async()=>{
    await assert.rejects(sheetsClient.batchWriteValues(env,data),error=>error instanceof SheetsHttpError&&!(error instanceof SheetsMutationOutcomeUnknownError));
  });
});

test('timeout after an applied Sheet write stays in review after lease expiry',async()=>{
  const h=harness(),attemptedRanges=[],sheet={row:null};
  let attempts=0;
  try{
    await withSheetWriter(async(_env,data)=>{
      attempts+=1;
      attemptedRanges.push(data[0].range);
      sheet.row=[...data[0].values[0]];
      if(attempts===1)throw new SheetsMutationOutcomeUnknownError(new OperationTimeoutError('Google Sheets timed out after write',15000));
    },async()=>{
      assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW');
      const ambiguous=plain(h.sqlite.prepare(`SELECT status,attempt_count,next_attempt_at,lease_until,lease_token,last_error FROM sync_jobs WHERE entity_type='PERSONAL_USE' AND entity_key=? AND entity_version=2`).get(h.id));
      assert.equal(ambiguous.status,'REVIEW');
      assert.equal(ambiguous.attempt_count,1);
      assert.equal(ambiguous.next_attempt_at,null);
      assert.equal(typeof ambiguous.lease_token,'string');
      assert.match(ambiguous.last_error,/^SHEETS_MUTATION_OUTCOME_UNKNOWN:/);
      expireLease(h,2);
      assert.equal(await syncJob(h.env,job(h.id,2),2),'REVIEW');
    });
    assert.equal(attempts,1);
    assert.equal(new Set(attemptedRanges).size,1);
    assert.equal(sheet.row[6],'CONFIRMED');
    assert.equal(sheet.row[14],2);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) count FROM sheet_row_index WHERE sheet_name='V52_PERSONAL_USE_RAW' AND entity_key=?`).get(h.id).count,1);
    assert.deepEqual(syncRows(h),[{entity_version:2,status:'REVIEW',attempt_count:1}]);
  }finally{h.close();}
});

test('timeout of an older version keeps the newer version in review',async()=>{
  const h=harness(),sheet={row:null,writes:[]};
  let first=true;
  try{
    await withSheetWriter(async(_env,data)=>{
      const values=data[0].values[0];
      sheet.row=[...values];sheet.writes.push(Number(values[14]));
      if(first){first=false;throw new SheetsMutationOutcomeUnknownError(new OperationTimeoutError('Google Sheets timed out after applied write',15000));}
    },async()=>{
      assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW');
      cancelAtVersionThree(h);
      assert.equal(await syncJob(h.env,job(h.id,3)),'REVIEW');
      expireLease(h,2);
      assert.equal(await syncJob(h.env,job(h.id,3)),'REVIEW');
      assert.equal(await syncJob(h.env,job(h.id,2),2),'REVIEW');
    });
    assert.deepEqual(sheet.writes,[2]);
    assert.equal(sheet.row[6],'CONFIRMED');
    assert.equal(sheet.row[14],2);
  }finally{h.close();}
});

test('reconcile interleaving queues the authoritative version and converges after an older writer',async()=>{
  const h=harness(),olderWriteStarted=deferred(),releaseOlderWrite=deferred(),sheet={row:null,writes:[]};
  try{
    await withSheetWriter(async(_env,data)=>{
      const values=data[0].values[0],version=Number(values[14]);
      if(version===2){olderWriteStarted.resolve();await releaseOlderWrite.promise;}
      sheet.row=[...values];sheet.writes.push(version);
    },async()=>{
      const older=syncJob(h.env,job(h.id,2));
      await olderWriteStarted.promise;
      cancelAtVersionThree(h,{enqueue:false});
      const result=await reconcileSheets(h.env,{fromDate:'2026-09-06',toDate:'2026-09-06',limitPerType:10});
      assert.equal(result.counts.PERSONAL_USE,1);
      assert.ok(result.enqueued>=1,'reconcile may also enqueue seeded migration fixtures from other entity types');
      const reconciled=h.queued.find(message=>message.body?.entityType==='PERSONAL_USE')?.body;
      assert.equal(reconciled,undefined,'reconcile must report the held version instead of dispatching it');
      assert.ok(result.held>=1);
      releaseOlderWrite.resolve();
      assert.equal(await older,'PROCESSED');
      h.sqlite.prepare(`UPDATE sync_jobs SET updated_at='2000-01-01T00:00:00.000Z',next_attempt_at='2000-01-01T00:00:00.000Z' WHERE entity_type='PERSONAL_USE' AND entity_key=? AND entity_version=3`).run(h.id);
      await recoverPendingSheetJobs(h.env,0);
      const recovered=h.queued.find(message=>message.body?.entityType==='PERSONAL_USE')?.body;
      assert.equal(recovered?.entityVersion,3);
      assert.equal(await syncJob(h.env,recovered),'PROCESSED');
    });
    assert.deepEqual(sheet.writes,[2,3]);
    assert.equal(sheet.row[6],'CANCELLED');
    assert.equal(sheet.row[14],3);
  }finally{releaseOlderWrite.resolve();h.close();}
});

test('reconcile uses actual confirmed expense versions and reports held rows',async()=>{
  const h=harness(),now='2026-09-06T00:00:00.000Z';
  try{
    const insert=h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at,version) VALUES(?,?,?,'sanitized',100,'cash','CASH_DRAWER','ingredients','2026-09-06','CONFIRMED','trace_fixture',?,?)`);
    for(const [id,version] of [['exp_v2',2],['exp_v3',3],['exp_review',3],['exp_processing',3]])insert.run(id,`message_${id}`,'user_fixture',now,version);
    const insertJob=h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,lease_until,lease_token) VALUES(?,'EXPENSE',?,2,'trace_fixture',?,1,?,'2099-01-01T00:00:00.000Z','fixture')`);
    insertJob.run('review_fixture','exp_review','REVIEW',now);
    insertJob.run('processing_fixture','exp_processing','PROCESSING',now);
    const result=await reconcileSheets(h.env,{fromDate:'2026-09-06',toDate:'2026-09-06',limitPerType:100});
    assert.equal(result.counts.EXPENSE,4);
    assert.equal(result.held,2);
    assert.equal(result.disabled,0);
    assert.equal(result.enqueued+result.held,Object.values(result.counts).reduce((a,b)=>a+b,0));
    const sent=h.queued.map(m=>m.body).filter(j=>j?.entityType==='EXPENSE');
    assert.deepEqual(sent.map(j=>[j.entityKey,j.entityVersion]),[['exp_v2',2],['exp_v3',3]]);
    assert.deepEqual(plain(h.sqlite.prepare(`SELECT entity_key,entity_version,status FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key IN ('exp_processing','exp_review') AND entity_version=3 ORDER BY entity_key`).all()),[{entity_key:'exp_processing',entity_version:3,status:'PENDING'},{entity_key:'exp_review',entity_version:3,status:'PENDING'}]);
    h.env.SHEETS_SYNC_ENABLED='false';
    const disabled=await reconcileSheets(h.env,{fromDate:'2026-09-06',toDate:'2026-09-06',limitPerType:100});
    assert.equal(disabled.enqueued,0);assert.equal(disabled.held,2);
    assert.equal(disabled.disabled+disabled.held,Object.values(disabled.counts).reduce((a,b)=>a+b,0));
  }finally{h.close();}
});

test('EXPENSE versions cannot process simultaneously',async()=>{
  const h=harness();
  try{
    const older={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'expense_ordering_fixture',entityVersion:1,traceId:'trace_expense_v1'};
    const newer={...older,entityVersion:2,traceId:'trace_expense_v2'};
    assert.equal(typeof await claimSheetSyncJob(h.env,older),'string');
    assert.equal(await claimSheetSyncJob(h.env,newer),null);
    const rows=plain(h.sqlite.prepare(`SELECT entity_version,status FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=? ORDER BY entity_version`).all(older.entityKey));
    assert.deepEqual(rows,[{entity_version:1,status:'PROCESSING'},{entity_version:2,status:'PENDING'}]);
  }finally{h.close();}
});

test('PERSONAL_USE serialization is scoped per entity rather than global',async()=>{
  const h=harness(),secondId='personal_ordering_fixture_2';
  try{
    h.sqlite.prepare(`INSERT INTO owner_personal_transactions SELECT ?,?,line_user_id,transaction_type,description,amount_satang,source_wallet,transaction_date,status,?,submitted_by_employee_id,branch_id,reviewed_by_employee_id,approved_at,created_at,updated_at,version FROM owner_personal_transactions WHERE personal_use_id=?`).run(secondId,'message_ordering_fixture_2','trace_ordering_2',h.id);
    h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token) VALUES(?,?,?,?,?,'PENDING',0,?,?,NULL,NULL)`).run('sync_ordering_second_v2','PERSONAL_USE',secondId,2,'trace_ordering_second_v2','2026-09-06T00:00:00.000Z','2026-09-06T00:00:00.000Z');
    assert.equal(typeof await claimSheetSyncJob(h.env,job(h.id,2)),'string');
    assert.equal(typeof await claimSheetSyncJob(h.env,job(secondId,2)),'string');
  }finally{h.close();}
});


test('expense raw identity guard fails closed for stale, occupied, duplicate and formula rows',async()=>{
  const h=harness(),sheet='V52_EXPENSE_RAW',id='expense_guard_fixture';
  try{
    const {assertExpenseRawSheetRowSafe:check}=require('../dist/sheets/sync.js');
    sheetsClient.batchGetSheetFormulaValues=async()=>[[],[]];
    await check(h.env,sheet,2,id,true);
    await assert.rejects(check(h.env,sheet,2,id,false),/MAPPED_ROW_MISSING/);
    sheetsClient.batchGetSheetFormulaValues=async()=>[[[id]],[[id,'2026-10-04']]];
    await check(h.env,sheet,2,id,false);
    sheetsClient.batchGetSheetFormulaValues=async()=>[[['different_id']],[[ 'different_id','2026-10-04']]];
    await assert.rejects(check(h.env,sheet,2,id,false),/ROW_COLLISION/);
    sheetsClient.batchGetSheetFormulaValues=async()=>[[],[['','unexpected value']]];
    await assert.rejects(check(h.env,sheet,2,id,true),/ROW_COLLISION/);
    sheetsClient.batchGetSheetFormulaValues=async()=>[[[id]],[[id,'=1+1']]];
    await assert.rejects(check(h.env,sheet,2,id,false),/FORMULA_CONFLICT/);
    sheetsClient.batchGetSheetFormulaValues=async()=>[[[id],[],[id]],[[id,'text']]];
    await assert.rejects(check(h.env,sheet,2,id,false),/IDENTITY_COLLISION/);
    sheetsClient.batchGetSheetFormulaValues=async()=>[[[],[id]],[[]]];
    await assert.rejects(check(h.env,sheet,2,id,true),/IDENTITY_COLLISION/);
    sheetsClient.batchGetSheetFormulaValues=async()=>[[[id]],[[]]];
    await assert.rejects(check(h.env,sheet,2,id,true),/INCONSISTENT_READBACK/);
    sheetsClient.batchGetSheetFormulaValues=async()=>[[]];
    await assert.rejects(check(h.env,sheet,2,id,true),/READBACK_INCOMPLETE/);
    h.sqlite.prepare('INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES(?,?,?)').run(sheet,'other_id',2);
    await assert.rejects(check(h.env,sheet,2,id,false),/D1_ROW_COLLISION/);
  }finally{h.close();}
});

test('expense raw collision is held before any sheet write or daily cancellation',async()=>{
  const h=harness(),id='expense_guard_collision',writes=[],now='2026-10-04T00:00:00.000Z';
  try{
    h.env.SHEET_EXPENSE_RAW='V52_EXPENSE_RAW';h.env.SHEET_EXPENSE_DAILY='daily_fixture';
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at,version) VALUES(?,?,?,'synthetic',100,'cash','CASH_DRAWER','ingredients','2026-10-04','CANCELLED','trace_fixture',?,1)`).run(id,'message_expense_guard','user_expense_guard',now);
    sheetsClient.batchGetSheetFormulaValues=async()=>[[['unrelated_id']],[['unrelated_id','2026-10-04']]];
    const request={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:id,entityVersion:1,traceId:'trace_expense_guard'};
    await withSheetWriter(async(_env,data)=>writes.push(data),async()=>assert.equal(await syncJob(h.env,request),'REVIEW'));
    assert.equal(writes.length,0);
    assert.deepEqual(plain(h.sqlite.prepare(`SELECT status,last_error FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=?`).get(id)),{status:'REVIEW',last_error:'EXPENSE_RAW_ROW_COLLISION'});
  }finally{h.close();}
});
test('personal stable flag blocks numeric-row writer and durably holds the job',async()=>{const h=harness();try{h.env.PERSONAL_STABLE_PROJECTION_ENABLED='true';let writes=0;await withSheetWriter(async()=>{writes++;},async()=>assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW'));assert.equal(writes,0);assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs WHERE entity_key=?').get(h.id).status,'REVIEW');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM sheet_row_index').get().n,0);}finally{h.close();}});
test('personal cutover gate closed after OAuth holds exact owner before Sheets POST',async()=>{const h=harness(),original=sheetsClient.batchWriteValues;try{h.env.PERSONAL_LEGACY_WRITER_GATE_ENABLED='true';h.env.GOOGLE_SPREADSHEET_ID='book';h.sqlite.exec("UPDATE personal_legacy_writer_gates SET state='OPEN'");let posts=0;sheetsClient.batchWriteValues=async(_env,_data,before)=>{h.sqlite.exec("UPDATE personal_legacy_writer_gates SET state='HOLD'");await before();posts++;};assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW');assert.equal(posts,0);const row=h.sqlite.prepare('SELECT status,last_error,lease_token FROM sync_jobs WHERE entity_key=?').get(h.id);assert.equal(row.status,'REVIEW');assert.equal(row.last_error,'PERSONAL_LEGACY_CUTOVER_HOLD');assert.equal(row.lease_token,null);}finally{sheetsClient.batchWriteValues=original;h.close();}});
test('missing or unreadable personal cutover gate fails closed',async()=>{const h=harness();try{h.env.PERSONAL_LEGACY_WRITER_GATE_ENABLED='true';h.env.GOOGLE_SPREADSHEET_ID='book';h.sqlite.exec('DELETE FROM personal_legacy_writer_gates');assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM sheet_row_index').get().n,0);}finally{h.close();}});
test('personal gate closing between final read and lease renewal stops the POST',async()=>{const h=harness();try{h.env.PERSONAL_LEGACY_WRITER_GATE_ENABLED='true';h.env.GOOGLE_SPREADSHEET_ID='book';h.sqlite.exec("UPDATE personal_legacy_writer_gates SET state='OPEN'");let reads=0,posts=0;h.DB.afterFirst=async sql=>{if(sql.includes('FROM personal_legacy_writer_gates')&&++reads===3)h.sqlite.exec("UPDATE personal_legacy_writer_gates SET state='HOLD'");};await withSheetWriter(async()=>{posts++;},async()=>assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW'));assert.equal(posts,0);const row=h.sqlite.prepare('SELECT status,last_error FROM sync_jobs WHERE entity_key=?').get(h.id);assert.equal(row.status,'REVIEW');assert.equal(row.last_error,'PERSONAL_LEGACY_CUTOVER_HOLD');}finally{h.close();}});
test('personal gate closing before allocation holds without creating a cached row',async()=>{const h=harness();try{h.env.PERSONAL_LEGACY_WRITER_GATE_ENABLED='true';h.env.GOOGLE_SPREADSHEET_ID='book';h.sqlite.exec("UPDATE personal_legacy_writer_gates SET state='OPEN'");let reads=0,posts=0;h.DB.afterFirst=async sql=>{if(sql.includes('FROM personal_legacy_writer_gates')&&++reads===1)h.sqlite.exec("UPDATE personal_legacy_writer_gates SET state='HOLD'");};await withSheetWriter(async()=>{posts++;},async()=>assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW'));assert.equal(posts,0);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM sheet_row_index').get().n,0);}finally{h.close();}});
test('personal legacy gate never reclaims an active or completed owner',async()=>{for(const status of ['PROCESSING','COMPLETED']){const h=harness();try{h.env.PERSONAL_STABLE_PROJECTION_ENABLED='true';h.sqlite.prepare("UPDATE sync_jobs SET status=?,lease_token=?,lease_until=? WHERE entity_key=?").run(status,status==='PROCESSING'?'old_owner_token':null,status==='PROCESSING'?'9999-01-01T00:00:00.000Z':null,h.id);assert.equal(await syncJob(h.env,job(h.id,2)),'TERMINAL_HOLD');const row=h.sqlite.prepare('SELECT status,lease_token FROM sync_jobs WHERE entity_key=?').get(h.id);assert.equal(row.status,status);assert.equal(row.lease_token,status==='PROCESSING'?'old_owner_token':null);}finally{h.close();}}});
test('legacy writer stays held if any cutover exists even when the gate says OPEN',async()=>{for(const state of ['PREPARED','ACTIVE','HELD']){const h=harness();try{h.env.PERSONAL_LEGACY_WRITER_GATE_ENABLED='true';h.env.GOOGLE_SPREADSHEET_ID='book';h.sqlite.exec("UPDATE personal_legacy_writer_gates SET state='OPEN'");h.sqlite.prepare("INSERT INTO personal_projection_cutovers(spreadsheet_id,sheet_name,generation,state,admission_watermark,activated_at) VALUES('book','V52_PERSONAL_USE_RAW','generation_1',?,?,?)").run(state,state==='ACTIVE'?0:null,state==='ACTIVE'?'now':null);assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM sheet_row_index').get().n,0);}finally{h.close();}}});
test('persisted personal HOLD blocks even when both flags are false or missing',async()=>{for(const flag of [undefined,'false']){const h=harness();try{h.env.PERSONAL_LEGACY_WRITER_GATE_ENABLED=flag;h.env.PERSONAL_STABLE_PROJECTION_ENABLED='false';h.sqlite.exec("UPDATE personal_legacy_writer_gates SET state='HOLD' WHERE spreadsheet_id='book'");assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM sheet_row_index').get().n,0);}finally{h.close();}}});
test('installed schema requires the exact workbook/sheet OPEN row even with flag off',async()=>{const h=harness();try{h.env.PERSONAL_LEGACY_WRITER_GATE_ENABLED='false';h.sqlite.exec("DELETE FROM personal_legacy_writer_gates WHERE spreadsheet_id='book'");assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM sheet_row_index').get().n,0);}finally{h.close();}});
test('gate changing after read blocks final lease CAS even with flag false',async()=>{const h=harness();try{h.env.PERSONAL_LEGACY_WRITER_GATE_ENABLED='false';let reads=0,posts=0;h.DB.afterFirst=async sql=>{if(sql.includes('FROM personal_legacy_writer_gates')&&++reads===3)h.sqlite.exec("UPDATE personal_legacy_writer_gates SET state='HOLD' WHERE spreadsheet_id='book'");};await withSheetWriter(async()=>{posts++;},async()=>assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW'));assert.equal(posts,0);}finally{h.close();}});
test('missing or inconsistent migration ledger and dropped schema fail closed',async()=>{for(const mode of ['missing_ledger','missing_schema','partial_schema','missing_expected','unknown_future','duplicate_version','db_error']){const h=harness();try{if(mode==='missing_ledger')h.sqlite.exec('DROP TABLE d1_migrations');if(mode==='missing_schema')h.sqlite.exec('DROP TABLE personal_legacy_writer_gates; DROP TABLE personal_projection_cutovers');if(mode==='partial_schema')h.sqlite.exec('DROP TABLE personal_projection_cutovers');if(mode==='missing_expected')h.sqlite.exec("DELETE FROM d1_migrations WHERE name='0023_daily_stable_row_intents.sql'");if(mode==='unknown_future')h.sqlite.exec("INSERT INTO d1_migrations(name) VALUES('0099_unexpected.sql')");if(mode==='duplicate_version')h.sqlite.exec("INSERT INTO d1_migrations(name) VALUES('0037_wrong_name.sql')");if(mode==='db_error'){const prepare=h.DB.prepare.bind(h.DB);h.DB.prepare=sql=>{if(sql.includes('sqlite_master'))throw Error('synthetic DB unavailable');return prepare(sql);};}assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW',mode);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM sheet_row_index').get().n,0);}finally{h.close();}}});
test('verified pre-migration ledger preserves legacy operation with intentional gaps',async()=>{const h=harness();try{h.sqlite.exec("DROP TABLE personal_legacy_writer_gates; DROP TABLE personal_projection_cutovers; DELETE FROM d1_migrations WHERE CAST(substr(name,1,4) AS INTEGER)>26");let posts=0;await withSheetWriter(async()=>{posts++;},async()=>assert.equal(await syncJob(h.env,job(h.id,2)),'PROCESSED'));assert.equal(posts,1);}finally{h.close();}});
test('bootstrap fails closed on personal HOLD before Google request',async()=>{const h=harness(),oldFetch=globalThis.fetch,oldToken=googleAuth.getGoogleAccessToken;try{h.sqlite.exec("UPDATE personal_legacy_writer_gates SET state='HOLD' WHERE spreadsheet_id='book'");let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected');};googleAuth.getGoogleAccessToken=async()=> 'token';await assert.rejects(sheetsClient.bootstrapSheets(h.env),/PERSONAL_LEGACY_CUTOVER_HOLD/);assert.equal(calls,0);}finally{globalThis.fetch=oldFetch;googleAuth.getGoogleAccessToken=oldToken;h.close();}});
test('read-only bootstrap cannot mutate even if gate changes during inspection',async()=>{const h=harness();configureBootstrap(h);const oldFetch=globalThis.fetch,oldToken=googleAuth.getGoogleAccessToken;try{let posts=0;googleAuth.getGoogleAccessToken=async()=> 'token';globalThis.fetch=async(_url,init)=>{if(init.method==='GET'){h.sqlite.exec("UPDATE personal_legacy_writer_gates SET state='HOLD' WHERE spreadsheet_id='book'");return new Response(JSON.stringify({sheets:[]}));}posts++;throw Error('unexpected mutation');};const result=await sheetsClient.bootstrapSheets(h.env);assert.equal(result.mode,'READ_ONLY');assert.equal(result.headersVerified,false);assert.equal(result.requiresManualSetup,true);assert.equal(posts,0);}finally{globalThis.fetch=oldFetch;googleAuth.getGoogleAccessToken=oldToken;h.close();}});
test('any later migration with missing gate migration cannot enter pre-migration mode',async()=>{const h=harness();try{h.sqlite.exec("DROP TABLE personal_legacy_writer_gates; DROP TABLE personal_projection_cutovers; DELETE FROM d1_migrations WHERE name='0037_personal_projection_runtime_intents.sql'");assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM sheet_row_index').get().n,0);}finally{h.close();}});
test('migration appearing between pre-mode check and final CAS stops the POST',async()=>{const h=harness();try{h.sqlite.exec("DROP TABLE personal_legacy_writer_gates; DROP TABLE personal_projection_cutovers; DELETE FROM d1_migrations WHERE CAST(substr(name,1,4) AS INTEGER)>20");let reads=0,posts=0;h.DB.afterFirst=async sql=>{if(sql.includes('sqlite_master')&&++reads===3)h.sqlite.exec("CREATE TABLE personal_legacy_writer_gates(spreadsheet_id TEXT,sheet_name TEXT,state TEXT); CREATE TABLE personal_projection_cutovers(spreadsheet_id TEXT,sheet_name TEXT)");};await withSheetWriter(async()=>{posts++;},async()=>assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW'));assert.equal(posts,0);}finally{h.close();}});
test('installed schema with pre-migration ledger is inconsistent and holds',async()=>{const h=harness();try{h.sqlite.exec("DELETE FROM d1_migrations WHERE CAST(substr(name,1,4) AS INTEGER)>20");assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW');}finally{h.close();}});
test('read-only bootstrap reports missing tabs without creating them',async()=>{const h=harness();configureBootstrap(h);const oldFetch=globalThis.fetch,oldToken=googleAuth.getGoogleAccessToken;try{let posts=0;googleAuth.getGoogleAccessToken=async()=> 'token';globalThis.fetch=async(_url,init)=>{if(init.method==='GET')return new Response(JSON.stringify({sheets:[]}));posts++;throw Error('unexpected mutation');};const result=await sheetsClient.bootstrapSheets(h.env);assert.equal(result.missingTabs.length,10);assert.equal(result.headersVerified,false);assert.equal(result.requiresManualSetup,true);assert.equal(posts,0);}finally{globalThis.fetch=oldFetch;googleAuth.getGoogleAccessToken=oldToken;h.close();}});
test('duplicate gate rows cannot select an arbitrary OPEN state',async()=>{const h=harness();try{h.sqlite.exec("DROP TABLE personal_legacy_writer_gates; CREATE TABLE personal_legacy_writer_gates(spreadsheet_id TEXT,sheet_name TEXT,state TEXT); INSERT INTO personal_legacy_writer_gates VALUES('book','V52_PERSONAL_USE_RAW','OPEN'); INSERT INTO personal_legacy_writer_gates VALUES('book','V52_PERSONAL_USE_RAW','HOLD')");assert.equal(await syncJob(h.env,job(h.id,2)),'REVIEW');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM sheet_row_index').get().n,0);}finally{h.close();}});
test('read-only bootstrap never rewrites existing tabs or trusts malformed metadata',async()=>{const h=harness();configureBootstrap(h);const oldFetch=globalThis.fetch,oldToken=googleAuth.getGoogleAccessToken;try{let posts=0,malformed=false;googleAuth.getGoogleAccessToken=async()=> 'token';globalThis.fetch=async(_url,init)=>{if(init.method==='GET')return new Response(malformed?'{invalid secret':JSON.stringify({sheets:[{properties:{sheetId:5,title:'attendance'}},{properties:{sheetId:6,title:'04_OWNER_MONTH_CLOSE'}}]}));posts++;throw Error('unexpected mutation');};const result=await sheetsClient.bootstrapSheets(h.env);assert.ok(!result.missingTabs.includes('attendance'));assert.equal(result.requiresManualSetup,true);malformed=true;await assert.rejects(sheetsClient.bootstrapSheets(h.env),e=>e.message==='BOOTSTRAP_INSPECTION_UNAVAILABLE'&&!e.message.includes('secret'));assert.equal(posts,0);}finally{globalThis.fetch=oldFetch;googleAuth.getGoogleAccessToken=oldToken;h.close();}});

test('admin bootstrap explicitly reports read-only and incomplete setup',async()=>{const h=harness();configureBootstrap(h);const oldFetch=globalThis.fetch,oldToken=googleAuth.getGoogleAccessToken;try{h.env.ADMIN_TOKEN='synthetic-admin-token-with-32-characters';googleAuth.getGoogleAccessToken=async()=> 'token';let posts=0;globalThis.fetch=async(_url,init)=>{if(init.method==='GET')return new Response(JSON.stringify({sheets:[]}));posts++;throw Error('unexpected mutation');};const {handleAdmin}=require('../dist/admin/handler.js');const request=new Request('https://fixture/admin/bootstrap-sheets',{method:'POST',headers:{authorization:`Bearer ${h.env.ADMIN_TOKEN}`}});const response=await handleAdmin(request,h.env,{});const body=await response.json();assert.equal(response.status,409);assert.equal(body.ok,false);assert.equal(body.mode,'READ_ONLY');assert.equal(body.setupComplete,false);assert.equal(body.headersVerified,false);assert.equal(body.requiresManualSetup,true);assert.equal(body.missingTabs.length,10);assert.equal(posts,0);}finally{globalThis.fetch=oldFetch;googleAuth.getGoogleAccessToken=oldToken;h.close();}});
