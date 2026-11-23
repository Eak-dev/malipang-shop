import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const child=fileURLToPath(new URL('./helpers/serial-runner-kill-child.mjs',import.meta.url));
for(const cut of ['open','handover','advance'])test('process kill after '+cut+' retains the same synthetic round and does not redispatch',()=>{
 const dir=mkdtempSync(join(tmpdir(),'serial-runner-cut-')),path=join(dir,'state.sqlite');try{
  const first=spawnSync(process.execPath,[child,path,cut,'first'],{encoding:'utf8',timeout:15000});assert.equal(first.signal,'SIGKILL',first.stderr||first.stdout);
  const restart=spawnSync(process.execPath,[child,path,cut,'restart'],{encoding:'utf8',timeout:15000});assert.equal(restart.status,0,restart.stderr||restart.stdout);
  const db=new DatabaseSync(path);try{
   const actions=db.prepare('SELECT action FROM actions ORDER BY rowid').all().map(x=>x.action),counts=action=>actions.filter(x=>x===action).length;
   const job='12345678-1234-1234-1234-123456789abc',next='22345678-1234-1234-1234-123456789abc',version='01234567-89ab-cdef-0123-456789abcdef';
   const rounds=db.prepare('SELECT * FROM rounds').all();assert.equal(rounds.length,1);assert.deepEqual(JSON.parse(rounds[0].members),[job,next]);assert.equal(rounds[0].fingerprint,'b'.repeat(64));
   assert.equal(counts('OPEN_INITIAL'),1);assert.equal(counts('HANDOVER_ONE'),cut==='open'?0:1);assert.equal(counts('ADVANCE_ONE'),cut==='advance'?1:0);
   const root=db.prepare("SELECT * FROM admin_audit WHERE action='ISSUE296_PAUSED_NOTICE_HANDOVER'").all();assert.equal(root.length,cut==='open'?0:1);if(root.length){assert.equal(root[0].entity_key,job);assert.equal(root[0].reason,rounds[0].fingerprint);assert.equal(JSON.parse(root[0].before_json).book,'test-book');assert.deepEqual(JSON.parse(root[0].after_json),{version,roundId:rounds[0].round_id});}
   const edge=db.prepare("SELECT * FROM admin_audit WHERE action='ISSUE296_SERIAL_EXPENSE_HANDOVER'").all();assert.equal(edge.length,cut==='advance'?1:0);
   if(edge.length){const before=JSON.parse(edge[0].before_json),after=JSON.parse(edge[0].after_json);assert.equal(edge[0].id,'issue296:serial:'+job);assert.equal(edge[0].entity_key,next);assert.equal(before.book,'test-book');assert.equal(before.predecessorJobId,job);assert.equal(before.proof,createHash('sha256').update(job).digest('hex'));assert.equal(after.roundId,rounds[0].round_id);assert.equal(after.version,version);}
   assert.ok(actions.some(x=>x==='STOP:PILOT_ROUND_IDENTITY_NEEDS_RECONCILIATION'),actions.join(','));
  }finally{db.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

for(const cut of ['mockhold','mocktransfer'])test('local mock runner kill after '+cut+' never resends the transition',()=>{
 const dir=mkdtempSync(join(tmpdir(),'serial-mock-cut-')),path=join(dir,'state.sqlite');try{
  const first=spawnSync(process.execPath,[child,path,cut,'first'],{encoding:'utf8',timeout:15000});assert.equal(first.signal,'SIGKILL',first.stderr||first.stdout);
  const restarted=spawnSync(process.execPath,[child,path,cut,'restart'],{encoding:'utf8',timeout:15000});assert.equal(restarted.status,0,restarted.stderr||restarted.stdout);
  const db=new DatabaseSync(path);try{
   const actions=db.prepare('SELECT action FROM actions ORDER BY rowid').all().map(x=>x.action),count=x=>actions.filter(v=>v===x).length;
   assert.equal(count('HOLD_RESERVED'),1);assert.equal(count('MOCK_TRANSFER'),cut==='mocktransfer'?1:0);
   assert.equal(db.prepare('SELECT count(*) n FROM mock_holds').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM mock_handoffs').get().n,cut==='mocktransfer'?1:0);
   assert.equal(db.prepare("SELECT count(*) n FROM admin_audit WHERE action='ISSUE296_SERIAL_EXPENSE_HANDOVER'").get().n,cut==='mocktransfer'?1:0);
   assert.ok(actions.includes('STOP:PILOT_ROUND_IDENTITY_NEEDS_RECONCILIATION'),actions.join(','));
  }finally{db.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

for(const cut of ['mockbefore-record','mockrecord','mockdelayedclose','mockclose'])test('restart after '+cut+' uses durable evidence without replaying uncertain transitions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'serial-recover-cut-')),path=join(dir,'state.sqlite');try{
  const first=spawnSync(process.execPath,[child,path,cut,'first'],{encoding:'utf8',timeout:15000});assert.equal(first.signal,'SIGKILL',first.stderr||first.stdout);
  const restart=spawnSync(process.execPath,[child,path,cut,'restart'],{encoding:'utf8',timeout:15000});assert.equal(restart.status,0,restart.stderr||restart.stdout);
  const db=new DatabaseSync(path);try{
   const actions=db.prepare('SELECT action FROM actions ORDER BY rowid').all().map(x=>x.action),count=x=>actions.filter(a=>a===x).length;
   assert.equal(count('OPEN_INITIAL'),1);assert.equal(count('HANDOVER_ONE'),1);assert.equal(count('HOLD_RESERVED'),1);assert.equal(count('MOCK_TRANSFER'),1);
   assert.equal(count('RECORD_VERIFIED'),cut==='mockbefore-record'?0:1);assert.equal(count('CLOSE_MOCK_PARKED'),['mockclose','mockdelayedclose'].includes(cut)?1:0);
   const round=db.prepare('SELECT * FROM rounds').get(),receipt=db.prepare('SELECT * FROM mock_receipts').all(),handoffs=db.prepare('SELECT * FROM mock_handoffs').all();
   assert.equal(handoffs.length,1);assert.equal(handoffs[0].round_id,round.round_id);assert.equal(receipt.length,cut==='mockbefore-record'?0:1);
   if(receipt.length){assert.equal(receipt[0].round_id,round.round_id);assert.equal(receipt[0].job_id,handoffs[0].next_id);assert.equal(receipt[0].proof,createHash('sha256').update(handoffs[0].next_id).digest('hex'));}
   assert.equal(round.state,cut==='mockclose'?'CLOSED':'OPEN');
   assert.ok(actions.includes(cut==='mockclose'?'SUCCESS:PILOT_MOCK_ROUND_RECORDED':'STOP:PILOT_ROUND_IDENTITY_NEEDS_RECONCILIATION'),actions.join(','));
   if(cut==='mockdelayedclose'){assert.equal(db.prepare('SELECT count(*) n FROM pending_close WHERE round_id=?').get(round.round_id).n,1);db.prepare("UPDATE rounds SET state='CLOSED' WHERE round_id=(SELECT round_id FROM pending_close)").run();assert.equal(db.prepare('SELECT state FROM rounds').get().state,'CLOSED','old request can finish after restart without a second close');}
  }finally{db.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('restart does not duplicate a delayed handover that commits later',()=>{
 const dir=mkdtempSync(join(tmpdir(),'serial-handover-delay-')),path=join(dir,'state.sqlite');try{
  const first=spawnSync(process.execPath,[child,path,'handover-before-commit','first'],{encoding:'utf8',timeout:15000});assert.equal(first.signal,'SIGKILL',first.stderr||first.stdout);
  const restart=spawnSync(process.execPath,[child,path,'handover-before-commit','restart'],{encoding:'utf8',timeout:15000});assert.equal(restart.status,0,restart.stderr||restart.stdout);
  const db=new DatabaseSync(path);try{
   const actions=db.prepare('SELECT action FROM actions ORDER BY rowid').all().map(x=>x.action),pending=db.prepare('SELECT * FROM pending_handover').get(),round=db.prepare('SELECT * FROM rounds').get();
   assert.equal(actions.filter(x=>x==='HANDOVER_ONE').length,1);assert.ok(actions.includes('STOP:PILOT_ROUND_IDENTITY_NEEDS_RECONCILIATION'));
   assert.equal(db.prepare('SELECT count(*) n FROM admin_audit').get().n,0);assert.equal(pending.round_id,round.round_id);
   db.prepare('INSERT INTO admin_audit VALUES(?,?,?,?,?,?)').run('issue296:parked:synthetic','ISSUE296_PAUSED_NOTICE_HANDOVER',pending.job_id,round.fingerprint,JSON.stringify({book:'test-book'}),JSON.stringify({version:'01234567-89ab-cdef-0123-456789abcdef',roundId:round.round_id}));
   assert.equal(db.prepare('SELECT count(*) n FROM admin_audit').get().n,1,'original handover can commit later without replay');
  }finally{db.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('explicit synthetic quiescence permits a separate local reconciliation to close',()=>{
 const dir=mkdtempSync(join(tmpdir(),'serial-fenced-reconcile-')),path=join(dir,'state.sqlite');try{
  const first=spawnSync(process.execPath,[child,path,'mockrecord','first'],{encoding:'utf8',timeout:15000});assert.equal(first.signal,'SIGKILL',first.stderr||first.stdout);
  const restart=spawnSync(process.execPath,[child,path,'mockrecord','restart'],{encoding:'utf8',timeout:15000});assert.equal(restart.status,0,restart.stderr||restart.stdout);
  // This record represents an authoritative external oracle in the synthetic
  // fixture, not a claim that a real provider or writer has stopped.
  const without=spawnSync(process.execPath,[child,path,'mockrecord','reconcile'],{encoding:'utf8',timeout:15000});assert.notEqual(without.status,0);assert.match(without.stderr,/MOCK_QUIESCENCE_REQUIRED/);
  const db=new DatabaseSync(path);try{
   const round=db.prepare('SELECT * FROM rounds').get(),receipt=db.prepare('SELECT * FROM mock_receipts').get();assert.equal(round.state,'OPEN');assert.equal(receipt.round_id,round.round_id);
   db.prepare("INSERT INTO mock_quiescence VALUES(?,?,'QUIESCENT_FENCED',?,1,?)").run(round.round_id,'01234567-89ab-cdef-0123-456789abcdef','f'.repeat(64),'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  }finally{db.close();}
  const reconcile=spawnSync(process.execPath,[child,path,'mockrecord','reconcile'],{encoding:'utf8',timeout:15000});assert.equal(reconcile.status,0,reconcile.stderr||reconcile.stdout);
  const after=new DatabaseSync(path);try{const actions=after.prepare('SELECT action FROM actions ORDER BY rowid').all().map(x=>x.action);assert.equal(actions.filter(x=>x==='RECORD_VERIFIED').length,1);assert.equal(actions.filter(x=>x==='CLOSE_MOCK_PARKED').length,1);assert.equal(after.prepare('SELECT state FROM rounds').get().state,'CLOSED');assert.ok(actions.includes('SUCCESS:PILOT_MOCK_ROUND_RECORDED'));}finally{after.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

for(const cut of ['open-before-commit','settle-before-commit'])test('durable identity prevents a new round while '+cut+' may still finish',()=>{
 const dir=mkdtempSync(join(tmpdir(),'serial-identity-delay-')),path=join(dir,'state.sqlite');try{
  const first=spawnSync(process.execPath,[child,path,cut,'first'],{encoding:'utf8',timeout:15000});assert.equal(first.signal,'SIGKILL',first.stderr||first.stdout);
  const again=spawnSync(process.execPath,[child,path,cut,'restart'],{encoding:'utf8',timeout:15000});assert.equal(again.status,0,again.stderr||again.stdout);
  const db=new DatabaseSync(path);try{
   const actions=db.prepare('SELECT action FROM actions ORDER BY rowid').all().map(x=>x.action),counts=x=>actions.filter(a=>a===x).length;
   assert.ok(actions.includes('STOP:PILOT_ROUND_IDENTITY_NEEDS_RECONCILIATION'));assert.equal(counts('LIST_OPEN'),1);assert.equal(counts('OPEN_INITIAL'),cut==='open-before-commit'?1:0);assert.equal(counts('SETTLE'),cut==='settle-before-commit'?1:0);
   if(cut==='open-before-commit'){const pending=db.prepare('SELECT * FROM pending_open').get();assert.ok(pending);assert.equal(db.prepare('SELECT count(*) n FROM rounds').get().n,0);db.prepare('INSERT INTO rounds(round_id,fingerprint,members) VALUES(?,?,?)').run(pending.round_id,pending.fingerprint,pending.members);assert.equal(db.prepare('SELECT round_id FROM rounds').get().round_id,pending.round_id);}
   else assert.equal(db.prepare('SELECT count(*) n FROM pending_settle').get().n,1);
  }finally{db.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
