import type {Env,SheetsSyncJob} from '../types';
import {PersonalProjectionRuntimeJournal,type PersonalProjectionContext,type PersonalGenerationLease} from './personal-projection-runtime-journal';
import {digestLedgerCell,type LedgerBaseline} from './ledger-stable-journal';
import {rawSourceStillMatches,rawProjectionValuesMatch,type RawSourceProof} from './raw-source-proof';
import {readPersonalRawProductionSnapshot} from './ledger-uat-append-reader';
import {planPersonalRawEnrollment} from './personal-raw-enrollment-plan';
import {createPersonalRawProductionProbe} from './ledger-google-probe';
import {sendPersonalEnrollmentMutation} from './client';

export type PersonalEnrollmentResult={status:'REVIEW'|'HOLD_UNCONFIRMED'|'ALREADY_ATTEMPTED';observation:'NOT_DISPATCHED'|'OUTCOME_UNKNOWN'|'READBACK_UNVERIFIED'|'READBACK_MATCHED'};
const lockSchema=`(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('personal_enrollment_lock_no_delete','personal_enrollment_lock_no_release','personal_enrollment_lock_immutable','personal_enrollment_lock_no_replace','personal_enrollment_lock_rowid_no_replace'))=5 AND (SELECT count(*) FROM pragma_index_list('personal_raw_enrollment_locks') WHERE "unique"=1)=2 AND (SELECT count(*) FROM pragma_index_list('personal_raw_enrollment_locks') WHERE "unique"=1 AND partial=0 AND name IN ('sqlite_autoindex_personal_raw_enrollment_locks_1','sqlite_autoindex_personal_raw_enrollment_locks_2'))=2 AND (SELECT group_concat(name,',') FROM (SELECT name FROM pragma_index_info('sqlite_autoindex_personal_raw_enrollment_locks_1') ORDER BY seqno))='spreadsheet_id,sheet_name' AND (SELECT group_concat(name,',') FROM (SELECT name FROM pragma_index_info('sqlite_autoindex_personal_raw_enrollment_locks_2') ORDER BY seqno))='spreadsheet_id,metadata_id' AND (SELECT count(*) FROM pragma_index_xinfo('sqlite_autoindex_personal_raw_enrollment_locks_1') WHERE key=1 AND (coll IS NULL OR upper(coll)<>'BINARY'))=0 AND (SELECT count(*) FROM pragma_index_xinfo('sqlite_autoindex_personal_raw_enrollment_locks_2') WHERE key=1 AND (coll IS NULL OR upper(coll)<>'BINARY'))=0`;
/** New post-cutover identity enrollment candidate. No live route, automatic
 * retry or lock release. Sheets has no CAS; editor/legacy exclusion is a
 * separate prerequisite. Historical pre-watermark records remain REVIEW. */
export class PersonalRawEnrollment{
  #env:Env;#job:SheetsSyncJob;#outer:PersonalProjectionRuntimeJournal;#outerToken:string;#context:PersonalProjectionContext;
  #lock:string|null=null;#reserved:{token:string;metadataId:number;baseline:string}|null=null;#attempted=false;#authorized=false;#claimed=false;
  constructor(env:Env,job:SheetsSyncJob,lease:string,outerToken:string,context:PersonalProjectionContext,generationLease:PersonalGenerationLease){this.#env=env;this.#job={...job};this.#outer=new PersonalProjectionRuntimeJournal(env,job,lease,generationLease);this.#outerToken=outerToken;this.#context={...context};}
  #check(source:RawSourceProof,metadataId:number,token:string,sheetId:number):void{
    const e=this.#env,j=this.#job;if(e.RUNTIME_MODE!=='production'||e.PERSONAL_ENROLLMENT_ENABLED!=='true'||e.PERSONAL_IDENTITY_READER_ENABLED!=='true'||e.PERSONAL_STABLE_PROJECTION_ENABLED!=='true'||!e.GOOGLE_SPREADSHEET_ID||!e.SHEET_PERSONAL_USE_RAW||j.kind!=='SHEETS_SYNC'||j.entityType!=='PERSONAL_USE'||source.kind!=='PERSONAL_USE'||source.entityId!==j.entityKey||source.version!==j.entityVersion||!/^[a-f0-9]{64}$/.test(source.fingerprint)||!/^[-A-Za-z0-9_]{16,128}$/.test(token)||!Number.isSafeInteger(metadataId)||metadataId<1||metadataId>2147483647||!Number.isSafeInteger(sheetId)||sheetId<0)throw Error('PERSONAL_ENROLLMENT_DISABLED');
  }
  async acquire(source:RawSourceProof,metadataId:number,token:string,sheetId:number):Promise<boolean>{
    this.#check(source,metadataId,token,sheetId);if(!await rawSourceStillMatches(this.#env,source))return false;const f=this.#outer.dispatchFence(this.#outerToken,this.#context);
    const r=await this.#env.DB.prepare(`INSERT INTO personal_raw_enrollment_locks(spreadsheet_id,sheet_name,personal_use_id,metadata_id,state,operation_token,outer_token,cutover_generation,updated_at) SELECT ?,?,?,?,'HELD',?,?,?,? WHERE ${lockSchema} AND ${f.sql} ON CONFLICT DO NOTHING`).bind(this.#env.GOOGLE_SPREADSHEET_ID,this.#env.SHEET_PERSONAL_USE_RAW,this.#job.entityKey,metadataId,token,this.#outerToken,this.#context.generation,new Date().toISOString(),...f.args).run();if(Number(r.meta.changes||0)!==1)return false;this.#lock=token;return true;
  }
  async #reserve(source:RawSourceProof,metadataId:number,token:string,sheetId:number):Promise<ReturnType<typeof planPersonalRawEnrollment>>{
    this.#check(source,metadataId,token,sheetId);if(this.#lock!==token)throw Error('PERSONAL_ENROLLMENT_LOCK_MISSING');
    const snapshot=await readPersonalRawProductionSnapshot(this.#env,sheetId),plan=planPersonalRawEnrollment(source,sheetId,metadataId,snapshot),position=plan.createDeveloperMetadata.developerMetadata.location.dimensionRange.startIndex;
    if(!await rawSourceStillMatches(this.#env,source))throw Error('PERSONAL_ENROLLMENT_SOURCE_CHANGED');const baseline:LedgerBaseline={};for(let i=1;i<15;i++)baseline[String(i)]=await digestLedgerCell(snapshot.rows[position]![i]!.entered);const canonical=JSON.stringify(baseline),f=this.#outer.dispatchFence(this.#outerToken,this.#context);
    const r=await this.#env.DB.prepare(`INSERT INTO personal_raw_identity_intents(spreadsheet_id,sheet_name,personal_use_id,metadata_id,state,projected_version,projected_revision,baseline_json,source_version,source_revision,source_fingerprint,operation_token,outer_token,cutover_generation,updated_at)
      SELECT ?,?,?,?,'IN_FLIGHT',?,?,?,?,?,?,?,?,?,? WHERE ${lockSchema} AND ${f.sql}
      AND EXISTS(SELECT 1 FROM personal_raw_enrollment_locks l WHERE l.spreadsheet_id=? AND l.sheet_name=? AND l.personal_use_id=? AND l.metadata_id=? AND l.state='HELD' AND l.operation_token=? AND l.outer_token=? AND l.cutover_generation=?) ON CONFLICT DO NOTHING`).bind(this.#env.GOOGLE_SPREADSHEET_ID,this.#env.SHEET_PERSONAL_USE_RAW,this.#job.entityKey,metadataId,source.version,this.#context.revision,canonical,source.version,this.#context.revision,source.fingerprint,token,this.#outerToken,this.#context.generation,new Date().toISOString(),...f.args,this.#env.GOOGLE_SPREADSHEET_ID,this.#env.SHEET_PERSONAL_USE_RAW,this.#job.entityKey,metadataId,token,this.#outerToken,this.#context.generation).run();
    if(Number(r.meta.changes||0)!==1)throw Error('PERSONAL_ENROLLMENT_RESERVATION_FAILED');this.#reserved={token,metadataId,baseline:canonical};return plan;
  }
  async #fence(source:RawSourceProof,metadataId:number,token:string):Promise<boolean>{
    if(this.#reserved?.token!==token||this.#reserved.metadataId!==metadataId||!await rawSourceStillMatches(this.#env,source))return false;const f=this.#outer.dispatchFence(this.#outerToken,this.#context);
    const r=await this.#env.DB.prepare(`SELECT 1 AS ok FROM personal_raw_identity_intents i JOIN personal_raw_enrollment_locks l ON l.spreadsheet_id=i.spreadsheet_id AND l.sheet_name=i.sheet_name AND l.personal_use_id=i.personal_use_id AND l.metadata_id=i.metadata_id AND l.operation_token=i.operation_token AND l.outer_token=i.outer_token AND l.cutover_generation=i.cutover_generation AND l.state='HELD' JOIN sheet_metadata_identity_registry g ON g.spreadsheet_id=i.spreadsheet_id AND g.metadata_id=i.metadata_id AND g.sheet_name=i.sheet_name AND g.entity_kind='PERSONAL_USE' AND g.entity_id=i.personal_use_id
      WHERE i.spreadsheet_id=? AND i.sheet_name=? AND i.personal_use_id=? AND i.metadata_id=? AND i.state='IN_FLIGHT' AND i.source_version=? AND i.source_revision=? AND i.source_fingerprint=? AND i.operation_token=? AND i.outer_token=? AND i.cutover_generation=? AND i.baseline_json=? AND ${lockSchema} AND ${f.sql}`).bind(this.#env.GOOGLE_SPREADSHEET_ID,this.#env.SHEET_PERSONAL_USE_RAW,this.#job.entityKey,metadataId,source.version,this.#context.revision,source.fingerprint,token,this.#outerToken,this.#context.generation,this.#reserved.baseline,...f.args).first<{ok:number}>();return !!r;
  }
  async #authorize(env:Env,source:RawSourceProof,metadataId:number,token:string,sheetId:number,expectedPlan:string):Promise<boolean>{
    if(this.#claimed||!this.#attempted)return false;this.#claimed=true;try{if(env!==this.#env)return false;this.#check(source,metadataId,token,sheetId);const fresh=await readPersonalRawProductionSnapshot(env,sheetId),plan=planPersonalRawEnrollment(source,sheetId,metadataId,fresh);if(JSON.stringify(plan)!==expectedPlan||!await this.#fence(source,metadataId,token))return false;this.#authorized=true;return true;}catch{return false;}
  }
  static async authorizeTransport(intent:unknown,env:Env,source:RawSourceProof,metadataId:number,token:string,sheetId:number,expectedPlan:string):Promise<boolean>{try{return await (intent as PersonalRawEnrollment).#authorize(env,source,metadataId,token,sheetId,expectedPlan);}catch{return false;}}
  async #hold(token:string):Promise<boolean>{
    const a=await this.#env.DB.prepare(`UPDATE personal_raw_enrollment_locks SET state='REVIEW',updated_at=? WHERE spreadsheet_id=? AND sheet_name=? AND personal_use_id=? AND operation_token=? AND outer_token=? AND state IN ('HELD','REVIEW')`).bind(new Date().toISOString(),this.#env.GOOGLE_SPREADSHEET_ID,this.#env.SHEET_PERSONAL_USE_RAW,this.#job.entityKey,token,this.#outerToken).run();
    const b=await this.#env.DB.prepare(`UPDATE personal_raw_identity_intents SET state='REVIEW',updated_at=? WHERE spreadsheet_id=? AND sheet_name=? AND personal_use_id=? AND operation_token=? AND outer_token=? AND state IN ('IN_FLIGHT','REVIEW')`).bind(new Date().toISOString(),this.#env.GOOGLE_SPREADSHEET_ID,this.#env.SHEET_PERSONAL_USE_RAW,this.#job.entityKey,token,this.#outerToken).run();
    const c=await this.#outer.hold(this.#outerToken,this.#context);return Number(a.meta.changes||0)===1&&Number(b.meta.changes||0)===1&&c;
  }
  async dispatchOnce(source:RawSourceProof,metadataId:number,token:string,sheetId:number):Promise<PersonalEnrollmentResult>{
    if(this.#attempted)return{status:'ALREADY_ATTEMPTED',observation:'NOT_DISPATCHED'};this.#attempted=true;let acknowledged=false,observation:PersonalEnrollmentResult['observation']='NOT_DISPATCHED';
    try{this.#check(source,metadataId,token,sheetId);const expected={...source,values:[...source.values]},plan=await this.#reserve(expected,metadataId,token,sheetId);await sendPersonalEnrollmentMutation(this.#env,expected,metadataId,token,sheetId,plan,this);acknowledged=true;observation='READBACK_UNVERIFIED';
      const post=await createPersonalRawProductionProbe(this.#env,this.#env.SHEET_PERSONAL_USE_RAW!,{kind:'PERSONAL_USE',sheetId,entityId:expected.entityId},metadataId).read();
      if(post.witness.metadataId!==metadataId||post.guard.observed.some(cell=>!cell||cell.note!==null||cell.hasValidation!==false)||!rawProjectionValuesMatch(expected,post.guard.observed)||!await this.#fence(expected,metadataId,token))throw Error('PERSONAL_ENROLLMENT_READBACK_INVALID');observation='READBACK_MATCHED';
    }catch{if(!acknowledged)observation=this.#authorized?'OUTCOME_UNKNOWN':'NOT_DISPATCHED';}
    let held=false;try{held=await this.#hold(token);}catch{/* unacknowledged D1 state remains blocked */}return{status:held?'REVIEW':'HOLD_UNCONFIRMED',observation};
  }
}
Object.freeze(PersonalRawEnrollment);Object.freeze(PersonalRawEnrollment.prototype);
