import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url),{resolvePublicationTarget}=require('../dist/sheets/continuous-publication-route.js');
test('publication configuration is inert until explicitly enabled and rejects invalid flags',async()=>{
 const h=expenseSqlite();try{h.env.GOOGLE_SPREADSHEET_ID='book';assert.equal(await resolvePublicationTarget(h.env),null);h.env.CONTINUOUS_PUBLICATION_ENABLED='false';assert.equal(await resolvePublicationTarget(h.env),null);h.env.CONTINUOUS_PUBLICATION_ENABLED='true';await assert.rejects(resolvePublicationTarget(h.env),/CONFIG_INVALID/);h.env.CONTINUOUS_PUBLICATION_ENABLED='yes';await assert.rejects(resolvePublicationTarget(h.env),/CONFIG_INVALID/);}finally{h.close();}
});
test('disabling publication after its target exists fails closed',async()=>{
 const h=expenseSqlite();try{h.env.GOOGLE_SPREADSHEET_ID='book';h.sqlite.exec("DROP TRIGGER continuous_publication_target_insert; INSERT INTO continuous_publication_targets(spreadsheet_id,sheet_id,sheet_name,row_count,bootstrap_digest,created_at) VALUES('book',7,'pub',3,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','now')");await assert.rejects(resolvePublicationTarget(h.env),/DISABLE_UNSAFE/);}finally{h.close();}
});
