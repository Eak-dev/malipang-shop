import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {bootstrapDailyCategoryRows} from '../dist/sheets/daily-category-bootstrap-service.js';
import {observeDailyCategoryChanges} from '../dist/sheets/daily-category-observer.js';

test('bootstrap verifies current rows, creates stable identities once, then observes a dropdown request',async()=>{
  const h=ownerOrderFixture();try{
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_boot','msg_boot','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
    Object.assign(h.env,{SHEET_EXPENSE_DAILY:'daily',SHEET_EXPENSE_RAW:'raw',SHEET_PURCHASE_DETAILS:'detail'});
    const daily=Array.from({length:100},()=>[]);daily[1]=Array(8).fill(null);daily[1][7]='เงินโอน';daily[4]=[2026];daily[99]=Array(23).fill(null);Object.assign(daily[99],{1:10,2:28,3:'Driver',7:2000,21:'general'});
    const raw=[[],['exp_boot','2026-10-28','Driver',2000,'transfer','SHOP_BANK','general','CONFIRMED']],metadata=[];let next=10;
    const ports={sheetId:async(_env,name)=>({daily:1,raw:2,detail:3})[name],values:async(_env,range)=>range.startsWith("'daily'")?daily:range.startsWith("'raw'")?raw:[],metadata:async(_env,key)=>metadata.filter(item=>item.metadataKey===key),
      create:async(_env,rows)=>rows.map(row=>{const result={...row,metadataId:next++};metadata.push(result);return result})};
    assert.deepEqual(await bootstrapDailyCategoryRows(h.env,ports),{ready:1,registered:1,conflicts:0,remaining:0});
    assert.deepEqual(await bootstrapDailyCategoryRows(h.env,ports),{ready:0,registered:0,conflicts:0,remaining:0});
    daily[99][21]='transport';assert.deepEqual(await observeDailyCategoryChanges(h.env,ports),{baselined:0,requested:1,conflicts:0});
    assert.equal(h.sqlite.prepare("SELECT category FROM expense_events WHERE expense_id='exp_boot'").get().category,'general');
    assert.equal(h.sqlite.prepare("SELECT to_category FROM daily_category_requests WHERE status='PENDING'").get().to_category,'transport');
    daily[99][21]='rent';assert.deepEqual(await observeDailyCategoryChanges(h.env,ports),{baselined:0,requested:1,conflicts:0});
    assert.equal(h.sqlite.prepare("SELECT to_category FROM daily_category_requests WHERE status='PENDING'").get().to_category,'rent');
    assert.equal(h.sqlite.prepare("SELECT to_category FROM daily_category_requests WHERE status='STALE'").get().to_category,'transport');
    daily[99][21]='general';await observeDailyCategoryChanges(h.env,ports);
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM daily_category_requests WHERE status='PENDING'").get().n,0);
  }finally{h.close()}
});
