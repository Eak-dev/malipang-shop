import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url),{handleAdmin}=require('../dist/admin/handler.js'),{openSerialRound}=require('../dist/admin/serial-round-store.js');
test('authenticated recovery records only unresolved results and is retry-safe',async()=>{
 const h=expenseSqlite(),prepare=h.DB.prepare,version='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',round='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',token='s'.repeat(40);
 h.DB.prepare=function(sql){const s=prepare.call(this,sql),all=s.all;s.all=async()=>({...await all.call(s),success:true});return s;};
 Object.assign(h.env,{ADMIN_TOKEN:token,CF_VERSION_METADATA:{id:version},CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book'});
 const call=(action,auth=token,pin=version)=>handleAdmin(new Request('https://example.invalid/admin/stable-sync/serial-round-recovery',{method:'POST',headers:{authorization:'Bearer '+auth,'x-malipang-expected-worker-version':pin},body:JSON.stringify({action,roundId:round})}),h.env,{});
 try{
  assert.equal((await call('READ','wrong')).status,401);
  assert.equal((await call('READ',token,'cccccccc-cccc-4ccc-8ccc-cccccccccccc')).status,409);
  assert.equal((await call('READ')).status,409); // activation is absent
  h.env.CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED='false';
  assert.equal((await call('READ')).status,404);
  h.env.CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED='true';
  h.sqlite.exec("DROP TRIGGER serial_pilot_fence_not_ready; INSERT INTO serial_pilot_round_fence_activation VALUES(1,'now')"); // synthetic fixture only
  assert.equal(await openSerialRound(h.DB,round,null,'created',['job'],{spreadsheetId:'book',fingerprint:'a'.repeat(64)}),true);
  const absent=(await (await call('READ')).json()).observations[0];
  assert.equal(absent.claimRelationship,'NO_CLAIM');assert.equal(absent.workbookClaimStateGlobal,null);assert.equal(absent.workbookClaimPhaseGlobal,null);assert.equal(absent.workbookClaimReasonGlobal,null);
  h.sqlite.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','claim-token','REVIEW','now','now')");
  // This claim belongs to another operation: its diagnostic is workbook-wide,
  // does not authorize this job, and never exposes unknown free-form values.
  h.sqlite.exec("UPDATE stable_workbook_claims SET phase='private phase',review_reason='private reason' WHERE spreadsheet_id='book'");
  const unknownRead=await (await call('READ')).json();let observed=unknownRead.observations[0];
  assert.equal(observed.claimRelationship,'UNKNOWN');assert.equal(observed.workbookClaimPhaseGlobal,'UNKNOWN');assert.equal(observed.workbookClaimReasonGlobal,'UNKNOWN');assert.doesNotMatch(JSON.stringify(unknownRead),/private (phase|reason)/);
  h.sqlite.exec("UPDATE stable_workbook_claims SET phase='SERIAL_CONTINUATION',review_reason='SHEETSxMUTATIONxOUTCOMExUNKNOWN:NETWORK' WHERE spreadsheet_id='book'");
  observed=(await (await call('READ')).json()).observations[0];assert.equal(observed.workbookClaimReasonGlobal,'UNKNOWN');
  h.sqlite.exec("UPDATE stable_workbook_claims SET review_reason='SHEETS_MUTATION_OUTCOME_UNKNOWN:NETWORK' WHERE spreadsheet_id='book'");
  observed=(await (await call('READ')).json()).observations[0];assert.equal(observed.workbookClaimReasonGlobal,'SHEETS_MUTATION_OUTCOME_UNKNOWN');
  h.sqlite.exec("UPDATE stable_workbook_claims SET review_reason='SERIAL_FINAL_COMPLETION_NOT_READY' WHERE spreadsheet_id='book'");
  observed=(await (await call('READ')).json()).observations[0];
  assert.equal(observed.claimRelationship,'UNKNOWN');assert.equal(observed.workbookClaimPhaseGlobal,'SERIAL_CONTINUATION');assert.equal(observed.workbookClaimReasonGlobal,'SERIAL_FINAL_COMPLETION_NOT_READY');
  const beforeRace=h.DB.prepare;let raced=false;
  h.DB.prepare=function(sql){const statement=beforeRace.call(this,sql);if(sql.startsWith('SELECT i.job_id,j.status')){const all=statement.all;statement.all=async()=>{const rows=await all.call(statement);if(!raced){raced=true;h.sqlite.exec("UPDATE stable_workbook_claims SET review_reason='private later reason' WHERE spreadsheet_id='book'");}return rows;};}return statement;};
  const racedRead=await (await call('READ')).json();h.DB.prepare=beforeRace;
  assert.equal(racedRead.observationsAtomicWithRound,false);assert.equal(racedRead.observations[0].workbookClaimReasonGlobal,'SERIAL_FINAL_COMPLETION_NOT_READY');
  assert.equal(h.sqlite.prepare("SELECT review_reason FROM stable_workbook_claims WHERE spreadsheet_id='book'").get().review_reason,'private later reason');
  const completePrepare=h.DB.prepare;
  for(const missing of [0,1]){
   h.DB.prepare=function(sql){const s=completePrepare.call(this,sql);if(sql.includes('pragma_table_info'))s.first=async()=>({n:missing});return s;};
   const result=await (await call('CLOSE_UNVERIFIED')).json();assert.equal(result.outcome,'UNVERIFIED');assert.equal(result.reason,'PROVENANCE_SCHEMA_UNAVAILABLE');
   assert.equal(h.sqlite.prepare('SELECT state FROM serial_pilot_rounds WHERE round_id=?').get(round).state,'OPEN');
  }
  h.DB.prepare=completePrepare;
  const listRequest=new Request('https://example.invalid/admin/stable-sync/serial-round-recovery',{method:'POST',headers:{authorization:'Bearer '+token,'x-malipang-expected-worker-version':version},body:JSON.stringify({action:'LIST_OPEN'})});
  assert.deepEqual((await (await handleAdmin(listRequest,h.env,{})).json()).rounds.map(x=>x.roundId),[round]);
  const stablePrepare=h.DB.prepare;let injected=false;
  h.DB.prepare=function(sql){const s=stablePrepare.call(this,sql);if(sql.startsWith('SELECT job_id,ordinal')){const all=s.all;s.all=async()=>{const r=await all.call(s);if(!injected){injected=true;h.env.GOOGLE_SPREADSHEET_ID='other-book';}return r;};}return s;};
  assert.equal((await call('CLOSE_UNVERIFIED')).status,409);
  assert.equal(h.sqlite.prepare('SELECT state FROM serial_pilot_rounds WHERE round_id=?').get(round).state,'OPEN');
  h.DB.prepare=stablePrepare;h.env.GOOGLE_SPREADSHEET_ID='book';
  h.env.GOOGLE_SPREADSHEET_ID='other-book';
  assert.equal((await call('CLOSE_UNVERIFIED')).status,409);
  assert.equal(h.sqlite.prepare('SELECT state FROM serial_pilot_rounds WHERE round_id=?').get(round).state,'OPEN');
  h.env.GOOGLE_SPREADSHEET_ID='book';
  assert.equal((await (await call('READ')).json()).outcome,'OPEN');
  const first=await (await call('CLOSE_UNVERIFIED')).json();
  assert.equal(first.outcome,'CLOSED');assert.equal(first.results[0].category,'RECONCILE');
  const again=await (await call('CLOSE_UNVERIFIED')).json();assert.deepEqual(again.results,first.results);assert.equal(again.outcome,first.outcome);
  const recentRequest=new Request('https://example.invalid/admin/stable-sync/serial-round-recovery',{method:'POST',headers:{authorization:'Bearer '+token,'x-malipang-expected-worker-version':version},body:JSON.stringify({action:'LIST_RECENT'})});
  assert.deepEqual((await (await handleAdmin(recentRequest,h.env,{})).json()).rounds.map(x=>[x.roundId,x.state]),[[round,'CLOSED']]);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM stable_workbook_claims WHERE operation_token='claim-token' AND state='REVIEW'").get().n,1);
  const newVersion='cccccccc-cccc-4ccc-8ccc-cccccccccccc';h.env.CF_VERSION_METADATA={id:newVersion};
  const before=h.DB.runs.length,read=await call('READ',token,newVersion);
  assert.equal((await read.json()).outcome,'CLOSED');assert.equal(h.DB.runs.length,before);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM stable_workbook_claims WHERE operation_token='claim-token' AND state='REVIEW'").get().n,1);
 }finally{h.close();}
});
test('missing or partial provenance columns leave an existing round open',async()=>{
 for(const partial of [true,false]){
  const h=expenseSqlite(),original=h.DB.prepare,version='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',round='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',token='s'.repeat(40);
  h.DB.prepare=function(sql){const s=original.call(this,sql),all=s.all;s.all=async()=>({...await all.call(s),success:true});return s;};
  Object.assign(h.env,{ADMIN_TOKEN:token,CF_VERSION_METADATA:{id:version},CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book'});
  try{
   h.sqlite.exec("DROP TRIGGER serial_pilot_fence_not_ready; INSERT INTO serial_pilot_round_fence_activation VALUES(1,'now')");
   assert.equal(await openSerialRound(h.DB,round,null,'created',['job'],{spreadsheetId:'book',fingerprint:'a'.repeat(64)}),true);
   // Synthetic partial schema for endpoint fail-closed behavior only; this
   // does not model an actual D1 migration boundary or rollback. Remove later
   // draft triggers that reference the columns before SQLite DROP COLUMN.
   const dependent=h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (sql LIKE '%serial_lease_generation%' OR sql LIKE '%serial_provenance_version%')").all();
   for(const {name} of dependent)h.sqlite.exec('DROP TRIGGER "'+name.replaceAll('"','""')+'"');
   h.sqlite.exec('ALTER TABLE sync_jobs DROP COLUMN serial_lease_generation');
   if(!partial)h.sqlite.exec('ALTER TABLE sync_jobs DROP COLUMN serial_provenance_version');
   const response=await handleAdmin(new Request('https://example.invalid/admin/stable-sync/serial-round-recovery',{method:'POST',headers:{authorization:'Bearer '+token,'x-malipang-expected-worker-version':version},body:JSON.stringify({action:'CLOSE_UNVERIFIED',roundId:round})}),h.env,{});
   const result=await response.json();assert.equal(result.outcome,'UNVERIFIED');assert.equal(result.reason,'PROVENANCE_SCHEMA_UNAVAILABLE');
   assert.equal(h.sqlite.prepare('SELECT state FROM serial_pilot_rounds WHERE round_id=?').get(round).state,'OPEN');
  }finally{h.close();}
 }
});
test('initial snapshot rejects missing held evidence',async()=>{
 const h=expenseSqlite(),prepare=h.DB.prepare,version='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',round='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',job='cccccccc-cccc-4ccc-8ccc-cccccccccccc',token='s'.repeat(40);
 h.DB.prepare=function(sql){const s=prepare.call(this,sql),all=s.all;s.all=async()=>({...await all.call(s),success:true});return s;};
 Object.assign(h.env,{ADMIN_TOKEN:token,CF_VERSION_METADATA:{id:version},CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book'});
 const call=body=>handleAdmin(new Request('https://example.invalid/admin/stable-sync/serial-round-recovery',{method:'POST',headers:{authorization:'Bearer '+token,'x-malipang-expected-worker-version':version},body:JSON.stringify(body)}),h.env,{});
 try{
  h.sqlite.exec("DROP TRIGGER serial_pilot_fence_not_ready; INSERT INTO serial_pilot_round_fence_activation VALUES(1,'now')");
  const body={action:'OPEN_INITIAL',roundId:round,fingerprint:'a'.repeat(64),preimageDigest:'b'.repeat(64),jobs:[job],ownerSupervising:true,externalWritersFenced:true};
  assert.equal((await call({...body,ownerSupervising:false})).status,400);
  assert.equal((await call(body)).status,409);
  assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM serial_pilot_rounds').get().n,0);
 }finally{h.close();}
});
test('empty selection is snapshotted and closed without treating other queue work as verified',async()=>{
 const h=expenseSqlite(),prepare=h.DB.prepare,version='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',round='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',token='s'.repeat(40);
 h.DB.prepare=function(sql){const s=prepare.call(this,sql),all=s.all;s.all=async()=>({...await all.call(s),success:true});return s;};
 Object.assign(h.env,{ADMIN_TOKEN:token,CF_VERSION_METADATA:{id:version},GOOGLE_SPREADSHEET_ID:'book',CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED:'true',CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED:'false',STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',STABLE_PHASE1_ENABLED:'true',STABLE_CANCELLATION_PREIMAGE_ENABLED:'true',SHEETS_SYNC_ENABLED:'true',CONTINUOUS_DAILY_ENABLED:'true',CONTINUOUS_DAILY_SHEET:'รายวันต่อเนื่อง_แบบร่าง'});
 const call=body=>handleAdmin(new Request('https://example.invalid/admin/stable-sync/serial-round-recovery',{method:'POST',headers:{authorization:'Bearer '+token,'x-malipang-expected-worker-version':version},body:JSON.stringify(body)}),h.env,{});
 try{
  h.sqlite.exec("DROP TRIGGER serial_pilot_fence_not_ready; INSERT INTO serial_pilot_round_fence_activation VALUES(1,'now')");
  assert.equal((await call({action:'OPEN_EMPTY',roundId:round,ownerSupervising:true,externalWritersFenced:true})).status,200);
  assert.equal((await call({action:'CLOSE_UNVERIFIED',roundId:round})).status,200);
  const saved=await (await call({action:'READ',roundId:round})).json();assert.equal(saved.outcome,'CLOSED');assert.equal(saved.selected,0);assert.deepEqual(saved.results,[]);
 }finally{h.close();}
});
