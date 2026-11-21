import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),daily=require('../dist/sheets/continuous-daily-positive-recovery.js');
const auth=require('../dist/sheets/google-auth.js'),notice=require('../dist/sheets/stable-edit-notice.js');
const {closeExactCanaryDailyIncident}=require('../dist/sheets/continuous-review-close.js');

test('exact incident verifier accepts no caller IDs and fails closed on state or identity changes',async()=>{
 let rows=[{expense_id:'exp_canary_'+'a'.repeat(32),trace_id:'trace_canary_'+'b'.repeat(32),operation_token:'claim',projection_state:'IN_FLIGHT',notice_state:null}],calls=0;
 const db={prepare(){return{bind(){return this},async all(){return{success:true,results:rows}}}}};
 const env={DB:db,GOOGLE_SPREADSHEET_ID:'book',CANARY_UNWRITTEN_RECOVERY_ENABLED:'true',CONTINUOUS_CANARY_OPERATOR_ENABLED:'true'};
 const old=daily.verifyReviewedDailyProjection;
 daily.verifyReviewedDailyProjection=async(e,job,token,mode,policy,authority,extra)=>{calls++;assert.equal(e,env);assert.equal(job.entityKey,rows[0].expense_id);assert.equal(token,'claim');assert.equal(mode,'PAUSED');assert.equal(policy.kind,'continuous-expense');assert.equal(authority,'REVIEW');assert.equal(extra,true);return true;};
 try{
  assert.equal(await closeExactCanaryDailyIncident(env,'VERIFY'),'IN_PROGRESS');assert.equal(calls,1);
  for(const change of [{expense_id:'exp_other'},{trace_id:'trace_other'},{projection_state:'VERIFIED'},{notice_state:'TIME_IN_FLIGHT'}]){
   rows=[{expense_id:'exp_canary_'+'a'.repeat(32),trace_id:'trace_canary_'+'b'.repeat(32),operation_token:'claim',projection_state:'IN_FLIGHT',notice_state:null,...change}];
   assert.equal(await closeExactCanaryDailyIncident(env,'VERIFY'),'HELD');
  }
  rows=[];assert.equal(await closeExactCanaryDailyIncident(env,'VERIFY'),'HELD');
  rows=[{},{}];assert.equal(await closeExactCanaryDailyIncident(env,'VERIFY'),'HELD');
  assert.equal(await closeExactCanaryDailyIncident({...env,CANARY_UNWRITTEN_RECOVERY_ENABLED:'false'},'VERIFY'),'DISABLED');
  assert.equal(await closeExactCanaryDailyIncident({...env,CONTINUOUS_PUBLICATION_ENABLED:'true'},'VERIFY'),'DISABLED');assert.equal(calls,1);
 }finally{daily.verifyReviewedDailyProjection=old;}
});
test('status probe is read-only and reserves the same provider budget as dispatch',async()=>{
 const row={expense_id:'exp_canary_'+'a'.repeat(32),trace_id:'trace_canary_'+'b'.repeat(32),operation_token:'claim',projection_state:'VERIFIED',notice_state:'TIME_VERIFIED'};
 const db={prepare(sql){return{bind(){return this},async all(){return{success:true,results:[row]}},async first(){if(sql.includes('SELECT * FROM continuous_review_notice_close'))return{notice_identity:'id',next_stamp:'stamp',style_digest:'f'.repeat(64)};if(sql.includes('SELECT revision FROM stable_source_revision'))return{revision:1};if(sql.includes('SELECT count(*) AS n FROM sync_jobs'))return{n:1};throw Error('unexpected read')}}}};
 const env={DB:db,GOOGLE_SPREADSHEET_ID:'book',CANARY_UNWRITTEN_RECOVERY_ENABLED:'true',CONTINUOUS_CANARY_OPERATOR_ENABLED:'true'};
 const old={verify:daily.verifyReviewedDailyProjection,token:auth.getGoogleAccessToken,style:notice.stableNoticeStyleFingerprint};
 auth.getGoogleAccessToken=async(_e,b)=>{b.consumeRead();return 'token'};
 daily.verifyReviewedDailyProjection=async(_e,_j,_t,_m,p,_a,extra,d)=>{assert.equal(extra,true);p.budget.consumeRead();d.stage='COMPLETE';return true;};
 notice.stableNoticeStyleFingerprint=async(_e,_id,_status,_stamp,b)=>{b.consumeRead();return 'f'.repeat(64)};
 try{
  const diagnostic={stage:'',remaining:-1};assert.equal(await closeExactCanaryDailyIncident(env,'PROBE_STATUS',diagnostic),'READY');assert.deepEqual(diagnostic,{stage:'COMPLETE',remaining:37});
  row.projection_state='IN_FLIGHT';assert.equal(await closeExactCanaryDailyIncident(env,'PROBE_STATUS',diagnostic),'HELD');
 }finally{daily.verifyReviewedDailyProjection=old.verify;auth.getGoogleAccessToken=old.token;notice.stableNoticeStyleFingerprint=old.style;}
});
