import type {Env} from '../types';
import {readRawSourceProof,rawProjectionValuesMatch,rawSourceStillMatches} from './raw-source-proof';
import {createPersonalRawProductionProbe} from './ledger-google-probe';
import {digestLedgerCell,type LedgerBaseline} from './ledger-stable-journal';
import {historicalEnrollmentIntegrity} from './personal-historical-enrollment-integrity';
import {personalRecoverySourceIntegrity} from './personal-projection-runtime-journal';
import {personalEnrollmentLockIntegrity} from './personal-raw-enrollment';
import {sheetMetadataRegistryIntegrity} from './sheet-metadata-registry-guard';
import {isIsoDate} from '../shared/time';

type Snapshot={metadataId:number;sheetId:number;version:number;revision:number;fingerprint:string;generation:string;watermark:number;admission:number;month:string;token:string;outerToken:string;baseline:string;intentState:string;lockState:string};
export type HistoricalRecoveryInspection={state:'REVIEW';observation:'READBACK_MATCHED'|'READBACK_MISMATCH'|'EVIDENCE_UNAVAILABLE';evidenceDigest:string|null};
async function digest(value:unknown):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),v=>v.toString(16).padStart(2,'0')).join('');}

/** Point-in-time evidence only. Never resolves, replays, changes an outbox,
 * exposes provider values or makes a claim about editor exclusivity. */
export async function inspectPersonalHistoricalRecovery(env:Env,entityId:string):Promise<HistoricalRecoveryInspection>{
  const unavailable:HistoricalRecoveryInspection={state:'REVIEW',observation:'EVIDENCE_UNAVAILABLE',evidenceDigest:null};
  if(env.RUNTIME_MODE!=='production'||env.PERSONAL_HISTORICAL_IDENTITY_ENABLED!=='true'||env.PERSONAL_IDENTITY_READER_ENABLED!=='true'||env.PERSONAL_STABLE_PROJECTION_ENABLED!=='true'||!env.GOOGLE_SPREADSHEET_ID||!env.SHEET_PERSONAL_USE_RAW||!/^personal_[A-Za-z0-9_-]{1,128}$/.test(entityId))return unavailable;
  const snapshot=()=>env.DB.prepare(`SELECT i.metadata_id AS metadataId,i.sheet_id AS sheetId,i.source_version AS version,i.source_revision AS revision,i.source_fingerprint AS fingerprint,i.cutover_generation AS generation,i.admission_watermark AS watermark,i.admission_sequence AS admission,i.month,i.operation_token AS token,i.outer_token AS outerToken,i.baseline_json AS baseline,i.state AS intentState,l.state AS lockState
    FROM personal_historical_enrollment_intents i JOIN personal_raw_enrollment_locks l ON l.spreadsheet_id=i.spreadsheet_id AND l.sheet_name=i.sheet_name AND l.personal_use_id=i.personal_use_id AND l.metadata_id=i.metadata_id AND l.operation_token=i.operation_token AND l.outer_token=i.outer_token AND l.cutover_generation=i.cutover_generation AND l.state='REVIEW'
    JOIN owner_personal_transactions p ON p.personal_use_id=i.personal_use_id AND p.version=i.source_version AND p.status='CONFIRMED' AND substr(p.transaction_date,1,7)=i.month
    JOIN personal_projection_source_revisions r ON r.personal_use_id=i.personal_use_id AND r.revision=i.source_revision AND r.state='TRACKED'
    JOIN personal_projection_admissions a ON a.personal_use_id=i.personal_use_id AND a.sequence=i.admission_sequence
    JOIN personal_projection_cutovers c ON c.spreadsheet_id=i.spreadsheet_id AND c.sheet_name=i.sheet_name AND c.generation=i.cutover_generation AND c.admission_watermark=i.admission_watermark AND c.state='ACTIVE'
    JOIN personal_legacy_writer_gates g ON g.spreadsheet_id=i.spreadsheet_id AND g.sheet_name=i.sheet_name AND g.generation=i.cutover_generation AND g.state='HOLD'
    JOIN sheet_metadata_identity_registry m ON m.spreadsheet_id=i.spreadsheet_id AND m.sheet_name=i.sheet_name AND m.entity_kind='PERSONAL_USE' AND m.entity_id=i.personal_use_id AND m.metadata_id=i.metadata_id
    WHERE i.spreadsheet_id=? AND i.sheet_name=? AND i.personal_use_id=? AND i.state='REVIEW' AND i.admission_sequence<=i.admission_watermark
    AND EXISTS(SELECT 1 FROM personal_projection_bootstrap b WHERE b.singleton=1 AND b.state='COMPLETE') AND ${historicalEnrollmentIntegrity} AND ${personalRecoverySourceIntegrity} AND ${personalEnrollmentLockIntegrity} AND ${sheetMetadataRegistryIntegrity}
    AND NOT EXISTS(SELECT 1 FROM personal_raw_identity_intents j WHERE j.spreadsheet_id=i.spreadsheet_id AND j.sheet_name=i.sheet_name AND j.personal_use_id=i.personal_use_id)
    AND NOT EXISTS(SELECT 1 FROM sync_jobs s WHERE s.entity_type='PERSONAL_USE' AND (s.status='PROCESSING' OR (s.entity_key=i.personal_use_id AND s.status='REVIEW')))
    AND NOT EXISTS(SELECT 1 FROM personal_projection_runtime_intents o WHERE o.spreadsheet_id=i.spreadsheet_id AND o.personal_use_id=i.personal_use_id AND o.state IN ('IN_FLIGHT','REVIEW'))
    AND NOT EXISTS(SELECT 1 FROM personal_projection_generation_observations seen WHERE seen.spreadsheet_id=i.spreadsheet_id AND seen.personal_use_id=i.personal_use_id AND (seen.source_revision>i.source_revision OR seen.source_version>i.source_version OR (seen.state='REVIEW' AND NOT (COALESCE(seen.reason,'')='HISTORICAL_IDENTITY_UNVERIFIED' AND seen.cutover_generation=i.cutover_generation AND seen.source_version=i.source_version AND seen.source_revision=i.source_revision))))
    AND NOT EXISTS(SELECT 1 FROM personal_projection_generation_jobs seen WHERE seen.spreadsheet_id=i.spreadsheet_id AND seen.personal_use_id=i.personal_use_id AND (seen.source_revision>i.source_revision OR seen.source_version>i.source_version OR seen.state='IN_FLIGHT' OR (seen.state='REVIEW' AND NOT (COALESCE(seen.reason,'')='HISTORICAL_IDENTITY_UNVERIFIED' AND seen.cutover_generation=i.cutover_generation AND seen.source_version=i.source_version AND seen.source_revision=i.source_revision))))`).bind(env.GOOGLE_SPREADSHEET_ID,env.SHEET_PERSONAL_USE_RAW,entityId).first<Snapshot>();
  try{
    const before=await snapshot();if(!before||!Number.isSafeInteger(before.sheetId)||before.sheetId<0||!Number.isSafeInteger(before.metadataId)||before.metadataId<1||!Number.isSafeInteger(before.version)||before.version<1||!Number.isSafeInteger(before.revision)||before.revision<1||!Number.isSafeInteger(before.admission)||!Number.isSafeInteger(before.watermark)||before.admission<1||before.admission>before.watermark||!/^\d{4}-10$/.test(before.month))return unavailable;
    const source=await readRawSourceProof(env,'PERSONAL_USE',entityId,before.version);if(source.fingerprint!==before.fingerprint||typeof source.values[2]!=='string'||!isIsoDate(source.values[2])||!source.values[2].startsWith(`${before.month}-`))return unavailable;
    const post=await createPersonalRawProductionProbe(env,env.SHEET_PERSONAL_USE_RAW,{kind:'PERSONAL_USE',sheetId:before.sheetId,entityId},before.metadataId).read();
    if(post.witness.metadataId!==before.metadataId||post.guard.observed.some(cell=>!cell||cell.note!==null||cell.hasValidation!==false)||!rawProjectionValuesMatch(source,post.guard.observed))return{state:'REVIEW',observation:'READBACK_MISMATCH',evidenceDigest:null};
    const baseline:LedgerBaseline={};for(let i=1;i<15;i++)baseline[String(i)]=await digestLedgerCell(post.guard.observed[i]!.entered);if(JSON.stringify(baseline)!==before.baseline)return{state:'REVIEW',observation:'READBACK_MISMATCH',evidenceDigest:null};
    const after=await snapshot();if(!after||JSON.stringify(before)!==JSON.stringify(after)||!await rawSourceStillMatches(env,source))return unavailable;
    return{state:'REVIEW',observation:'READBACK_MATCHED',evidenceDigest:await digest(['personal-historical-recovery-v1',env.GOOGLE_SPREADSHEET_ID,env.SHEET_PERSONAL_USE_RAW,entityId,before])};
  }catch{return unavailable;}
}
