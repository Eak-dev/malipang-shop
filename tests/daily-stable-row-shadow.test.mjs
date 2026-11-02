import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js');
const {writeDailyStableShadow}=require('../dist/sheets/daily-stable-row-shadow.js');
const {expectedHelperFormulae}=require('../dist/sheets/daily-stable-row-writes.js');
const migration=readFileSync(new URL('../migrations/0023_daily_stable_row_intents.sql',import.meta.url),'utf8');
const record={expenseId:'exp_uat',transactionDate:'2026-10-26',description:'Synthetic',amountBaht:930,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'marketing',version:1};

test('real D1 journal and fence route a new UAT row through metadata without storing its row number',async()=>{
  const h=expenseSqlite(),names=['stablePrototypeSheetInfo','stablePrototypeSearchMetadata','stablePrototypeSnapshot','batchUpdateStablePrototype','writeDailyByMetadataPrototype'],old=Object.fromEntries(names.map(name=>[name,client[name]]));
  try{
    h.sqlite.exec(migration);h.sqlite.exec("CREATE TABLE daily_stable_uat_guard(marker TEXT); INSERT INTO daily_stable_uat_guard VALUES('fixture');");Object.assign(h.env,{RUNTIME_MODE:'shadow',DAILY_STABLE_ID_PROTOTYPE_ENABLED:'true',DAILY_STABLE_UAT_SPREADSHEET_ID:'uat',DAILY_STABLE_PRODUCTION_SPREADSHEET_ID:'production',DAILY_STABLE_UAT_DATABASE_MARKER:'fixture',GOOGLE_SPREADSHEET_ID:'uat',DAILY_STABLE_UAT_EXCLUSIVE_EDITORS:'true',DAILY_STABLE_UAT_NEW_EXPENSE_ID:'exp_uat',SHEET_EXPENSE_DAILY:'daily'});
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_uat','msg','fixture','Synthetic',93000,'transfer','SHOP_BANK','marketing','2026-10-26','CONFIRMED','now',1)`).run();
    const blank=()=>Array(25).fill(null),rows=Array.from({length:10},blank);rows[4][0]=2026;rows[6][1]=10;rows[6][3]='รายรับทั้งหมดในบัญชี';rows[6][4]=50000;rows[9][0]='รวม';rows[9][1]=10;
    const headers=[blank(),blank(),blank()];headers[1][7]='เงินโอน';let metadata=[];
    client.stablePrototypeSheetInfo=async()=>({sheetId:123,rowCount:rows.length,columnCount:25});
    client.stablePrototypeSnapshot=async(_env,range,formulas)=>{
      if(range.endsWith('A5'))return [[2026]];
      if(range.endsWith('A1:W3'))return headers;
      if(formulas)return rows.map(row=>[...row]);
      let balance=50000;return rows.map((row,index)=>{const out=[...row];if(index>=6){const cash=Number(row[5]||0)+Number(row[6]||0)+Number(row[7]||0);out[8]=cash;out[9]=balance-cash;balance=out[9];out[17]=0;out[18]=out[9];out[20]=46321;}return out;});
    };
    client.stablePrototypeSearchMetadata=async(_env,filter)=>{if(filter.metadataLocation)assert.equal(filter.locationMatchingStrategy,'EXACT_LOCATION');return metadata.filter(m=>filter.metadataId?m.metadataId===filter.metadataId:m.row===filter.metadataLocation.dimensionRange.startIndex+1);};
    client.batchUpdateStablePrototype=async(_env,requests,before)=>{await before();for(const request of requests){if(request.createDeveloperMetadata){const m=request.createDeveloperMetadata.developerMetadata;metadata.push({metadataId:m.metadataId,sheetId:123,row:m.location.dimensionRange.startIndex+1});continue;}const u=request.updateCells;u.rows[0].values.forEach((v,i)=>{const c=v.userEnteredValue;rows[u.range.startRowIndex][u.range.startColumnIndex+i]=c?c.stringValue??c.numberValue??c.formulaValue??null:null;});}};
    let metadataWrites=0;client.writeDailyByMetadataPrototype=async(_env,range,before)=>{await before();metadataWrites++;const m=metadata.find(m=>m.metadataId===range.dataFilter.developerMetadataLookup.metadataId),row=rows[m.row-1];range.values[0].forEach((value,index)=>{if(value!==null)row[index]=value;});};
    await writeDailyStableShadow(h.env,record);
    assert.equal(rows[7][23],'MALIPANG_EXPENSE:exp_uat');
    const journal=h.sqlite.prepare('SELECT expense_id,metadata_id,state FROM daily_stable_row_intents').get();assert.equal(journal.state,'VERIFIED');assert.equal(journal.metadata_id,metadata[0].metadataId);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM sheet_row_index WHERE sheet_name='daily'").get().n,0);
    await writeDailyStableShadow(h.env,record);assert.equal(metadataWrites,0,'same version verifies without a second write');
    rows.splice(7,0,blank());metadata[0].row++;const moved=expectedHelperFormulae(7,9);for(const [i,k] of [[8,'I'],[9,'J'],[17,'R'],[18,'S'],[20,'U']])rows[8][i]=moved[k];
    h.sqlite.prepare("UPDATE expense_events SET description='Revised',amount_satang=80000,version=2 WHERE expense_id='exp_uat'").run();
    await writeDailyStableShadow(h.env,{...record,description:'Revised',amountBaht:800,version:2});
    assert.equal(metadataWrites,1);assert.equal(rows[8][3],'Revised');assert.equal(rows[8][7],800);assert.equal(rows[7][3],null,'row inserted above remains untouched');
    assert.equal(h.sqlite.prepare('SELECT projected_version FROM daily_stable_row_intents').get().projected_version,2);
    h.sqlite.prepare("UPDATE expense_events SET description='Third',version=3 WHERE expense_id='exp_uat'").run();
    const successful=client.writeDailyByMetadataPrototype;client.writeDailyByMetadataPrototype=async(...args)=>{await successful(...args);throw new Error('lost response');};
    await assert.rejects(writeDailyStableShadow(h.env,{...record,description:'Third',amountBaht:800,version:3}),/DAILY_STABLE_OUTCOME_UNKNOWN/);
    assert.equal(h.sqlite.prepare('SELECT state FROM daily_stable_row_intents').get().state,'IN_FLIGHT');
    assert.equal(h.sqlite.prepare('SELECT state FROM owner_correction_daily_write_fences').get().state,'IN_FLIGHT');
    await assert.rejects(writeDailyStableShadow(h.env,{...record,description:'Third',amountBaht:800,version:3}),/CORRECTION_DAILY_SHEET_BUSY/);
    assert.equal(metadataWrites,2,'unknown outcome must never dispatch again');
  }finally{for(const name of names)client[name]=old[name];h.close();}
});
test('production and mismatched workbook configuration refuse before any IO',async()=>{
  const env={RUNTIME_MODE:'production',DAILY_STABLE_ID_PROTOTYPE_ENABLED:'true'};
  await assert.rejects(writeDailyStableShadow(env,record),/DAILY_STABLE_UAT_NOT_AUTHORIZED/);
});

test('production workbook or an unmarked database is rejected even in shadow',async()=>{
  const h=expenseSqlite();try{
    Object.assign(h.env,{RUNTIME_MODE:'shadow',DAILY_STABLE_ID_PROTOTYPE_ENABLED:'true',DAILY_STABLE_UAT_SPREADSHEET_ID:'same',DAILY_STABLE_PRODUCTION_SPREADSHEET_ID:'same',DAILY_STABLE_UAT_DATABASE_MARKER:'fixture',GOOGLE_SPREADSHEET_ID:'same',DAILY_STABLE_UAT_EXCLUSIVE_EDITORS:'true',DAILY_STABLE_UAT_NEW_EXPENSE_ID:'exp_uat'});
    await assert.rejects(writeDailyStableShadow(h.env,record),/DAILY_STABLE_UAT_NOT_AUTHORIZED/);
    h.env.DAILY_STABLE_PRODUCTION_SPREADSHEET_ID='different';
    await assert.rejects(writeDailyStableShadow(h.env,record),/DAILY_STABLE_UAT_DATABASE_UNVERIFIED/);
  }finally{h.close();}
});
