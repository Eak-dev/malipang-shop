import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const pilot = require('../dist/admin/parked-expense-handover.js');
const {handleAdmin} = require('../dist/admin/handler.js');
const version = '01234567-89ab-cdef-0123-456789abcdef';
const secret = 'a'.repeat(40);
const jobId = '00000000-0000-4000-a000-000000000001';

test('pilot authorizes the pinned Worker and exposes only the enrollment outcome', async () => {
  const env = {ADMIN_TOKEN:secret, CF_VERSION_METADATA:{id:version}};
  const call = (body, auth = secret, expected = version) => handleAdmin(
    new Request('https://synthetic.invalid/admin/stable-sync/normal-expense-pilot', {
      method:'POST',
      headers:{authorization:'Bearer ' + auth, 'x-malipang-expected-worker-version':expected},
      body:JSON.stringify(body)
    }), env, {}
  );
  const fingerprint='b'.repeat(64);
  const op={action:'INSPECT_HANDOVER',jobId,fingerprint};
  const original=pilot.operateParkedPilot;
  let calls=0;
  try {
    pilot.operateParkedPilot=async (_,body,pin)=>{
      assert.deepEqual(body,op);assert.equal(pin,version);calls++;
      return {ok:true,outcome:'RESERVED'};
    };
    assert.equal((await call(op,'wrong')).status,401);
    assert.equal((await call(op,secret,'other')).status,409);
    assert.equal((await call(op)).status,404);
    env.CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED='true';
    for(const invalid of [{},[],{jobId},{...op,extra:true},{action:'HANDOVER_ONE',jobId,fingerprint}]){
      assert.equal((await call(invalid)).status,400);
    }
    assert.equal(calls,0);
    const response=await call(op);assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{ok:true,outcome:'RESERVED',servedVersion:version});assert.equal(calls,1);
  } finally {pilot.operateParkedPilot=original;}
});

test('verified receipt action requires exact round, proof, supervision and fence',()=>{
 const value={action:'RECORD_VERIFIED',jobId,fingerprint:'b'.repeat(64),roundId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',proof:'c'.repeat(64),ownerSupervising:true,externalWritersFenced:true};
 assert.deepEqual(pilot.parseParkedPilot(value),value);
 for(const invalid of [{...value,ownerSupervising:false},{...value,externalWritersFenced:false},{...value,roundId:'bad'},{...value,proof:'bad'},{...value,extra:true}])assert.equal(pilot.parseParkedPilot(invalid),null);
});
