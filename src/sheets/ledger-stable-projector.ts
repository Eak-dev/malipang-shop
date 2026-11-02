import type {Env} from '../types';
import {writeValuesByMetadataPrototype} from './client';
import {LedgerStableJournal,digestLedgerCell,baselineMatches,type LedgerSourceProof,type LedgerBaseline,type LedgerCellValue} from './ledger-stable-journal';
import {verifyLedgerMetadataWitness,buildLedgerMetadataValueRange,type LedgerWriteIdentity,type LedgerMetadataWitness,type LedgerWriteGuard} from './ledger-metadata-writer';

/** UAT injection seam, not an independently trusted Google reader. */
export interface LedgerProjectionProbe {
  read():Promise<{witness:LedgerMetadataWitness;identityRows:unknown[][];guard:LedgerWriteGuard}>;
}
export type LedgerProjectionResult='VERIFIED'|'REVIEW';

/** Initial supported fields are those exactly derived from the source proof. */
function sourceValues(proof:LedgerSourceProof):Record<number,unknown>{
  if(proof.kind==='EXPENSE')return {1:proof.transactionDate,2:proof.description,3:proof.amountSatang/100,4:proof.paymentKey,5:proof.sourceWallet,6:proof.category,7:proof.status};
  if(proof.kind==='PERSONAL_USE')return {1:proof.transactionType,2:proof.transactionDate,3:proof.description,4:proof.amountSatang/100,5:proof.sourceWallet,6:proof.status,13:proof.updatedAt,14:proof.version};
  // Item/document siblings need a consistent whole-expense proof and
  // cross-projection coordinator before any detail write may be attempted.
  throw new Error('LEDGER_DETAIL_COORDINATION_UNAVAILABLE');
}

/**
 * Existing-row UAT experiment only. There is no production route, enrollment,
 * new-row append or release workflow. The injected probe must eventually be
 * replaced by an authenticated, bounded Google reader with exclusive cutover.
 */
export async function projectExistingLedgerShadow(env:Env,sheet:string,proof:LedgerSourceProof,identity:LedgerWriteIdentity,metadataId:number,projectedVersion:number,values:readonly unknown[],token:string,probe:LedgerProjectionProbe):Promise<LedgerProjectionResult>{
  let journal:LedgerStableJournal|undefined,started=false;
  try{
    if(proof.kind==='PURCHASE_DETAILS'||identity.kind!==proof.kind||identity.entityId!==proof.id||metadataId<1)throw new Error('LEDGER_PROJECTION_SCOPE');
    const derived=sourceValues(proof);
    journal=new LedgerStableJournal(env,sheet,proof);
    const baseline=await journal.getVerified(metadataId,projectedVersion);if(!baseline)throw new Error('LEDGER_BASELINE_UNAVAILABLE');
    const first=await probe.read();
    if(first.witness.metadataId!==metadataId)throw new Error('LEDGER_METADATA_MISMATCH');
    verifyLedgerMetadataWitness(identity,first.witness,first.identityRows);
    const initial=buildLedgerMetadataValueRange(identity,metadataId,values,first.guard);
    const owned=Object.keys(derived).map(Number);
    if(first.guard.fields.length!==owned.length||owned.some(index=>!first.guard.fields.includes(index)))throw new Error('LEDGER_CORE_FIELDS_INCOMPLETE');
    for(const index of first.guard.fields)if(!(index in derived)||values[index]!==derived[index])throw new Error('LEDGER_DESIRED_SOURCE_MISMATCH');
    if(!await journal.beginUpdate(metadataId,projectedVersion,baseline,token))throw new Error('LEDGER_INTENT_UNAVAILABLE');started=true;
    await writeValuesByMetadataPrototype(env,{identity,witness:first.witness,identityRows:first.identityRows,values,guard:first.guard,baselineHashes:baseline},async()=>{
      const fresh=await probe.read();
      if(fresh.witness.metadataId!==metadataId)throw new Error('LEDGER_METADATA_MISMATCH');
      verifyLedgerMetadataWitness(identity,fresh.witness,fresh.identityRows);
      const refreshed=buildLedgerMetadataValueRange(identity,metadataId,values,fresh.guard);
      const current:Record<string,LedgerCellValue>={};for(const i of fresh.guard.fields)current[String(i)]=fresh.guard.observed[i]!.entered;
      if(JSON.stringify(refreshed)!==JSON.stringify(initial)||!await baselineMatches(baseline,current)||!await journal!.canDispatch(metadataId,token))throw new Error('LEDGER_DISPATCH_FENCE_LOST');
    });
    const post=await probe.read();
    if(post.witness.metadataId!==metadataId)throw new Error('LEDGER_POSTIMAGE_MISMATCH');
    verifyLedgerMetadataWitness(identity,post.witness,post.identityRows);
    const next:LedgerBaseline={...baseline};
    for(const index of first.guard.fields){
      const cell=post.guard.observed[index],desired=values[index]??'';
      if(!cell||cell.formula!==null||cell.note!==null||cell.hasValidation!==false||!((desired===''&&cell.entered===null)||cell.entered===desired))throw new Error('LEDGER_POSTIMAGE_MISMATCH');
      next[String(index)]=await digestLedgerCell(cell.entered);
    }
    if(!await journal.finish(metadataId,token,next))throw new Error('LEDGER_FINISH_UNVERIFIED');
    return 'VERIFIED';
  }catch{
    if(started&&journal){try{await journal.hold(metadataId,token);}catch{/* IN_FLIGHT remains sticky */}}
    return 'REVIEW';
  }
}
