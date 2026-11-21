import test from 'node:test';import assert from 'node:assert/strict';import {verifyVersion} from '../scripts/issue248-version-proof.mjs';
const prior='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',next='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const fixture=()=>({success:true,result:{deployments:[{versions:[{percentage:100,version_id:next}]}]}});
test('accepts exactly one Wrangler version and matching 100% provider version',()=>assert.equal(verifyVersion(`Uploaded synthetic\nCurrent Version ID: ${next}\n`,fixture(),prior),next));
for(const [name,log,change] of [
 ['missing output','Uploaded synthetic',()=>{}],['duplicate lines',`Current Version ID: ${next}\nCurrent Version ID: ${next}`,()=>{}],
 ['malformed extra line',`Current Version ID: ${next}\nCurrent Version ID: unexpected`,()=>{}],['wrong version',`Current Version ID: ${prior}`,()=>{}],
 ['split traffic',`Current Version ID: ${next}`,p=>p.result.deployments[0].versions.push({percentage:1,version_id:prior})],
 ['partial traffic',`Current Version ID: ${next}`,p=>{p.result.deployments[0].versions[0].percentage=99;}],
 ['API mismatch',`Current Version ID: ${next}`,p=>{p.result.deployments[0].versions[0].version_id=prior;}],
 ['failed API',`Current Version ID: ${next}`,p=>{p.success=false;}]
])test(`fails closed for ${name}`,()=>{const p=fixture();change(p);assert.throws(()=>verifyVersion(log,p,prior),/NO_GO_VERSION_PROOF/);});
