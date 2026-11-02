import test from 'node:test';
import assert from 'node:assert/strict';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
import {handleAdmin} from '../dist/admin/handler.js';

const token='synthetic-admin-token-01234567890123456789';
const request=(authorized=true)=>new Request('https://example.test/admin/uat/daily-stable-row',{method:'POST',headers:authorized?{authorization:`Bearer ${token}`}:{}});

test('UAT endpoint requires admin auth and is unavailable in production even if flag is set',async()=>{
  const h=expenseSqlite();try{
    Object.assign(h.env,{ADMIN_TOKEN:token,RUNTIME_MODE:'production',DAILY_STABLE_ID_PROTOTYPE_ENABLED:'true'});
    assert.equal((await handleAdmin(request(false),h.env,{})).status,401);
    assert.equal((await handleAdmin(request(),h.env,{})).status,404);
    assert.equal(h.sqlite.prepare('SELECT count(*) n FROM sync_jobs').get().n,0);
  }finally{h.close();}
});

test('UAT endpoint refuses unmarked database without touching Google or exposing IDs',async()=>{
  const h=expenseSqlite(),old=globalThis.fetch;try{
    Object.assign(h.env,{ADMIN_TOKEN:token,RUNTIME_MODE:'shadow',DAILY_STABLE_ID_PROTOTYPE_ENABLED:'true',DAILY_STABLE_UAT_SPREADSHEET_ID:'uat',DAILY_STABLE_PRODUCTION_SPREADSHEET_ID:'production',DAILY_STABLE_UAT_DATABASE_MARKER:'fixture',GOOGLE_SPREADSHEET_ID:'uat',DAILY_STABLE_UAT_EXCLUSIVE_EDITORS:'true',DAILY_STABLE_UAT_NEW_EXPENSE_ID:'exp_uat'});
    let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('unexpected external call');};
    const response=await handleAdmin(request(),h.env,{}),body=await response.json();assert.equal(response.status,409);assert.deepEqual(body,{ok:false,result:'REVIEW'});assert.equal(calls,0);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM sheet_row_index').get().n,0);
  }finally{globalThis.fetch=old;h.close();}
});
