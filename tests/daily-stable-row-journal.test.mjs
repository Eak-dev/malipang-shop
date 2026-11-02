import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
import {StableDailyJournal} from '../dist/sheets/daily-stable-row-journal.js';

const migration=readFileSync(new URL('../migrations/0023_daily_stable_row_intents.sql',import.meta.url),'utf8');
const baseline=()=>{const row=Array(25).fill(null);row[23]='MALIPANG_EXPENSE:exp_test';return row;};
function setup(){const h=expenseSqlite();h.sqlite.exec(migration);Object.assign(h.env,{RUNTIME_MODE:'shadow',DAILY_STABLE_ID_PROTOTYPE_ENABLED:'true'});h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_test','msg','fixture','Synthetic',93000,'transfer','SHOP_BANK','marketing','2026-10-26','CONFIRMED','now',1)`).run();return h;}

test('journal records metadata ID without row and holds uncertain operations forever',async()=>{
  const h=setup();try{const journal=new StableDailyJournal(h.env,'uat-sheet','exp_test',1),id=await journal.reserve();assert.ok(id>0);assert.equal(await journal.matchesReserved(id),true);await assert.rejects(journal.reserve(),/PRIOR_INTENT_REQUIRES_REVIEW/);assert.equal(await journal.finish(id,baseline()),true);assert.equal((await journal.get()).state,'VERIFIED');await assert.rejects(journal.reserve(),/PRIOR_INTENT_REQUIRES_REVIEW/);assert.deepEqual(h.sqlite.prepare('PRAGMA table_info(daily_stable_row_intents)').all().filter(r=>r.name.includes('row_number')),[]);}finally{h.close();}
});

test('concurrent duplicate reservation and changed source fail closed',async()=>{
  const h=setup();try{const a=new StableDailyJournal(h.env,'uat-sheet','exp_test',1),b=new StableDailyJournal(h.env,'uat-sheet','exp_test',1),results=await Promise.allSettled([a.reserve(),b.reserve()]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);h.sqlite.prepare(`UPDATE expense_events SET version=2 WHERE expense_id='exp_test'`).run();const id=(await a.get()).metadataId;assert.equal(await a.finish(id,baseline()),false);assert.equal((await a.get()).state,'IN_FLIGHT');}finally{h.close();}
});

test('newer version atomically enters hold and stores new baseline only after verification',async()=>{
  const h=setup();try{const first=new StableDailyJournal(h.env,'uat-sheet','exp_test',1),id=await first.reserve();assert.equal(await first.finish(id,baseline()),true);
    h.sqlite.prepare(`UPDATE expense_events SET version=2 WHERE expense_id='exp_test'`).run();const next=new StableDailyJournal(h.env,'uat-sheet','exp_test',2);
    assert.equal(await next.beginUpdate(id,1),true);assert.equal((await next.get()).state,'IN_FLIGHT');assert.equal(await next.beginUpdate(id,1),false);
    const revised=baseline();revised[3]='changed';assert.equal(await next.finish(id,revised),true);const result=await next.get();assert.equal(result.projectedVersion,2);assert.equal(result.baseline[3],'changed');
  }finally{h.close();}
});

test('journal is unavailable in production and migration is idempotent',async()=>{
  const h=setup();try{h.sqlite.exec(migration);h.env.RUNTIME_MODE='production';await assert.rejects(new StableDailyJournal(h.env,'uat-sheet','exp_test',1).reserve(),/DISABLED/);assert.equal(h.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);}finally{h.close();}
});
