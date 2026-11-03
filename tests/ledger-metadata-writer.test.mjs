import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {verifyLedgerMetadataWitness,buildLedgerMetadataValueRange}=require('../dist/sheets/ledger-metadata-writer.js');
const {digestLedgerCell}=require('../dist/sheets/ledger-stable-journal.js');
const client=require('../dist/sheets/client.js');
const auth=require('../dist/sheets/google-auth.js');
const {RAW_PROJECTION_HEADERS}=require('../dist/sheets/raw-projection.js');
const original={fetch:globalThis.fetch,token:auth.getGoogleAccessToken};
test.afterEach(()=>{globalThis.fetch=original.fetch;auth.getGoogleAccessToken=original.token});
const identity={kind:'EXPENSE',sheetId:42,entityId:'exp_a'};
const witness={metadataId:123,metadataKey:'E',sheetId:42,dimension:'ROWS',startIndex:1,endIndex:2,visibility:'DOCUMENT'};
const rows=[[...RAW_PROJECTION_HEADERS.EXPENSE],['exp_a'],['exp_b']];
const guard=(size,fields)=>{
  const cells=Array.from({length:size},()=>({entered:null,formula:null,note:null,hasValidation:false}));
  return{fields,expected:structuredClone(cells),observed:structuredClone(cells)};
};
const fullExpenseBaseline=async()=>Object.fromEntries(await Promise.all([1,2,3,4,5,6,7].map(async i=>[String(i),await digestLedgerCell(null)])));
test('preflight follows moved rows and rejects duplicate, wrong row, metadata, or header',()=>{
  assert.doesNotThrow(()=>verifyLedgerMetadataWitness(identity,witness,rows));
  const moved=[rows[0],rows[2],rows[1]];
  assert.doesNotThrow(()=>verifyLedgerMetadataWitness(identity,{...witness,startIndex:2,endIndex:3},moved));
  assert.throws(()=>verifyLedgerMetadataWitness(identity,witness,moved));
  assert.throws(()=>verifyLedgerMetadataWitness(identity,witness,[...rows,['exp_a']]));
  assert.throws(()=>verifyLedgerMetadataWitness(identity,{...witness,metadataKey:'P'},rows));
  assert.throws(()=>verifyLedgerMetadataWitness(identity,witness,[['Wrong'],...rows.slice(1)]));
});
test('detail identity uses both item and parent expense; copied IDs hold',()=>{
  const ident={kind:'PURCHASE_DETAILS',sheetId:42,entityId:'exp_a',itemId:'item_a'}, w={...witness,metadataKey:'D'};
  const header=[...RAW_PROJECTION_HEADERS.PURCHASE_DETAILS];
  assert.doesNotThrow(()=>verifyLedgerMetadataWitness(ident,w,[header,['item_a','exp_a']]));
  assert.throws(()=>verifyLedgerMetadataWitness(ident,w,[header,['item_a','exp_b']]));
  assert.throws(()=>verifyLedgerMetadataWitness(ident,w,[header,['item_a','exp_a'],['item_a','exp_a']]));
  const swapped=[...header];[swapped[16],swapped[19]]=[swapped[19],swapped[16]];assert.throws(()=>verifyLedgerMetadataWitness(ident,w,[swapped,['item_a','exp_a']]));
});
test('expense and personal RAW reject reordered non-ID column headers',()=>{
  const expHeaders=[...RAW_PROJECTION_HEADERS.EXPENSE];[expHeaders[2],expHeaders[3]]=[expHeaders[3],expHeaders[2]];
  assert.throws(()=>verifyLedgerMetadataWitness(identity,witness,[expHeaders,['exp_a']]));
  const personal={kind:'PERSONAL_USE',sheetId:42,entityId:'personal_a'},pw={...witness,metadataKey:'P'},personalHeaders=[...RAW_PROJECTION_HEADERS.PERSONAL_USE];
  assert.doesNotThrow(()=>verifyLedgerMetadataWitness(personal,pw,[personalHeaders,['personal_a']]));
  [personalHeaders[2],personalHeaders[3]]=[personalHeaders[3],personalHeaders[2]];assert.throws(()=>verifyLedgerMetadataWitness(personal,pw,[personalHeaders,['personal_a']]));
});
test('data filter uses metadataId only, preserves identity cells and deliberately clears old nulls',()=>{
  const values=['exp_a',...Array(16).fill('fixture')];values[4]=null;
  const p=buildLedgerMetadataValueRange(identity,123,values,guard(17,[4,6]));
  assert.deepEqual(p.dataFilter,{developerMetadataLookup:{metadataId:123}});
  assert.equal(p.values[0][0],null);assert.equal(p.values[0][4],'');assert.equal(p.values[0][6],'fixture');assert.equal(p.values[0][5],null);assert.equal(p.values[0].length,17);
  assert.throws(()=>buildLedgerMetadataValueRange(identity,123,['exp_wrong',...Array(16).fill('')],guard(17,[4])));
});
test('changed, formula, note, validation, incomplete or identity-field preimages are held',()=>{
  const values=['exp_a',...Array(16).fill('new')],g=guard(17,[4]);
  g.observed[4].entered='manual change';assert.throws(()=>buildLedgerMetadataValueRange(identity,123,values,g),/PREIMAGE/);
  g.observed[4].entered=null;g.observed[4].formula='=1+1';assert.throws(()=>buildLedgerMetadataValueRange(identity,123,values,g),/PREIMAGE/);
  g.observed[4].formula=null;g.observed[4].note='human note';assert.throws(()=>buildLedgerMetadataValueRange(identity,123,values,g),/PREIMAGE/);
  g.observed[4].note=null;g.observed[4].hasValidation=true;assert.throws(()=>buildLedgerMetadataValueRange(identity,123,values,g),/PREIMAGE/);
  g.observed[4]={};assert.throws(()=>buildLedgerMetadataValueRange(identity,123,values,g),/PREIMAGE/);
  assert.throws(()=>buildLedgerMetadataValueRange(identity,123,values,guard(17,[0])),/FORBIDDEN/);
});
test('detail cancellation changes only Q and T, never A/B and evidence',()=>{
  const ident={kind:'PURCHASE_DETAILS',sheetId:42,entityId:'exp_a',itemId:'item_a'};
  const values=Array(20).fill('old');values[0]='item_a';values[1]='exp_a';values[16]='CANCELLED';values[19]='2026-10-30';
  const p=buildLedgerMetadataValueRange(ident,123,values,guard(20,[16,19]),'CANCEL_DETAIL').values[0];
  assert.deepEqual(p.map((v,i)=>v===null?null:i).filter(v=>v!==null),[16,19]);
  assert.equal(p[16],'CANCELLED');assert.equal(p[19],'2026-10-30');
});
test('writer dispatches metadata DataFilter after fence and rejects unknown result',async()=>{
  auth.getGoogleAccessToken=async()=> 'synthetic';let dispatch=0,received;
  const env={RUNTIME_MODE:'shadow',GOOGLE_SPREADSHEET_ID:'synthetic',SHEETS_LEDGER_UAT_SPREADSHEET_ID:'synthetic',SHEETS_LEDGER_PRODUCTION_SPREADSHEET_ID:'production',SHEETS_LEDGER_ANCHORED_WRITE_PROTOTYPE:'true'};
  globalThis.fetch=async(url,init)=>{received={url:String(url),body:JSON.parse(init.body)};return new Response(JSON.stringify({totalUpdatedRows:1,responses:[{}]}),{status:200})};
  const p={identity,witness,identityRows:rows,values:['exp_a',...Array(16).fill('fixture')],guard:guard(17,[4]),baselineHashes:await fullExpenseBaseline()};
  await client.writeValuesByMetadataPrototype(env,p,async()=>{dispatch++});
  assert.equal(dispatch,1);assert.match(received.url,/values:batchUpdateByDataFilter$/);assert.equal(received.body.data[0].dataFilter.developerMetadataLookup.metadataId,123);
  globalThis.fetch=async()=>new Response(JSON.stringify({totalUpdatedRows:0,responses:[]}),{status:200});
  await assert.rejects(client.writeValuesByMetadataPrototype(env,p,async()=>{}),{name:'SheetsMutationOutcomeUnknownError'});
  globalThis.fetch=async()=>new Response('sensitive upstream body',{status:403});
  await assert.rejects(client.writeValuesByMetadataPrototype(env,p,async()=>{}),{message:'Sheets HTTP 403'});
});
test('a lost response or failed pre-dispatch fence never appears successful',async()=>{
  auth.getGoogleAccessToken=async()=> 'synthetic';const p={identity,witness,identityRows:rows,values:['exp_a',...Array(16).fill('fixture')],guard:guard(17,[4]),baselineHashes:await fullExpenseBaseline()};let calls=0;
  const env={RUNTIME_MODE:'shadow',GOOGLE_SPREADSHEET_ID:'synthetic',SHEETS_LEDGER_UAT_SPREADSHEET_ID:'synthetic',SHEETS_LEDGER_PRODUCTION_SPREADSHEET_ID:'production',SHEETS_LEDGER_ANCHORED_WRITE_PROTOTYPE:'true'};
  globalThis.fetch=async()=>{calls++;return new Response('not-json')};
  await assert.rejects(client.writeValuesByMetadataPrototype({GOOGLE_SPREADSHEET_ID:'synthetic'},p,async()=>{}),{message:'LEDGER_METADATA_WRITER_DISABLED'});assert.equal(calls,0);
  await assert.rejects(client.writeValuesByMetadataPrototype({...env,RUNTIME_MODE:'production'},p,async()=>{}),{message:'LEDGER_METADATA_WRITER_DISABLED'});assert.equal(calls,0);
  await assert.rejects(client.writeValuesByMetadataPrototype({...env,SHEETS_LEDGER_PRODUCTION_SPREADSHEET_ID:'synthetic'},p,async()=>{}),{message:'LEDGER_METADATA_WRITER_DISABLED'});assert.equal(calls,0);
  await assert.rejects(client.writeValuesByMetadataPrototype({...env,GOOGLE_SPREADSHEET_ID:'production'},p,async()=>{}),{message:'LEDGER_METADATA_WRITER_DISABLED'});assert.equal(calls,0);
  const changed={...p,guard:guard(17,[4])};changed.guard.observed[4].formula='=1+1';
  await assert.rejects(client.writeValuesByMetadataPrototype(env,changed,async()=>{}),/PREIMAGE/);assert.equal(calls,0);
  await assert.rejects(client.writeValuesByMetadataPrototype(env,{...p,baselineHashes:{...p.baselineHashes,'4':'f'.repeat(64)}},async()=>{}),/DIGEST_MISMATCH/);assert.equal(calls,0);
  await assert.rejects(client.writeValuesByMetadataPrototype(env,{...p,witness:{...witness,sheetId:99}},async()=>{}),/METADATA_INVALID/);assert.equal(calls,0);
  await assert.rejects(client.writeValuesByMetadataPrototype(env,p,async()=>{throw Error('FENCE_LOST')}),{message:'FENCE_LOST'});assert.equal(calls,0);
  await assert.rejects(client.writeValuesByMetadataPrototype(env,p,async()=>{}),{name:'SheetsMutationOutcomeUnknownError'});assert.equal(calls,1);
});
