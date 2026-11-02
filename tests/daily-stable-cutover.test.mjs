import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
import {activateStableShadowCutover,classifyStableShadowSource} from '../dist/sheets/daily-stable-cutover.js';
const ids=readFileSync(new URL('../migrations/0023_daily_stable_row_intents.sql',import.meta.url),'utf8');
const admission=readFileSync(new URL('../migrations/0024_daily_stable_admissions.sql',import.meta.url),'utf8');
function setup(){const h=expenseSqlite();h.sqlite.exec(ids);h.sqlite.exec(admission);h.sqlite.exec("CREATE TABLE daily_stable_uat_guard(marker TEXT); INSERT INTO daily_stable_uat_guard VALUES('fixture');");Object.assign(h.env,{RUNTIME_MODE:'shadow',DAILY_STABLE_ID_PROTOTYPE_ENABLED:'true',DAILY_STABLE_UAT_SPREADSHEET_ID:'uat',DAILY_STABLE_PRODUCTION_SPREADSHEET_ID:'prod',DAILY_STABLE_UAT_DATABASE_MARKER:'fixture',GOOGLE_SPREADSHEET_ID:'uat',DAILY_STABLE_UAT_EXCLUSIVE_EDITORS:'true',SHEET_EXPENSE_DAILY:'daily'});h.sqlite.prepare("INSERT INTO daily_stable_cutovers(spreadsheet_id,sheet_name,generation,state,created_at) VALUES('uat','daily','fixture_1','PREPARED','now')").run();return h;}
function add(h,id,version=1){h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES(?,?,?,'Synthetic',93000,'transfer','SHOP_BANK','marketing','2026-10-26','CONFIRMED','now',?)`).run(id,`msg_${id}`,'fixture',version);}

test('cutover watermark is atomic and only a new post-cutover source can be appended',async()=>{
  const h=setup();try{add(h,'exp_before');assert.equal(await activateStableShadowCutover(h.env,'fixture_1'),true);assert.equal(await activateStableShadowCutover(h.env,'fixture_1'),false);add(h,'exp_after');
    assert.equal((await classifyStableShadowSource(h.env,'exp_before',1)).reason,'DAILY_STABLE_LEGACY_REVIEW_REQUIRED');assert.deepEqual(await classifyStableShadowSource(h.env,'exp_after',1),{kind:'NEW',generation:'fixture_1',watermark:1});
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM daily_stable_source_admissions').get().n,2);
  }finally{h.close();}
});
test('unindexed old source, split mapping and unverified later first version are held',async()=>{
  const h=setup();try{add(h,'exp_old');await activateStableShadowCutover(h.env,'fixture_1');add(h,'exp_split');add(h,'exp_later',2);h.sqlite.prepare("INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES('daily','exp_split|item',7)").run();
    assert.equal((await classifyStableShadowSource(h.env,'exp_old',1)).reason,'DAILY_STABLE_LEGACY_REVIEW_REQUIRED');assert.equal((await classifyStableShadowSource(h.env,'exp_split',1)).reason,'DAILY_STABLE_LEGACY_REVIEW_REQUIRED');assert.equal((await classifyStableShadowSource(h.env,'exp_later',2)).reason,'DAILY_STABLE_FIRST_PROJECTION_VERSION_UNVERIFIED');
  }finally{h.close();}
});
test('an in-flight journal or inactive boundary never authorizes projection',async()=>{
  const h=setup();try{add(h,'exp_test');assert.equal((await classifyStableShadowSource(h.env,'exp_test',1)).reason,'DAILY_STABLE_CUTOVER_NOT_ACTIVE');await activateStableShadowCutover(h.env,'fixture_1');add(h,'exp_new');h.sqlite.prepare("INSERT INTO daily_stable_row_intents(spreadsheet_id,expense_id,metadata_id,state,expense_version,created_at,updated_at) VALUES('uat','exp_new',10,'IN_FLIGHT',1,'now','now')").run();assert.equal((await classifyStableShadowSource(h.env,'exp_new',1)).reason,'DAILY_STABLE_PRIOR_INTENT_REQUIRES_REVIEW');
  }finally{h.close();}
});
test('migration is idempotent and production never gains activation authority',async()=>{
  const h=setup();try{h.sqlite.exec(admission);h.env.RUNTIME_MODE='production';await assert.rejects(activateStableShadowCutover(h.env,'fixture_1'),/NOT_AUTHORIZED/);assert.equal((await classifyStableShadowSource(h.env,'exp_test',1)).reason,'DAILY_STABLE_UAT_UNVERIFIED');assert.equal(h.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);}finally{h.close();}
});
