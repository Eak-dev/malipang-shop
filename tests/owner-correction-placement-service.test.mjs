import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {inspectOwnerCorrectionPlacement} from '../dist/sheets/owner-correction-placement-service.js';

test('live placement inspection requires current D1 values, one row, and direct proof the old marker is gone',async()=>{
  const h=ownerOrderFixture();try{
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_place_service','msg_place_service','fixture_staff','Driver',200000,'transfer','SHOP_BANK','transport','2026-10-28','CONFIRMED','now',2)`).run();
    h.env.SHEET_EXPENSE_DAILY='daily';const daily=Array.from({length:100},()=>[]);daily[1]=Array(8).fill(null);daily[1][7]='เงินโอน';daily[4]=[2026];daily[99]=Array(23).fill(null);Object.assign(daily[99],{1:10,2:28,3:'Driver',7:2000,21:'transport',22:'บัญชีร้าน'});
    const before={expenseId:'exp_place_service',status:'CONFIRMED',version:1,updatedAt:null,description:'Driver',category:'general',amountSatang:200000,transactionDate:'2026-10-28',paymentKey:'transfer',sourceWallet:'SHOP_BANK'},after={...before,category:'transport'};
    const marker={metadataId:12,metadataKey:'malipang_expense_daily',metadataValue:'exp_place_service',sheetId:1,rowIndex:99};let source=null;
    const ports={sheetId:async()=>1,values:async()=>daily,metadata:async()=>[marker],metadataById:async()=>source};
    const input={before,after,sourceMetadataId:11,destinationMetadataId:12,committedVersion:2};
    assert.equal(await inspectOwnerCorrectionPlacement(h.env,input,ports),true);
    ports.metadataById=async()=>{throw new Error('same-row inspection must not request a deleted marker')};
    assert.equal(await inspectOwnerCorrectionPlacement(h.env,{...input,sourceMetadataId:12},ports),true);
    ports.metadataById=async()=>source;
    source={...marker,metadataId:11,metadataKey:'changed-key'};assert.equal(await inspectOwnerCorrectionPlacement(h.env,input,ports),false);source=null;
    h.sqlite.prepare("UPDATE expense_events SET version=3 WHERE expense_id='exp_place_service'").run();assert.equal(await inspectOwnerCorrectionPlacement(h.env,input,ports),false);
  }finally{h.close()}
});
