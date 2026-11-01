import test from 'node:test';
import assert from 'node:assert/strict';
import {observeDailyCategory,mayApproveDailyCategory} from '../dist/sheets/daily-category-review.js';

const current={category:'general',version:4};
test('only changes to a verified and consistent baseline become owner requests',()=>{
  assert.equal(observeDailyCategory({identityVerified:true,observed:'general',current,baseline:null}).kind,'BASELINE');
  assert.deepEqual(observeDailyCategory({identityVerified:true,observed:'transport',current,baseline:current}),{kind:'OWNER_REVIEW',from:'general',to:'transport',expectedVersion:4});
  assert.equal(observeDailyCategory({identityVerified:true,observed:'transport',current,baseline:null}).reason,'UNBASELINED_DIFFERENCE');
  assert.equal(observeDailyCategory({identityVerified:false,observed:'transport',current,baseline:current}).reason,'IDENTITY_NOT_VERIFIED');
  assert.equal(observeDailyCategory({identityVerified:true,observed:'invalid',current,baseline:current}).reason,'INVALID_CATEGORY');
  assert.equal(observeDailyCategory({identityVerified:true,observed:'transport',current,baseline:{category:'general',version:3}}).reason,'DATABASE_CHANGED');
});

test('approval fails closed for non-owners, stale data, changed cells or replay',()=>{
  const request={from:'general',to:'transport',expectedVersion:4,status:'PENDING'};
  const base={ownerVerified:true,identityVerified:true,request,current,observed:'transport'};
  assert.equal(mayApproveDailyCategory(base),true);
  for(const bad of [{ownerVerified:false},{identityVerified:false},{observed:'rent'},{current:{...current,version:5}},{request:{...request,status:'APPROVED'}}])assert.equal(mayApproveDailyCategory({...base,...bad}),false);
});
