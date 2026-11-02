import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {reconcileSheets} from '../dist/admin/reconcile-sheets.js';

class Statement {
  constructor(db,sql){this.db=db;this.sql=sql;this.args=[];}
  bind(...args){this.args=args;return this;}
  async all(){return{results:this.db.prepare(this.sql).all(...this.args)};}
  async run(){if(/^\s*SELECT/i.test(this.sql))return{results:this.db.prepare(this.sql).all(...this.args),meta:{changes:0}};return{meta:{changes:Number(this.db.prepare(this.sql).run(...this.args).changes)}};}
}
function setup(){
  const db=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>/^\d+.*\.sql$/.test(n)).sort())db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  const DB={prepare(sql){return new Statement(db,sql);},async batch(statements){db.exec('BEGIN');try{const result=[];for(const stmt of statements)result.push(await stmt.run());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};
  const sent=[];return{db,sent,env:{DB,SHEETS_SYNC_ENABLED:'true',JOB_QUEUE:{async sendBatch(messages){sent.push(...messages.map(m=>m.body));}}}};
}
test('pagination covers over 500 matching expenses and eligible cancellations without repeating finished types',async()=>{
  const {db,sent,env}=setup();
  try{
    const insert=db.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at,version) VALUES(?,?,?,'fixture',100,'cash','CASH_DRAWER','ingredients','2026-10-01',?,'trace','2026-10-01T00:00:00.000Z',?)`);
    for(let i=0;i<503;i++)insert.run(`expense_${String(i).padStart(4,'0')}`,`msg_${i}`,'user','CONFIRMED',i===2?3:1);
    insert.run('cancelled_synced','msg_sync','user','CANCELLED',2);
    insert.run('cancelled_indexed','msg_index','user','CANCELLED',2);
    insert.run('cancelled_draft','msg_draft','user','CANCELLED',1);
    db.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('job_old','EXPENSE','cancelled_synced',1,'trace','COMPLETED',1,'2026-10-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES('expense','cancelled_indexed',4)`).run();
    let cursors,passes=0,review=[];
    do{
      const result=await reconcileSheets(env,{fromDate:'2026-10-01',toDate:'2026-10-01',limitPerType:200,...(cursors?{cursors}:{})});
      assert.equal(result.counts.EXPENSE,passes<2?200:105);
      review.push(...result.cancellationReview);
      assert.equal(result.cancellationReviewCount,result.cancellationReview.length);
      assert.equal(result.held,0);
      cursors=result.hasMore?result.cursors:null;passes++;
    }while(cursors&&passes<5);
    assert.equal(passes,3);const expenses=sent.filter(j=>j.entityType==='EXPENSE');
    assert.equal(expenses.length,503);assert.equal(new Set(expenses.map(j=>j.entityKey)).size,503);
    assert.deepEqual(review.map(item=>[item.entityKey,item.entityVersion,item.reason]),[['cancelled_indexed',2,'CANCELLATION_ROW_IDENTITY_UNVERIFIED'],['cancelled_synced',2,'CANCELLATION_ROW_IDENTITY_UNVERIFIED']]);
    assert.equal(expenses.some(j=>j.entityKey==='cancelled_draft'),false);
    assert.equal(expenses.find(j=>j.entityKey==='expense_0002').entityVersion,3);
    assert.equal(expenses.some(j=>j.entityKey==='cancelled_synced'||j.entityKey==='cancelled_indexed'),false);
  }finally{db.close();}
});
test('invalid cursors and page limits are rejected before any database query',async()=>{
  const env={DB:{prepare(){throw new Error('unexpected database query');}}};
  await assert.rejects(reconcileSheets(env,{cursors:{EXPENSE:{date:'bad',key:'x'}}}),/Invalid reconcile cursor/);
  await assert.rejects(reconcileSheets(env,{limitPerType:501}),/limitPerType/);
});
