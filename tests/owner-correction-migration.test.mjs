import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';

test('owner correction migration can be reapplied without changing existing financial records',()=>{
  const h=expenseSqlite();try{
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at)
      VALUES('exp_migration','msg_migration','fixture','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now')`).run();
    const sql=readFileSync(new URL('../migrations/0021_owner_expense_corrections.sql',import.meta.url),'utf8');h.sqlite.exec(sql);h.sqlite.exec(sql);
    assert.equal(h.sqlite.prepare('SELECT amount_satang FROM expense_events').get().amount_satang,200000);
    assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(h.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{h.close()}
});
