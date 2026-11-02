import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {grantSyntheticOpenPeriods,syntheticCorrectionHeaders} from './helpers/owner-correction-periods.mjs';
import {createOwnerCorrectionDraft,loadOwnerExpense} from '../dist/expense/owner-correction-repository.js';
import {claimCorrectionDailyWriteFence} from '../dist/sheets/owner-correction-daily-write-fence.js';
import {reserveOwnerCorrectionMoveRow} from '../dist/sheets/owner-correction-move-reservation.js';
import {inspectReservedMoveMarker} from '../dist/sheets/owner-correction-move-marker-recovery.js';

const owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},staff={employeeId:'TEST_STAFF',lineUserId:'fixture_staff'};
const formulas=row=>{const v=[];v[8]=`=SUM(F${row}:H${row})`;v[17]=`=SUM(K${row}:Q${row})`;v[20]=`=DATE($A$5,B${row},C${row})`;return v};
async function setup(){
  const h=ownerOrderFixture(),now=Date.now();Object.assign(h.env,{OWNER_EXPENSE_CORRECTION_ENABLED:'true',SHEET_EXPENSE_DAILY:'daily'});
  h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_move_test','msg_move_test','fixture_staff','Synthetic',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
  const before=await loadOwnerExpense(h.env,owner,'exp_move_test'),id=await createOwnerCorrectionDraft(h.env,owner,before,'transactionDate','2026-11-01',now);await grantSyntheticOpenPeriods(h,id);
  const fence=await claimCorrectionDailyWriteFence(h.env,'daily',now),reserved=await reserveOwnerCorrectionMoveRow(h.env,owner,id,{rowNumber:12,metadataId:22,headers:syntheticCorrectionHeaders(),fenceToken:fence},now);assert.ok(reserved);
  h.sqlite.prepare('INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES(?,?,?)').run('daily','exp_move_test',8);
  const values=Array.from({length:20},()=>[]),formulasByRow=Array.from({length:20},()=>[]);values[4]=[2026];values[5]=[null,10,null,'รายรับทั้งหมดในบัญชี'];values[7]=Array(23).fill(null);Object.assign(values[7],{1:10,2:28,3:'Synthetic',7:2000,21:'general',22:'บัญชีร้าน'});values[9]=['รวม',10];values[10]=[null,11,null,'รายรับทั้งหมดในบัญชี'];values[15]=['รวม',11];for(let row=12;row<=15;row++)formulasByRow[row-1]=formulas(row);
  const source={metadataId:11,metadataKey:'malipang_expense_daily',metadataValue:'exp_move_test',sheetId:1,rowIndex:7},marker={metadataId:22,metadataKey:'malipang_correction_reservation',metadataValue:id,sheetId:1,rowIndex:11};
  const observation={coverage:'VERIFIED_SHEET_ID_AND_ALL_SHEET_ROW_METADATA_AND_INDEX',sheetId:1,values,formulas:formulasByRow,metadata:[source,marker],mappings:[{entityKey:'exp_move_test',rowNumber:8},{entityKey:`__owner_move__:${id}`,rowNumber:12}],sourceById:source,markerById:marker,template:{rowNumber:12,values:formulas(12)}};
  return {...h,now,id,fence,observation,inspect:(obs=observation,who=owner,clock=()=>now)=>inspectReservedMoveMarker(h.env,who,id,11,fence,async()=>obs,clock)};
}
test('verifies an existing reservation using local D1 and two independent observations',async()=>{const h=await setup();try{assert.deepEqual(await h.inspect(),{kind:'VERIFIED',sheetId:1,sourceMetadataId:11,destinationMetadataId:22,destinationRow:12});}finally{h.close()}});
test('missing or conflicting marker, source, mapping, owner or fence stays in review',async()=>{
  for(const mode of ['missing','collision','staff','expired','stale','mapping']){const h=await setup();try{
    const o=structuredClone(h.observation);if(mode==='missing')o.markerById=null;if(mode==='collision')o.metadata.push({metadataId:23,metadataKey:'other',metadataValue:'occupant',sheetId:1,rowIndex:11});if(mode==='stale')h.sqlite.exec("UPDATE expense_events SET amount_satang=1 WHERE expense_id='exp_move_test'");if(mode==='mapping')h.sqlite.exec("UPDATE sheet_row_index SET row_number=13 WHERE entity_key='exp_move_test'");
    assert.deepEqual(await h.inspect(o,mode==='staff'?staff:owner,()=>h.now+(mode==='expired'?16*60_000:0)),{kind:'REVIEW'},mode);
  }finally{h.close()}}
});
test('moved row, changed observation or expired lease during observation never verifies',async()=>{const h=await setup();try{
  const moved=structuredClone(h.observation);moved.markerById.rowIndex=12;assert.deepEqual(await h.inspect(moved),{kind:'REVIEW'});
  let calls=0;const changed=await inspectReservedMoveMarker(h.env,owner,h.id,11,h.fence,async()=>{const o=structuredClone(h.observation);if(++calls===2)o.values[11][3]='occupied';return o},()=>h.now);assert.deepEqual(changed,{kind:'REVIEW'});
  let ticks=0;const expired=await h.inspect(h.observation,owner,()=>++ticks>2?h.now+16*60_000:h.now);assert.deepEqual(expired,{kind:'REVIEW'});
}finally{h.close()}});
