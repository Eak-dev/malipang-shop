// Release-schema (migrations/ only, what Production applies) checks on a real
// Miniflare D1, whatever MALIPANG_TEST_SCHEMA says: the LINE confirmation writes
// its durable outbox job, and queue recovery honours a review claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readdirSync,readFileSync,copyFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Miniflare} from 'miniflare';
import {handleExpenseImage,handleExpensePostback} from '../dist/expense/service.js';
import {confirmExpenseAtomically} from '../dist/expense/confirm.js';
import {enqueueSheetSync,recoverPendingSheetJobs} from '../dist/db/repositories.js';
import {migrationFiles} from './helpers/migration-files.mjs';

// The vars this commit would deploy; no serial flag is set there.
const releaseVars=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8')).vars;
const created='2026-01-01T00:00:00.000Z';
const reviewedJson=JSON.stringify({expenseReview:{requiredFields:['payment'],confirmedFields:['payment']}});
const snapshot={description:'sanitized fixture',amountSatang:100,transactionDate:'2026-01-01',paymentKey:'cash',sourceWallet:'CASH_DRAWER',category:'ingredients',version:1};

async function releaseD1(seed){
  const dir=mkdtempSync(join(tmpdir(),'release-d1-')),fixture=join(dir,'source.sqlite'),source=new DatabaseSync(':memory:');
  for(const {url} of migrationFiles({draft:false}))source.exec(readFileSync(url,'utf8'));
  seed(source);
  source.exec(`VACUUM INTO '${fixture.replaceAll("'","''")}'`);source.close();
  const options={modules:true,compatibilityDate:'2026-07-20',d1Databases:{DB:'release-db'},d1Persist:dir,script:'export default {async fetch(_r,e){await e.DB.prepare("SELECT 1").first();return new Response("ok")}}'};
  let mf=new Miniflare(options);await mf.dispatchFetch('http://local/');await mf.dispose();
  const folder=join(dir,'miniflare-D1DatabaseObject'),file=readdirSync(folder).find(x=>x.endsWith('.sqlite'));
  for(const ext of ['-wal','-shm'])rmSync(join(folder,file+ext),{force:true});
  copyFileSync(fixture,join(folder,file));mf=new Miniflare(options);
  return{db:await mf.getD1Database('DB'),async close(){await mf.dispose();rmSync(dir,{recursive:true,force:true});}};
}
const seedExpense=sqlite=>{
  sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at,version)
    VALUES('exp_fixture','msg_fixture','line_fixture',?,?,?,?,?,?,'WAITING_CONFIRM','trace_fixture',?,1)`)
    .run(snapshot.description,snapshot.amountSatang,snapshot.paymentKey,snapshot.sourceWallet,snapshot.category,snapshot.transactionDate,created);
  sqlite.prepare(`INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,expense_id,created_at,normalized_json,updated_at)
    VALUES('doc_fixture','doc_msg_fixture','line_fixture','RECEIPT','WAITING_CONFIRM','exp_fixture',?,?,?)`).run(created,reviewedJson,created);
};
const input={expenseId:'exp_fixture',lineUserId:'line_fixture',traceId:'trace_confirm_fixture',actorEmployeeId:'staff_fixture',branchId:'branch_fixture',snapshot,
  documentSnapshot:{documentId:'doc_fixture',normalizedJson:reviewedJson,updatedAt:created}};
const queue=()=>({messages:[],async sendBatch(batch){this.messages.push(...batch);}});

test('release schema on Miniflare D1: LINE confirmation records the expense and one outbox job',async()=>{
  const d1=await releaseD1(seedExpense);
  try{
    const columns=(await d1.db.prepare("SELECT name FROM pragma_table_info('sync_jobs')").all()).results.map(r=>r.name);
    assert.ok(!columns.some(name=>name.startsWith('serial_')),'release schema has no serial columns');
    assert.ok(!Object.keys(releaseVars).some(name=>name.startsWith('SERIAL_')),'no serial flag in the release vars');
    const q=queue(),env={...releaseVars,DB:d1.db,JOB_QUEUE:q,GOOGLE_SPREADSHEET_ID:'book'};
    assert.equal(await confirmExpenseAtomically(env,input),1);
    const expense=await d1.db.prepare("SELECT status,reviewed_by_employee_id FROM expense_events WHERE expense_id='exp_fixture'").first();
    assert.deepEqual({...expense},{status:'CONFIRMED',reviewed_by_employee_id:'staff_fixture'});
    assert.equal((await d1.db.prepare("SELECT status FROM expense_documents WHERE document_id='doc_fixture'").first()).status,'CONFIRMED');
    const jobs=(await d1.db.prepare("SELECT entity_type,entity_key,entity_version,status,attempt_count,lease_token FROM sync_jobs").all()).results.map(r=>({...r}));
    assert.deepEqual(jobs,[{entity_type:'EXPENSE',entity_key:'exp_fixture',entity_version:1,status:'PENDING',attempt_count:0,lease_token:null}]);
    assert.equal(await confirmExpenseAtomically(env,input),null,'a repeated confirm adds nothing');
    await enqueueSheetSync(env,{kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_fixture',entityVersion:1,traceId:'trace_again'});
    assert.equal((await d1.db.prepare('SELECT count(*) n FROM sync_jobs').first()).n,1,'enqueue of the same version is idempotent');
  }finally{await d1.close();}
});

test('release D1: choosing General on a bank slip resolves the category and offers an explicit Save',async t=>{
  const d1=await releaseD1(()=>{});
  t.after(()=>d1.close());
  const notifications=[];
  const jobsQueue={...queue(),async send(job){notifications.push(job);}};
  const env={...releaseVars,DB:d1.db,JOB_QUEUE:jobsQueue,RUNTIME_MODE:'shadow',SHADOW_LINE_OUTPUT:'true',SHEETS_SYNC_ENABLED:'true'};
  const replies=[];
  let failNextReply=false;
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(String(url),'https://api.line.me/v2/bot/message/reply');
    replies.push(JSON.parse(init.body).messages[0]);
    if(failNextReply){failNextReply=false;return new Response('',{status:503});}
    return new Response('{}');
  });
  const source={type:'user',userId:'line_fixture'},actor={employeeId:'staff_fixture',canSubmitExpense:true};
  const buttonData=()=>replies.at(-1).contents.footer.contents.map(button=>button.action.data);
  const click=data=>handleExpensePostback(env,{source,replyToken:'test-reply',postback:{data}},actor);
  for(const legacy of [false,true]){
    const id=legacy?'old':'new';
    const document={documentType:'BANK_SLIP',channel:legacy?'BANK':'G_WALLET',institution:'Fixture bank or wallet',
      transactionType:legacy?'PAYMENT':'WALLET_PAYMENT',transactionStatus:'SUCCESS',
      paymentDate:'2026-01-15',paymentTime:'10:34',printedYear:'26',referenceId:'FIXTURE-'+id,sender:'',senderAccountMasked:'',
      recipient:'Fixture supplier',recipientAccountMasked:'',merchant:'Fixture supplier',grossAmountBaht:null,discountAmountBaht:null,paidAmountBaht:17.25,
      currency:'THB',suggestedDescription:'Fixture supplies',suggestedCategory:'general',confidence:0.98,needsReview:true,note:'category'};
    await handleExpenseImage(env,{source,replyToken:'test-image',message:{type:'image',id}},
      {kind:'BANK_SLIP',document,confidence:0.98,raw:{},note:''},'fixture',id,'hash-'+id,actor);
    const expense=await d1.db.prepare('SELECT expense_id FROM expense_documents WHERE message_id=?').bind(id).first('expense_id');
    const menu='a=expense_category_menu&id='+expense,save='a=expense_confirm&id='+expense;
    const state=()=>d1.db.prepare('SELECT normalized_json,status FROM expense_documents WHERE expense_id=?').bind(expense).first();
    const jobs=()=>d1.db.prepare('SELECT COUNT(*) n FROM sync_jobs WHERE entity_key=?').bind(expense).first('n');
    const audits=action=>d1.db.prepare('SELECT COUNT(*) n FROM expense_audit_log WHERE expense_id=? AND action=?').bind(expense,action).first('n');
    // Older open drafts may predate stored review fields. Their General value alone is insufficient.
    if(legacy)await d1.db.prepare("UPDATE expense_documents SET normalized_json=json_remove(normalized_json,'$.expenseReview') WHERE expense_id=?").bind(expense).run();
    await click(save);
    assert.match(JSON.stringify(replies.at(-1).contents.body),legacy?/Bank slip/:/G-Wallet receipt/);
    assert.ok(buttonData().includes(menu));
    assert.ok(!buttonData().includes(save));
    await click(menu);
    const choice=buttonData().find(data=>data.endsWith('&category=general'));
    assert.ok(choice);
    failNextReply=legacy; // An unavailable LINE reply must preserve the committed choice on replay.
    await click(choice);
    const reviewed=await state(),review=JSON.parse(reviewed.normalized_json).expenseReview;
    assert.ok(review?.confirmedFields.includes('category'),'explicit General must survive the postback');
    assert.ok(review.requiredFields.includes('category'));
    if(legacy)assert.ok(notifications.some(job=>job.kind==='LINE_NOTIFICATION'&&job.messages[0].contents.footer.contents.some(button=>button.action.data===save)));
    assert.ok(buttonData().includes(save),'the actual review reply must offer Save');
    assert.ok(!buttonData().includes(menu));
    assert.equal(reviewed.status,'WAITING_CONFIRM');
    assert.equal(await jobs(),0);
    await click(choice);
    assert.ok(buttonData().includes(save));
    assert.equal(await audits('EDIT'),1);
    assert.equal(await audits('CONFIRM'),0);
    assert.equal(await jobs(),0);
    await click(save);
    await click(save);
    assert.equal((await state()).status,'CONFIRMED');
    const saved=await d1.db.prepare('SELECT status,category,payment_key,source_wallet FROM expense_events WHERE expense_id=?').bind(expense).first();
    assert.deepEqual({...saved},{status:'CONFIRMED',category:'general',payment_key:'transfer',source_wallet:'SHOP_BANK'});
    assert.equal(await audits('CONFIRM'),1);
    assert.equal(await jobs(),1);
  }
});

test('release schema on Miniflare D1: recovery sends nothing while a review claim holds the workbook, and sends once it is clear',async()=>{
  const stale='2000-01-01T00:00:00.000Z';
  const seed=claim=>sqlite=>{
    seedExpense(sqlite);
    sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token)
      VALUES('job_fixture','EXPENSE','exp_fixture',1,'trace_fixture','PENDING',0,?,NULL,NULL,NULL)`).run(stale);
    if(claim)sqlite.prepare(`INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,notice_stamp,notice_identity,created_at,updated_at,phase,review_reason)
      VALUES('book','claim-token','REVIEW','stamp','identity',?,?,'OPERATION','INSERT_DAILY_SNAPSHOT_UNVERIFIED')`).run(stale,stale);
  };
  for(const claim of [true,false]){
    const d1=await releaseD1(seed(claim));
    try{
      const q=queue(),env={...releaseVars,DB:d1.db,JOB_QUEUE:q,GOOGLE_SPREADSHEET_ID:'book'};
      const sent=await recoverPendingSheetJobs(env,0);
      const job=await d1.db.prepare("SELECT status,attempt_count FROM sync_jobs WHERE job_id='job_fixture'").first();
      if(claim){
        assert.equal(sent,0);assert.equal(q.messages.length,0);
        assert.deepEqual({...job},{status:'PENDING',attempt_count:0},'the blocked job stays durable');
      }else{
        assert.equal(sent,1);assert.equal(q.messages.length,1);
        assert.deepEqual(q.messages[0].body,{kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_fixture',entityVersion:1,traceId:q.messages[0].body.traceId});
      }
    }finally{await d1.close();}
  }
});
