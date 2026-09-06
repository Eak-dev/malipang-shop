import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handlePersonalUsePostback} from '../dist/personal-use/service.js';

const owner={employeeId:'OWN001',role:'OWNER',scope:'ORGANIZATION',branchId:'B001',employeeStatus:'ACTIVE',roleStatus:'ACTIVE',employee:{canSubmitExpense:true}};
const migration=name=>readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));

class ReadBarrier{
  constructor(count){this.remaining=count;this.promise=new Promise(resolve=>{this.resolve=resolve;});}
  async wait(){if(this.remaining<=0)return;this.remaining-=1;if(this.remaining===0)this.resolve();await this.promise;}
}

class SqliteD1Statement{
  constructor(owner,sql){this.owner=owner;this.sql=sql;this.args=[];}
  bind(...args){this.args=args;return this;}
  async first(){
    const row=this.owner.sqlite.prepare(this.sql).get(...this.args)??null;
    if(this.owner.readBarrier&&this.sql.includes('FROM owner_personal_transactions WHERE personal_use_id=? AND line_user_id=?'))await this.owner.readBarrier.wait();
    return row;
  }
  async all(){return{results:this.owner.sqlite.prepare(this.sql).all(...this.args),meta:{changes:0}};}
  runSync(){const result=this.owner.sqlite.prepare(this.sql).run(...this.args);return{meta:{changes:Number(result.changes)}};}
  async run(){return this.runSync();}
}

class SqliteD1{
  constructor(sqlite){this.sqlite=sqlite;this.tail=Promise.resolve();this.readBarrier=null;}
  prepare(sql){return new SqliteD1Statement(this,sql);}
  setReadBarrier(count){this.readBarrier=new ReadBarrier(count);}
  batch(statements){
    const execute=()=>{
      this.sqlite.exec('BEGIN IMMEDIATE');
      try{const results=statements.map(statement=>statement.runSync());this.sqlite.exec('COMMIT');return results;}
      catch(error){this.sqlite.exec('ROLLBACK');throw error;}
    };
    const result=this.tail.then(execute,execute);
    this.tail=result.catch(()=>{});
    return result;
  }
}

class QueueHarness{
  constructor(){this.batchMessages=[];this.directMessages=[];this.beforeSendBatch=null;}
  async sendBatch(messages){if(this.beforeSendBatch)await this.beforeSendBatch(messages);this.batchMessages.push(...messages);}
  async send(message){this.directMessages.push(message);}
}

function harness({lineOutput=false}={}){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(migration('0001_initial.sql'));
  sqlite.exec(migration('0002_rc2_reliability.sql'));
  sqlite.exec(migration('0006_sync_job_lease.sql'));
  sqlite.exec(migration('0018_owner_personal_use.sql'));
  const DB=new SqliteD1(sqlite),queue=new QueueHarness();
  const env={DB,JOB_QUEUE:queue,SHEETS_SYNC_ENABLED:'true',RUNTIME_MODE:lineOutput?'production':'shadow',SHADOW_LINE_OUTPUT:'false',LINE_CHANNEL_ACCESS_TOKEN:'test-only'};
  return{sqlite,DB,queue,env,close(){sqlite.close();}};
}

function seedPersonal(sqlite,{id='personal_test',status='WAITING_CONFIRM',version=1}={}){
  sqlite.prepare(`INSERT INTO owner_personal_transactions(personal_use_id,message_id,line_user_id,transaction_type,description,amount_satang,source_wallet,transaction_date,status,trace_id,submitted_by_employee_id,branch_id,reviewed_by_employee_id,approved_at,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,`message_${id}`,'line_owner','PERSONAL_USE','sanitized integration fixture',100,'SHOP_BANK','2026-09-06',status,`trace_${id}`,'OWN001','B001',status==='WAITING_CONFIRM'?null:'OWN001',status==='WAITING_CONFIRM'?null:'2026-09-06T00:01:00Z','2026-09-06T00:00:00Z','2026-09-06T00:00:00Z',version);
  const actions=status==='WAITING_CONFIRM'?['CREATE_DRAFT']:['CREATE_DRAFT','CONFIRM'];
  for(const [index,action] of actions.entries())sqlite.prepare(`INSERT INTO owner_personal_transaction_audit(audit_id,personal_use_id,actor_employee_id,action,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)`).run(`audit_seed_${id}_${index}`,id,'OWN001',action,'{}','{}',`2026-09-06T00:00:0${index}Z`);
  if(status==='CONFIRMED')sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token) VALUES(?,?,?,?,?,'PENDING',0,?,?,NULL,NULL)`).run(`sync_seed_${id}`,'PERSONAL_USE',id,version,`trace_${id}`,'2026-09-06T00:01:00Z','2026-09-06T00:01:00Z');
  return id;
}

function postback(id,action,replyToken){return{webhookEventId:`webhook_${action}_${replyToken||'none'}`,replyToken,source:{type:'user',userId:'line_owner'},postback:{data:`a=${action}&id=${id}`}};}
function row(sqlite,id){return plain(sqlite.prepare(`SELECT status,version FROM owner_personal_transactions WHERE personal_use_id=?`).get(id));}
function actions(sqlite,id){return plain(sqlite.prepare(`SELECT action FROM owner_personal_transaction_audit WHERE personal_use_id=? ORDER BY created_at,action`).all(id)).map(item=>item.action);}
function outbox(sqlite,id){return plain(sqlite.prepare(`SELECT entity_version,status FROM sync_jobs WHERE entity_type='PERSONAL_USE' AND entity_key=? ORDER BY entity_version`).all(id));}
function sheetJobs(queue){return queue.batchMessages.map(message=>message.body).filter(job=>job.kind==='SHEETS_SYNC'&&job.entityType==='PERSONAL_USE');}

test('SQLite integration: exactly one confirm/cancel CAS transition wins from WAITING_CONFIRM',async()=>{
  for(const competing of [
    ['personal_use_confirm','personal_use_cancel'],
    ['personal_use_cancel','personal_use_confirm']
  ]){
    const h=harness();
    try{
      const id=seedPersonal(h.sqlite,{id:`race_${competing[0]}`});h.DB.setReadBarrier(2);
      await Promise.all(competing.map(action=>handlePersonalUsePostback(h.env,postback(id,action),owner)));
      const current=row(h.sqlite,id),transitionActions=actions(h.sqlite,id).filter(action=>action!=='CREATE_DRAFT');
      assert.equal(current.version,2);
      assert.equal(transitionActions.length,1);
      assert.equal(transitionActions[0],current.status==='CONFIRMED'?'CONFIRM':'CANCEL');
      assert.deepEqual(outbox(h.sqlite,id),current.status==='CONFIRMED'?[{entity_version:2,status:'PENDING'}]:[]);
      assert.equal(sheetJobs(h.queue).length,current.status==='CONFIRMED'?1:0);
    }finally{h.close();}
  }
});

test('SQLite integration: duplicate confirm and stale Flex actions are idempotent',async()=>{
  const h=harness();
  try{
    const id=seedPersonal(h.sqlite,{id:'duplicate_confirm'});h.DB.setReadBarrier(2);
    await Promise.all([
      handlePersonalUsePostback(h.env,postback(id,'personal_use_confirm'),owner),
      handlePersonalUsePostback(h.env,postback(id,'personal_use_confirm'),owner)
    ]);
    await handlePersonalUsePostback(h.env,postback(id,'personal_use_cancel'),owner);
    await handlePersonalUsePostback(h.env,postback(id,'personal_use_confirm'),owner);
    assert.deepEqual(row(h.sqlite,id),{status:'CONFIRMED',version:2});
    assert.deepEqual(actions(h.sqlite,id),['CREATE_DRAFT','CONFIRM']);
    assert.deepEqual(outbox(h.sqlite,id),[{entity_version:2,status:'PENDING'}]);
    assert.deepEqual(sheetJobs(h.queue).map(job=>job.entityVersion),[2]);
  }finally{h.close();}
});

test('SQLite integration: confirm/undo interleaving uses committed state and truthful versions',async()=>{
  const h=harness({lineOutput:true}),originalFetch=globalThis.fetch,replies=[];
  let releaseVersionTwo,versionTwoReached;
  const versionTwoBlocked=new Promise(resolve=>{versionTwoReached=resolve;});
  const release=new Promise(resolve=>{releaseVersionTwo=resolve;});
  h.queue.beforeSendBatch=async messages=>{
    if(messages.some(message=>message.body?.kind==='SHEETS_SYNC'&&message.body.entityVersion===2)){versionTwoReached();await release;}
  };
  globalThis.fetch=async(_url,init)=>{replies.push(JSON.parse(String(init?.body||'{}')));return new Response(null,{status:200});};
  try{
    const id=seedPersonal(h.sqlite,{id:'confirm_undo_interleave'});
    const confirm=handlePersonalUsePostback(h.env,postback(id,'personal_use_confirm','reply_confirm'),owner);
    await versionTwoBlocked;
    await handlePersonalUsePostback(h.env,postback(id,'personal_use_undo','reply_undo'),owner);
    releaseVersionTwo();await confirm;
    assert.deepEqual(row(h.sqlite,id),{status:'CANCELLED',version:3});
    assert.deepEqual(actions(h.sqlite,id),['CREATE_DRAFT','CONFIRM','UNDO']);
    assert.deepEqual(outbox(h.sqlite,id),[{entity_version:2,status:'PENDING'},{entity_version:3,status:'PENDING'}]);
    assert.deepEqual(sheetJobs(h.queue).map(job=>job.entityVersion),[3,2]);
    assert.equal(replies.length,2);
    for(const reply of replies)assert.equal(reply.messages[0].text,'รายการถอนใช้ส่วนตัวนี้ถูกยกเลิกแล้ว');
  }finally{globalThis.fetch=originalFetch;releaseVersionTwo?.();h.close();}
});

test('SQLite integration: retry after LINE response failure does not repeat business effects',async()=>{
  const h=harness({lineOutput:true}),originalFetch=globalThis.fetch;
  let replies=0;
  globalThis.fetch=async()=>{replies+=1;return replies===1?new Response('temporary',{status:500}):new Response(null,{status:200});};
  try{
    const id=seedPersonal(h.sqlite,{id:'response_retry'});
    await handlePersonalUsePostback(h.env,postback(id,'personal_use_confirm','reply_fails'),owner);
    await handlePersonalUsePostback(h.env,postback(id,'personal_use_confirm','reply_retry'),owner);
    assert.deepEqual(row(h.sqlite,id),{status:'CONFIRMED',version:2});
    assert.deepEqual(actions(h.sqlite,id),['CREATE_DRAFT','CONFIRM']);
    assert.deepEqual(outbox(h.sqlite,id),[{entity_version:2,status:'PENDING'}]);
    assert.deepEqual(sheetJobs(h.queue).map(job=>job.entityVersion),[2]);
    assert.equal(h.queue.directMessages.filter(job=>job.kind==='LINE_NOTIFICATION').length,1);
  }finally{globalThis.fetch=originalFetch;h.close();}
});

test('SQLite integration: audit, row version and outbox roll back together on batch failure',async()=>{
  const h=harness();
  try{
    const id=seedPersonal(h.sqlite,{id:'atomic_failure'});
    h.sqlite.exec(`CREATE TRIGGER reject_personal_sync BEFORE INSERT ON sync_jobs WHEN NEW.entity_type='PERSONAL_USE' BEGIN SELECT RAISE(ABORT,'forced integration failure'); END;`);
    await assert.rejects(handlePersonalUsePostback(h.env,postback(id,'personal_use_confirm'),owner),/forced integration failure/);
    assert.deepEqual(row(h.sqlite,id),{status:'WAITING_CONFIRM',version:1});
    assert.deepEqual(actions(h.sqlite,id),['CREATE_DRAFT']);
    assert.deepEqual(outbox(h.sqlite,id),[]);
    assert.equal(sheetJobs(h.queue).length,0);
  }finally{h.close();}
});

test('SQLite integration: pre-fix CONFIRMED version remains safely undoable without rewrite',async()=>{
  const h=harness();
  try{
    const id=seedPersonal(h.sqlite,{id:'legacy_confirmed',status:'CONFIRMED',version:1});
    await handlePersonalUsePostback(h.env,postback(id,'personal_use_undo'),owner);
    await handlePersonalUsePostback(h.env,postback(id,'personal_use_undo'),owner);
    assert.deepEqual(row(h.sqlite,id),{status:'CANCELLED',version:2});
    assert.deepEqual(actions(h.sqlite,id),['CREATE_DRAFT','CONFIRM','UNDO']);
    assert.deepEqual(outbox(h.sqlite,id),[{entity_version:1,status:'PENDING'},{entity_version:2,status:'PENDING'}]);
    assert.deepEqual(sheetJobs(h.queue).map(job=>job.entityVersion),[2]);
  }finally{h.close();}
});
