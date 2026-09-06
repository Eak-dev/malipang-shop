import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';

const require=createRequire(import.meta.url);
const sheetsClient=require('../dist/sheets/client.js');
const {claimSheetSyncJob,syncJob}=require('../dist/sheets/sync.js');
const {reconcileSheets}=require('../dist/admin/reconcile-sheets.js');
const worker=require('../dist/index.js').default;
const migration=name=>readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
const migrationNames=readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>/^\d+.*\.sql$/.test(name)).sort();
const plain=value=>JSON.parse(JSON.stringify(value));

class SqliteD1Statement{
  constructor(owner,sql){this.owner=owner;this.sql=sql;this.args=[];}
  bind(...args){this.args=args;return this;}
  async first(){const row=this.owner.sqlite.prepare(this.sql).get(...this.args)??null;if(this.owner.afterFirst)await this.owner.afterFirst(this.sql,this.args,row);return row;}
  async all(){return{results:this.owner.sqlite.prepare(this.sql).all(...this.args),meta:{changes:0}};}
  async run(){const result=this.owner.sqlite.prepare(this.sql).run(...this.args);return{meta:{changes:Number(result.changes)}};}
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
  const id='personal_ordering_fixture',now='2026-09-06T00:00:00.000Z';
  sqlite.prepare(`INSERT INTO owner_personal_transactions(personal_use_id,message_id,line_user_id,transaction_type,description,amount_satang,source_wallet,transaction_date,status,trace_id,submitted_by_employee_id,branch_id,reviewed_by_employee_id,approved_at,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,'message_ordering_fixture','line_owner','PERSONAL_USE','sanitized ordering fixture',100,'SHOP_BANK','2026-09-06','CONFIRMED','trace_ordering','OWN001','B001','OWN001',now,now,now,2);
  sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token) VALUES(?,?,?,?,?,'PENDING',0,?,?,NULL,NULL)`).run('sync_ordering_v2','PERSONAL_USE',id,2,'trace_ordering_v2',now,now);
  const DB=new SqliteD1(sqlite),queued=[];
  const env={DB,SHEETS_SYNC_ENABLED:'true',SHEET_PERSONAL_USE_RAW:'V52_PERSONAL_USE_RAW',JOB_QUEUE:{async send(body,options={}){queued.push({body,...options});},async sendBatch(messages){queued.push(...messages);}}};
  return{sqlite,DB,env,queued,id,close(){sqlite.close();}};
}

function job(id,version){return{kind:'SHEETS_SYNC',entityType:'PERSONAL_USE',entityKey:id,entityVersion:version,traceId:`trace_ordering_v${version}`};}
function cancelAtVersionThree(h,{enqueue=true}={}){
  h.sqlite.prepare(`UPDATE owner_personal_transactions SET status='CANCELLED',updated_at=?,version=3 WHERE personal_use_id=?`).run('2026-09-06T00:01:00.000Z',h.id);
  if(enqueue)h.sqlite.prepare(`INSERT OR IGNORE INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token) VALUES(?,?,?,?,?,'PENDING',0,?,?,NULL,NULL)`).run('sync_ordering_v3','PERSONAL_USE',h.id,3,'trace_ordering_v3','2026-09-06T00:01:00.000Z','2026-09-06T00:01:00.000Z');
}
function syncRows(h){return plain(h.sqlite.prepare(`SELECT entity_version,status,attempt_count FROM sync_jobs WHERE entity_type='PERSONAL_USE' AND entity_key=? ORDER BY entity_version`).all(h.id));}
async function withSheetWriter(write,run){const original=sheetsClient.batchWriteValues;sheetsClient.batchWriteValues=write;try{return await run();}finally{sheetsClient.batchWriteValues=original;}}

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

test('timeout after an applied Sheet write retries idempotently into the same mapped row',async()=>{
  const h=harness(),attemptedRanges=[],sheet={row:null};
  let attempts=0;
  try{
    await withSheetWriter(async(_env,data)=>{
      attempts+=1;
      attemptedRanges.push(data[0].range);
      sheet.row=[...data[0].values[0]];
      if(attempts===1)throw new Error('Google Sheets timed out after write');
    },async()=>{
      await assert.rejects(syncJob(h.env,job(h.id,2)),/timed out after write/);
      const failed=plain(h.sqlite.prepare(`SELECT status,attempt_count,next_attempt_at,lease_token FROM sync_jobs WHERE entity_type='PERSONAL_USE' AND entity_key=? AND entity_version=2`).get(h.id));
      assert.equal(failed.status,'FAILED');
      assert.equal(failed.attempt_count,1);
      assert.ok(failed.next_attempt_at);
      assert.equal(failed.lease_token,null);
      h.sqlite.prepare(`UPDATE sync_jobs SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE entity_type='PERSONAL_USE' AND entity_key=? AND entity_version=2`).run(h.id);
      assert.equal(await syncJob(h.env,job(h.id,2),2),'PROCESSED');
    });
    assert.equal(attempts,2);
    assert.equal(new Set(attemptedRanges).size,1);
    assert.equal(sheet.row[6],'CONFIRMED');
    assert.equal(sheet.row[14],2);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) count FROM sheet_row_index WHERE sheet_name='V52_PERSONAL_USE_RAW' AND entity_key=?`).get(h.id).count,1);
    assert.deepEqual(syncRows(h),[{entity_version:2,status:'COMPLETED',attempt_count:2}]);
  }finally{h.close();}
});

test('timeout retry from an older version cannot overwrite a newer committed projection',async()=>{
  const h=harness(),sheet={row:null,writes:[]};
  let first=true;
  try{
    await withSheetWriter(async(_env,data)=>{
      const values=data[0].values[0];
      sheet.row=[...values];sheet.writes.push(Number(values[14]));
      if(first){first=false;throw new Error('Google Sheets timed out after applied write');}
    },async()=>{
      await assert.rejects(syncJob(h.env,job(h.id,2)),/timed out after applied write/);
      cancelAtVersionThree(h);
      assert.equal(await syncJob(h.env,job(h.id,3)),'PROCESSED');
      h.sqlite.prepare(`UPDATE sync_jobs SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE entity_type='PERSONAL_USE' AND entity_key=? AND entity_version=2`).run(h.id);
      assert.equal(await syncJob(h.env,job(h.id,2),2),'IGNORED');
    });
    assert.deepEqual(sheet.writes,[2,3]);
    assert.equal(sheet.row[6],'CANCELLED');
    assert.equal(sheet.row[14],3);
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
      assert.equal(reconciled?.entityVersion,3);
      assert.equal(await syncJob(h.env,reconciled),'BUSY');
      releaseOlderWrite.resolve();
      assert.equal(await older,'PROCESSED');
      assert.equal(await syncJob(h.env,reconciled),'PROCESSED');
    });
    assert.deepEqual(sheet.writes,[2,3]);
    assert.equal(sheet.row[6],'CANCELLED');
    assert.equal(sheet.row[14],3);
  }finally{releaseOlderWrite.resolve();h.close();}
});

test('non-PERSONAL_USE versions retain independent claim behavior',async()=>{
  const h=harness();
  try{
    const older={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'expense_ordering_fixture',entityVersion:1,traceId:'trace_expense_v1'};
    const newer={...older,entityVersion:2,traceId:'trace_expense_v2'};
    assert.equal(typeof await claimSheetSyncJob(h.env,older),'string');
    assert.equal(typeof await claimSheetSyncJob(h.env,newer),'string');
    const rows=plain(h.sqlite.prepare(`SELECT entity_version,status FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=? ORDER BY entity_version`).all(older.entityKey));
    assert.deepEqual(rows,[{entity_version:1,status:'PROCESSING'},{entity_version:2,status:'PROCESSING'}]);
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
