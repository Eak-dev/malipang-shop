import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAuditMetadataResponse,readDailyExpenseIndexAudit,readDailyIndexDatabaseSnapshot} from '../dist/sheets/owner-correction-index-audit-service.js';

const env={SHEET_EXPENSE_DAILY:'รายวัน',GOOGLE_SPREADSHEET_ID:'synthetic'};
const metadata={metadataId:1,metadataKey:'malipang_expense_daily',metadataValue:'exp_1',visibility:'DOCUMENT',location:{dimensionRange:{sheetId:2,dimension:'ROWS',startIndex:9,endIndex:10}}};
const db={expenseIds:['exp_1'],mappings:[{entityKey:'exp_1',rowNumber:10}]};
const sheet={sheetId:2,metadata:[{metadataId:1,metadataKey:'malipang_expense_daily',metadataValue:'exp_1',sheetId:2,rowIndex:9}]};
const rows=()=>[
  {success:true,meta:{},results:[{count:1}]},
  {success:true,meta:{},results:[{expense_id:'exp_1'}]},
  {success:true,meta:{},results:[{count:1}]},
  {success:true,meta:{},results:[{entity_key:'exp_1',row_number:10}]}
];
function database(results){return {...env,DB:{prepare(){return {bind(){return this}}},async batch(){return results}}}}

test('reads full D1 sets and rejects count mismatch or pagination hints',async()=>{
  assert.deepEqual(await readDailyIndexDatabaseSnapshot(database(rows())),db);
  const truncated=rows();truncated[0].results[0].count=2;assert.equal(await readDailyIndexDatabaseSnapshot(database(truncated)),null);
  const paged=rows();paged[1].nextPageToken='more';assert.equal(await readDailyIndexDatabaseSnapshot(database(paged)),null);
  const unknown=rows();unknown[1].meta.hasMore=true;assert.equal(await readDailyIndexDatabaseSnapshot(database(unknown)),null);
  const failed=rows();failed[1].success=false;assert.equal(await readDailyIndexDatabaseSnapshot(database(failed)),null);
});
test('requires complete unpaged document metadata with valid single-row location',()=>{
  const response={matchedDeveloperMetadata:[{developerMetadata:metadata}]};
  assert.deepEqual(parseAuditMetadataResponse(response),sheet.metadata);
  assert.deepEqual(parseAuditMetadataResponse({matchedDeveloperMetadata:[]}),[]);
  assert.equal(parseAuditMetadataResponse({}),null);
  assert.equal(parseAuditMetadataResponse({...response,nextPageToken:'next'}),null);
  assert.equal(parseAuditMetadataResponse({matchedDeveloperMetadata:[{developerMetadata:{...metadata,visibility:'PROJECT'}}]}),null);
  assert.equal(parseAuditMetadataResponse({matchedDeveloperMetadata:[{developerMetadata:{...metadata,location:{dimensionRange:{...metadata.location.dimensionRange,endIndex:11}}}}]}),null);
});
test('returns only stable complete snapshots and sends matching rows to audit',async()=>{
  const result=await readDailyExpenseIndexAudit(env,{db:async()=>db,sheet:async()=>sheet});
  assert.equal(result.kind,'AUDITED');assert.equal(result.audit.entries[0].status,'MATCH');
  let call=0;const changed=await readDailyExpenseIndexAudit(env,{db:async()=>++call===1?db:{...db,mappings:[{entityKey:'exp_1',rowNumber:11}]},sheet:async()=>sheet});
  assert.deepEqual(changed,{kind:'REVIEW'});
  assert.deepEqual(await readDailyExpenseIndexAudit(env,{db:async()=>null,sheet:async()=>sheet}),{kind:'REVIEW'});
  assert.deepEqual(await readDailyExpenseIndexAudit(env,{db:async()=>{throw Error('offline')},sheet:async()=>sheet}),{kind:'REVIEW'});
});
