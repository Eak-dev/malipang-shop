import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {finishProgress}=createRequire(import.meta.url)('../dist/admin/serial-expense-handover.js');
const version='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',identity={jobId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',fingerprint:'c'.repeat(64)};
const row={audit_count:1,target_count:1,job:'PROCESSING',epoch:'ARMED',leased:1,unleased:0,open_failure:0,revision_valid:1,revision:3,epoch_id:'normal_pilot296_test',verified_count:2,verified_unique:2,verified_digests:1,last_verified_at:'2026-11-22T00:00:00.000Z',verified_snapshot:JSON.stringify([['exp','DAILY','d'.repeat(64),'op1','e'.repeat(64)],['exp|item','DETAIL','d'.repeat(64),'op2','f'.repeat(64)]])};
function envFor(value){return {GOOGLE_SPREADSHEET_ID:'book',CONTINUOUS_DAILY_SHEET_ID:'1',CONTINUOUS_DAILY_SHEET:'daily',CONTINUOUS_RAW_SHEET_ID:'2',CONTINUOUS_RAW_SHEET:'raw',CONTINUOUS_DETAIL_SHEET_ID:'3',CONTINUOUS_DETAIL_SHEET:'detail',DB:{prepare(){return {bind(){return {async all(){return {success:true,results:[value]};}};}};}}};}
test('progress returns only hashes for verified unique stages and rejects inconsistent evidence',async()=>{
 const result=await finishProgress(envFor(row),identity,version);
 assert.equal(result.outcome,'PROGRESS');assert.equal(result.verifiedStages,2);assert.equal(result.stageProofs.length,2);assert.ok(result.stageProofs.every(x=>/^[0-9a-f]{64}$/.test(x)));
 for(const bad of [{...row,job:'REVIEW'},{...row,claim:'REVIEW'},{...row,verified_unique:1},{...row,verified_digests:2},{...row,revision_valid:0},{...row,verified_snapshot:'invalid'}, {...row,last_verified_at:'invalid'}])assert.equal(await finishProgress(envFor(bad),identity,version),null);
});
