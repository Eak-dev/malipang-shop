import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
const {quiescencePayload,verifyQuiescenceAttestation}=createRequire(import.meta.url)('../dist/admin/serial-quiescence-attestation.js');
const uuid=n=>`${String(n).repeat(8)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(12)}`;
test('local attestation verifies signature and exact bounded context but grants no reservation',async()=>{
 const signer=await webcrypto.subtle.generateKey('Ed25519',true,['sign','verify']);
 const other=await webcrypto.subtle.generateKey('Ed25519',true,['sign','verify']);
 const pub=new Uint8Array(await webcrypto.subtle.exportKey('raw',signer.publicKey)),wrong=new Uint8Array(await webcrypto.subtle.exportKey('raw',other.publicKey));
 const context={bookDigest:'a'.repeat(64),originalOperationDigest:'b'.repeat(64),originalProofDigest:'c'.repeat(64),predecessorAuditDigest:'1'.repeat(64),holdEvidenceDigest:'2'.repeat(64),roundId:uuid(1),predecessorJobId:uuid(2),predecessorEpochId:'normal_pilot296_'+uuid(3),predecessorSourceDigest:'3'.repeat(64),predecessorGeneration:0,claimDigest:'d'.repeat(64),successorJobId:uuid(4),successorSourceDigest:'4'.repeat(64),successorVersion:1,successorMonth:'2026-11',predecessorOrdinal:0,successorOrdinal:1,sourceRevision:7,workerVersion:uuid(5),fenceDigest:'e'.repeat(64),fenceGeneration:2};
 const value={...context,domain:'MALIPANG_SERIAL_QUIESCENCE_V1',nonce:uuid(6),issuedAt:'2026-11-22T00:00:00.000Z',expiresAt:'2026-11-22T00:05:00.000Z',signature:''};
 value.signature=Buffer.from(await webcrypto.subtle.sign('Ed25519',signer.privateKey,quiescencePayload(value))).toString('base64url');
 const now=Date.parse('2026-11-22T00:02:00.000Z');
 assert.equal(await verifyQuiescenceAttestation(value,context,pub,now),true);
 for(const [key,entry] of Object.entries(context)){
  const replacement=typeof entry==='number'?entry+1:String(entry)+'x';
  assert.equal(await verifyQuiescenceAttestation(value,{...context,[key]:replacement},pub,now),false,key);
 }
 for(const key of ['bookDigest','claimDigest','fenceDigest','originalProofDigest'])assert.equal(await verifyQuiescenceAttestation(value,{...context,[key]:'f'.repeat(64)},pub,now),false);
 assert.equal(await verifyQuiescenceAttestation(value,{...context,successorJobId:uuid(7)},pub,now),false);
 assert.equal(await verifyQuiescenceAttestation(value,context,wrong,now),false);
 assert.equal(await verifyQuiescenceAttestation(value,context,pub,Date.parse(value.expiresAt)),false);
 assert.equal(await verifyQuiescenceAttestation({...value,nonce:uuid(8)},context,pub,now),false);
 assert.equal(await verifyQuiescenceAttestation({...value,signature:'A'.repeat(86)},context,pub,now),false);
 assert.equal(await verifyQuiescenceAttestation(value,context,pub,Date.parse(value.issuedAt)-1),false);
 assert.equal(await verifyQuiescenceAttestation({...value,expiresAt:'2026-11-22T00:06:00.000Z'},context,pub,now),false);
 assert.equal(await verifyQuiescenceAttestation({...value,issuedAt:'2026-13-22T00:00:00.000Z'},context,pub,now),false);
 assert.equal(await verifyQuiescenceAttestation({...value,predecessorEpochId:'normal_pilot296_'+('-'.repeat(36))},{...context,predecessorEpochId:'normal_pilot296_'+('-'.repeat(36))},pub,now),false);
 assert.equal(await verifyQuiescenceAttestation({...value,unexpected:'data'},context,pub,now),false);
 // A stateless verifier cannot prevent replay; a future D1 handoff must bind a
 // unique nonce and all proof inputs atomically before granting authority.
 assert.equal(await verifyQuiescenceAttestation(value,context,pub,now),true);
});
