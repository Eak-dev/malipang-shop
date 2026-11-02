import test from 'node:test';
import assert from 'node:assert/strict';
import {correctionRawPatchMatches} from '../dist/sheets/owner-correction-sync-plan.js';
const before={expenseId:'e',transactionDate:'2026-10-28',description:'Driver',amountSatang:200000,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'general'};
const original=['e','2026-10-28','Driver',2000,'transfer','SHOP_BANK','general'];
test('raw plan permits only the reviewed changes for all editable fields',()=>{
  const cases=[{after:{description:'Taxi'},cells:[{columnIndex:2,value:'Taxi'}]},{after:{category:'transport'},cells:[{columnIndex:6,value:'transport'}]},{after:{amountSatang:205050},cells:[{columnIndex:3,value:2050.5}]},{after:{transactionDate:'2026-10-29'},cells:[{columnIndex:1,value:'2026-10-29'}]},{after:{paymentKey:'cash',sourceWallet:'CASH_DRAWER'},cells:[{columnIndex:4,value:'cash'},{columnIndex:5,value:'CASH_DRAWER'}]}];
  for(const c of cases){const p={expenseId:'e',rawMetadataId:2,patches:[{metadataId:2,cells:c.cells}],originalRows:[{metadataId:2,values:original}]};assert.equal(correctionRawPatchMatches(p,before,{...before,...c.after}),true);assert.equal(correctionRawPatchMatches({...p,patches:[{metadataId:2,cells:[...c.cells,{columnIndex:1,value:'unexpected'}]}]},before,{...before,...c.after}),false);}
});
