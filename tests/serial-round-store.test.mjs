import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url);
const {openSerialRound,closeSerialRound,closeUnverifiedSerialRound,findOpenSerialRounds,readSerialRound,serialSelectionGuard}=require('../dist/admin/serial-round-store.js');
function setup(){
 const h=expenseSqlite(),prepare=h.DB.prepare;
 h.DB.prepare=function(sql){const s=prepare.call(this,sql),all=s.all;s.all=async()=>({...await all.call(s),success:true});return s;};
 return h;
}
test('opening is atomic and a lost response is reconciled against the exact snapshot',async()=>{
 const h=setup();try{
  assert.equal(await openSerialRound(h.DB,'drift',null,'created',['a'],undefined,()=>false),false);
  assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM serial_pilot_rounds').get().n,0);
  assert.equal(await openSerialRound(h.DB,'drift',null,'created',['a'],undefined,()=>true,[serialSelectionGuard(h.DB,'book',['a'])]),false);
  assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM serial_pilot_rounds').get().n,0);
  h.DB.failAt=1;
  assert.equal(await openSerialRound(h.DB,'r',null,'created',['a','b']),false);
  assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM serial_pilot_rounds').get().n,0);
  h.DB.failAt=null;h.DB.failAfterCommit=true;
  assert.equal(await openSerialRound(h.DB,'r',null,'created',['a','b']),true);
  h.DB.failAfterCommit=false;
  assert.equal(await openSerialRound(h.DB,'r',null,'created',['a','b']),true);
  assert.equal(await openSerialRound(h.DB,'r',null,'created',['b','a']),false);
 }finally{h.close();}
});
test('close is atomic, repeatable, and preserves the first exact result',async()=>{
 const h=setup();try{
  assert.equal(await openSerialRound(h.DB,'r',null,'created',['a','b']),true);
  assert.deepEqual(await findOpenSerialRounds(h.DB),[{roundId:'r',createdAt:'created',selectedCount:2}]);
  assert.deepEqual((await readSerialRound(h.DB,'r')).items.map(i=>i.job_id),['a','b']);
  const result=[{jobId:'a',category:'RECONCILE',evidence:'UNRESOLVED',successorJobId:null},{jobId:'b',category:'NOT_STARTED',evidence:'NOT_ADMITTED',successorJobId:null}];
  h.DB.failAt=1;assert.equal(await closeSerialRound(h.DB,'r','closed','HELD',result),false);
  assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM serial_pilot_round_results').get().n,0);
  h.DB.failAt=null;h.DB.failAfterCommit=true;assert.equal(await closeSerialRound(h.DB,'r','closed','HELD',result),true);
  h.DB.failAfterCommit=false;assert.equal(await closeSerialRound(h.DB,'r','closed','HELD',result),true);
  assert.equal(await closeSerialRound(h.DB,'r','closed','OTHER',result),false);
  assert.equal(await closeSerialRound(h.DB,'r','closed','HELD',[{...result[0],category:'VERIFIED'},result[1]]),false);
 }finally{h.close();}
});
test('concurrent proposals cannot change a sealed snapshot or terminal result',async()=>{
 const h=setup();try{
  const opens=await Promise.all([openSerialRound(h.DB,'r',null,'created',['a']),openSerialRound(h.DB,'r',null,'created',['b'])]);
  assert.deepEqual(opens.sort(),[false,true]);
  const item=(await readSerialRound(h.DB,'r')).items[0].job_id;
  const one=[{jobId:item,category:'RECONCILE',evidence:'UNKNOWN',successorJobId:null}];
  const two=[{jobId:item,category:'NOT_STARTED',evidence:'UNSTARTED',successorJobId:null}];
  const closes=await Promise.all([closeSerialRound(h.DB,'r','when','HELD',one),closeSerialRound(h.DB,'r','when','HELD',two)]);
  assert.deepEqual(closes.sort(),[false,true]);
 }finally{h.close();}
});
test('the local item limit is checked before any write',async()=>{
 const h=setup();try{
  assert.equal(await openSerialRound(h.DB,'r',null,'created',Array.from({length:101},(_,n)=>`j${n}`)),false);
  assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM serial_pilot_rounds').get().n,0);
  assert.equal(await openSerialRound(h.DB,'r',null,'created',Array.from({length:100},(_,n)=>`j${n}`)),true);
 }finally{h.close();}
});
test('read failure after commit does not authorize a second snapshot and is discoverable after service returns',async()=>{
 const h=setup(),prepare=h.DB.prepare;let failRead=true;
 try{
  h.DB.prepare=function(sql){const stmt=prepare.call(this,sql);if(failRead&&sql.startsWith('SELECT * FROM serial_pilot_rounds'))stmt.all=async()=>{throw Error('synthetic read outage');};return stmt;};
  await assert.rejects(openSerialRound(h.DB,'r',null,'created',['a']),/synthetic read outage/);
  failRead=false;
  assert.deepEqual(await findOpenSerialRounds(h.DB),[{roundId:'r',createdAt:'created',selectedCount:1}]);
  assert.deepEqual((await readSerialRound(h.DB,'r')).items.map(x=>x.job_id),['a']);
  assert.equal(await openSerialRound(h.DB,'r',null,'created',['b']),false);
 }finally{h.close();}
});
test('opt-in fence rejects legacy and out-of-round reservations and closes the audit gate',async()=>{
 const h=setup(),db=h.DB,d=h.sqlite,fp='a'.repeat(64),binding={spreadsheetId:'book',fingerprint:fp};try{
  for(const job of ['a','b']){
   d.prepare("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES(?,?,?,'synthetic',1,'cash','cash','other','2026-11-15','CONFIRMED','now',1)").run('exp_'+job,'msg_'+job,'synthetic');
   d.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES(?,'EXPENSE',?,1,'synthetic','PENDING','now')").run(job,'exp_'+job);
  }
  const insert=(id,action,job,before,after)=>d.prepare('INSERT INTO admin_audit VALUES(?,?,?,?,?,?,?)').run(id,action,job,fp,JSON.stringify(before),JSON.stringify({...after,epoch:'normal_pilot296_'+id,version:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}),'now');
  // Before activation the existing legacy path remains unchanged.
  insert('legacy','ISSUE296_PAUSED_NOTICE_HANDOVER','old',{book:'legacy-book'},{});
  assert.throws(()=>d.exec("INSERT INTO serial_pilot_round_fence_activation VALUES(1,'now')"));
  d.exec("DROP TRIGGER serial_pilot_fence_not_ready; INSERT INTO serial_pilot_round_fence_activation VALUES(1,'now')"); // synthetic fixture only
  assert.throws(()=>insert('legacy-new','ISSUE296_PAUSED_NOTICE_HANDOVER','a',{book:'book'},{}));
  assert.equal(await openSerialRound(db,'r',null,'created',['a','b'],binding),true);
  assert.equal(await openSerialRound(db,'other',null,'created',['c'],binding),false);
  assert.throws(()=>insert('wrong','ISSUE296_PAUSED_NOTICE_HANDOVER','b',{book:'book'},{roundId:'r'}));
  const rollbackAudit=db.prepare('INSERT INTO admin_audit VALUES(?,?,?,?,?,?,?)').bind('rollback','ISSUE296_PAUSED_NOTICE_HANDOVER','a',fp,JSON.stringify({book:'book'}),JSON.stringify({roundId:'r',epoch:'normal_pilot296_rollback',version:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}),'now');
  await assert.rejects(db.batch([rollbackAudit,db.prepare("SELECT json_extract('invalid','$')")]));
  assert.equal(d.prepare("SELECT count(*) AS n FROM serial_pilot_reservation_snapshots WHERE audit_id='rollback'").get().n,0);
  assert.throws(()=>d.prepare('INSERT INTO admin_audit VALUES(?,?,?,?,?,?,?)').run('invalid-version','ISSUE296_PAUSED_NOTICE_HANDOVER','a',fp,JSON.stringify({book:'book'}),JSON.stringify({roundId:'r',epoch:'normal_pilot296_invalid',version:'z'.repeat(36)}),'now'));
  assert.equal(d.prepare("SELECT count(*) AS n FROM admin_audit WHERE id='invalid-version'").get().n,0);
  insert('root','ISSUE296_PAUSED_NOTICE_HANDOVER','a',{book:'book'},{roundId:'r'});
  assert.equal(d.prepare("SELECT transaction_date FROM serial_pilot_reservation_snapshots WHERE audit_id='root'").get().transaction_date,'2026-11-15');
  assert.throws(()=>d.exec("UPDATE serial_pilot_reservation_snapshots SET transaction_date='2026-12-15' WHERE audit_id='root'"));
  assert.throws(()=>d.exec("UPDATE admin_audit SET reason='changed' WHERE id='root'"));
  d.exec("INSERT INTO admin_audit VALUES('other-action','UNRELATED','a','x',NULL,NULL,'now')");
  assert.throws(()=>d.exec("UPDATE admin_audit SET action='ISSUE296_SERIAL_EXPENSE_HANDOVER' WHERE id='other-action'"));
  assert.throws(()=>d.prepare("INSERT OR REPLACE INTO admin_audit(rowid,id,action,entity_key,reason,created_at) VALUES((SELECT rowid FROM admin_audit WHERE id='root'),'replacement','UNRELATED','a','x','now')").run());
  assert.throws(()=>insert('bad-proof','ISSUE296_SERIAL_EXPENSE_HANDOVER','b',{book:'book',predecessorJobId:'a',proof:'z'.repeat(64)},{roundId:'r'}));
  assert.throws(()=>insert('bad-round','ISSUE296_SERIAL_EXPENSE_HANDOVER','b',{book:'book',predecessorJobId:'a',proof:'f'.repeat(64)},{roundId:'different'}));
  const stale=[{jobId:'a',category:'RECONCILE',evidence:'UNVERIFIED',successorJobId:null},{jobId:'b',category:'RECONCILE',evidence:'UNVERIFIED',successorJobId:null}];
  insert('issue296:serial:a','ISSUE296_SERIAL_EXPENSE_HANDOVER','b',{book:'book',predecessorJobId:'a',proof:'f'.repeat(64)},{roundId:'r'});
  assert.equal(await closeSerialRound(db,'r','closed','HELD',stale),false);
  assert.equal(await closeUnverifiedSerialRound(db,'r','closed'),true);
  assert.deepEqual((await readSerialRound(db,'r')).results.map(x=>[x.job_id,x.successor_job_id]),[['a','b'],['b',null]]);
  assert.throws(()=>insert('late','ISSUE296_SERIAL_EXPENSE_HANDOVER','b',{book:'book',predecessorJobId:'a',proof:'f'.repeat(64)},{roundId:'r'}));
  assert.equal(await openSerialRound(db,'recovery','r','created',['b'],binding),false); // lineage proof is not implemented
  assert.equal(await openSerialRound(db,'new-initial',null,'created',[],binding),false); // prior root prevents a new empty chain
 }finally{h.close();}
});
test('observation excludes verified projections from an older epoch and labels the workbook claim as global',async()=>{
 const {DatabaseSync}=await import('node:sqlite');
 const {observeSerialRound}=require('../dist/admin/serial-round-store.js'),d=new DatabaseSync(':memory:');
 try{
  d.exec(`CREATE TABLE serial_pilot_round_items(round_id,ordinal,job_id); CREATE TABLE sync_jobs(job_id,entity_type,entity_key,entity_version,status,serial_provenance_version,serial_lease_generation,last_error);
   CREATE TABLE serial_pilot_round_bindings(round_id,spreadsheet_id); CREATE TABLE admin_audit(action,entity_key,after_json,before_json);
   CREATE TABLE stable_recovery_epochs(epoch_id,state,spreadsheet_id,target_type,target_key,target_version); CREATE TABLE stable_recovery_operations(epoch_id,operation_token,state);
   CREATE TABLE stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,source_version,operation_token,state,updated_at);
   CREATE TABLE stable_workbook_claims(spreadsheet_id,state,operation_token,phase,review_reason);
   INSERT INTO serial_pilot_round_items VALUES('r',0,'job'); INSERT INTO sync_jobs VALUES('job','EXPENSE','expense',1,'REVIEW',0,0,NULL);
   INSERT INTO serial_pilot_round_bindings VALUES('r','book'); INSERT INTO stable_workbook_claims VALUES('book','REVIEW','old-op',NULL,NULL);
   INSERT INTO admin_audit VALUES('ISSUE296_PAUSED_NOTICE_HANDOVER','job','{"roundId":"r","epoch":"new"}','{"book":"book"}');
   INSERT INTO stable_recovery_epochs VALUES('new','REVIEW','book','EXPENSE','expense',1),('old','COMPLETE','book','EXPENSE','expense',1);
   INSERT INTO stable_recovery_operations VALUES('new','new-op','ADMITTED'),('old','old-op','VERIFIED');
   INSERT INTO stable_projection_writes VALUES('book','EXPENSE','expense','DAILY',1,'old-op','VERIFIED','2026-01-01'),('book','EXPENSE','expense|item','DETAIL',1,'new-op','IN_FLIGHT','2026-02-01');`);
  const db={prepare(sql){return {bind(...args){return {async all(){return {success:true,results:d.prepare(sql).all(...args)};}};}};}};
  const [row]=await observeSerialRound(db,'r');
  assert.equal(row.verified_stages,0);assert.equal(row.unresolved_stages,1);assert.equal(row.epoch_state,'REVIEW');assert.equal(row.workbook_claim,'REVIEW');
  d.exec("UPDATE sync_jobs SET last_error='SERIAL_EXPIRED_PROVIDER_UNCERTAIN'");assert.equal((await observeSerialRound(db,'r'))[0].hold_reason,'SERIAL_EXPIRED_PROVIDER_UNCERTAIN');
  d.exec("UPDATE sync_jobs SET last_error='private unknown provider text'");assert.equal((await observeSerialRound(db,'r'))[0].hold_reason,null);
  assert.equal(row.admitted_operations,1);assert.equal(row.claim_relationship,'UNKNOWN');
  d.exec("UPDATE stable_workbook_claims SET operation_token='new-op'");assert.equal((await observeSerialRound(db,'r'))[0].claim_relationship,'EXACT_EPOCH_OPERATION');
  d.exec("UPDATE stable_recovery_epochs SET spreadsheet_id='other' WHERE epoch_id='new'");const wrongScope=(await observeSerialRound(db,'r'))[0];assert.equal(wrongScope.claim_relationship,'UNKNOWN');assert.equal(wrongScope.epoch_state,null);
  d.exec('DELETE FROM stable_workbook_claims');assert.equal((await observeSerialRound(db,'r'))[0].claim_relationship,'NO_CLAIM');
  d.exec("INSERT INTO admin_audit VALUES('ISSUE296_SERIAL_EXPENSE_HANDOVER','job','{\"roundId\":\"r\",\"epoch\":\"old\"}','{\"book\":\"book\"}')");assert.equal(await observeSerialRound(db,'r'),null);
 }finally{d.close();}
});
test('draft barrier rejects replace/upsert and fails closed for a preexisting activation row',async()=>{
 const h=setup();try{
  assert.throws(()=>h.sqlite.exec("INSERT OR REPLACE INTO serial_pilot_round_fence_activation VALUES(1,'now')"));
  assert.throws(()=>h.sqlite.exec("INSERT INTO serial_pilot_round_fence_activation VALUES(1,'now') ON CONFLICT(singleton) DO UPDATE SET activated_at=excluded.activated_at"));
  h.sqlite.exec("DROP TRIGGER serial_pilot_fence_not_ready; INSERT INTO serial_pilot_round_fence_activation VALUES(1,'now'); CREATE TRIGGER serial_pilot_fence_not_ready BEFORE INSERT ON serial_pilot_round_fence_activation BEGIN SELECT RAISE(ABORT,'not ready'); END");
  assert.equal(await openSerialRound(h.DB,'r',null,'created',['a'],{spreadsheetId:'book',fingerprint:'a'.repeat(64)}),false);
  assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM serial_pilot_rounds').get().n,0);
 }finally{h.close();}
});
test('an empty selection closes idempotently without claiming the queue is empty',async()=>{
 const h=setup();try{
  h.sqlite.exec("DROP TRIGGER serial_pilot_fence_not_ready; INSERT INTO serial_pilot_round_fence_activation VALUES(1,'now')");
  assert.equal(await openSerialRound(h.DB,'empty',null,'created',[],{spreadsheetId:'book',fingerprint:'a'.repeat(64)}),true);
  assert.equal(await closeUnverifiedSerialRound(h.DB,'empty','closed'),true);
  assert.equal(await closeUnverifiedSerialRound(h.DB,'empty','later'),true);
  const round=await readSerialRound(h.DB,'empty');assert.equal(round.round.reason,'EMPTY_SELECTION');assert.equal(round.results.length,0);
 }finally{h.close();}
});
test('selection guard compares the complete ordered eligible set and detects drift',async()=>{
 const {DatabaseSync}=await import('node:sqlite'),{serialSelectionGuard}=require('../dist/admin/serial-round-store.js'),d=new DatabaseSync(':memory:');
 try{
  d.exec(`CREATE TABLE sync_jobs(job_id,entity_type,entity_key,entity_version,status,attempt_count,lease_token,lease_until,next_attempt_at,updated_at);
   CREATE TABLE expense_events(expense_id,version,status,transaction_date);
   CREATE TABLE continuous_daily_post_cutover_expenses(spreadsheet_id,expense_id);
   CREATE TABLE continuous_daily_cutovers(spreadsheet_id,state);
   INSERT INTO continuous_daily_cutovers VALUES('book','ACTIVE');`);
  const db={prepare(sql){return {bind(...args){return {async all(){return {success:true,results:d.prepare(sql).all(...args)};}};}};}};
  const check=jobs=>serialSelectionGuard(db,'book',jobs).all();
  await check([]);
  const add=(id)=>{d.prepare("INSERT INTO sync_jobs VALUES(?,'EXPENSE',?,1,'PENDING',0,NULL,NULL,NULL,?)").run(id,id,id);d.prepare("INSERT INTO expense_events VALUES(?,1,'CONFIRMED',date('now','+7 hours'))").run(id);d.prepare("INSERT INTO continuous_daily_post_cutover_expenses VALUES('book',?)").run(id);};
  add('a');add('b');await check(['a','b']);
  await assert.rejects(check(['b','a']));await assert.rejects(check(['a']));await assert.rejects(check(['a','b','b']));
  add('c');await assert.rejects(check(['a','b']));await check(['a','b','c']);
  d.exec("UPDATE sync_jobs SET status='PROCESSING' WHERE job_id='b'");await assert.rejects(check(['a','b','c']));await check(['a','c']);
 }finally{d.close();}
});
