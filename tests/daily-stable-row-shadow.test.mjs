import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js');
const {writeDailyStableShadow}=require('../dist/sheets/daily-stable-row-shadow.js');
const {syncStableShadowFixtureJob}=require('../dist/sheets/sync.js');
const {expectedHelperFormulae}=require('../dist/sheets/daily-stable-row-writes.js');
const {activateStableShadowCutover}=require('../dist/sheets/daily-stable-cutover.js');
const migration=readFileSync(new URL('../migrations/0023_daily_stable_row_intents.sql',import.meta.url),'utf8');
const admission=readFileSync(new URL('../migrations/0024_daily_stable_admissions.sql',import.meta.url),'utf8');
const record={expenseId:'exp_uat',transactionDate:'2026-10-26',description:'Synthetic',amountBaht:930,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'marketing',version:1};

test('real D1 journal and fence route a new UAT row through metadata without storing its row number',async()=>{
  const h=expenseSqlite(),names=['stablePrototypeSheetInfo','stablePrototypeSearchMetadata','stablePrototypeSnapshot','batchUpdateStablePrototype','writeDailyByMetadataPrototype','requireStablePrototypeAnnotations'],old=Object.fromEntries(names.map(name=>[name,client[name]]));
  try{
    h.sqlite.exec(migration);h.sqlite.exec(admission);h.sqlite.exec("CREATE TABLE daily_stable_uat_guard(marker TEXT); INSERT INTO daily_stable_uat_guard VALUES('fixture'); INSERT INTO daily_stable_cutovers(spreadsheet_id,sheet_name,generation,state,created_at) VALUES('uat','daily','fixture_1','PREPARED','now');");Object.assign(h.env,{RUNTIME_MODE:'shadow',DAILY_STABLE_ID_PROTOTYPE_ENABLED:'true',DAILY_STABLE_UAT_SPREADSHEET_ID:'uat',DAILY_STABLE_PRODUCTION_SPREADSHEET_ID:'production',DAILY_STABLE_UAT_DATABASE_MARKER:'fixture',GOOGLE_SPREADSHEET_ID:'uat',DAILY_STABLE_UAT_EXCLUSIVE_EDITORS:'true',DAILY_STABLE_UAT_NEW_EXPENSE_ID:'exp_uat',SHEET_EXPENSE_DAILY:'daily'});await activateStableShadowCutover(h.env,'fixture_1');
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_uat','msg','fixture','Synthetic',93000,'transfer','SHOP_BANK','marketing','2026-10-26','CONFIRMED','now',1)`).run();
    const blank=()=>Array(25).fill(null),rows=Array.from({length:10},blank);rows[4][0]=2026;rows[6][1]=10;rows[6][3]='รายรับทั้งหมดในบัญชี';rows[6][4]=50000;rows[6][9]='=E7';rows[9][0]='รวม';rows[9][1]=10;
    const setTotals=t=>{const r=rows[t-1];for(const [name,index] of [['E',4],['F',5],['G',6],['H',7],['K',10],['L',11],['M',12],['N',13],['O',14],['P',15],['Q',16]])r[index]=`=SUMIF($B$8:$B$${t-1},$B${t},${name}8:${name}${t-1})`;r[8]=`=SUM(F${t}:H${t})`;r[9]=`=$E$7-I${t}`;r[17]=`=SUM(K${t}:Q${t})`;r[18]=`=J${t}-R${t}`;};setTotals(10);
    const headers=[blank(),blank(),blank()];headers[1][7]='เงินโอน';let metadata=[];
    client.stablePrototypeSheetInfo=async()=>({sheetId:123,rowCount:rows.length,columnCount:25});
    client.requireStablePrototypeAnnotations=async()=>{};
    client.stablePrototypeSnapshot=async(_env,range,formulas)=>{
      if(range.endsWith('A5'))return [[2026]];
      if(range.endsWith('A1:W3'))return headers;
      if(formulas)return rows.map(row=>[...row]);
      let balance=50000;const totals=Array(25).fill(0);return rows.map((row,index)=>{const out=[...row];if(row[0]==='รวม'){for(const i of [4,5,6,7,10,11,12,13,14,15,16])out[i]=totals[i];out[8]=totals[5]+totals[6]+totals[7];out[9]=50000-out[8];out[17]=[10,11,12,13,14,15,16].reduce((sum,i)=>sum+totals[i],0);out[18]=out[9]-out[17];return out;}if(index>=6){if(index>6)for(const i of [4,5,6,7,10,11,12,13,14,15,16])totals[i]+=typeof row[i]==='number'?row[i]:0;const cash=Number(row[5]||0)+Number(row[6]||0)+Number(row[7]||0);out[8]=cash;out[9]=balance-cash;balance=out[9];out[17]=0;out[18]=out[9];out[20]=46321;}return out;});
    };
    client.stablePrototypeSearchMetadata=async(_env,filter)=>{if(filter.metadataLocation)assert.equal(filter.locationMatchingStrategy,'EXACT_LOCATION');return metadata.filter(m=>filter.metadataId?m.metadataId===filter.metadataId:m.row===filter.metadataLocation.dimensionRange.startIndex+1);};
    let batchWrites=0;client.batchUpdateStablePrototype=async(_env,requests,before)=>{await before();batchWrites++;for(const request of requests){if(request.createDeveloperMetadata){const m=request.createDeveloperMetadata.developerMetadata;metadata.push({metadataId:m.metadataId,sheetId:123,row:m.location.dimensionRange.startIndex+1});continue;}const u=request.updateCells;u.rows[0].values.forEach((v,i)=>{const c=v.userEnteredValue;rows[u.range.startRowIndex][u.range.startColumnIndex+i]=c?c.stringValue??c.numberValue??c.formulaValue??null:null;});}};
    let metadataWrites=0;client.writeDailyByMetadataPrototype=async(_env,range,before)=>{await before();metadataWrites++;const m=metadata.find(m=>m.metadataId===range.dataFilter.developerMetadataLookup.metadataId),row=rows[m.row-1];range.values[0].forEach((value,index)=>{if(value!==null)row[index]=value;});};
    const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_uat',entityVersion:1,traceId:'synthetic'};
    await assert.rejects(syncStableShadowFixtureJob(h.env,job),/OUTBOX_MISSING/);
    assert.equal(h.sqlite.prepare('SELECT count(*) n FROM daily_stable_row_intents').get().n,0);
    h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('fixture','EXPENSE','exp_uat',1,'synthetic','PENDING','now')").run();
    const normalInfo=client.stablePrototypeSheetInfo;let boundaryChanged=false;client.stablePrototypeSheetInfo=async(...args)=>{if(!boundaryChanged){boundaryChanged=true;h.sqlite.prepare("UPDATE daily_stable_cutovers SET generation='fixture_2',source_watermark=999").run();}return normalInfo(...args);};
    assert.equal(await syncStableShadowFixtureJob(h.env,job),'REVIEW');assert.equal(batchWrites,0,'a new boundary invalidates earlier eligibility');
    client.stablePrototypeSheetInfo=normalInfo;h.sqlite.prepare("UPDATE daily_stable_cutovers SET generation='fixture_1',source_watermark=0").run();h.sqlite.prepare("UPDATE sync_jobs SET status='PENDING' WHERE job_id='fixture'").run();
    let legacyAdded=false;client.stablePrototypeSheetInfo=async(...args)=>{if(!legacyAdded){legacyAdded=true;h.sqlite.prepare("INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES('daily','exp_uat|item',9)").run();}return normalInfo(...args);};
    assert.equal(await syncStableShadowFixtureJob(h.env,job),'REVIEW');assert.equal(batchWrites,0,'a newly appeared legacy mapping invalidates create');
    client.stablePrototypeSheetInfo=normalInfo;h.sqlite.prepare("DELETE FROM sheet_row_index WHERE sheet_name='daily' AND entity_key='exp_uat|item'").run();h.sqlite.prepare("UPDATE sync_jobs SET status='PENDING' WHERE job_id='fixture'").run();
    let annotationChecks=0;client.requireStablePrototypeAnnotations=async()=>{if(++annotationChecks===2)h.sqlite.prepare("UPDATE daily_stable_row_intents SET metadata_id=metadata_id+1").run();};
    assert.equal(await syncStableShadowFixtureJob(h.env,job),'REVIEW');assert.equal(batchWrites,0,'a changed reservation cannot dispatch');
    client.requireStablePrototypeAnnotations=async()=>{};h.sqlite.prepare('DELETE FROM daily_stable_row_intents').run();h.sqlite.prepare('DELETE FROM owner_correction_daily_write_fences').run();h.sqlite.prepare("UPDATE sync_jobs SET status='PENDING' WHERE job_id='fixture'").run();
    assert.equal(await syncStableShadowFixtureJob(h.env,job),'PROCESSED');
    assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='fixture'").get().status,'COMPLETED');
    assert.equal(await syncStableShadowFixtureJob(h.env,job),'PROCESSED');
    assert.equal(rows[7][23],'MALIPANG_EXPENSE:exp_uat');
    const journal=h.sqlite.prepare('SELECT expense_id,metadata_id,state FROM daily_stable_row_intents').get();assert.equal(journal.state,'VERIFIED');assert.equal(journal.metadata_id,metadata[0].metadataId);
    rows[7][3]='Tampered';assert.equal(await syncStableShadowFixtureJob(h.env,job),'REVIEW');rows[7][3]='Synthetic';
    const originalId=rows[7][23];rows[7][23]=null;assert.equal(await syncStableShadowFixtureJob(h.env,job),'REVIEW');rows[7][23]=originalId;
    h.sqlite.prepare("UPDATE daily_stable_row_intents SET state='IN_FLIGHT'").run();assert.equal(await syncStableShadowFixtureJob(h.env,job),'REVIEW');h.sqlite.prepare("UPDATE daily_stable_row_intents SET state='VERIFIED'").run();
    h.sqlite.prepare("UPDATE daily_stable_row_intents SET expense_id='exp_hidden'").run();assert.equal(await syncStableShadowFixtureJob(h.env,job),'REVIEW');h.sqlite.prepare("UPDATE daily_stable_row_intents SET expense_id='exp_uat'").run();
    const normalSnapshot=client.stablePrototypeSnapshot;let held=false;client.stablePrototypeSnapshot=async(...args)=>{const result=await normalSnapshot(...args);if(!held&&args[2]===true&&args[1].includes('A1:Y')){held=true;h.sqlite.prepare("UPDATE daily_stable_cutovers SET state='HELD'").run();}return result;};
    assert.equal(await syncStableShadowFixtureJob(h.env,job),'REVIEW');client.stablePrototypeSnapshot=normalSnapshot;h.sqlite.prepare("UPDATE daily_stable_cutovers SET state='ACTIVE'").run();
    let statusChanged=false;client.stablePrototypeSnapshot=async(...args)=>{const result=await normalSnapshot(...args);if(!statusChanged&&args[2]===true&&args[1].includes('A1:Y')){statusChanged=true;h.sqlite.prepare("UPDATE sync_jobs SET status='REVIEW' WHERE job_id='fixture'").run();}return result;};
    assert.equal(await syncStableShadowFixtureJob(h.env,job),'REVIEW');client.stablePrototypeSnapshot=normalSnapshot;h.sqlite.prepare("UPDATE sync_jobs SET status='COMPLETED' WHERE job_id='fixture'").run();
    let journalChanged=false;client.stablePrototypeSnapshot=async(...args)=>{const result=await normalSnapshot(...args);if(!journalChanged&&args[2]===true&&args[1].includes('A1:Y')){journalChanged=true;h.sqlite.prepare('UPDATE daily_stable_row_intents SET metadata_id=metadata_id+1').run();}return result;};
    assert.equal(await syncStableShadowFixtureJob(h.env,job),'REVIEW');client.stablePrototypeSnapshot=normalSnapshot;h.sqlite.prepare('UPDATE daily_stable_row_intents SET metadata_id=metadata_id-1').run();
    assert.equal(metadataWrites,0,'replay verification never dispatches a metadata update');assert.equal(batchWrites,1,'replay verification never appends');
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM sheet_row_index WHERE sheet_name='daily'").get().n,0);
    await writeDailyStableShadow(h.env,record);assert.equal(metadataWrites,0,'same version verifies without a second write');
    rows.splice(7,0,blank());metadata[0].row++;setTotals(11);const moved=expectedHelperFormulae(7,9);for(const [i,k] of [[8,'I'],[9,'J'],[17,'R'],[18,'S'],[20,'U']])rows[8][i]=moved[k];
    h.sqlite.prepare("UPDATE expense_events SET description='Revised',amount_satang=80000,version=2 WHERE expense_id='exp_uat'").run();
    await writeDailyStableShadow(h.env,{...record,description:'Revised',amountBaht:800,version:2});
    assert.equal(metadataWrites,1);assert.equal(rows[8][3],'Revised');assert.equal(rows[8][7],800);assert.equal(rows[7][3],null,'row inserted above remains untouched');
    assert.equal(h.sqlite.prepare('SELECT projected_version FROM daily_stable_row_intents').get().projected_version,2);
    h.sqlite.prepare("UPDATE expense_events SET description='Third',version=3 WHERE expense_id='exp_uat'").run();
    const successful=client.writeDailyByMetadataPrototype;client.writeDailyByMetadataPrototype=async(...args)=>{await successful(...args);throw new Error('lost response');};
    h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('fixture3','EXPENSE','exp_uat',3,'synthetic','PENDING','now')").run();
    const job3={...job,entityVersion:3};
    assert.equal(await syncStableShadowFixtureJob(h.env,job3),'REVIEW');
    assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='fixture3'").get().status,'REVIEW');
    assert.equal(await syncStableShadowFixtureJob(h.env,job3),'REVIEW');
    assert.equal(h.sqlite.prepare('SELECT state FROM daily_stable_row_intents').get().state,'IN_FLIGHT');
    assert.equal(h.sqlite.prepare('SELECT state FROM owner_correction_daily_write_fences').get().state,'IN_FLIGHT');
    await assert.rejects(writeDailyStableShadow(h.env,{...record,description:'Third',amountBaht:800,version:3}),/DAILY_STABLE_PRIOR_INTENT_REQUIRES_REVIEW/);
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

test('fixture outbox refuses a misbound DB before any mutation or Google call',async()=>{
  const h=expenseSqlite(),old=globalThis.fetch;try{
    Object.assign(h.env,{RUNTIME_MODE:'shadow',DAILY_STABLE_ID_PROTOTYPE_ENABLED:'true',DAILY_STABLE_UAT_SPREADSHEET_ID:'uat',DAILY_STABLE_PRODUCTION_SPREADSHEET_ID:'prod',DAILY_STABLE_UAT_DATABASE_MARKER:'fixture',GOOGLE_SPREADSHEET_ID:'uat',DAILY_STABLE_UAT_EXCLUSIVE_EDITORS:'true',DAILY_STABLE_UAT_NEW_EXPENSE_ID:'exp_uat'});
    h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('fixture','EXPENSE','exp_uat',1,'synthetic','PENDING','now')").run();
    const before=h.sqlite.prepare('SELECT total_changes() n').get().n;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected Google request');};
    await assert.rejects(syncStableShadowFixtureJob(h.env,{kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_uat',entityVersion:1,traceId:'synthetic'}),/DATABASE_UNVERIFIED/);
    assert.equal(h.sqlite.prepare('SELECT total_changes() n').get().n,before);assert.equal(calls,0);
  }finally{globalThis.fetch=old;h.close();}
});

test('legacy item-only mapping is held before any Google read or new summary row',async()=>{
  const h=expenseSqlite(),old=globalThis.fetch;try{
    h.sqlite.exec(migration);h.sqlite.exec(admission);h.sqlite.exec("CREATE TABLE daily_stable_uat_guard(marker TEXT); INSERT INTO daily_stable_uat_guard VALUES('fixture'); INSERT INTO daily_stable_cutovers(spreadsheet_id,sheet_name,generation,state,created_at) VALUES('uat','daily','fixture_1','PREPARED','now');");
    Object.assign(h.env,{RUNTIME_MODE:'shadow',DAILY_STABLE_ID_PROTOTYPE_ENABLED:'true',DAILY_STABLE_UAT_SPREADSHEET_ID:'uat',DAILY_STABLE_PRODUCTION_SPREADSHEET_ID:'production',DAILY_STABLE_UAT_DATABASE_MARKER:'fixture',GOOGLE_SPREADSHEET_ID:'uat',DAILY_STABLE_UAT_EXCLUSIVE_EDITORS:'true',DAILY_STABLE_UAT_NEW_EXPENSE_ID:'exp_uat',SHEET_EXPENSE_DAILY:'daily'});
    await activateStableShadowCutover(h.env,'fixture_1');h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_uat','msg','fixture','Synthetic',93000,'transfer','SHOP_BANK','marketing','2026-10-26','CONFIRMED','now',1)`).run();h.sqlite.prepare("INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES('daily','exp_uat|item_1',7)").run();let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected Google request');};
    h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('fixture','EXPENSE','exp_uat',1,'synthetic','PENDING','now')").run();
    const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_uat',entityVersion:1,traceId:'synthetic'};
    assert.equal(await syncStableShadowFixtureJob(h.env,job),'REVIEW');assert.equal(await syncStableShadowFixtureJob(h.env,job),'REVIEW');
    assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='fixture'").get().status,'REVIEW');assert.equal(calls,0);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM daily_stable_row_intents').get().n,0);
  }finally{globalThis.fetch=old;h.close();}
});
