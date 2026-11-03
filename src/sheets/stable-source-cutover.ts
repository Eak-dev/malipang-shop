import type {Env} from '../types';

export type StableSourceType='EXPENSE'|'PERSONAL_USE';
const revisionTriggers=['expense_events','expense_documents','expense_document_links','expense_document_items','owner_personal_transactions'].flatMap(table=>['insert','update','delete'].map(operation=>`stable_source_revision_${table}_${operation}`));
/** Missing tracking or retention triggers makes revision evidence unusable. */
const retained=['stable_source_revision_no_delete','stable_source_revision_no_replace','stable_source_revision_monotonic','stable_pre_cutover_no_delete','stable_pre_cutover_no_update','stable_pre_cutover_no_replace','stable_cutover_no_delete','stable_cutover_no_replace','stable_cutover_transition','stable_projection_no_delete','stable_projection_no_replace','stable_projection_transition'];
export const stableSourceIntegrity=`(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN (${[...revisionTriggers,...retained].map(name=>`'${name}'`).join(',')}))=27`;

/** The snapshot and activation must be submitted in one D1 batch only after
 * legacy writers and their provider requests are drained. This function is a
 * local building block, not a route or authorization to change production. */
export function stableCutoverStatements(env:Env):D1PreparedStatement[]{
  return [
    env.DB.prepare("INSERT INTO stable_pre_cutover_sources(entity_type,entity_id) SELECT 'EXPENSE',expense_id FROM expense_events"),
    env.DB.prepare("INSERT INTO stable_pre_cutover_sources(entity_type,entity_id) SELECT 'PERSONAL_USE',personal_use_id FROM owner_personal_transactions"),
    env.DB.prepare("UPDATE stable_sync_cutover SET state='ACTIVE',activated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE singleton=1 AND state='PREPARED'"),
    env.DB.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid','$') END AS ok")
  ];
}

/** Reusable D1 predicate. It must be evaluated in the same transaction as
 * a durable write intent, never used as standalone Sheets permission. */
export function newStableSourcePredicate(type:StableSourceType):string{
  if(type!=='EXPENSE'&&type!=='PERSONAL_USE')throw Error('INVALID_STABLE_SOURCE_TYPE');
  const exists=type==='EXPENSE'
    ?"SELECT 1 FROM expense_events e WHERE e.expense_id=? AND NOT EXISTS(SELECT 1 FROM stable_pre_cutover_sources s WHERE s.entity_type='EXPENSE' AND s.entity_id=e.expense_id)"
    :"SELECT 1 FROM owner_personal_transactions p WHERE p.personal_use_id=? AND NOT EXISTS(SELECT 1 FROM stable_pre_cutover_sources s WHERE s.entity_type='PERSONAL_USE' AND s.entity_id=p.personal_use_id)";
  return `EXISTS(SELECT 1 FROM stable_sync_cutover WHERE singleton=1 AND state='ACTIVE') AND EXISTS(${exists})`;
}
