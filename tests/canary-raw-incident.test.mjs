import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ledger=require('../dist/sheets/continuous-ledger-positive-recovery.js');
const auth=require('../dist/sheets/google-auth.js'),notice=require('../dist/sheets/stable-edit-notice.js');
const {closeExactCanaryRawIncident}=require('../dist/sheets/continuous-review-close.js');
const valid=()=>({expense_id:'exp_canary_'+'a'.repeat(32),trace_id:'trace_canary_'+'b'.repeat(32),operation_token:'claim',projection_state:'IN_FLIGHT',notice_state:null});

test('RAW timeout verifier scopes exact synthetic incident and refuses changed state',async()=>{
 let rows=[valid()],calls=0,scopeSql='',proof=true;
 const db={prepare(sql){scopeSql=sql;return{bind(){return this},async all(){return{success:true,results:rows}}}}};
 const env={DB:db,GOOGLE_SPREADSHEET_ID:'book',CANARY_UNWRITTEN_RECOVERY_ENABLED:'true',CONTINUOUS_CANARY_OPERATOR_ENABLED:'true'};
 const old=ledger.verifyReviewedLedgerProjection;
 ledger.verifyReviewedLedgerProjection=async(e,job,token,projection,kind,item,mode,policy,authority)=>{calls++;assert.equal(e,env);assert.equal(job.entityKey,rows[0].expense_id);assert.equal(token,'claim');assert.equal(projection,'EXPENSE_RAW');assert.equal(kind,'CONFIRM');assert.equal(item,undefined);assert.equal(mode,'PAUSED');assert.equal(policy.kind,'continuous-expense');assert.equal(authority,'REVIEW');return proof;};
 try{
  assert.equal(await closeExactCanaryRawIncident(env,'VERIFY'),'IN_PROGRESS');assert.equal(calls,1);
  proof=false;assert.equal(await closeExactCanaryRawIncident(env,'VERIFY'),'HELD');proof=true;
  for(const guard of ["w.review_reason='TIMEOUT'","d.target_row=2","d.before_rows=1000","d.write_mode='REPLACE'","previous.projection='DAILY'","previous.state='COMPLETE'","other.state<>'VERIFIED'"])assert.ok(scopeSql.includes(guard),guard);
  for(const change of [{expense_id:'exp_other'},{trace_id:'trace_other'},{projection_state:'VERIFIED'},{notice_state:'TIME_IN_FLIGHT'}]){rows=[{...valid(),...change}];assert.equal(await closeExactCanaryRawIncident(env,'VERIFY'),'HELD');}
  rows=[];assert.equal(await closeExactCanaryRawIncident(env,'VERIFY'),'HELD');rows=[valid(),valid()];assert.equal(await closeExactCanaryRawIncident(env,'VERIFY'),'HELD');
  assert.equal(await closeExactCanaryRawIncident({...env,CANARY_UNWRITTEN_RECOVERY_ENABLED:'false'},'VERIFY'),'DISABLED');assert.equal(await closeExactCanaryRawIncident({...env,CONTINUOUS_PUBLICATION_ENABLED:'true'},'VERIFY'),'DISABLED');assert.equal(calls,2);
 }finally{ledger.verifyReviewedLedgerProjection=old;}
});
test('RAW status probe reserves write budget but only reads verified evidence',async()=>{
 const row={...valid(),projection_state:'VERIFIED',notice_state:'TIME_VERIFIED'};
 const db={prepare(sql){return{bind(){return this},async all(){return{success:true,results:[row]}},async first(){if(sql.includes('SELECT * FROM continuous_review_notice_close'))return{notice_identity:'id',next_stamp:'stamp',style_digest:'f'.repeat(64)};if(sql.includes('SELECT revision FROM stable_source_revision'))return{revision:1};if(sql.includes('SELECT count(*) AS n FROM sync_jobs'))return{n:1};throw Error('unexpected read')}}}};
 const env={DB:db,GOOGLE_SPREADSHEET_ID:'book',CANARY_UNWRITTEN_RECOVERY_ENABLED:'true',CONTINUOUS_CANARY_OPERATOR_ENABLED:'true'};
 const old={verify:ledger.verifyReviewedLedgerProjection,token:auth.getGoogleAccessToken,style:notice.stableNoticeStyleFingerprint};let calls=0;
 auth.getGoogleAccessToken=async(_e,b)=>{b.consumeRead();return 'token'};
 ledger.verifyReviewedLedgerProjection=async(_e,_j,_t,p,k,_i,mode,policy)=>{calls++;assert.equal(p,'EXPENSE_RAW');assert.equal(k,'CONFIRM');assert.equal(mode,'PAUSED');policy.budget.consumeRead();return true;};
 notice.stableNoticeStyleFingerprint=async(_e,_id,_status,_stamp,b)=>{b.consumeRead();return 'f'.repeat(64)};
 try{assert.equal(await closeExactCanaryRawIncident(env,'PROBE_STATUS'),'READY');row.projection_state='IN_FLIGHT';assert.equal(await closeExactCanaryRawIncident(env,'PROBE_STATUS'),'HELD');assert.equal(calls,1);}
 finally{ledger.verifyReviewedLedgerProjection=old.verify;auth.getGoogleAccessToken=old.token;notice.stableNoticeStyleFingerprint=old.style;}
});
