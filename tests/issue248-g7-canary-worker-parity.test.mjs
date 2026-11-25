// Issue 248 G7 canary: the provider-side SQL digest equals the compiled Worker's
// readStableExpenseSource digest for the same D1 rows. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
import {readStableExpenseSource} from '../dist/sheets/stable-expense-source.js';
import {canarySourceSql,canarySourceDigest,SELFTEST_DIGEST,EXPENSE_COLUMNS} from '../scripts/issue248-canary-source-digest.mjs';

const cases=[
 {description:'SYNTHETIC tip ทิป 😀',trace_id:null,updated_at:null},
 {description:'quote " backslash \\ slash / newline \n tab \t cr \r bs \b ff \f c1 \u0001 c31 \u001f del \u007f ls   ps  ',trace_id:'trace_synthetic',updated_at:'2026-11-10T01:00:00.000Z',submitted_by_employee_id:'emp_synthetic',branch_id:'branch_synthetic',reviewed_by_employee_id:'emp_reviewer',approved_at:'2026-11-10T02:00:00.000Z'},
 {description:'d'.repeat(3000)+'ก',amount_satang:123456789,version:7}
];
test('provider-side SQL digest equals the compiled Worker digest for synthetic canary rows',async()=>{
 for(const [i,extra] of cases.entries()){
  const h=expenseSqlite();try{
   h.env.GOOGLE_SPREADSHEET_ID='book';const batch=h.DB.batch;h.DB.batch=async function(statements){return(await batch.call(this,statements)).map(result=>({...result,success:true}));};
   const version=extra.version??1,key='exp_parity_'+i;
   const row={expense_id:key,message_id:'m_parity_'+i,line_user_id:'U_SYNTHETIC_PRIVATE_'+i,amount_satang:500,payment_key:'CASH',source_wallet:'SHOP_BANK',category:'tip',transaction_date:'2026-11-10',status:'CONFIRMED',created_at:'2026-11-10T00:00:00.000Z',...extra,version};
   h.sqlite.exec("UPDATE stable_sync_cutover SET state='ACTIVE',activated_at='now'");
   const cols=Object.keys(row);h.sqlite.prepare(`INSERT INTO expense_events(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...Object.values(row));
   h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('job','EXPENSE',?,?,'fixture','PROCESSING','now','2099-01-01T00:00:00.000Z','lease')").run(key,version);
   h.sqlite.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','claim','HELD','now','now')");
   const worker=await readStableExpenseSource(h.env,{kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:key,entityVersion:version,traceId:'fixture'},'lease','claim');
   assert.ok(worker,'worker source read '+i);
   const legacyRow=h.sqlite.prepare(`SELECT ${EXPENSE_COLUMNS.join(',')} FROM expense_events WHERE expense_id=?`).get(key);
   const legacyDigest=createHash('sha256').update(JSON.stringify({expense:legacyRow,links:[],documents:[],items:[]})).digest('hex');
   assert.equal(worker.digest,legacyDigest,'0070 preserves pre-migration source hash');
   const previous=h.DB.batch;h.DB.batch=async function(statements){const r=await previous.call(this,statements);if(r[0]?.results?.[0])delete r[0].results[0].serial_source_namespace;return r;};
   const beforeMigration=await readStableExpenseSource(h.env,{kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:key,entityVersion:version,traceId:'fixture'},'lease','claim');
   assert.equal(beforeMigration?.digest,worker.digest,'Worker v1 hash matches the old row shape');assert.deepEqual([worker.links.length,worker.documents.length,worker.items.length],[0,0,0]);
   const x=h.sqlite.prepare(canarySourceSql(key,version)).get();
   assert.equal(x.selftest,SELFTEST_DIGEST);assert.equal(x.digest,worker.digest,'case '+i);assert.equal(x.rev,worker.revision);
   assert.equal(canarySourceDigest([{success:true,meta:{changed_db:false,rows_written:0},results:[x]}],{targetKey:key,targetVersion:version,epochRevision:worker.revision}).digest,worker.digest);
  }finally{h.close()}
 }
});

test('provider SQL accepts the exact pre-0070 schema and rejects unknown schema',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(`CREATE TABLE expense_events (${EXPENSE_COLUMNS.map(c=>c+' '+(['amount_satang','version'].includes(c)?'INTEGER':'TEXT')).join(',')});
   CREATE TABLE stable_source_revision(singleton INTEGER,revision INTEGER);INSERT INTO stable_source_revision VALUES(1,1);
   CREATE TABLE expense_document_links(expense_id TEXT);CREATE TABLE expense_documents(expense_id TEXT,document_id TEXT);CREATE TABLE expense_document_items(expense_id TEXT);`);
  const row=Object.fromEntries(EXPENSE_COLUMNS.map(c=>[c,null]));Object.assign(row,{expense_id:'exp_legacy',version:1,status:'CONFIRMED'});
  db.prepare(`INSERT INTO expense_events(${EXPENSE_COLUMNS.join(',')}) VALUES(${EXPENSE_COLUMNS.map(()=>'?').join(',')})`).run(...Object.values(row));
  const result=db.prepare(canarySourceSql('exp_legacy',1)).get();
  assert.equal(result.digest,createHash('sha256').update(JSON.stringify({expense:row,links:[],documents:[],items:[]})).digest('hex'));
  db.exec('ALTER TABLE expense_events ADD COLUMN unknown_field TEXT');
  assert.equal(db.prepare(canarySourceSql('exp_legacy',1)).get(),undefined);
 }finally{db.close()}
});
