import type {Env} from '../types';
import {writeRawFullByMetadataUat} from './client';
import {baselineMatches,type LedgerBaseline,type LedgerCellValue} from './ledger-stable-journal';
import {buildLedgerMetadataValueRange,verifyLedgerMetadataWitness,type LedgerWriteIdentity,type LedgerWriteGuard} from './ledger-metadata-writer';
import type {LedgerProjectionProbe} from './ledger-stable-projector';
import {rawProjectionValuesMatch,rawSourceStillMatches,type RawSourceProof} from './raw-source-proof';

/** Injected transaction authority for local/shadow experiments only. An actual
 * production implementation must atomically prove source, lease, cutover and
 * full baseline, and hold uncertain dispatches durably. No implementation or
 * live sync route is supplied here. */
export interface RawFullIntentPort{
  begin(source:RawSourceProof,metadataId:number,baseline:LedgerBaseline,token:string):Promise<boolean>;
  canDispatch(source:RawSourceProof,metadataId:number,token:string):Promise<boolean>;
  hold(metadataId:number,token:string):Promise<void>;
}
export interface RawFullProjectionObservation{status:'REVIEW';observation:'READBACK_MATCHED'|'UNVERIFIED';}

/**
 * Existing-row, full RAW adapter with no production route. Even successful
 * readback remains REVIEW; this function never marks an intent verified or a
 * multi-sheet job complete. A mock/injected port is not production evidence.
 */
export async function projectRawFullShadow(env:Env,source:RawSourceProof,identity:LedgerWriteIdentity,metadataId:number,baseline:LedgerBaseline,token:string,probe:LedgerProjectionProbe,intents:RawFullIntentPort):Promise<RawFullProjectionObservation>{
  const unverified:RawFullProjectionObservation={status:'REVIEW',observation:'UNVERIFIED'};let begun=false;
  try{
    if(env.RUNTIME_MODE!=='shadow'||env.SHEETS_LEDGER_FULL_PROJECTION_UAT!=='true'||identity.kind!==source.kind||identity.entityId!==source.entityId||identity.itemId!==undefined||!Number.isSafeInteger(metadataId)||metadataId<1||metadataId>2147483647||!/^[-A-Za-z0-9_]{16,128}$/.test(token))return unverified;
    if(!await rawSourceStillMatches(env,source))return unverified;
    const size=source.kind==='EXPENSE'?17:source.kind==='PERSONAL_USE'?15:0,fields=Array.from({length:size-1},(_,i)=>i+1);
    const first=await probe.read();if(first.witness.metadataId!==metadataId)throw Error('RAW_FULL_METADATA_INVALID');
    verifyLedgerMetadataWitness(identity,first.witness,first.identityRows);
    if(first.guard.observed[0]?.entered!==identity.entityId||first.guard.observed[0]?.formula!==null)throw Error('RAW_FULL_IDENTITY_INVALID');
    const guard:LedgerWriteGuard={...first.guard,fields},initial=buildLedgerMetadataValueRange(identity,metadataId,source.values,guard);
    const keys=Object.keys(baseline||{}),preimage:Record<string,LedgerCellValue>={};for(const i of fields)preimage[String(i)]=guard.observed[i]!.entered;
    if(keys.length!==size-1||fields.some(i=>!/^[a-f0-9]{64}$/.test(baseline[String(i)]||''))||!await baselineMatches(baseline,preimage))throw Error('RAW_FULL_BASELINE_INCOMPLETE');
    if(!await intents.begin(source,metadataId,baseline,token))return unverified;begun=true;
    await writeRawFullByMetadataUat(env,{identity,witness:first.witness,identityRows:first.identityRows,values:source.values,guard,baselineHashes:baseline},async()=>{
      const fresh=await probe.read();if(fresh.witness.metadataId!==metadataId)throw Error('RAW_FULL_METADATA_INVALID');
      verifyLedgerMetadataWitness(identity,fresh.witness,fresh.identityRows);
      if(fresh.guard.observed[0]?.entered!==identity.entityId||fresh.guard.observed[0]?.formula!==null)throw Error('RAW_FULL_IDENTITY_INVALID');
      const refreshed=buildLedgerMetadataValueRange(identity,metadataId,source.values,{...fresh.guard,fields});
      const current:Record<string,LedgerCellValue>={};for(const i of fields)current[String(i)]=fresh.guard.observed[i]!.entered;
      if(JSON.stringify(initial)!==JSON.stringify(refreshed)||!await baselineMatches(baseline,current)||!await rawSourceStillMatches(env,source)||!await intents.canDispatch(source,metadataId,token))throw Error('RAW_FULL_DISPATCH_FENCE_LOST');
    });
    const post=await probe.read();if(post.witness.metadataId!==metadataId)throw Error('RAW_FULL_METADATA_INVALID');
    verifyLedgerMetadataWitness(identity,post.witness,post.identityRows);
    if(post.guard.observed.some(cell=>!cell||cell.note!==null||cell.hasValidation!==false)||!rawProjectionValuesMatch(source,post.guard.observed)||!await rawSourceStillMatches(env,source)||!await intents.canDispatch(source,metadataId,token))throw Error('RAW_FULL_READBACK_UNVERIFIED');
    return{status:'REVIEW',observation:'READBACK_MATCHED'};
  }catch{return unverified;}
  finally{if(begun){try{await intents.hold(metadataId,token);}catch{/* uncertain IN_FLIGHT must remain held */}}}
}
