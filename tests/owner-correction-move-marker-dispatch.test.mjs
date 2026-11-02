import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {grantSyntheticOpenPeriods,syntheticCorrectionHeaders} from './helpers/owner-correction-periods.mjs';
import {createOwnerCorrectionDraft,loadOwnerExpense} from '../dist/expense/owner-correction-repository.js';
import {claimCorrectionDailyWriteFence} from '../dist/sheets/owner-correction-daily-write-fence.js';
import {reserveOwnerCorrectionMoveRow} from '../dist/sheets/owner-correction-move-reservation.js';
import {dispatchReservedMoveMarker,recoverReservedMoveMarker} from '../dist/sheets/owner-correction-move-marker-dispatch.js';

const owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'};
const formulas=row=>{const f=[];f[8]=`=SUM(F${row}:H${row})`;f[17]=`=SUM(K${row}:Q${row})`;f[20]=`=DATE($A$5,B${row},C${row})`;return f};
async function setup(){const h=ownerOrderFixture(),now=Date.now();Object.assign(h.env,{OWNER_EXPENSE_CORRECTION_ENABLED:'true',SHEET_EXPENSE_DAILY:'daily'});
  h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_move_test','msg_move_test','fixture_staff','Synthetic',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
  const before=await loadOwnerExpense(h.env,owner,'exp_move_test'),id=await createOwnerCorrectionDraft(h.env,owner,before,'transactionDate','2026-11-01',now);await grantSyntheticOpenPeriods(h,id);
  const fence=await claimCorrectionDailyWriteFence(h.env,'daily',now),target={sheetId:1,rowNumber:12,metadataId:22,headers:syntheticCorrectionHeaders(),fenceToken:fence};assert.ok(await reserveOwnerCorrectionMoveRow(h.env,owner,id,target,now));
  h.sqlite.prepare('INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES(?,?,?)').run('daily','exp_move_test',8);
  const values=Array.from({length:20},()=>[]),formulaRows=Array.from({length:20},()=>[]);values[4]=[2026];values[5]=[null,10,null,'รายรับทั้งหมดในบัญชี'];values[7]=Array(23).fill(null);Object.assign(values[7],{1:10,2:28,3:'Synthetic',7:2000,21:'general',22:'บัญชีร้าน'});values[9]=['รวม',10];values[10]=[null,11,null,'รายรับทั้งหมดในบัญชี'];values[15]=['รวม',11];for(let row=12;row<=15;row++)formulaRows[row-1]=formulas(row);
  const source={metadataId:11,metadataKey:'malipang_expense_daily',metadataValue:'exp_move_test',sheetId:1,rowIndex:7},marker={metadataId:22,metadataKey:'malipang_correction_reservation',metadataValue:id,sheetId:1,rowIndex:11};
  const observation={coverage:'VERIFIED_SHEET_ID_AND_ALL_SHEET_ROW_METADATA_AND_INDEX',sheetId:1,values,formulas:formulaRows,metadata:[source,marker],mappings:[{entityKey:'exp_move_test',rowNumber:8},{entityKey:`__owner_move__:${id}`,rowNumber:12}],sourceById:source,markerById:marker,template:{rowNumber:12,values:formulas(12)}};
  let sent=0;const ports={verify:async()=>true,now:()=>now,create:async(_env,rows,callback)=>{await callback();sent++;throw Error('lost provider response')}};
  return {...h,now,id,fence,target,ports,observation,sent:()=>sent,dispatch:()=>dispatchReservedMoveMarker(h.env,owner,id,target,ports)};
}
test('lost response leaves durable fence and prevents repeat dispatch',async()=>{const h=await setup();try{
  assert.equal(await h.dispatch(),'PENDING');assert.equal(h.sent(),1);
  const d=h.sqlite.prepare('SELECT state,not_before FROM expense_owner_correction_move_marker_dispatch').get(),f=h.sqlite.prepare('SELECT state FROM owner_correction_daily_write_fences').get();assert.equal(d.state,'IN_FLIGHT');assert.equal(f.state,'IN_FLIGHT');
  assert.equal(await h.dispatch(),'REVIEW');assert.equal(h.sent(),1);
  assert.equal(await recoverReservedMoveMarker(h.env,owner,h.id,11,h.fence,async()=>null,()=>h.now),'WAIT');
  assert.equal(await recoverReservedMoveMarker(h.env,owner,h.id,11,h.fence,async()=>null,()=>h.now+16*60_000),'REVIEW');
  assert.equal(h.sqlite.prepare('SELECT state FROM expense_owner_correction_move_marker_dispatch').get().state,'IN_FLIGHT');
}finally{h.close()}});
test('concurrent attempts dispatch at most once',async()=>{const h=await setup();try{
  const result=await Promise.all([h.dispatch(),h.dispatch()]);assert.deepEqual(result.sort(),['PENDING','REVIEW']);assert.equal(h.sent(),1);assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM expense_owner_correction_move_marker_dispatch').get().n,1);
}finally{h.close()}});
test('each D1 batch failure rolls back the dispatch and fence before send',async()=>{
  for(let failAt=0;failAt<3;failAt++){const h=await setup();try{
    h.DB.failAt=failAt;assert.equal(await h.dispatch(),'REVIEW');assert.equal(h.sent(),0);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM expense_owner_correction_move_marker_dispatch').get().n,0);
    assert.equal(h.sqlite.prepare('SELECT state FROM owner_correction_daily_write_fences').get().state,'OWNED');
  }finally{h.close()}}
});
test('a changed preflight after authentication prevents dispatch',async()=>{const h=await setup();try{
  let checks=0;h.ports.verify=async()=>++checks===1;assert.equal(await h.dispatch(),'REVIEW');assert.equal(h.sent(),0);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM expense_owner_correction_move_marker_dispatch').get().n,0);
}finally{h.close()}});
test('lost response can verify the exact marker after the deadline even when the draft expired',async()=>{const h=await setup();try{
  assert.equal(await h.dispatch(),'PENDING');const later=h.now+16*60_000,newFence=await claimCorrectionDailyWriteFence(h.env,'daily',later);assert.ok(newFence);
  assert.equal(await recoverReservedMoveMarker(h.env,owner,h.id,11,newFence,async()=>h.observation,()=>later),'VERIFIED');
  assert.equal(h.sqlite.prepare('SELECT state FROM expense_owner_correction_move_marker_dispatch').get().state,'VERIFIED');
  assert.equal(h.sqlite.prepare('SELECT status FROM expense_owner_corrections WHERE correction_id=?').get(h.id).status,'DRAFT');
  assert.equal(h.sqlite.prepare('SELECT transaction_date FROM expense_events WHERE expense_id=?').get('exp_move_test').transaction_date,'2026-10-28');
}finally{h.close()}});
test('failed verification, stale expense, expired fence or held period never sends',async()=>{
  for(const mode of ['verification','stale','expired','held']){const h=await setup();try{
    if(mode==='verification')h.ports.verify=async()=>false;if(mode==='stale')h.sqlite.exec("UPDATE expense_events SET amount_satang=1 WHERE expense_id='exp_move_test'");if(mode==='expired')h.ports.now=()=>h.now+16*60_000;if(mode==='held')h.sqlite.exec("UPDATE expense_owner_correction_period_decisions SET decision='HOLD' WHERE period='2026-11'");
    assert.equal(await h.dispatch(),'REVIEW',mode);assert.equal(h.sent(),0,mode);assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM expense_owner_correction_move_marker_dispatch').get().n,0,mode);
  }finally{h.close()}}
});
test('dispatch migration is additive and repeatable',async()=>{const h=await setup();try{
  const sql=readFileSync(new URL('../migrations/0030_owner_correction_move_marker_dispatch.sql',import.meta.url),'utf8');h.sqlite.exec(sql);h.sqlite.exec(sql);
  assert.equal(h.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
}finally{h.close()}});
