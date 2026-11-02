import test from 'node:test';
import assert from 'node:assert/strict';
import {findOwnerCorrectionMoveCandidates as candidates} from '../dist/sheets/owner-correction-move-candidates.js';

const before={expenseId:'exp_synthetic_move',status:'CONFIRMED',version:1,updatedAt:null,description:'Synthetic',category:'transport',amountSatang:200000,transactionDate:'2026-10-28',paymentKey:'transfer',sourceWallet:'SHOP_BANK'};
const after={...before,transactionDate:'2026-11-01'};
const formulasFor=row=>{const f=[];f[8]=`=SUM(F${row}:H${row})`;f[17]=`=SUM(K${row}:Q${row})`;f[20]=`=DATE($A$5,B${row},C${row})`;return f};
function fixture(){
  const values=Array.from({length:20},()=>[]),formulas=Array.from({length:20},()=>[]);values[1]=Array(8).fill(null);values[1][7]='เงินโอน';values[4]=[2026];
  values[5]=[null,10,null,'รายรับทั้งหมดในบัญชี'];values[7]=Array(23).fill(null);Object.assign(values[7],{1:10,2:28,3:'Synthetic',7:2000,21:'transport',22:'บัญชีร้าน'});values[9]=['รวม',10];
  values[10]=[null,11,null,'รายรับทั้งหมดในบัญชี'];values[15]=['รวม',11];for(let row=12;row<=15;row++)formulas[row-1]=formulasFor(row);
  return {before,after,sheetId:1,sourceMetadataId:10,values,formulas,metadata:[{metadataId:10,metadataKey:'malipang_expense_daily',metadataValue:before.expenseId,sheetId:1,rowIndex:7}],mappedRows:[8],template:{rowNumber:12,values:formulasFor(12)}};
}
test('selects only unoccupied destination-month rows with matching formulas',()=>{
  const f=fixture();f.values[12]=[null,null,null,'occupied'];f.mappedRows.push(14);f.metadata.push({metadataId:11,metadataKey:'other',metadataValue:'reserved',sheetId:1,rowIndex:14});
  assert.deepEqual(candidates(f).map(x=>x.destinationRow),[12]);
});
test('missing or altered formulas and wrong accounting blocks fail closed',()=>{
  const f=fixture();f.formulas[11][8]='=0';f.formulas[12][17]='=SUM(K13:P13)';f.formulas[13][20]='=DATE($A$6,B14,C14)';f.formulas[14]=[];
  assert.deepEqual(candidates(f),[]);assert.deepEqual(candidates({...fixture(),after:{...after,transactionDate:'2027-01-01'}}),[]);
});
test('metadata identity conflicts and stale source values never choose a row',()=>{
  const f=fixture();f.metadata.push({...f.metadata[0],metadataId:99,rowIndex:8});assert.deepEqual(candidates(f),[]);
  const conflicting=fixture();conflicting.metadata.push({...conflicting.metadata[0],metadataId:99,metadataValue:'other_expense'});assert.deepEqual(candidates(conflicting),[]);
  const stale=fixture();stale.values[7][7]=1999;assert.deepEqual(candidates(stale),[]);
});
test('a formula that renders blank in a writable cell still makes the row unavailable',()=>{
  const f=fixture();f.formulas[11][3]='=IF(TRUE,"","")';
  assert.deepEqual(candidates(f).map(x=>x.destinationRow),[13,14,15]);
});
test('a freshly read inserted row follows metadata and does not reuse an indexed or reserved row',()=>{
  const f=fixture();f.values.splice(11,0,[]);f.formulas.splice(11,0,formulasFor(12));
  for(let row=13;row<=16;row++)f.formulas[row-1]=formulasFor(row);
  f.metadata.push({metadataId:20,metadataKey:'malipang_correction_reservation',metadataValue:'synthetic',sheetId:1,rowIndex:12});f.mappedRows.push(14);
  assert.deepEqual(candidates(f).map(x=>x.destinationRow),[12,15,16]);
});
