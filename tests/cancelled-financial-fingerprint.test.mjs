import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url);
const {cancelledProjectionSnapshot,cancelledFinancialFingerprint}=require('../dist/sheets/cancelled-financial-fingerprint.js');

function fixture(){
 const h=expenseSqlite(),s=h.sqlite,job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_fixture',entityVersion:2};
 h.env.GOOGLE_SPREADSHEET_ID='book';
 s.exec("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_fixture','msg','owner','fixture',100,'transfer','SHOP_BANK','ingredients','2026-11-15','CANCELLED','now',2)");
 s.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE','exp_fixture','DAILY',2,'draft',1,?,'prior','VERIFIED','now')").run('a'.repeat(64));
 s.prepare("INSERT INTO stable_expense_projection_preimages(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,preimage_width,preimage_digest,created_at) VALUES('book','EXPENSE','exp_fixture','DAILY',2,'draft',1,?,29,?,'now')").run('a'.repeat(64),'b'.repeat(64));
 const read=async()=>{const [expense,projection]=await h.DB.batch([h.DB.prepare("SELECT * FROM expense_events WHERE expense_id='exp_fixture'"),cancelledProjectionSnapshot(h.env,job)]);return cancelledFinancialFingerprint(job,expense.results[0],projection.results,{state:'STAGED',detailCount:0});};
 return{...h,job,read};
}
test('supporting document changes do not alter a cancellation financial fingerprint',async()=>{
 const h=fixture();try{const before=await h.read();assert.match(before,/^[0-9a-f]{64}$/);h.sqlite.exec("INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,created_at,expense_id) VALUES('doc','other_msg','owner','RECEIPT','WAITING_REVIEW','now',NULL); INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,created_at) VALUES('link','exp_fixture','doc','SUPPORTING_DOCUMENT','EXACT_IDENTIFIER','now')");assert.equal(await h.read(),before);}finally{h.close();}
});
test('financial source and journal changes invalidate the fingerprint',async()=>{
 const h=fixture();try{const before=await h.read();h.sqlite.exec("UPDATE expense_events SET amount_satang=200 WHERE expense_id='exp_fixture'");assert.notEqual(await h.read(),before);h.sqlite.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE','exp_fixture','EXPENSE_RAW',3,'raw',1,?,'raw','IN_FLIGHT','now')").run('a'.repeat(64));assert.equal(await h.read(),null);}finally{h.close();}
});
test('wrong expense identity, missing preimage, and malformed prior version fail closed',async()=>{
 const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_test',entityVersion:2};
 const expense={expense_id:'exp_test',version:2,status:'CANCELLED'};
 const base={entity_id:'exp_test',projection:'DAILY',sheet_id:2,sheet_name:'draft',source_version:1,source_digest:'a'.repeat(64),operation_token:'op',state:'VERIFIED',preimage_sheet_id:2,preimage_sheet_name:'draft',preimage_source_version:1,preimage_source_digest:'a'.repeat(64),preimage_width:29,preimage_digest:'b'.repeat(64)};
 const staged={state:'STAGED',detailCount:0},published={state:'PUBLISHED',detailCount:0};
 assert.equal(await cancelledFinancialFingerprint(job,{...expense,expense_id:'exp_other'},[base],staged),null);
 assert.equal(await cancelledFinancialFingerprint(job,expense,[{...base,preimage_digest:null}],staged),null);
 assert.equal(await cancelledFinancialFingerprint(job,expense,[{...base,source_version:0}],staged),null);
 assert.equal(await cancelledFinancialFingerprint(job,expense,[base,base],staged),null);
 assert.equal(await cancelledFinancialFingerprint(job,expense,[base],published),null);
 const raw={...base,projection:'EXPENSE_RAW',sheet_id:3,sheet_name:'raw',preimage_sheet_id:3,preimage_sheet_name:'raw'};
 assert.match(await cancelledFinancialFingerprint(job,expense,[base,raw],published),/^[0-9a-f]{64}$/);
 assert.equal(await cancelledFinancialFingerprint(job,expense,[base,raw],{state:'PUBLISHED',detailCount:1}),null);
});
