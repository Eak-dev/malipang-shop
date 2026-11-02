import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {grantSyntheticOpenPeriods,syntheticCorrectionHeaders} from './helpers/owner-correction-periods.mjs';
import {createOwnerCorrectionDraft,loadOwnerExpense} from '../dist/expense/owner-correction-repository.js';
import {claimCorrectionDailyWriteFence} from '../dist/sheets/owner-correction-daily-write-fence.js';
import {reserveOwnerCorrectionMoveRow as reserve} from '../dist/sheets/owner-correction-move-reservation.js';

const owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},staff={employeeId:'TEST_STAFF',lineUserId:'fixture_staff'};
async function setup(){const h=ownerOrderFixture(),now=Date.now();Object.assign(h.env,{OWNER_EXPENSE_CORRECTION_ENABLED:'true',SHEET_EXPENSE_DAILY:'daily'});
  h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
    VALUES('exp_move_test','msg_move_test','fixture_staff','Synthetic',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
  const before=await loadOwnerExpense(h.env,owner,'exp_move_test'),id=await createOwnerCorrectionDraft(h.env,owner,before,'transactionDate','2026-11-01',now);await grantSyntheticOpenPeriods(h,id);
  const fenceToken=await claimCorrectionDailyWriteFence(h.env,'daily',now),input={rowNumber:300,metadataId:123456,headers:syntheticCorrectionHeaders(),fenceToken};return {...h,now,before,id,input};
}
test('owner reservation atomically claims one row and is idempotent',async()=>{
  const h=await setup();try{const first=await reserve(h.env,owner,h.id,h.input,h.now);assert.ok(first);assert.deepEqual(await reserve(h.env,owner,h.id,h.input,h.now),first);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_owner_correction_move_reservations').get().n,1);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sheet_row_index').get().n,1);assert.equal(h.sqlite.prepare('SELECT transaction_date FROM expense_events').get().transaction_date,'2026-10-28');}finally{h.close()}
});
test('occupied rows, staff, expired fence, stale snapshot and held month cannot reserve',async()=>{
  for(const mode of ['occupied','staff','expired','stale','held']){const h=await setup();try{
    if(mode==='occupied')h.sqlite.prepare('INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES(?,?,?)').run('daily','exp_other',300);
    if(mode==='stale')h.sqlite.exec("UPDATE expense_events SET amount_satang=1 WHERE expense_id='exp_move_test'");
    if(mode==='held')h.sqlite.exec("UPDATE expense_owner_correction_period_decisions SET decision='HOLD' WHERE period='2026-11'");
    const who=mode==='staff'?staff:owner,at=mode==='expired'?h.now+16*60_000:h.now;
    assert.equal(await reserve(h.env,who,h.id,h.input,at),null,mode);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_owner_correction_move_reservations').get().n,0);
  }finally{h.close()}}
});
test('two owners drafts cannot claim the same destination row',async()=>{
  const h=await setup();try{const second=await createOwnerCorrectionDraft(h.env,owner,h.before,'transactionDate','2026-11-02',h.now);await grantSyntheticOpenPeriods(h,second);
    const [a,b]=await Promise.all([reserve(h.env,owner,h.id,h.input,h.now),reserve(h.env,owner,second,{...h.input,metadataId:123457},h.now)]);assert.equal(Number(Boolean(a))+Number(Boolean(b)),1);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_owner_correction_move_reservations').get().n,1);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sheet_row_index').get().n,1);
  }finally{h.close()}
});
test('reservation transaction failures roll back both the reservation and index',async()=>{
  for(let index=0;index<3;index++){const h=await setup();try{h.DB.failAt=index;await assert.rejects(reserve(h.env,owner,h.id,h.input,h.now),/fixture batch failure/);h.DB.failAt=null;assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_owner_correction_move_reservations').get().n,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sheet_row_index').get().n,0)}finally{h.close()}}
});
test('a missing mapping is never recreated from a stale reservation',async()=>{
  const h=await setup();try{assert.ok(await reserve(h.env,owner,h.id,h.input,h.now));h.sqlite.exec('DELETE FROM sheet_row_index');await assert.rejects(reserve(h.env,owner,h.id,h.input,h.now));assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sheet_row_index').get().n,0)}finally{h.close()}
});
test('reservation migration is additive and repeatable',async()=>{const h=await setup();try{const sql=readFileSync(new URL('../migrations/0028_owner_correction_move_reservations.sql',import.meta.url),'utf8');h.sqlite.exec(sql);h.sqlite.exec(sql);assert.equal(h.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[])}finally{h.close()}});
