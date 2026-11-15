import type {Env,SheetsSyncJob} from '../types';

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
 const triggers=['continuous_financial_journal_revision_no_delete','continuous_financial_journal_revision_no_replace','continuous_financial_journal_revision_monotonic','continuous_financial_projection_insert_revision','continuous_financial_projection_update_revision','continuous_financial_projection_delete_revision','continuous_financial_preimage_insert_revision','continuous_financial_preimage_update_revision','continuous_financial_preimage_delete_revision','continuous_revoke_journal_revision_insert','continuous_revoke_journal_revision_immutable','continuous_revoke_projection_insert_fence','continuous_revoke_projection_update_fence','continuous_revoke_preimage_insert_fence'];
 return env.DB.prepare(`SELECT revision FROM continuous_financial_journal_revision WHERE singleton=1 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN (${triggers.map(x=>`'${x}'`).join(',')}))=${triggers.length}`);
}

export async function cancelledFinancialFingerprint(job:SheetsSyncJob,expense:Record<string,unknown>,rows:Record<string,unknown>[],prior:{state:'PUBLISHED'|'STAGED';detailCount:number}):Promise<string|null>{
 if(!/^exp_[A-Za-z0-9_-]{1,128}$/.test(job.entityKey)||job.entityVersion<2||!Number.isSafeInteger(job.entityVersion)||expense.expense_id!==job.entityKey||expense.version!==job.entityVersion||expense.status!=='CANCELLED'||rows.length>502||!['STAGED','PUBLISHED'].includes(prior.state)||!Number.isSafeInteger(prior.detailCount)||prior.detailCount<0||prior.detailCount>500)return null;
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
 if(rows.some(p=>p.source_digest!==rows[0]?.source_digest))return null;
 const bytes=new TextEncoder().encode(JSON.stringify({protocol:'CANCEL_FINANCIAL_V1',prior,expense,projections:rows}));if(bytes.byteLength>256000)return null;
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
}
