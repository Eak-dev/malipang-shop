import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync,readFileSync } from 'node:fs';
const require=createRequire(import.meta.url);
const client=require('../dist/sheets/client.js');
const {resolveLedgerSnapshot,inspectLedgerAndHold,ledgerInspectionEnabled}=require('../dist/sheets/ledger-identity-inspection.js');
const {markCancelledExpensePurchaseDetails,writeConfirmedExpensePurchaseDetails}=require('../dist/sheets/purchase-details.js');
const {syncJob}=require('../dist/sheets/sync.js');
const original={count:client.getSheetRowCount,read:client.getSheetValues};
test.afterEach(()=>{client.getSheetRowCount=original.count;client.getSheetValues=original.read});
const raw=[['Expense_ID'],['exp_a'],['exp_b']];
const personal=[['Personal_Use_ID'],['personal_a'],['personal_b']];
const details=[['Purchase_Item_ID','Expense_ID'],['item_a','exp_a'],['item_b','exp_a'],['item_c','exp_b']];

test('locates exact identities independent of row movement and sort',()=>{
  assert.equal(resolveLedgerSnapshot('EXPENSE',raw,'exp_a'),'UNIQUE');
  assert.equal(resolveLedgerSnapshot('EXPENSE',[raw[0],[],raw[2],raw[1]],'exp_a'),'UNIQUE');
  assert.equal(resolveLedgerSnapshot('PERSONAL_USE',[personal[0],personal[2],personal[1]],'personal_a'),'UNIQUE');
  assert.equal(resolveLedgerSnapshot('PURCHASE_DETAILS',[details[0],details[3],details[2],details[1]],'exp_a',['item_a','item_b']),'UNIQUE');
});
test('missing, duplicate, wrong header, and cross-expense item fail closed',()=>{
  assert.equal(resolveLedgerSnapshot('EXPENSE',raw,'exp_missing'),'ABSENT');
  assert.equal(resolveLedgerSnapshot('EXPENSE',[...raw,['exp_a']],'exp_a'),'DUPLICATE');
  assert.equal(resolveLedgerSnapshot('PERSONAL_USE',[['bad'],['personal_a']],'personal_a'),'CONFLICT');
  assert.equal(resolveLedgerSnapshot('PURCHASE_DETAILS',[...details,['item_a','exp_other']],'exp_a',['item_a']),'DUPLICATE');
  assert.equal(resolveLedgerSnapshot('PURCHASE_DETAILS',details,'exp_a',['item_c']),'CONFLICT');
  assert.equal(resolveLedgerSnapshot('PURCHASE_DETAILS',[['Purchase_Item_ID','Expense_ID'],['','exp_a']],'exp_a'),'CONFLICT');
  assert.equal(resolveLedgerSnapshot('PURCHASE_DETAILS',details,'exp_a',['item_a','missing']),'CONFLICT');
});
test('disabled by default performs no read; enabled inspection never grants a write',async()=>{
  client.getSheetRowCount=async()=>{throw Error('must not read')};
  assert.equal(ledgerInspectionEnabled({}),false);
  await inspectLedgerAndHold({},'EXPENSE','RAW','exp_a');
  client.getSheetRowCount=async()=>3;client.getSheetValues=async()=>raw;
  await assert.rejects(inspectLedgerAndHold({SHEETS_LEDGER_IDENTITY_INSPECTION:'true'},'EXPENSE','RAW','exp_a'),{message:'LEDGER_IDENTITY_INSPECTION_UNIQUE_REVIEW'});
});
test('missing data, unavailable Sheets and oversized grids hold without leaking IDs',async()=>{
  const env={SHEETS_LEDGER_IDENTITY_INSPECTION:'true'};
  client.getSheetRowCount=async()=>10_001;
  await assert.rejects(inspectLedgerAndHold(env,'EXPENSE','RAW','exp_private'),{message:'LEDGER_IDENTITY_INSPECTION_UNAVAILABLE_REVIEW'});
  client.getSheetRowCount=async()=>3;client.getSheetValues=async()=>{throw Error('private upstream text')};
  await assert.rejects(inspectLedgerAndHold(env,'EXPENSE','RAW','exp_private'),{message:'LEDGER_IDENTITY_INSPECTION_UNAVAILABLE_REVIEW'});
});
test('direct purchase-detail write and cancellation stop before D1 allocation or Sheets write',async()=>{
  client.getSheetRowCount=async()=>4;client.getSheetValues=async()=>details;
  const env={SHEETS_LEDGER_IDENTITY_INSPECTION:'true',DB:{prepare(){throw Error('unexpected mutation')}}};
  await assert.rejects(markCancelledExpensePurchaseDetails(env,'exp_a'),{message:'LEDGER_IDENTITY_INSPECTION_UNIQUE_REVIEW'});
  await assert.rejects(writeConfirmedExpensePurchaseDetails(env,{expenseId:'exp_a',status:'CONFIRMED',amountBaht:1},{documentId:'doc_a'},[{itemId:'item_a',documentId:'doc_a',expenseId:'exp_a',description:'fixture',lineTotalSatang:100}]),{message:'LEDGER_IDENTITY_INSPECTION_UNIQUE_REVIEW'});
});
class D1Statement{
  constructor(db,sql){this.db=db;this.sql=sql;this.args=[]} bind(...args){this.args=args;return this}
  async first(){return this.db.prepare(this.sql).get(...this.args)??null}
  async all(){return {results:this.db.prepare(this.sql).all(...this.args),meta:{changes:0}}}
  async run(){if(/^\s*SELECT/i.test(this.sql))return{results:this.db.prepare(this.sql).all(...this.args),meta:{changes:0}};return{meta:{changes:Number(this.db.prepare(this.sql).run(...this.args).changes)}}}
}
class D1{
  constructor(db){this.db=db} prepare(sql){return new D1Statement(this.db,sql)}
  async batch(stmts){this.db.exec('BEGIN');try{const out=[];for(const s of stmts)out.push(await s.run());this.db.exec('COMMIT');return out}catch(e){this.db.exec('ROLLBACK');throw e}}
}
test('personal sync inspection sets REVIEW before any row allocation or write',async()=>{
  const db=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(x=>/^\d+.*\.sql$/.test(x)).sort())db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  const now='2026-10-01T00:00:00.000Z',id='personal_fixture';
  db.prepare(`INSERT INTO owner_personal_transactions(personal_use_id,message_id,line_user_id,transaction_type,description,amount_satang,source_wallet,transaction_date,status,trace_id,submitted_by_employee_id,branch_id,reviewed_by_employee_id,approved_at,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,'msg','line','PERSONAL_USE','fixture',100,'SHOP_BANK',now,'CONFIRMED','trace','OWN001','B001','OWN001',now,now,now,1);
  db.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at) VALUES(?,?,?,?,?,'PENDING',0,?,?)`).run('j','PERSONAL_USE',id,1,'trace',now,now);
  client.getSheetRowCount=async()=>2;client.getSheetValues=async()=>[['Personal_Use_ID'],[id]];
  const env={DB:new D1(db),SHEETS_SYNC_ENABLED:'true',SHEETS_LEDGER_IDENTITY_INSPECTION:'true',SHEET_PERSONAL_USE_RAW:'V52_PERSONAL_USE_RAW'};
  const outcome=await syncJob(env,{kind:'SHEETS_SYNC',entityType:'PERSONAL_USE',entityKey:id,entityVersion:1,traceId:'trace'});
  assert.equal(outcome,'REVIEW');
  assert.equal(db.prepare(`SELECT status FROM sync_jobs WHERE job_id='j'`).get().status,'REVIEW');
  assert.equal(db.prepare(`SELECT count(*) AS n FROM sheet_row_index`).get().n,0);
  db.close();
});
test('expense sync inspection sets REVIEW before allocating RAW or writing any sheet',async()=>{
  const db=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(x=>/^\d+.*\.sql$/.test(x)).sort())db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  const now='2026-10-01T00:00:00.000Z',id='exp_fixture';
  db.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,'msg','line','fixture',100,'transfer','SHOP_BANK','ingredients',now,'CONFIRMED','trace',now);
  db.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at) VALUES(?,?,?,?,?,'PENDING',0,?,?)`).run('j','EXPENSE',id,1,'trace',now,now);
  client.getSheetRowCount=async()=>2;client.getSheetValues=async()=>[['Expense_ID'],[id]];
  const env={DB:new D1(db),SHEETS_SYNC_ENABLED:'true',SHEETS_LEDGER_IDENTITY_INSPECTION:'true',SHEET_EXPENSE_RAW:'V52_EXPENSE_RAW',SHEET_EXPENSE_DAILY:'รายวัน'};
  const outcome=await syncJob(env,{kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:id,entityVersion:1,traceId:'trace'});
  assert.equal(outcome,'REVIEW');
  assert.equal(db.prepare(`SELECT status FROM sync_jobs WHERE job_id='j'`).get().status,'REVIEW');
  assert.equal(db.prepare(`SELECT count(*) AS n FROM sheet_row_index`).get().n,0);
  db.close();
});
