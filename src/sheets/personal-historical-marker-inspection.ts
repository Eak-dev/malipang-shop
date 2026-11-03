import type {Env} from '../types';
import {searchPersonalProductionMetadataById} from './client';
import {readPersonalRawProductionSnapshot} from './ledger-uat-append-reader';
import {readHistoricalRecoveryContext} from './personal-historical-recovery-inspection';
import {readRawSourceProof,rawSourceStillMatches} from './raw-source-proof';
import {classifyHistoricalMarkerReview,type HistoricalMarkerObservation,type HistoricalMarkerClassification} from './personal-historical-marker-classifier';
import {planPersonalRawEnrollment} from './personal-raw-enrollment-plan';
import {digestLedgerCell,type LedgerBaseline} from './ledger-stable-journal';
import {sheetScopesDistinct} from './sheet-scope-isolation';
import {isIsoDate} from '../shared/time';

const record=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid');return value as Record<string,unknown>;};
function observationOf(data:unknown,id:number):HistoricalMarkerObservation{
  const root=record(data);if(Object.keys(root).some(key=>key!=='matchedDeveloperMetadata'))throw Error('invalid');const matches=root.matchedDeveloperMetadata===undefined?[]:root.matchedDeveloperMetadata;if(!Array.isArray(matches)||matches.length>1)throw Error('invalid');
  if(matches.length===0)return{kind:'ABSENT',metadataId:id};
  const metadata=record(record(matches[0]).developerMetadata),location=record(record(metadata.location).dimensionRange);
  if(metadata.metadataId!==id||typeof metadata.metadataKey!=='string'||typeof metadata.visibility!=='string'||metadata.metadataValue!==undefined&&metadata.metadataValue!==''||!Number.isSafeInteger(location.sheetId)||typeof location.dimension!=='string'||!Number.isSafeInteger(location.startIndex)||!Number.isSafeInteger(location.endIndex))throw Error('invalid');
  return{kind:'PRESENT',metadataId:id,metadataKey:metadata.metadataKey,visibility:metadata.visibility,sheetId:Number(location.sheetId),dimension:location.dimension,startIndex:Number(location.startIndex),endIndex:Number(location.endIndex)};
}
/** Internal read-only planning. The ephemeral plan includes a physical row;
 * never return or persist it. This does not prove a prior request has stopped
 * and does not itself authorize remediation. */
export async function prepareHistoricalMarkerInspection(env:Env,entityId:string):Promise<{state:'REVIEW';observation:HistoricalMarkerClassification;evidenceDigest:string|null;plan:ReturnType<typeof planPersonalRawEnrollment>|null;metadataId:number|null;marker:HistoricalMarkerObservation|null}>{
  const unavailable={state:'REVIEW' as const,observation:'EVIDENCE_UNAVAILABLE' as const,evidenceDigest:null,plan:null,metadataId:null,marker:null};
  if(!sheetScopesDistinct(env)||env.RUNTIME_MODE!=='production'||env.PERSONAL_HISTORICAL_IDENTITY_ENABLED!=='true'||env.PERSONAL_IDENTITY_READER_ENABLED!=='true'||env.PERSONAL_STABLE_PROJECTION_ENABLED!=='true'||!env.GOOGLE_SPREADSHEET_ID||!env.SHEET_PERSONAL_USE_RAW||!/^personal_[A-Za-z0-9_-]{1,128}$/.test(entityId))return unavailable;
  try{
    const before=await readHistoricalRecoveryContext(env,entityId);if(!before||!Number.isSafeInteger(before.metadataId)||before.metadataId<1||!Number.isSafeInteger(before.sheetId)||before.sheetId<0||!/^\d{4}-10$/.test(before.month))return unavailable;
    const source=await readRawSourceProof(env,'PERSONAL_USE',entityId,before.version);if(source.fingerprint!==before.fingerprint||typeof source.values[2]!=='string'||!isIsoDate(source.values[2])||!source.values[2].startsWith(`${before.month}-`))return unavailable;
    const first=observationOf(await searchPersonalProductionMetadataById(env,before.metadataId),before.metadataId),grid=await readPersonalRawProductionSnapshot(env,before.sheetId),last=observationOf(await searchPersonalProductionMetadataById(env,before.metadataId),before.metadataId);
    if(JSON.stringify(first)!==JSON.stringify(last))return unavailable;
    const scope={spreadsheetId:env.GOOGLE_SPREADSHEET_ID,sheetName:env.SHEET_PERSONAL_USE_RAW},owner={...scope,kind:'PERSONAL_USE',entityId,metadataId:before.metadataId},result=classifyHistoricalMarkerReview(source,before.sheetId,before.metadataId,grid,owner,scope,last);
    if(result==='EVIDENCE_UNAVAILABLE')return unavailable;
    const plan=planPersonalRawEnrollment(source,before.sheetId,before.metadataId,grid),target=plan.createDeveloperMetadata.developerMetadata.location.dimensionRange.startIndex,baseline:LedgerBaseline={};for(let i=1;i<15;i++)baseline[String(i)]=await digestLedgerCell(grid.rows[target]![i]!.entered);if(JSON.stringify(baseline)!==before.baseline)return unavailable;
    const after=await readHistoricalRecoveryContext(env,entityId);if(!sheetScopesDistinct(env)||!after||JSON.stringify(after)!==JSON.stringify(before)||!await rawSourceStillMatches(env,source))return unavailable;
    const wrongRow=last.kind==='PRESENT'?grid.rows[last.startIndex]:null;
    const data=new TextEncoder().encode(JSON.stringify(['historical-marker-inspection-v1',scope,entityId,before,last,result,wrongRow]));const evidenceDigest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),n=>n.toString(16).padStart(2,'0')).join('');
    return{state:'REVIEW',observation:result,evidenceDigest,plan,metadataId:before.metadataId,marker:last};
  }catch{return unavailable;}
}
export async function inspectHistoricalMarker(env:Env,entityId:string):Promise<{state:'REVIEW';observation:HistoricalMarkerClassification;evidenceDigest:string|null}>{const {state,observation,evidenceDigest}=await prepareHistoricalMarkerInspection(env,entityId);return{state,observation,evidenceDigest};}
