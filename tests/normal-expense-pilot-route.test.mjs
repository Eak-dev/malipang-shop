import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const pilot = require('../dist/sheets/continuous-normal-recovery.js');
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
  const original = pilot.armSingleNormalExpense;
  let calls = 0;
  try {
    pilot.armSingleNormalExpense = async (_, id) => {
      assert.equal(id, jobId);
      calls++;
      if (calls === 3) throw Error('private provider response');
      return calls === 1;
    };
    assert.equal((await call({jobId}, 'wrong')).status, 401);
    assert.equal((await call({jobId}, secret, 'other')).status, 409);
    assert.equal((await call({jobId})).status, 404);
    env.CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED = 'true';
    for (const invalid of [{}, [], {jobId:4}, {jobId, extra:true}]) {
      assert.equal((await call(invalid)).status, 400);
    }
    assert.equal(calls, 0);
    for (const [code, status] of [[200,'ARMED'], [409,'HELD'], [503,'UNVERIFIED']]) {
      const response = await call({jobId});
      assert.equal(response.status, code);
      assert.deepEqual(await response.json(), {status, servedVersion:version});
    }
  } finally {
    pilot.armSingleNormalExpense = original;
  }
});
