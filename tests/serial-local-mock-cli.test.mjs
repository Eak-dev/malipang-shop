import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('./helpers/serial-local-mock-cli.mjs',import.meta.url));
test('local mock launcher runs an isolated synthetic round and rejects external inputs',()=>{
 const run=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:20000,env:{...process.env,MALIPANG_WORKER_URL:'https://external.invalid',PILOT_LOCAL_MOCK:'false',CLOUDFLARE_API_TOKEN:'must-not-be-used'}});
 assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),{outcome:'LOCAL_MOCK_ROUND_RECORDED',evidence:'SYNTHETIC_ONLY'});assert.ok(!run.stdout.includes('must-not-be-used'));
 const rejected=spawnSync(process.execPath,[script,'https://external.invalid'],{encoding:'utf8',timeout:20000});assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/LOCAL_MOCK_ARGUMENTS_FORBIDDEN/);
});
