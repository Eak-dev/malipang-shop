import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {seedDailyCategoryBaseline,requestDailyCategoryChange} from '../dist/sheets/daily-category-repository.js';
import {handleDailyCategoryReviewPostback} from '../dist/sheets/daily-category-owner.js';

test('LINE review rejects an employee, permits the owner once, and recovers a failed reply without changing the expense',async()=>{
  const h=ownerOrderFixture();try{
    h.env.DAILY_CATEGORY_REVIEW_ENABLED='true';
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_review','msg_review','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
    const row={expenseId:'exp_review',rowNumber:100,metadataId:11,fingerprint:'fixture',category:'general',expenseVersion:1};
    await seedDailyCategoryBaseline(h.env,row);const id=await requestDailyCategoryChange(h.env,row,'transport');
    const data=new URLSearchParams({a:'sheet_category_reject',id,v:'1'}).toString();
    const post=line=>h.event(line,{type:'postback',postback:{data}});
    await h.capture(()=>handleDailyCategoryReviewPostback(h.env,post('fixture_staff'),'trace_staff'));
    assert.equal(h.sqlite.prepare('SELECT status FROM daily_category_requests WHERE request_id=?').get(id).status,'PENDING');
    await h.capture(()=>handleDailyCategoryReviewPostback(h.env,post('fixture_owner'),'trace_owner'),{failReply:true});
    assert.equal(h.sqlite.prepare('SELECT status FROM daily_category_requests WHERE request_id=?').get(id).status,'REJECTED');
    assert.equal(h.sqlite.prepare("SELECT category FROM expense_events WHERE expense_id='exp_review'").get().category,'general');
    assert.equal(h.queue.filter(item=>(item.body||item).kind==='LINE_NOTIFICATION').length,1);
    await h.capture(()=>handleDailyCategoryReviewPostback(h.env,post('fixture_owner'),'trace_replay'));
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM daily_category_rejections').get().n,1);
  }finally{h.close()}
});
