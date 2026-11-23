// Local research primitive only. A valid signature authenticates a statement;
// it does not independently prove Google requests finished or that an external
// writer fence remains in force. No production authority is wired to this.
export type QuiescenceContext={
 bookDigest:string;originalOperationDigest:string;originalProofDigest:string;predecessorAuditDigest:string;holdEvidenceDigest:string;
 roundId:string;predecessorJobId:string;predecessorEpochId:string;predecessorSourceDigest:string;predecessorGeneration:number;claimDigest:string;
 successorJobId:string;successorSourceDigest:string;successorVersion:number;successorMonth:string;predecessorOrdinal:number;successorOrdinal:number;
 sourceRevision:number;workerVersion:string;fenceDigest:string;fenceGeneration:number;
};
export type QuiescenceAttestation=QuiescenceContext & {domain:'MALIPANG_SERIAL_QUIESCENCE_V1';nonce:string;issuedAt:string;expiresAt:string;signature:string};
const hash=/^[0-9a-f]{64}$/,uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,iso=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const keys=['bookDigest','originalOperationDigest','originalProofDigest','predecessorAuditDigest','holdEvidenceDigest','roundId','predecessorJobId','predecessorEpochId','predecessorSourceDigest','predecessorGeneration','claimDigest','successorJobId','successorSourceDigest','successorVersion','successorMonth','predecessorOrdinal','successorOrdinal','sourceRevision','workerVersion','fenceDigest','fenceGeneration'] as const;
export function quiescencePayload(value:QuiescenceAttestation):Uint8Array{
 return new TextEncoder().encode(JSON.stringify([value.domain,...keys.map(key=>value[key]),value.nonce,value.issuedAt,value.expiresAt]));
}
/** Caller must separately authenticate the public key and atomically bind all
 * context, nonce, deadline and a continuously held fence at admission. */
export async function verifyQuiescenceAttestation(value:QuiescenceAttestation,expected:QuiescenceContext,publicKey:Uint8Array,nowMs:number):Promise<boolean>{
 try{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length+5||Object.keys(value).some(key=>![...keys,'domain','nonce','issuedAt','expiresAt','signature'].includes(key as never))||value.domain!=='MALIPANG_SERIAL_QUIESCENCE_V1'||keys.some(key=>value[key]!==expected[key])||
   ![value.bookDigest,value.originalOperationDigest,value.originalProofDigest,value.predecessorAuditDigest,value.holdEvidenceDigest,value.predecessorSourceDigest,value.claimDigest,value.successorSourceDigest,value.fenceDigest].every(x=>typeof x==='string'&&hash.test(x))||
   ![value.roundId,value.predecessorJobId,value.successorJobId,value.workerVersion,value.nonce].every(x=>typeof x==='string'&&uuid.test(x))||
   value.predecessorJobId===value.successorJobId||typeof value.predecessorEpochId!=='string'||!value.predecessorEpochId.startsWith('normal_pilot296_')||!uuid.test(value.predecessorEpochId.slice(16))||value.predecessorGeneration!==0||
   value.successorVersion!==1||!/^\d{4}-(0[1-9]|1[0-2])$/.test(value.successorMonth)||
   !Number.isSafeInteger(value.predecessorOrdinal)||value.predecessorOrdinal<0||!Number.isSafeInteger(value.successorOrdinal)||value.successorOrdinal!==value.predecessorOrdinal+1||!Number.isSafeInteger(value.sourceRevision)||value.sourceRevision<0||!Number.isSafeInteger(value.fenceGeneration)||value.fenceGeneration<1||
   !iso.test(value.issuedAt)||!iso.test(value.expiresAt)||!Number.isFinite(nowMs)||publicKey.length!==32||typeof value.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(value.signature))return false;
  const issued=Date.parse(value.issuedAt),expires=Date.parse(value.expiresAt);
  if(!Number.isFinite(issued)||!Number.isFinite(expires)||new Date(issued).toISOString()!==value.issuedAt||new Date(expires).toISOString()!==value.expiresAt||issued>nowMs||nowMs>=expires||expires-issued>300000)return false;
  const raw=atob(value.signature.replace(/-/g,'+').replace(/_/g,'/')+'=='),signature=Uint8Array.from(raw,c=>c.charCodeAt(0));
  const key=await crypto.subtle.importKey('raw',publicKey,{name:'Ed25519'},false,['verify']);
  return await crypto.subtle.verify('Ed25519',key,signature,quiescencePayload(value));
 }catch{return false;}
}
