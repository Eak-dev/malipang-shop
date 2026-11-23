import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {canarySourceSql,EXPENSE_COLUMNS} from '../scripts/issue248-canary-source-digest.mjs';
import {mkdtempSync,readdirSync,readFileSync,copyFileSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Miniflare} from 'miniflare';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const {openSerialRound,closeSerialRound,closeUnverifiedSerialRound,readSerialRound}=createRequire(import.meta.url)('../dist/admin/serial-round-store.js');
async function localD1BeforeMigration(lastMigration){
 const dir=mkdtempSync(join(tmpdir(),'serial-partial-d1-')),fixture=join(dir,'source.sqlite'),source=new DatabaseSync(':memory:');
 const migrations=new URL('../migrations/',import.meta.url);
 for(const name of readdirSync(migrations).filter(x=>x.endsWith('.sql')&&Number(x.slice(0,4))<=lastMigration).sort())source.exec(readFileSync(new URL(name,migrations),'utf8'));
 source.exec(`VACUUM INTO '${fixture.replaceAll("'","''")}'`);source.close();
 const options={modules:true,compatibilityDate:'2026-07-20',d1Databases:{DB:'test-db'},d1Persist:dir,script:'export default {async fetch(_r,e){await e.DB.prepare("SELECT 1").first();return new Response("ok")}}'};
 let mf=new Miniflare(options);await mf.dispatchFetch('http://local/');await mf.dispose();
 const folder=join(dir,'miniflare-D1DatabaseObject'),file=readdirSync(folder).find(x=>x.endsWith('.sqlite'));
 for(const ext of ['-wal','-shm'])rmSync(join(folder,file+ext),{force:true});
 copyFileSync(fixture,join(folder,file));mf=new Miniflare(options);
 return {db:await mf.getD1Database('DB'),async close(){await mf.dispose();rmSync(dir,{recursive:true,force:true});}};
}

for(const item of [
 {version:69,table:'sync_jobs',column:'serial_provenance_version',migration:'0069_serial_job_provenance_draft.sql'},
 {version:70,table:'expense_events',column:'serial_source_namespace',migration:'0070_serial_source_provenance_draft.sql'}
])test(`local D1 partial migration ${item.version} rolls back a failed batch and rejects naive rerun`,async()=>{
 const h=await localD1BeforeMigration(item.version-1),db=h.db;
 try{
  const sql=readFileSync(new URL('../migrations/'+item.migration,import.meta.url),'utf8');
  const alter=sql.match(new RegExp(`ALTER TABLE ${item.table} ADD COLUMN ${item.column}[^;]+;`))?.[0];assert.ok(alter);
  const column=()=>db.prepare(`SELECT count(*) n FROM pragma_table_info('${item.table}') WHERE name=?`).bind(item.column).first();
  assert.equal((await column()).n,0);
  await assert.rejects(db.batch([db.prepare(alter),db.prepare("SELECT json_extract('invalid','$')")]));
  assert.equal((await column()).n,0,'failed D1 batch rolls back schema change');
  await db.prepare(alter).run();assert.equal((await column()).n,1);
  await assert.rejects(db.prepare(alter).run(),/duplicate column/i);
  const marker=item.version===69?'serial_job_provenance_activation':'serial_source_provenance_activation';
  assert.equal((await db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name=?").bind(marker).first()).n,0);
  if(item.version===70){
   // Synthetic partial rollout: make 0069 readiness pass so rejection cannot
   // be attributed only to its still-closed activation barrier.
   await db.prepare('DROP TRIGGER serial_job_provenance_not_ready').run();
   await db.prepare('DROP TRIGGER serial_job_provenance_source_gate').run();
   await db.prepare("INSERT INTO serial_job_provenance_activation VALUES(1,'book','now')").run();
  }
  const {ensureSheetSyncOutbox}=createRequire(import.meta.url)('../dist/sheets/sync.js');
  const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'partial-source',entityVersion:1,traceId:'partial-test'};
  await assert.rejects(ensureSheetSyncOutbox({DB:db,SERIAL_JOB_PROVENANCE_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book'},job),item.version===70?/serial_source_provenance_activation|no such table/i:/serial_job_provenance_activation|no such table/i);
  assert.equal((await db.prepare("SELECT count(*) n FROM sync_jobs WHERE entity_key='partial-source'").first()).n,0,'partial schema does not create an outbox job');
 }finally{await h.close();}
});
async function localD1(){
 const h=expenseSqlite(),dir=mkdtempSync(join(tmpdir(),'serial-round-d1-')),fixture=join(dir,'source.sqlite');
 for(const job of ['a','b','c','d','e','f']){
  h.sqlite.prepare("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES(?,?,?,'synthetic',1,'cash','cash','other','2026-11-15','CONFIRMED','now',1)").run('exp_'+job,'msg_'+job,'synthetic');
  h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES(?,'EXPENSE',?,1,'synthetic','PENDING','now')").run(job,'exp_'+job);
 }
 h.sqlite.exec(`VACUUM INTO '${fixture.replaceAll("'","''")}'`);h.close();
 const config={modules:true,compatibilityDate:'2026-07-20',d1Databases:{DB:'test-db'},d1Persist:dir,script:'export default {async fetch(_request,env){await env.DB.prepare("SELECT 1").first();return new Response("ok")}}'};
 let mf=new Miniflare(config);await mf.dispatchFetch('http://local/');await mf.dispose();
 const folder=join(dir,'miniflare-D1DatabaseObject'),file=readdirSync(folder).find(x=>x.endsWith('.sqlite'));
 for(const ext of ['-wal','-shm'])rmSync(join(folder,file+ext),{force:true});
 copyFileSync(fixture,join(folder,file));mf=new Miniflare(config);
 return {db:await mf.getD1Database('DB'),async close(){await mf.dispose();rmSync(dir,{recursive:true,force:true});}};
}
test('local D1 fences both reservation/close orderings and rolls back failed batches',async()=>{
 const h=await localD1(),db=h.db,fp='a'.repeat(64);try{
  await db.prepare('DROP TRIGGER serial_pilot_fence_not_ready').run(); // synthetic local D1 only
  await db.prepare("INSERT INTO serial_pilot_round_fence_activation VALUES(1,'now')").run();
  const open=(r,book,jobs)=>openSerialRound(db,r,null,'created',jobs,{spreadsheetId:book,fingerprint:fp});
  const audit=(id,action,job,book,round,predecessor)=>db.prepare('INSERT INTO admin_audit VALUES(?,?,?,?,?,?,?)').bind(id,action,job,fp,JSON.stringify({book,...(predecessor?{predecessorJobId:predecessor,proof:'f'.repeat(64)}:{})}),JSON.stringify({roundId:round,epoch:'normal_pilot296_'+id,version:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}),'now');
  assert.equal(await open('r1','book1',['a','b']),true);
  await assert.rejects(db.batch([audit('rollback','ISSUE296_PAUSED_NOTICE_HANDOVER','a','book1','r1'),db.prepare("SELECT json_extract('invalid','$')")]));
  assert.equal((await db.prepare("SELECT count(*) AS n FROM admin_audit WHERE id='rollback'").first()).n,0);
  await audit('root1','ISSUE296_PAUSED_NOTICE_HANDOVER','a','book1','r1').run();
  const stale=[{jobId:'a',category:'RECONCILE',evidence:'UNVERIFIED',successorJobId:null},{jobId:'b',category:'RECONCILE',evidence:'UNVERIFIED',successorJobId:null}];
  await audit('issue296:serial:a','ISSUE296_SERIAL_EXPENSE_HANDOVER','b','book1','r1','a').run();
  assert.equal(await closeSerialRound(db,'r1','closed','HELD',stale),false);
  assert.equal(await closeUnverifiedSerialRound(db,'r1','closed'),true);
  assert.deepEqual((await readSerialRound(db,'r1')).results.map(x=>[x.job_id,x.successor_job_id]),[['a','b'],['b',null]]);
  assert.equal(await open('r2','book2',['c','d']),true);
  await audit('root2','ISSUE296_PAUSED_NOTICE_HANDOVER','c','book2','r2').run();
  assert.equal(await closeUnverifiedSerialRound(db,'r2','closed'),true);
  await assert.rejects(audit('issue296:serial:c','ISSUE296_SERIAL_EXPENSE_HANDOVER','d','book2','r2','c').run());
  assert.equal(await open('r3','book3',['e','f']),true);
  await audit('root3','ISSUE296_PAUSED_NOTICE_HANDOVER','e','book3','r3').run();
  const [reservation,close]=await Promise.allSettled([
   audit('issue296:serial:e','ISSUE296_SERIAL_EXPENSE_HANDOVER','f','book3','r3','e').run(),
   closeUnverifiedSerialRound(db,'r3','closed')
  ]);
  assert.equal(close.status,'fulfilled');
  if(!close.value)assert.equal(await closeUnverifiedSerialRound(db,'r3','closed-again'),true);
  const saved=(await readSerialRound(db,'r3')).results.find(x=>x.job_id==='e');
  assert.equal(saved.successor_job_id,reservation.status==='fulfilled'?'f':null);
  // Local D1 only. This does not prove provider quiescence or authorize park.
  await db.prepare("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('foreign','foreign-msg','synthetic','synthetic',1,'cash','cash','other','2026-11-15','CONFIRMED','now',1)").run();
  await db.prepare('DROP TRIGGER continuous_daily_cutover_prepared').run();
  await db.prepare("INSERT INTO continuous_daily_cutovers VALUES('book',1,'legacy',2,'daily',3,'raw',4,'detail','claim',0,'ACTIVE','now','now')").run();
  await db.prepare("INSERT INTO continuous_daily_cutovers VALUES('book2',11,'legacy2',12,'daily2',13,'raw2',14,'detail2','claim2',0,'ACTIVE','now','now')").run();
  await db.prepare("INSERT INTO continuous_daily_post_cutover_expenses VALUES('book2','foreign')").run();
  for(const key of ['prototype-expense','batch-expense','exp_g'])await db.prepare("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES(?,?,?,'synthetic',1,'cash','cash','other','2026-11-15','CONFIRMED','now',1)").bind(key,'msg-'+key,'synthetic').run();
  // Source-namespace draft remains independently fenced; this fixture removes
  // its barrier only in local D1 and checks the guard, not provider safety.
  await db.prepare('DROP TRIGGER serial_source_provenance_not_ready').run();
  const namespace='a'.repeat(32),sourceId=`exp_${namespace}_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
  await db.prepare("INSERT INTO serial_source_provenance_activation VALUES(1,'book',?,'now')").bind(namespace).run();
  await assert.rejects(db.prepare("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES(?,?,'synthetic','synthetic',1,'cash','cash','other','2026-11-15','WAITING_CONFIRM','now',1)").bind(sourceId,'untagged-source').run());
  const source=await db.prepare("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version,serial_source_namespace) VALUES(?,?,'synthetic','synthetic',1,'cash','cash','other','2026-11-15','WAITING_CONFIRM','now',1,?)").bind(sourceId,'tagged-source',namespace).run();
  assert.equal(source.success,true);
  await assert.rejects(db.prepare('DELETE FROM expense_events WHERE expense_id=?').bind(sourceId).run());
  await db.prepare('DROP TRIGGER serial_job_provenance_not_ready').run();
  await db.prepare("INSERT INTO serial_job_provenance_activation VALUES(1,'book','now')").run();
  await db.prepare("UPDATE expense_events SET status='CONFIRMED' WHERE expense_id=?").bind(sourceId).run();
  const {claimSheetSyncJob}=createRequire(import.meta.url)('../dist/sheets/sync.js');
  const workerEnv={DB:db,GOOGLE_SPREADSHEET_ID:'book',SERIAL_JOB_PROVENANCE_ENABLED:'true'};
  await db.prepare("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('confirm-job','confirm-msg','synthetic','synthetic',1,'cash','cash','other','2026-11-15','WAITING_CONFIRM','now',1)").run();
  const {confirmExpenseAtomically}=createRequire(import.meta.url)('../dist/expense/confirm.js');
  const confirmInput={expenseId:'confirm-job',lineUserId:'synthetic',traceId:'synthetic',actorEmployeeId:null,branchId:null,snapshot:{description:'synthetic',amountSatang:1,paymentKey:'cash',sourceWallet:'cash',category:'other',transactionDate:'2026-11-15',version:1}};
  const confirmEnv={...workerEnv,SHEETS_SYNC_ENABLED:'true'};
  const confirmations=await Promise.all([confirmExpenseAtomically(confirmEnv,confirmInput),confirmExpenseAtomically(confirmEnv,confirmInput)]);
  assert.equal(confirmations.filter(x=>x===1).length,1,JSON.stringify({confirmations,source:await db.prepare("SELECT status,version FROM expense_events WHERE expense_id='confirm-job'").first(),jobs:(await db.prepare("SELECT status,serial_provenance_version FROM sync_jobs WHERE entity_key='confirm-job'").all()).results}));
  assert.equal((await db.prepare("SELECT serial_provenance_version FROM sync_jobs WHERE entity_key='confirm-job'").first()).serial_provenance_version,0);
  await db.prepare("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('confirm-off','confirm-off-msg','synthetic','synthetic',1,'cash','cash','other','2026-11-15','WAITING_CONFIRM','now',1)").run();
  assert.equal(await confirmExpenseAtomically({...confirmEnv,SERIAL_JOB_PROVENANCE_ENABLED:'false'},{...confirmInput,expenseId:'confirm-off'}),1);
  assert.equal((await db.prepare("SELECT serial_provenance_version FROM sync_jobs WHERE entity_key='confirm-off'").first()).serial_provenance_version,0);
  const workerJob={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'prototype-expense',entityVersion:1,traceId:'synthetic'};
  assert.ok(await claimSheetSyncJob(workerEnv,workerJob));
  const workerRow=await db.prepare("SELECT status,serial_provenance_version,serial_lease_generation FROM sync_jobs WHERE entity_key='prototype-expense'").first();
  assert.deepEqual(workerRow,{status:'PROCESSING',serial_provenance_version:0,serial_lease_generation:0});
  const outside={...workerJob,entityKey:'outside-cohort'};assert.ok(await claimSheetSyncJob(workerEnv,outside));
  assert.deepEqual(await db.prepare("SELECT serial_provenance_version,serial_lease_generation FROM sync_jobs WHERE entity_key='outside-cohort'").first(),{serial_provenance_version:0,serial_lease_generation:0});
  await db.prepare("DELETE FROM sync_jobs WHERE entity_key='outside-cohort'").run();
  const foreign={...workerJob,entityKey:'foreign'};assert.ok(await claimSheetSyncJob(workerEnv,foreign));
  assert.equal((await db.prepare("SELECT serial_provenance_version FROM sync_jobs WHERE entity_key='foreign'").first()).serial_provenance_version,0);
  await assert.rejects(claimSheetSyncJob({...workerEnv,GOOGLE_SPREADSHEET_ID:'book2'},{...workerJob,entityKey:'wrong-book'}),/SERIAL_JOB_PROVENANCE_NOT_READY/);
  const {enqueueSheetSyncBatch}=createRequire(import.meta.url)('../dist/db/repositories.js'),sent=[];
  const producerEnv={...workerEnv,SHEETS_SYNC_ENABLED:'true',JOB_QUEUE:{sendBatch:async messages=>sent.push(...messages)}};
  const batchJob={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'batch-expense',entityVersion:1,traceId:'synthetic'};
  assert.equal(await enqueueSheetSyncBatch(producerEnv,[batchJob]),1);
  assert.equal(await enqueueSheetSyncBatch(producerEnv,[batchJob]),1);
  assert.equal((await db.prepare("SELECT serial_provenance_version FROM sync_jobs WHERE entity_key='batch-expense'").first()).serial_provenance_version,0);
  assert.equal(sent.length,2);await assert.rejects(enqueueSheetSyncBatch(producerEnv,[batchJob],true),/SERIAL_JOB_PROVENANCE_FORCE_UNSUPPORTED/);
  const mixedExpense={...batchJob,entityKey:'mixed-expense'},mixedPayroll={...batchJob,entityType:'DAILY_PAYROLL',entityKey:'mixed-payroll'};
  await assert.rejects(enqueueSheetSyncBatch(producerEnv,[mixedExpense,mixedPayroll]),/SERIAL_JOB_PROVENANCE_MIXED_BATCH_UNSUPPORTED/);
  await assert.rejects(enqueueSheetSyncBatch(producerEnv,[mixedExpense,mixedPayroll],true),/SERIAL_JOB_PROVENANCE_MIXED_BATCH_UNSUPPORTED/);
  assert.equal((await db.prepare("SELECT count(*) n FROM sync_jobs WHERE entity_key IN ('mixed-expense','mixed-payroll')").first()).n,0);
  assert.equal(sent.length,2);
  const born=await db.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,serial_provenance_version) VALUES('g','EXPENSE',?,1,'synthetic','PENDING','now',1)").bind(sourceId).run();
  assert.equal(born.meta.changes,1);
  await assert.rejects(db.prepare("UPDATE sync_jobs SET status='PROCESSING',lease_token='old-worker' WHERE job_id='g'").run());
  const lease=token=>db.prepare("UPDATE sync_jobs SET status='PROCESSING',lease_token=?,serial_lease_generation=serial_lease_generation+1 WHERE job_id='g' AND status='PENDING' RETURNING job_id").bind(token).all();
  const claims=await Promise.all([lease('one'),lease('two')]);
  assert.equal(claims.reduce((n,x)=>n+x.results.length,0),1);
  assert.equal(claims.find(x=>x.results.length===1).meta.changes,1);
  assert.equal((await db.prepare("SELECT serial_lease_generation n FROM sync_jobs WHERE job_id='g'").first()).n,1);
  await db.prepare("UPDATE sync_jobs SET status='PENDING',attempt_count=0,lease_token=NULL WHERE job_id='g'").run();
  await assert.rejects(db.batch([db.prepare("UPDATE sync_jobs SET status='PROCESSING',lease_token='rollback',serial_lease_generation=serial_lease_generation+1 WHERE job_id='g'"),db.prepare("SELECT json_extract('invalid','$')")]));
  assert.equal((await db.prepare("SELECT serial_lease_generation n FROM sync_jobs WHERE job_id='g'").first()).n,1);
  assert.equal((await db.prepare("SELECT status FROM sync_jobs WHERE job_id='g'").first()).status,'PENDING');
  const {handleExpenseText}=createRequire(import.meta.url)('../dist/expense/service.js');
  const sourceEnv={...producerEnv,SERIAL_SOURCE_PROVENANCE_ENABLED:'true',RUNTIME_MODE:'shadow',SHADOW_LINE_OUTPUT:'false'};
  const textEvent={source:{type:'user',userId:'synthetic'},message:{id:'namespace-text',type:'text',text:'ค่าไฟ transfer 1200'}};
  assert.equal(await handleExpenseText(sourceEnv,textEvent,'synthetic'),'WAITING_CONFIRM');
  assert.equal(await handleExpenseText(sourceEnv,textEvent,'synthetic'),'WAITING_CONFIRM');
  const draft=await db.prepare("SELECT expense_id,description,amount_satang,transaction_date,payment_key,source_wallet,category,version,serial_source_namespace FROM expense_events WHERE message_id='namespace-text'").first();
  assert.equal(draft.serial_source_namespace,namespace);assert.equal(draft.expense_id.length,73);
  const draftInput={expenseId:draft.expense_id,lineUserId:'synthetic',traceId:'synthetic',actorEmployeeId:null,branchId:null,snapshot:{description:draft.description,amountSatang:draft.amount_satang,transactionDate:draft.transaction_date,paymentKey:draft.payment_key,sourceWallet:draft.source_wallet,category:draft.category,version:draft.version}};
  assert.equal(await confirmExpenseAtomically(sourceEnv,draftInput),1);
  assert.equal((await db.prepare("SELECT serial_provenance_version FROM sync_jobs WHERE entity_key=?").bind(draft.expense_id).first()).serial_provenance_version,1);
  assert.equal(await enqueueSheetSyncBatch(sourceEnv,[{kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:draft.expense_id,entityVersion:1,traceId:'synthetic'}]),1);
  const {undoConfirmedExpense}=createRequire(import.meta.url)('../dist/expense/undo.js');
  assert.equal(await undoConfirmedExpense(sourceEnv,draftInput),2);
  assert.equal((await db.prepare("SELECT serial_provenance_version FROM sync_jobs WHERE entity_key=? AND entity_version=2").bind(draft.expense_id).first()).serial_provenance_version,0);
  // A direct outbox statement may run inside a source-confirmation batch.
  // Even an existing duplicate must abort that batch if readiness drifts.
  const {sheetSyncOutboxStatement}=createRequire(import.meta.url)('../dist/sheets/sync.js');
  const before=(await db.prepare("SELECT description FROM expense_events WHERE expense_id='exp_a'").first()).description;
  await db.prepare("CREATE TRIGGER serial_job_provenance_not_ready BEFORE INSERT ON serial_job_provenance_activation BEGIN SELECT RAISE(ABORT,'not ready'); END").run();
  await assert.rejects(db.batch([db.prepare("UPDATE expense_events SET description='must-rollback' WHERE expense_id='exp_a'"),sheetSyncOutboxStatement(workerEnv,workerJob,new Date().toISOString())]));
  assert.equal((await db.prepare("SELECT description FROM expense_events WHERE expense_id='exp_a'").first()).description,before);
  await db.prepare('DROP TRIGGER serial_job_provenance_not_ready').run();
  await db.prepare('DROP TRIGGER serial_job_provenance_update_guard').run();
  await assert.rejects(db.batch([db.prepare("UPDATE expense_events SET description='must-rollback' WHERE expense_id='exp_a'"),sheetSyncOutboxStatement(workerEnv,workerJob,new Date().toISOString())]));
  assert.equal((await db.prepare("SELECT description FROM expense_events WHERE expense_id='exp_a'").first()).description,before);
 }finally{await h.close();}
});

test('local D1 canary schema check preserves the legacy digest after 0070',async()=>{
 const h=await localD1();try{
  const row=await h.db.prepare(`SELECT ${EXPENSE_COLUMNS.join(',')} FROM expense_events WHERE expense_id='exp_a'`).first();
  const expected=createHash('sha256').update(JSON.stringify({expense:row,links:[],documents:[],items:[]})).digest('hex');
  assert.equal((await h.db.prepare(canarySourceSql('exp_a',1)).first()).digest,expected);
  await h.db.prepare('ALTER TABLE expense_events ADD COLUMN synthetic_unknown TEXT').run();
  assert.equal(await h.db.prepare(canarySourceSql('exp_a',1)).first(),null);
 }finally{await h.close();}
});
