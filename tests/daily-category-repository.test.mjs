import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {seedDailyCategoryBaseline,refreshDailyCategoryBaselineRow,requestDailyCategoryChange} from '../dist/sheets/daily-category-repository.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;

function harness(){
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON; CREATE TABLE expense_events(expense_id TEXT PRIMARY KEY,status TEXT,category TEXT,version INTEGER); CREATE TABLE employees(employee_id TEXT PRIMARY KEY);');
  db.exec(readFileSync(new URL('../migrations/0021_daily_category_review.sql',import.meta.url),'utf8'));
  db.exec("INSERT INTO expense_events VALUES('synthetic','CONFIRMED','general',1)");
  const DB={prepare(sql){return{bind(...args){return{async run(){const result=db.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}}}}}}}};
  return {db,env:{DB},row:{expenseId:'synthetic',rowNumber:8,metadataId:10,fingerprint:'fixture',category:'general',expenseVersion:1}};
}

test('a sheet change is held exactly once and does not modify the expense',async()=>{
  const h=harness();try{
    assert.equal(await seedDailyCategoryBaseline(h.env,h.row),true);
    assert.equal(await seedDailyCategoryBaseline(h.env,h.row),false);
    assert.ok(await requestDailyCategoryChange(h.env,h.row,'transport'));
    assert.equal(await requestDailyCategoryChange(h.env,h.row,'transport'),null);
    assert.equal(h.db.prepare("SELECT category FROM expense_events WHERE expense_id='synthetic'").get().category,'general');
    assert.equal(h.db.prepare("SELECT count(*) n FROM daily_category_requests WHERE status='PENDING'").get().n,1);
  }finally{h.db.close()}
});

test('unverified or stale baselines cannot create requests',async()=>{
  const h=harness();try{
    assert.equal(await requestDailyCategoryChange(h.env,h.row,'transport'),null);
    assert.equal(await seedDailyCategoryBaseline(h.env,{...h.row,category:'rent'}),false);
    await seedDailyCategoryBaseline(h.env,h.row);
    assert.equal(await requestDailyCategoryChange(h.env,{...h.row,fingerprint:'changed'},'transport'),null);
    assert.equal(await requestDailyCategoryChange(h.env,h.row,'not-a-category'),null);
    h.db.exec("UPDATE expense_events SET version=2 WHERE expense_id='synthetic'");
    assert.equal(await requestDailyCategoryChange(h.env,h.row,'transport'),null);
  }finally{h.db.close()}
});

test('a row can move only with the same verified metadata and no request awaiting review',async()=>{
  const h=harness();try{
    await seedDailyCategoryBaseline(h.env,h.row);
    assert.equal(await refreshDailyCategoryBaselineRow(h.env,{...h.row,rowNumber:9,metadataId:11}),false);
    const moved={...h.row,rowNumber:9};assert.equal(await refreshDailyCategoryBaselineRow(h.env,moved),true);
    assert.ok(await requestDailyCategoryChange(h.env,moved,'transport'));
    assert.equal(await refreshDailyCategoryBaselineRow(h.env,{...moved,rowNumber:10}),false);
  }finally{h.db.close()}
});
