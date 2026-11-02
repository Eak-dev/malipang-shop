import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {loadOwnerExpense} from '../dist/expense/owner-correction-repository.js';
import {bootstrapOwnerCorrectionTargets,inspectOwnerCorrectionExistingTargets,verifyOwnerCorrectionProjectionRows} from '../dist/sheets/owner-correction-bootstrap-service.js';

test('bootstrap creates metadata only after verifying rows and safely repeats',async()=>{
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'};try{
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_bootstrap','msg_bootstrap','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
    Object.assign(h.env,{SHEET_EXPENSE_DAILY:'daily',SHEET_EXPENSE_RAW:'raw',SHEET_PURCHASE_DETAILS:'detail'});
    const before=await loadOwnerExpense(h.env,owner,'exp_bootstrap'),daily=Array.from({length:100},()=>[]),raw=[[],['exp_bootstrap','2026-10-28','Driver',2000,'transfer','SHOP_BANK','general','CONFIRMED']],metadata=[];
    daily[1]=Array(8).fill(null);daily[1][7]='เงินโอน';daily[4]=[2026];daily[99]=Array(23).fill(null);Object.assign(daily[99],{1:10,2:28,3:'Driver',7:2000,21:'general',22:'บัญชีร้าน'});
    let next=10,creates=0;
    const ports={sheetId:async(_env,name)=>({daily:1,raw:2,detail:3})[name],values:async(_env,range)=>range.startsWith("'daily'")?daily:range.startsWith("'raw'")?raw:[],metadata:async(_env,key)=>metadata.filter(m=>m.metadataKey===key),
      create:async(_env,rows)=>{creates++;return rows.map(row=>{const m={...row,metadataId:next++};metadata.push(m);return m})},
      expense:async()=>({expense:h.sqlite.prepare("SELECT * FROM expense_events WHERE expense_id='exp_bootstrap'").get(),summaryDocument:null,document:null,items:[],record:{}})};
    assert.equal(await inspectOwnerCorrectionExistingTargets(h.env,before,ports),null);assert.equal(creates,0);
    const one=await bootstrapOwnerCorrectionTargets(h.env,before,ports);assert.equal(one.length,2);assert.equal(creates,1);
    assert.deepEqual(await inspectOwnerCorrectionExistingTargets(h.env,before,ports),one);assert.equal(creates,1);
    const two=await bootstrapOwnerCorrectionTargets(h.env,before,ports);assert.deepEqual(two,one);assert.equal(creates,1);
    const plan={expenseId:'exp_bootstrap',dailyMetadataId:10,rawMetadataId:11,rebind:null,patches:[{metadataId:10,cells:[]},{metadataId:11,cells:[]}],originalRows:[]};
    assert.equal(await verifyOwnerCorrectionProjectionRows(h.env,before,plan,ports),true);
    assert.equal(await verifyOwnerCorrectionProjectionRows(h.env,before,{...plan,rawMetadataId:99},ports),false);
    raw.push([...raw[1]]);await assert.rejects(verifyOwnerCorrectionProjectionRows(h.env,before,plan,ports),/RAW_AMBIGUOUS/);raw.pop();
    const load=ports.expense;let loads=0;ports.expense=async(...args)=>{const result=await load(...args);loads++;return loads===2?{...result,expense:{...result.expense,version:2}}:result};
    assert.equal(await verifyOwnerCorrectionProjectionRows(h.env,before,plan,ports),false);ports.expense=load;
    metadata.splice(1,1);assert.equal(await verifyOwnerCorrectionProjectionRows(h.env,before,plan,ports),false);
    daily[99][3]='Changed';await assert.rejects(bootstrapOwnerCorrectionTargets(h.env,before,ports),/DAILY_AMBIGUOUS/);
  }finally{h.close()}
});

test('an insertion before metadata creation is detected on recheck and cannot authorize a write',async()=>{
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'};try{
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_race','msg_race','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
    Object.assign(h.env,{SHEET_EXPENSE_DAILY:'daily',SHEET_EXPENSE_RAW:'raw',SHEET_PURCHASE_DETAILS:'detail'});
    const before=await loadOwnerExpense(h.env,owner,'exp_race'),daily=Array.from({length:100},()=>[]),raw=[[],['exp_race','2026-10-28','Driver',2000,'transfer','SHOP_BANK','general','CONFIRMED']],metadata=[];
    daily[1]=Array(8).fill(null);daily[1][7]='เงินโอน';daily[4]=[2026];daily[99]=Array(23).fill(null);Object.assign(daily[99],{1:10,2:28,3:'Driver',7:2000,21:'general',22:'บัญชีร้าน'});
    let next=10;
    const ports={sheetId:async(_env,name)=>({daily:1,raw:2,detail:3})[name],values:async(_env,range)=>range.startsWith("'daily'")?daily:range.startsWith("'raw'")?raw:[],metadata:async(_env,key)=>metadata.filter(m=>m.metadataKey===key),
      create:async(_env,rows)=>{daily.splice(10,0,[]);return rows.map(row=>{const m={...row,metadataId:next++};metadata.push(m);return m})},
      expense:async()=>({expense:h.sqlite.prepare("SELECT * FROM expense_events WHERE expense_id='exp_race'").get(),summaryDocument:null,document:null,items:[],record:{}})};
    await assert.rejects(bootstrapOwnerCorrectionTargets(h.env,before,ports),/METADATA_CONFLICT/);
    assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');
  }finally{h.close()}
});

test('a row insertion after metadata creation is re-read and follows the correct record',async()=>{
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'};try{
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_moving','msg_moving','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
    Object.assign(h.env,{SHEET_EXPENSE_DAILY:'daily',SHEET_EXPENSE_RAW:'raw',SHEET_PURCHASE_DETAILS:'detail'});
    const before=await loadOwnerExpense(h.env,owner,'exp_moving'),daily=Array.from({length:100},()=>[]),raw=[[],['exp_moving','2026-10-28','Driver',2000,'transfer','SHOP_BANK','general','CONFIRMED']],metadata=[];
    daily[1]=Array(8).fill(null);daily[1][7]='เงินโอน';daily[4]=[2026];daily[99]=Array(23).fill(null);Object.assign(daily[99],{1:10,2:28,3:'Driver',7:2000,21:'general',22:'บัญชีร้าน'});
    let next=10;
    const ports={sheetId:async(_env,name)=>({daily:1,raw:2,detail:3})[name],values:async(_env,range)=>range.startsWith("'daily'")?daily:range.startsWith("'raw'")?raw:[],metadata:async(_env,key)=>metadata.filter(m=>m.metadataKey===key),
      create:async(_env,rows)=>{const made=rows.map(row=>{const m={...row,metadataId:next++};metadata.push(m);return m});daily.splice(10,0,[]);for(const m of metadata)if(m.sheetId===1&&m.rowIndex>=10)m.rowIndex++;return made},
      expense:async()=>({expense:h.sqlite.prepare("SELECT * FROM expense_events WHERE expense_id='exp_moving'").get(),summaryDocument:null,document:null,items:[],record:{}})};
    const targets=await bootstrapOwnerCorrectionTargets(h.env,before,ports),target=targets.find(row=>row.target.key==='malipang_expense_daily');assert.equal(target.target.rowIndex,100);assert.equal(target.metadataId,10);
  }finally{h.close()}
});
