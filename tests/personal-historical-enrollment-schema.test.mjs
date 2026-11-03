import test from 'node:test';
import assert from 'node:assert/strict';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
const code=ts.transpileModule(readFileSync(new URL('../src/sheets/personal-historical-enrollment-integrity.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,mod={exports:{}};
new Function('module','exports',code)(mod,mod.exports);

function insertIntent(db,id='personal_a',metadata=17){db.prepare(`INSERT INTO personal_historical_enrollment_intents(spreadsheet_id,sheet_name,personal_use_id,sheet_id,metadata_id,source_version,source_revision,source_fingerprint,cutover_generation,admission_watermark,admission_sequence,month,operation_token,outer_token,baseline_json,state,updated_at) VALUES('book','personal',?,1,?,2,3,?,'generation_a',5,2,'2026-10','operation_token','outer_token','{}','IN_FLIGHT','now')`).run(id,metadata,'a'.repeat(64));}

test('historical reservation registers a permanent workbook-global metadata owner',()=>{
  const h=expenseSqlite();try{
    h.sqlite.exec("INSERT INTO personal_raw_enrollment_locks VALUES('book','personal','personal_a',17,'HELD','operation_token','outer_token','generation_a','now')");
    insertIntent(h.sqlite);
    const owner=h.sqlite.prepare('SELECT sheet_name,entity_kind,entity_id FROM sheet_metadata_identity_registry WHERE spreadsheet_id=? AND metadata_id=?').get('book',17);
    assert.deepEqual({...owner},{sheet_name:'personal',entity_kind:'PERSONAL_USE',entity_id:'personal_a'});
    assert.throws(()=>insertIntent(h.sqlite,'personal_other',17),/CONFLICT|EXISTS|LOCK_REQUIRED/);
    assert.throws(()=>h.sqlite.exec("DELETE FROM personal_historical_enrollment_intents"),/IMMUTABLE/);
    assert.throws(()=>h.sqlite.exec("UPDATE personal_historical_enrollment_intents SET metadata_id=18"),/IMMUTABLE/);
  }finally{h.close();}
});

test('historical unknown outcome is quarantined and cannot become verified or release the common lock',()=>{
  const h=expenseSqlite();try{
    h.sqlite.exec("INSERT INTO personal_raw_enrollment_locks VALUES('book','personal','personal_a',17,'HELD','operation_token','outer_token','generation_a','now')");
    insertIntent(h.sqlite);
    h.sqlite.exec("UPDATE personal_historical_enrollment_intents SET state='REVIEW'; UPDATE personal_raw_enrollment_locks SET state='REVIEW'");
    assert.throws(()=>h.sqlite.exec("UPDATE personal_historical_enrollment_intents SET state='VERIFIED'"),/HISTORICAL_RECOVERY_REQUIRED/);
    assert.throws(()=>h.sqlite.exec("DELETE FROM personal_raw_enrollment_locks"),/PERSONAL_ENROLLMENT_REVIEW_REQUIRED/);
    assert.throws(()=>h.sqlite.exec("INSERT INTO personal_raw_enrollment_locks VALUES('book','personal','personal_b',18,'HELD','other','other','generation_a','now')"),/PERSONAL_ENROLLMENT_REVIEW_REQUIRED|UNIQUE/);
  }finally{h.close();}
});

test('historical admission cannot represent a non-October or post-watermark item',()=>{
  const h=expenseSqlite();try{
    h.sqlite.exec("INSERT INTO personal_raw_enrollment_locks VALUES('book','personal','personal_a',17,'HELD','operation_token','outer_token','generation_a','now')");
    insertIntent(h.sqlite);
    assert.throws(()=>h.sqlite.exec("UPDATE personal_historical_enrollment_intents SET month='2026-11'"),/IMMUTABLE/);
    assert.throws(()=>h.sqlite.exec("INSERT INTO personal_historical_enrollment_intents SELECT spreadsheet_id,sheet_name,'personal_b',sheet_id,18,source_version,source_revision,source_fingerprint,cutover_generation,1,2,month,'op2','out2',baseline_json,state,updated_at FROM personal_historical_enrollment_intents"),/CHECK|LOCK_REQUIRED/);
  }finally{h.close();}
});

test('historical schema guard detects missing or modified triggers',()=>{
  const h=expenseSqlite();try{
    const check=()=>h.sqlite.prepare(`SELECT CASE WHEN ${mod.exports.historicalEnrollmentIntegrity} THEN 1 ELSE 0 END AS ok`).get().ok;
    assert.equal(check(),1);
    h.sqlite.exec("CREATE TRIGGER historical_injected AFTER UPDATE ON personal_historical_enrollment_intents BEGIN SELECT 1; END");
    assert.equal(check(),0);
    h.sqlite.exec('DROP TRIGGER historical_injected');
    assert.equal(check(),1);
    h.sqlite.exec('DROP TRIGGER personal_historical_identity_transition');
    assert.equal(check(),0);
    h.sqlite.exec("CREATE TRIGGER personal_historical_identity_transition BEFORE UPDATE OF state ON personal_historical_enrollment_intents BEGIN SELECT 1; END");
    assert.equal(check(),0);
  }finally{h.close();}
});
