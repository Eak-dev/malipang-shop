import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {appendDailyRowFormulas}=require('../dist/sheets/append-daily-template.js');
const {encodeAtomicDailyPayload}=require('../dist/sheets/atomic-daily-template.js');
const {dailyPayloadDigest,dailySnapshotDigest,matchesCommittedDailyInsert}=require('../dist/sheets/continuous-daily-write-evidence.js');
const {matchesApprovedHistoricalDailyDelta}=require('../dist/sheets/exact-daily-historical-delta-draft.js');
const {prepareHistoricalDailyReceipt,parseHistoricalDailyReceipt,historicalDailyReceiptDigest,
 matchesPinnedHistoricalDailyReadback}=require('../dist/sheets/exact-daily-historical-receipt.js');
const backupCreatedAt='2026-08-16T12:34:56.123Z';
const syntheticChanges=[
 [1,1,'fixture label','fixture label','updated label','updated label'],
 [2,10,'=1+2',3,'=1+2',4],
 [4,29,null,null,'fixture panel cell','fixture panel cell'],
];

function auditDigest(scope,changes){
 const {sheetId,row}=scope.coordinates;
 return createHash('sha256').update(JSON.stringify([
  'issue296-daily-above-insert-delta-v1',sheetId,row,scope.beforeDigest,scope.backupCreatedAt,changes
 ])).digest('hex');
}

async function example(){
 const coordinates={sheetId:42,row:6,rowCount:8,columnCount:29};
 const rows=length=>Array.from({length},()=>Array(coordinates.columnCount).fill(null));
 const before={formula:rows(coordinates.rowCount),effective:rows(coordinates.rowCount)};
 before.formula[0][0]=before.effective[0][0]='fixture label';
 before.formula[1][9]='=1+2';before.effective[1][9]=3;
 const payload=encodeAtomicDailyPayload({
  expenseId:'exp_fixture',postingYear:2026,postingMonth:8,postingDay:15,description:'fixture expense',
  amountColumn:'H',amountSatang:100,category:'fixture category',wallet:'fixture wallet',operationMarker:'INSERT_'+'a'.repeat(32)
 });
 const evidence={fingerprint:'b'.repeat(64),spreadsheetId:'fixture-live-book',sheetName:'fixture daily',coordinates,
  beforeDigest:await dailySnapshotDigest(before,coordinates),payloadDigest:await dailyPayloadDigest(payload)};
 const policy={...structuredClone(evidence),backupSpreadsheetId:'fixture-backup-book',backupCreatedAt};
 policy.expectedDeltaDigest=auditDigest(policy,syntheticChanges);
 const identity={sheetId:coordinates.sheetId,sheetName:evidence.sheetName,rowCount:coordinates.rowCount+2,columnCount:coordinates.columnCount};
 const archive={...identity,spreadsheetId:policy.backupSpreadsheetId,sourceSpreadsheetId:evidence.spreadsheetId,createdAt:backupCreatedAt,values:structuredClone(before)};
 for(const matrix of [archive.values.formula,archive.values.effective])matrix.push(...rows(2));
 Object.assign(archive.values.formula[coordinates.row-1],appendDailyRowFormulas(),{24:payload});
 Object.assign(archive.values.effective[coordinates.row-1],{0:2026,1:8,2:15,3:'fixture expense',7:1,24:payload});
 const live={...identity,spreadsheetId:evidence.spreadsheetId,values:structuredClone(archive.values)};
 for(const [row,col,,,formula,effective] of syntheticChanges){
  live.values.formula[row-1][col-1]=formula;
  live.values.effective[row-1][col-1]=effective;
 }
 return {policy,evidence,payload,before,archive,live};
}

const prove=({policy,evidence,payload,archive,live})=>matchesApprovedHistoricalDailyDelta(policy,evidence,payload,archive,live);

test('approved historical delta restores exact archive postimage in memory and leaves both readbacks intact',async()=>{
 const fixture=await example();
 const {coordinates,beforeDigest,payloadDigest}=fixture.evidence;
 const trim=({formula,effective})=>({formula:formula.slice(0,coordinates.rowCount+1),effective:effective.slice(0,coordinates.rowCount+1)});
 assert.equal(await matchesCommittedDailyInsert(trim(fixture.archive.values),coordinates,fixture.payload,beforeDigest,payloadDigest),true);
 assert.equal(await matchesCommittedDailyInsert(trim(fixture.live.values),coordinates,fixture.payload,beforeDigest,payloadDigest),false);
 const original=structuredClone(fixture);
 assert.equal(await prove(fixture),true);
 assert.deepEqual(fixture,original);
 // Sheets omits trailing blank cells/rows and displays an empty formula result as ''.
 fixture.archive.values.effective[3][28]='';
 fixture.live.values.effective.pop();
 fixture.archive.values.formula.at(-1).length=0;
 assert.equal(await prove(fixture),true);
});

test('historical delta rejects different, zero, unordered, or unapproved cell changes',async()=>{
 const modes={
  'additional older change':x=>{x.live.values.effective[2][0]='unexpected';},
  'different scalar type':x=>{x.live.values.effective[1][9]='4';},
  'different formula with same value':x=>{x.live.values.formula[1][9]='=4';},
  'zero delta even when supplied zero hash':x=>{
   x.live.values=structuredClone(x.archive.values);x.policy.expectedDeltaDigest=auditDigest(x.policy,[]);
  },
  'reverse tuple order':x=>{x.policy.expectedDeltaDigest=auditDigest(x.policy,[...syntheticChanges].reverse());},
  'different approved hash':x=>{x.policy.expectedDeltaDigest='c'.repeat(64);},
 };
 for(const [name,change] of Object.entries(modes)){
  const fixture=await example();change(fixture);
  assert.equal(await prove(fixture),false,name);
 }
});

test('historical delta rejects target, later cells, occupied extra tails and a forged archive',async()=>{
 const modes={
  'target formula':x=>{x.live.values.formula[x.evidence.coordinates.row-1][0]='=0';},
  'target effective value even with matching approval':x=>{
   const row=x.evidence.coordinates.row;
   x.live.values.effective[row-1][7]=2;
   x.policy.expectedDeltaDigest=auditDigest(x.policy,[...syntheticChanges,[row,8,x.archive.values.formula[row-1][7],1,x.live.values.formula[row-1][7],2]]);
  },
  'duplicate live carrier even with matching approval':x=>{
   x.live.values.formula[4][24]=x.live.values.effective[4][24]=x.payload;
   x.policy.expectedDeltaDigest=auditDigest(x.policy,[...syntheticChanges,[5,25,null,null,x.payload,x.payload]]);
  },
  'target panel':x=>{x.live.values.effective[x.evidence.coordinates.row-1][28]=2;},
  'later cell even with matching approval':x=>{
   const row=x.evidence.coordinates.row+1;
   x.live.values.effective[row-1][28]='later';
   x.policy.expectedDeltaDigest=auditDigest(x.policy,[...syntheticChanges,[row,29,null,null,null,'later']]);
  },
  'live extra row effective':x=>{x.live.values.effective.at(-1)[28]=0;},
  'shared extra row formula':x=>{x.archive.values.formula.at(-1)[28]=x.live.values.formula.at(-1)[28]='=1';},
  'archive base invalid even with matching approval':x=>{
   x.archive.values.formula[0][1]=x.live.values.formula[0][1]='forged earlier cell';
  },
  'archive carrier invalid':x=>{x.archive.values.formula[x.evidence.coordinates.row-1][24]='wrong';},
  'wrong payload':x=>{x.payload=x.payload.replace('fixture expense','different expense');},
 };
 for(const [name,change] of Object.entries(modes)){
  const fixture=await example();change(fixture);
  assert.equal(await prove(fixture),false,name);
 }
});

for(const side of ['archive','live'])for(const view of ['formula','effective']){
 test(`historical delta rejects a second carrier in the ${side} ${view} view even when the difference is approved`,async()=>{
  const fixture=await example(),{policy,evidence,archive,payload}=fixture;
  const second=payload.replace('INSERT_'+'a'.repeat(32),'INSERT_'+'b'.repeat(32));
  fixture[side].values[view][4][24]=second;
  if(side==='archive'){
   fixture.before[view][4][24]=second;
   evidence.beforeDigest=policy.beforeDigest=await dailySnapshotDigest(fixture.before,evidence.coordinates);
   const archived={formula:archive.values.formula.slice(0,-1),effective:archive.values.effective.slice(0,-1)};
   assert.equal(await matchesCommittedDailyInsert(archived,evidence.coordinates,payload,evidence.beforeDigest,evidence.payloadDigest),true);
  }
  const cells=['archive','live'].flatMap(where=>['formula','effective'].map(layer=>fixture[where].values[layer][4][24]));
  policy.expectedDeltaDigest=auditDigest(policy,[...syntheticChanges,[5,25,...cells]]);
  assert.equal(await prove(fixture),false);
 });
}

test('historical delta scopes the approval to an independent incident, exact backup and bounded grid',async()=>{
 const modes={
  'different incident':x=>{x.evidence.fingerprint='d'.repeat(64);},
  'different authenticated workbook':x=>{x.evidence.spreadsheetId='other-book';},
  'different authenticated tab':x=>{x.evidence.sheetName='other-tab';},
  'different authenticated target row':x=>{x.evidence.coordinates.row++;},
  'different authenticated before hash':x=>{x.evidence.beforeDigest='e'.repeat(64);},
  'different authenticated payload hash':x=>{x.evidence.payloadDigest='f'.repeat(64);},
  'wrong live book':x=>{x.live.spreadsheetId='other-live';},
  'wrong live tab id':x=>{x.live.sheetId++;},
  'wrong backup logical source':x=>{x.archive.sourceSpreadsheetId='other-live';},
  'wrong backup physical book':x=>{x.archive.spreadsheetId='other-backup';},
  'wrong backup tab name':x=>{x.archive.sheetName='other-tab';},
  'wrong backup tab id':x=>{x.archive.sheetId++;},
  'wrong backup creation':x=>{x.archive.createdAt='2026-08-16T12:34:56.124Z';},
  'invalid creation on both inputs':x=>{x.policy.backupCreatedAt=x.archive.createdAt='2026-02-31T12:34:56.123Z';},
  'backup aliases live':x=>{x.archive.spreadsheetId=x.policy.backupSpreadsheetId=x.live.spreadsheetId;},
  'only one extra row':x=>{x.archive.rowCount--;x.live.rowCount--;},
  'wrong column span':x=>{x.live.columnCount++;},
  'row response outside declared dimensions':x=>{x.archive.values.formula.push([]);},
  'column response outside declared dimensions':x=>{x.live.values.effective[0].push(null);},
  'unsupported cell values':x=>{x.live.values.formula[1][1]={formulaValue:'=1'};},
  'non-finite numeric cell':x=>{x.live.values.effective[1][1]=Infinity;},
 };
 for(const [name,change] of Object.entries(modes)){
  const fixture=await example();change(fixture);
  assert.equal(await prove(fixture),false,name);
 }
});


const driveVersion='9223372036854775807';
const prepareReceipt=({policy,evidence,payload,archive,live},version=driveVersion)=>
 prepareHistoricalDailyReceipt(policy,evidence,payload,archive,live,version);
const hashTuple=tuple=>createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
const gridHash=grid=>hashTuple(['issue296-exact-daily-historical-grid-v1',
 grid.spreadsheetId,grid.sheetId,grid.sheetName,grid.rowCount,grid.columnCount,grid.values.formula,grid.values.effective]);

test('historical receipt binds the approved archive and live grid with canonical digest-only fields',async()=>{
 const x=await example(),original=structuredClone(x);
 const receipt=await prepareReceipt(x);
 const expected={
  incidentFingerprint:x.evidence.fingerprint,
  archiveIdentityDigest:hashTuple(['issue296-exact-daily-historical-archive-identity-v1',
   x.archive.spreadsheetId,x.archive.sourceSpreadsheetId,x.archive.createdAt,driveVersion]),
  archiveGridDigest:gridHash(x.archive),
  approvedDeltaDigest:x.policy.expectedDeltaDigest,
  liveGridDigest:gridHash(x.live),
 };
 assert.deepEqual(receipt,expected);
 const pin=await historicalDailyReceiptDigest(receipt);
 assert.equal(pin,hashTuple(['issue296-exact-daily-historical-receipt-v1',...Object.values(expected)]));
 assert.equal(await matchesPinnedHistoricalDailyReadback(receipt,pin,x.evidence.fingerprint,x.live),true);
 assert.ok(Object.values(receipt).every(value=>/^[0-9a-f]{64}$/.test(value)));
 assert.deepEqual(x,original);
});

test('historical receipt preparation rejects guesses and binds an exact opaque Drive version',async()=>{
 const x=await example();
 for(const value of [null,0,1,'','0','001','-1','+1','1.0','1e3','1\n',' 1']) {
  assert.equal(await prepareHistoricalDailyReceipt(x.policy,x.evidence,x.payload,x.archive,x.live,value),null);
 }
 const first=await prepareReceipt(x,'9007199254740992'),second=await prepareReceipt(x,'9007199254740993');
 assert.notEqual(first.archiveIdentityDigest,second.archiveIdentityDigest);
 assert.notEqual(await historicalDailyReceiptDigest(first),await historicalDailyReceiptDigest(second));
 assert.equal(first.archiveGridDigest,second.archiveGridDigest);
 x.archive.sourceSpreadsheetId='different-book';
 assert.equal(await prepareReceipt(x),null);
 const changed=await example();
 changed.live.values.formula[1][0]='unapproved edit';
 assert.equal(await prepareReceipt(changed),null);
});

test('historical receipt parser takes a clean snapshot and fails closed for altered artifacts or scope',async()=>{
 const x=await example(),receipt=await prepareReceipt(x),pin=await historicalDailyReceiptDigest(receipt);
 const original=Object.fromEntries(Object.entries(receipt).reverse()),snapshot=parseHistoricalDailyReceipt(original);
 assert.deepEqual(snapshot,receipt);
 assert.equal(await historicalDailyReceiptDigest(snapshot),pin);
 original.archiveGridDigest='a'.repeat(64);
 assert.deepEqual(snapshot,receipt);
 for(const invalid of [null,[],'{}',{...receipt,extra:true},{...receipt,[Symbol('extra')]:true},
  {...receipt,archiveGridDigest:null},{...receipt,archiveGridDigest:'a'.repeat(63)},
  {...receipt,incidentFingerprint:'B'.repeat(64)},Object.create(receipt)]){
  assert.equal(parseHistoricalDailyReceipt(invalid),null);
  assert.equal(await matchesPinnedHistoricalDailyReadback(invalid,pin,x.evidence.fingerprint,x.live),false);
 }
 const getter={...receipt,get archiveGridDigest(){assert.fail('the receipt parser must avoid getters');}};
 assert.equal(parseHistoricalDailyReceipt(getter),null);
 await assert.rejects(historicalDailyReceiptDigest({...receipt,extra:true}),/^Error: HISTORICAL_DAILY_RECEIPT_INVALID$/);
 for(const field of Object.keys(receipt)){
  const tampered={...receipt,[field]:'c'.repeat(64)};
  assert.equal(await matchesPinnedHistoricalDailyReadback(tampered,pin,x.evidence.fingerprint,x.live),false,field);
 }
 for(const invalidPin of [undefined,null,'','f'.repeat(64),pin.toUpperCase(),pin+'\n']){
  assert.equal(await matchesPinnedHistoricalDailyReadback(receipt,invalidPin,x.evidence.fingerprint,x.live),false);
 }
 assert.equal(await matchesPinnedHistoricalDailyReadback(receipt,pin,'e'.repeat(64),x.live),false);
});

test('historical receipt pins live provider identity, geometry, scalar types and the final physical row',async()=>{
 const x=await example(),receipt=await prepareReceipt(x),pin=await historicalDailyReceiptDigest(receipt);
 const drifts={
  'different book':g=>{g.spreadsheetId='other-book';},
  'different tab id':g=>{g.sheetId++;},
  'different tab title':g=>{g.sheetName='other-tab';},
  'different row geometry':g=>{g.rowCount++;},
  'different column geometry':g=>{g.columnCount++;},
  'changed formula':g=>{g.values.formula[1][9]='=2+1';},
  'changed effective':g=>{g.values.effective[1][9]=3;},
  'changed effective type':g=>{g.values.effective[1][9]='4';},
  'extra formula cell':g=>{g.values.formula[0].push(null);},
  'extra row':g=>{g.values.effective.push([]);},
  'nonblank final formula':g=>{g.values.formula.at(-1)[28]='=1';},
  'nonblank final value':g=>{g.values.effective.at(-1)[28]=false;},
  'unsupported live cell':g=>{g.values.formula[0][0]={formulaValue:'=A1'};},
 };
 for(const [name,mutate] of Object.entries(drifts)){
  const changed=structuredClone(x.live);mutate(changed);
  assert.equal(await matchesPinnedHistoricalDailyReadback(receipt,pin,x.evidence.fingerprint,changed),false,name);
 }
 x.live.values.formula.at(-2).length=0;
 x.live.values.formula.pop();
 x.live.values.effective.at(-1)[28]='';
 x.live.values.effective[0][28]=undefined;
 x.archive.values.formula.pop();
 x.archive.values.effective[0][28]='';
 assert.equal(await matchesPinnedHistoricalDailyReadback(receipt,pin,x.evidence.fingerprint,x.live),true);
 assert.deepEqual(await prepareReceipt(x),receipt);
});

test('historical receipt checks the same snapshot and Drive identity that were captured at invocation',async()=>{
 const x=await example(),receipt=await prepareReceipt(x),pin=await historicalDailyReceiptDigest(receipt);
 const preparing=prepareReceipt(x);
 const checking=matchesPinnedHistoricalDailyReadback(receipt,pin,x.evidence.fingerprint,x.live);
 x.live.values.effective[0][0]='changed during hash';
 x.archive.spreadsheetId='different-book';
 x.policy.expectedDeltaDigest='e'.repeat(64);
 assert.deepEqual(await preparing,receipt);
 assert.equal(await checking,true);
 assert.equal(await prepareReceipt(x),null);
 assert.equal(await matchesPinnedHistoricalDailyReadback(receipt,pin,x.evidence.fingerprint,x.live),false);
});
