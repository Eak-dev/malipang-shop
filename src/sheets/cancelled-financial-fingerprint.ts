import type {Env,SheetsSyncJob} from '../types';
import {decodePublicationCarrier,publicationTransition} from './continuous-publication-template';

/** Experimental, read-only cancellation identity. This is not write authority.
 * The caller must capture the expense and this statement in the same D1 batch,
 * preserve the global revision CAS, and fence journal mutations across a POST. */
export function cancelledProjectionSnapshot(env:Env,job:SheetsSyncJob):D1PreparedStatement{
 return env.DB.prepare(`SELECT p.entity_id,p.projection,p.sheet_id,p.sheet_name,p.source_version,p.source_digest,p.operation_token,p.state,
  x.sheet_id AS preimage_sheet_id,x.sheet_name AS preimage_sheet_name,x.source_version AS preimage_source_version,
  x.source_digest AS preimage_source_digest,x.preimage_width,x.preimage_digest
  FROM stable_projection_writes p LEFT JOIN stable_expense_projection_preimages x
  ON x.spreadsheet_id=p.spreadsheet_id AND x.entity_type=p.entity_type AND x.entity_id=p.entity_id AND x.projection=p.projection
  WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND (p.entity_id=? OR substr(p.entity_id,1,length(?)+1)=?||'|')
  ORDER BY p.entity_id,p.projection`).bind(env.GOOGLE_SPREADSHEET_ID,job.entityKey,job.entityKey,job.entityKey);
}

/** Capture this in the same transaction as the expense and projection rows.
 * REVOKE intent insertion must atomically compare the returned revision. */
export function cancelledJournalRevisionSnapshot(env:Env):D1PreparedStatement{
 const triggers=['continuous_cancel_financial_activation_insert','continuous_cancel_financial_activation_no_update','continuous_cancel_financial_activation_no_delete','continuous_cancel_financial_activation_no_replace','continuous_financial_journal_revision_no_delete','continuous_financial_journal_revision_no_replace','continuous_financial_journal_revision_monotonic','continuous_financial_projection_insert_revision','continuous_financial_projection_update_revision','continuous_financial_projection_delete_revision','continuous_financial_preimage_insert_revision','continuous_financial_preimage_update_revision','continuous_financial_preimage_delete_revision','continuous_revoke_journal_revision_insert','continuous_revoke_journal_revision_immutable','continuous_revoke_projection_insert_fence','continuous_revoke_projection_update_fence','continuous_revoke_preimage_insert_fence'];
 return env.DB.prepare(`SELECT revision FROM continuous_financial_journal_revision WHERE singleton=1 AND EXISTS(SELECT 1 FROM continuous_undo_serialization_activation WHERE singleton=1) AND EXISTS(SELECT 1 FROM continuous_cancel_financial_activation WHERE singleton=1) AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN (${triggers.map(x=>`'${x}'`).join(',')}))=${triggers.length}`);
}

export function cancelledPriorMarkerSnapshot(env:Env,job:SheetsSyncJob):D1PreparedStatement{
 return env.DB.prepare(`SELECT m.marker,m.state,m.version,i.kind,i.before_value,i.after_value,CASE WHEN i.kind='REVOKE' THEN previous.source_digest ELSE i.source_digest END AS confirmed_digest FROM continuous_publication_markers m JOIN continuous_publication_intents i ON i.transition_id=m.transition_id AND i.spreadsheet_id=m.spreadsheet_id AND i.entity_id=m.entity_id AND i.sheet_id=m.sheet_id AND i.sheet_name=m.sheet_name AND i.row_number=m.row_number AND i.source_version=m.version AND i.after_value=m.marker AND i.state='VERIFIED' LEFT JOIN continuous_publication_intents previous ON i.kind='REVOKE' AND previous.spreadsheet_id=i.spreadsheet_id AND previous.entity_id=i.entity_id AND previous.sheet_id=i.sheet_id AND previous.sheet_name=i.sheet_name AND previous.row_number=i.row_number AND previous.after_value=i.before_value AND previous.source_version=i.source_version-1 AND previous.state='VERIFIED' AND previous.kind=CASE i.before_state WHEN 'PUBLISHED' THEN 'PUBLISH' WHEN 'STAGED' THEN 'STAGE' ELSE '' END WHERE m.spreadsheet_id=? AND m.entity_id=?`).bind(env.GOOGLE_SPREADSHEET_ID,job.entityKey);
}
/** Resolve the same original marker before and after a verified REVOKE. */
export function cancelledPriorMarker(job:SheetsSyncJob,row:Record<string,unknown>|undefined):{state:'PUBLISHED'|'STAGED';detailCount:number;sourceDigest:string}|null{
 if(!row)return null;const current=decodePublicationCarrier(row.marker);if(!current||row.version!==current.version||row.state!==current.state||row.after_value!==row.marker||current.expenseId!==job.entityKey)return null;
 const prior=current.state==='REVOKED'?decodePublicationCarrier(row.before_value):current;
 if(!prior||prior.expenseId!==job.entityKey||prior.version!==job.entityVersion-1||!['PUBLISHED','STAGED'].includes(prior.state)||typeof row.confirmed_digest!=='string'||!/^[0-9a-f]{64}$/.test(row.confirmed_digest))return null;
 if(current.state==='REVOKED'){if(current.version!==job.entityVersion||row.kind!=='REVOKE')return null;try{publicationTransition(prior,current);}catch{return null;}}
 else if(current.version!==job.entityVersion-1||row.kind!==(current.state==='PUBLISHED'?'PUBLISH':'STAGE'))return null;
 return{state:prior.state as 'PUBLISHED'|'STAGED',detailCount:prior.detailCount,sourceDigest:row.confirmed_digest};
}

export async function cancelledFinancialFingerprint(job:SheetsSyncJob,expense:Record<string,unknown>,rows:Record<string,unknown>[],prior:{state:'PUBLISHED'|'STAGED';detailCount:number;sourceDigest:string}):Promise<string|null>{
 if(!/^exp_[A-Za-z0-9_-]{1,128}$/.test(job.entityKey)||job.entityVersion<2||!Number.isSafeInteger(job.entityVersion)||expense.expense_id!==job.entityKey||expense.version!==job.entityVersion||expense.status!=='CANCELLED'||rows.length>502||!['STAGED','PUBLISHED'].includes(prior.state)||!Number.isSafeInteger(prior.detailCount)||prior.detailCount<0||prior.detailCount>500||!/^[0-9a-f]{64}$/.test(prior.sourceDigest))return null;
 const seen=new Set<string>(),digest=/^[0-9a-f]{64}$/;
 for(const p of rows){
  const id=p.entity_id,kind=p.projection,key=JSON.stringify([id,kind]);
  if(typeof id!=='string'||seen.has(key)||!['DAILY','EXPENSE_RAW','DETAIL'].includes(String(kind))||
   (kind==='DETAIL'?!id.startsWith(`${job.entityKey}|`)||!/^item_[A-Za-z0-9_-]{1,128}$/.test(id.slice(job.entityKey.length+1)):id!==job.entityKey)||
   p.state!=='VERIFIED'||p.source_version!==job.entityVersion-1||!Number.isSafeInteger(p.sheet_id)||Number(p.sheet_id)<0||typeof p.sheet_name!=='string'||!p.sheet_name||p.sheet_name!==p.sheet_name.trim()||
   typeof p.source_digest!=='string'||!digest.test(p.source_digest)||typeof p.operation_token!=='string'||!p.operation_token||
   p.preimage_sheet_id!==p.sheet_id||p.preimage_sheet_name!==p.sheet_name||p.preimage_source_version!==p.source_version||p.preimage_source_digest!==p.source_digest||
   !Number.isSafeInteger(p.preimage_width)||Number(p.preimage_width)<1||Number(p.preimage_width)>100||typeof p.preimage_digest!=='string'||!digest.test(p.preimage_digest))return null;
  seen.add(key);
 }
 const details=rows.filter(p=>p.projection==='DETAIL').length;
 if(details>prior.detailCount||prior.state==='PUBLISHED'&&(rows.length!==prior.detailCount+2||details!==prior.detailCount||!seen.has(JSON.stringify([job.entityKey,'DAILY']))||!seen.has(JSON.stringify([job.entityKey,'EXPENSE_RAW']))))return null;
 if(rows.some(p=>p.source_digest!==prior.sourceDigest))return null;
 const bytes=new TextEncoder().encode(JSON.stringify({protocol:'CANCEL_FINANCIAL_V1',prior,expense,projections:rows}));if(bytes.byteLength>256000)return null;
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
}
