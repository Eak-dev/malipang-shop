import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url);
const {planStableExpenseCancellation}=require('../dist/sheets/stable-expense-cancellation-plan.js');
const stamp='2026-11-15T00:00:00.000Z';
const blank=n=>Array(n).fill(null);
const makeDaily=()=>{const r=blank(25);Object.assign(r,{1:11,2:4,3:'Synthetic',7:100,8:'=SUM(F3:H3)',9:'=J2-I3',21:'ingredients',22:'SHOP_BANK',23:'MALIPANG_EXPENSE:exp_one'});return r;};
const plan=(projection,rows,preimage,extra={})=>planStableExpenseCancellation({projection,expenseId:'exp_one',rows,...(preimage?{trustedPreimageWidth:preimage.length,trustedPreimageDigest:createHash('sha256').update(JSON.stringify(preimage.map(v=>v===undefined||v===''?null:v))).digest('hex')}:{ }),cancelledAt:stamp,...extra});

test('daily candidate stops until running-balance effects can be proven before any write',async()=>{
 const row=makeDaily(),copy=[...row],result=await plan('DAILY',[blank(25),row],copy);
 assert.equal(result.status,'REVIEW');assert.equal(result.reason,'DAILY_ACCOUNTING_SIMULATION_REQUIRED');assert.deepEqual(row,copy);
});
test('each ledger changes only the allowed cancellation columns',async()=>{
 const raw=blank(17);raw[0]='exp_one';raw[7]='CONFIRMED';
 assert.deepEqual((await plan('EXPENSE_RAW',[raw],raw)).changes,[{column:7,value:'CANCELLED'}]);
 const detail=blank(20);detail[0]='item_one';detail[1]='exp_one';detail[16]='CONFIRMED';
 assert.deepEqual((await plan('DETAIL',[detail],detail,{itemId:'item_one'})).changes,[{column:16,value:'CANCELLED'},{column:19,value:stamp}]);
});
test('missing or changed preimage, duplicate or missing ID, and input formula fail closed',async()=>{
 const row=makeDaily();
 assert.equal((await plan('DAILY',[row],undefined)).reason,'MISSING_PREIMAGE');
 assert.equal((await plan('DAILY',[row,row],row)).reason,'DUPLICATE_ID');
 assert.equal((await plan('DAILY',[blank(25)],row)).reason,'MISSING_ID');
 const changed=[...row];changed[3]='Edited';assert.equal((await plan('DAILY',[changed],row)).reason,'PREIMAGE_MISMATCH');
 const withFormula=[...row];withFormula[7]='=1+1';assert.equal((await plan('DAILY',[withFormula],withFormula)).reason,'FORMULA_IN_INPUT');
});
test('detail parent identity, status and cancellation timestamp are checked',async()=>{
 const row=blank(20);row[0]='item_one';row[1]='exp_other';row[16]='CONFIRMED';
 assert.equal((await plan('DETAIL',[row],row,{itemId:'item_one'})).reason,'EXPENSE_ID_MISMATCH');
 row[1]='exp_one';row[16]='CANCELLED';assert.equal((await plan('DETAIL',[row],row,{itemId:'item_one'})).reason,'STATUS_UNVERIFIED');
 row[16]='CONFIRMED';assert.equal((await plan('DETAIL',[row],row,{itemId:'item_one',cancelledAt:'2026-02-31T00:00:00.000Z'})).reason,'INVALID_TIME');
});
test('migration is additive, idempotent and retains verified source and cancellation intent',()=>{
 const h=expenseSqlite();try{
  const migration=readFileSync(new URL('../migrations/0024_stable_expense_cancellation_journal.sql',import.meta.url),'utf8');h.sqlite.exec(migration);
  const digest='a'.repeat(64),imageDigest='b'.repeat(64);
  const insertPreimage=h.sqlite.prepare("INSERT INTO stable_expense_projection_preimages(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,preimage_width,preimage_digest,created_at) VALUES('book','EXPENSE','exp_one','DAILY',5,'daily',1,?,25,?,'now')");
  assert.throws(()=>insertPreimage.run(digest,imageDigest),/unverified projection preimage/);
  h.sqlite.prepare("INSERT INTO stable_projection_writes VALUES('book','EXPENSE','exp_one','DAILY',5,'daily',1,?,'orig','IN_FLIGHT','now')").run(digest);
  assert.throws(()=>insertPreimage.run(digest,imageDigest),/unverified projection preimage/);
  h.sqlite.exec("UPDATE stable_projection_writes SET state='VERIFIED' WHERE entity_id='exp_one'");insertPreimage.run(digest,imageDigest);
  const intent=h.sqlite.prepare("INSERT INTO stable_expense_cancellation_writes VALUES('book','EXPENSE','exp_one','DAILY',2,1,?,'new-token','IN_FLIGHT','now','now')");
  assert.throws(()=>intent.run('c'.repeat(64)),/cancellation preimage unverified/);intent.run(imageDigest);
  assert.throws(()=>h.sqlite.exec("UPDATE stable_expense_cancellation_writes SET operation_token='changed'"),/invalid cancellation transition/);
  h.sqlite.exec("UPDATE stable_expense_cancellation_writes SET state='VERIFIED' WHERE entity_id='exp_one'");
  assert.throws(()=>h.sqlite.exec('DELETE FROM stable_expense_cancellation_writes'),/cancellation write retained/);
  assert.throws(()=>h.sqlite.exec('DELETE FROM stable_expense_projection_preimages'),/projection preimage retained/);
  assert.throws(()=>h.sqlite.prepare("INSERT OR REPLACE INTO stable_expense_cancellation_writes SELECT * FROM stable_expense_cancellation_writes").run(),/collision/);
  assert.equal(h.sqlite.prepare('PRAGMA foreign_key_check').all().length,0);assert.equal(h.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 }finally{h.close();}
});
