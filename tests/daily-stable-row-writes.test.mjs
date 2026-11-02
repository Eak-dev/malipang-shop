import test from 'node:test';
import assert from 'node:assert/strict';
import {buildStableRowMetadataWrite, buildStableMonthExpansion, buildStableEmptyRowAppend, hasExpectedMonthlySubtotal} from '../dist/sheets/daily-stable-row-writes.js';
import {writeDailyByMetadataPrototype,parseStablePrototypeSheetInfo} from '../dist/sheets/client.js';

const item={postingYear:2026,month:10,day:26,description:'Example',amountColumn:'H',amountBaht:930,category:'marketing',sourceWallet:'บัญชีร้าน'};
test('targets unique metadata ID and leaves formulas and stable ID untouched',()=>{
  const request=buildStableRowMetadataWrite(742,item),row=request.values[0];
  assert.deepEqual(request.dataFilter,{developerMetadataLookup:{metadataId:742}});
  assert.equal(row.length,25);assert.deepEqual([row[1],row[2],row[3],row[7],row[21],row[22]],[10,26,'Example',930,'marketing','บัญชีร้าน']);
  for(const column of [0,4,8,9,17,18,19,20,23,24])assert.equal(row[column],null,`column ${column}`);
  for(const column of [5,6,10,11,12,13,14,15,16])assert.equal(row[column],'',`clear old payment ${column}`);
});
test('rejects invalid metadata, input and formula columns',()=>{
  assert.throws(()=>buildStableRowMetadataWrite(-1,item),/INVALID_METADATA_ID/);
  assert.throws(()=>buildStableRowMetadataWrite(742,{...item,amountColumn:'I'}),/INVALID_DAILY_AMOUNT_COLUMN/);
  assert.throws(()=>buildStableRowMetadataWrite(742,{...item,amountBaht:NaN}),/INVALID_DAILY_VALUES/);
  assert.throws(()=>buildStableRowMetadataWrite(742,{...item,month:2,day:30}),/INVALID_DAILY_DATE/);
});

test('full month insertion builds a blank new input row and updates subtotal in the same batch',()=>{
  const req=buildStableMonthExpansion(123,1187,1433,'MALIPANG_EXPENSE:exp_abc',item,10,907);
  assert.equal(req.length,18);
  assert.deepEqual(req[0].insertDimension,{range:{sheetId:123,dimension:'ROWS',startIndex:1432,endIndex:1433},inheritFromBefore:true});
  assert.equal(req.some(item=>item.copyPaste),false);
  const row=req[1].updateCells.rows[0].values;
  assert.equal(row[7].userEnteredValue.numberValue,930);
  assert.equal(row[23].userEnteredValue.stringValue,'MALIPANG_EXPENSE:exp_abc');
  assert.equal(row[8].userEnteredValue.formulaValue,'=SUM(F1433:H1433)');
  assert.match(row[9].userEnteredValue.formulaValue,/B1433/);
  assert.equal(row[20].userEnteredValue.formulaValue,'=IF(AND(ISNUMBER(B1433),ISNUMBER(C1433)),DATE($A$5,B1433,C1433),"")');
  const h=req.find(item=>item.updateCells?.range?.startColumnIndex===7&&item.updateCells?.range?.startRowIndex===1433);
  assert.equal(h.updateCells.rows[0].values[0].userEnteredValue.formulaValue,'=SUMIF($B$1188:$B$1433,$B1434,H1188:H1433)');
  assert.equal(req.some(item=>item.updateCells?.range?.startRowIndex>=1434),false,'does not write November rows');
  assert.equal(req[17].createDeveloperMetadata.developerMetadata.metadataKey,'e');
  assert.equal(req[17].createDeveloperMetadata.developerMetadata.metadataId,907);
  assert.throws(()=>buildStableMonthExpansion(123,1187,1433,'MALIPANG_EXPENSE:exp_abc',item,11,907),/POSTING_MONTH_MISMATCH/);
});

test('subtotal preflight refuses missing or customized formulas',()=>{
  const row=Array(25).fill(null), header=1187,total=1433;
  for(const [name,index] of [['E',4],['F',5],['G',6],['H',7],['K',10],['L',11],['M',12],['N',13],['O',14],['P',15],['Q',16]])row[index]=`=SUMIF($B$1188:$B$1432,$B1433,${name}1188:${name}1432)`;
  row[8]='=SUM(F1433:H1433)';row[9]='=$E$1187-I1433';row[17]='=SUM(K1433:Q1433)';row[18]='=J1433-R1433';
  assert.equal(hasExpectedMonthlySubtotal(row,header,total),true);
  row[7]='=SUM(H1188:H1432)';
  assert.equal(hasExpectedMonthlySubtotal(row,header,total),false);
});

test('metadata transport remains disabled by default and always disabled in production',async()=>{
  const range=buildStableRowMetadataWrite(742,item),before=()=>{throw new Error('must not dispatch');};
  await assert.rejects(()=>writeDailyByMetadataPrototype({RUNTIME_MODE:'production',DAILY_STABLE_ID_PROTOTYPE_ENABLED:'true'},range,before),/DAILY_STABLE_PROTOTYPE_DISABLED/);
  await assert.rejects(()=>writeDailyByMetadataPrototype({RUNTIME_MODE:'shadow'},range,before),/DAILY_STABLE_PROTOTYPE_DISABLED/);
});

test('even UAT transport refuses attempts to write formulas or stable IDs',async()=>{
  const range=buildStableRowMetadataWrite(742,item);range.values[0][8]='=1';
  const env={RUNTIME_MODE:'shadow',DAILY_STABLE_ID_PROTOTYPE_ENABLED:'true',DAILY_STABLE_UAT_SPREADSHEET_ID:'uat',DAILY_STABLE_PRODUCTION_SPREADSHEET_ID:'prod',DAILY_STABLE_UAT_DATABASE_MARKER:'marker',GOOGLE_SPREADSHEET_ID:'uat',DAILY_STABLE_UAT_EXCLUSIVE_EDITORS:'true'};
  await assert.rejects(()=>writeDailyByMetadataPrototype(env,range,()=>{}),/DAILY_STABLE_METADATA_REQUEST_INVALID/);
});

test('a sheet beyond the supported full snapshot is held before any write',()=>{
  const metadata=rows=>({sheets:[{properties:{sheetId:123,title:'daily',gridProperties:{rowCount:rows,columnCount:25}}}]});
  assert.equal(parseStablePrototypeSheetInfo(metadata(5000),'daily').rowCount,5000);
  assert.throws(()=>parseStablePrototypeSheetInfo(metadata(5001),'daily'),/DAILY_STABLE_SHEET_GRID_UNSUPPORTED/);
});

test('append into a blank row only fills inputs and missing helper formulas',()=>{
  const req=buildStableEmptyRowAppend(123,1187,1370,'MALIPANG_EXPENSE:exp_abc',item,['I','U'],10,907);
  assert.deepEqual(req.filter(r=>r.updateCells).map(r=>r.updateCells.range.startColumnIndex),[1,7,21,8,20]);
  assert.equal(req[2].updateCells.rows[0].values[2].userEnteredValue.stringValue,'MALIPANG_EXPENSE:exp_abc');
  assert.equal(req[3].updateCells.rows[0].values[0].userEnteredValue.formulaValue,'=SUM(F1370:H1370)');
  assert.equal(req.some(r=>r.updateCells?.range.startColumnIndex===9),false,'existing J formula must remain untouched');
  assert.throws(()=>buildStableEmptyRowAppend(123,1187,1370,'MALIPANG_EXPENSE:exp_abc',item,['X'],10,907),/INVALID_MISSING_FORMULA/);
});
