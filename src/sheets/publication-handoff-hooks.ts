import type {Env,SheetsSyncJob} from '../types';
import {finishVerifiedNormalStage,hasNormalNoticeHandoff,normalNoticeHandoffEnabled} from './continuous-normal-notice-handoff';

/** Build an exact publication bridge for the 0042 normal-notice lifecycle.
 * Prefixes contain the immutable intent transition and marker transition;
 * the helper commits them with job PENDING + handoff + dispatch atomically. */
export function publicationHandoffHooks(env:Env,job:SheetsSyncJob,claim:string,lease:string,revision:number,kind:'STAGE'|'PUBLISH'|'REVOKE'):{atomicHandoff:(prefix:D1PreparedStatement[],transitionId:string)=>Promise<boolean>;verifyHandoff:(transitionId:string)=>Promise<boolean>}{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,operationKind=kind==='REVOKE'?'CANCEL':'CONFIRM';
 if(!book||!claim||!lease||!Number.isSafeInteger(revision)||revision<0||!normalNoticeHandoffEnabled(env))throw Error('PUBLICATION_HANDOFF_DISABLED');
 const verifyHandoff=async(transitionId:string)=>{
  const row=await db.prepare(`SELECT 1 AS ok FROM continuous_normal_notice_handoffs h JOIN continuous_publication_intents i ON i.transition_id=h.journal_entity AND i.spreadsheet_id=h.spreadsheet_id AND i.entity_id=h.expense_id AND i.source_version=h.source_version AND i.claim_token=h.operation_token AND i.kind=? AND i.state='VERIFIED' JOIN continuous_publication_markers m ON m.transition_id=i.transition_id AND m.spreadsheet_id=i.spreadsheet_id AND m.entity_id=i.entity_id AND m.sheet_id=i.sheet_id AND m.sheet_name=i.sheet_name AND m.row_number=i.row_number AND m.version=i.source_version AND m.marker=i.after_value WHERE h.spreadsheet_id=? AND h.operation_token=? AND h.expense_id=? AND h.source_version=? AND h.projection='PUBLICATION' AND h.journal_entity=? AND h.operation_kind=?`).bind(kind,book,claim,job.entityKey,job.entityVersion,transitionId,operationKind).first<{ok:number}>();
  return env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&row?.ok===1&&await hasNormalNoticeHandoff(env,claim,job);
 };
 return{verifyHandoff,atomicHandoff:async(prefix,transitionId)=>{await finishVerifiedNormalStage(env,prefix,{job,claim,entity:transitionId,projection:'PUBLICATION',kind:operationKind},lease,revision);return verifyHandoff(transitionId);}};
}
