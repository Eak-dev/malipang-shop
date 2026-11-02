import {inspectSignedExistingRow,type InspectorEnv} from './daily-row-attestation-inspector';
import {encodeEnrollmentApproval,type EnrollmentApproval} from './daily-row-enrollment';

async function evidenceDigests(env:InspectorEnv,a:EnrollmentApproval,signature:Uint8Array):Promise<{approval:string;signature:string;key:string}>{
  const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
  const rawKey=Uint8Array.from(atob(env.DAILY_ROW_REVIEWER_ED25519_PUBLIC_KEY_BASE64),x=>x.charCodeAt(0));
  if(rawKey.length!==32||signature.length!==64)throw new Error('INVALID_EVIDENCE');
  const [approvalHash,signatureHash,keyHash]=await Promise.all([crypto.subtle.digest('SHA-256',encodeEnrollmentApproval(a)),crypto.subtle.digest('SHA-256',signature),crypto.subtle.digest('SHA-256',rawKey)]);
  return {approval:hex(approvalHash),signature:hex(signatureHash),key:hex(keyHash)};
}

/** A staged observation is non-authoritative and cannot release a REVIEW job,
 * update an index, create metadata, or write Sheets. Old writers and owner
 * edits remain outside this D1 fence. Do not use a candidate as a write permit. */
export async function stageDailyIdentityCandidate(env:InspectorEnv,a:EnrollmentApproval,signature:Uint8Array):Promise<'CANDIDATE_ONLY'|'HELD'>{try{
  if(!a||!Array.isArray(a.entries)||a.entries.length!==1||typeof a.leaseId!=='string'||!a.leaseId||!env.SHEET_EXPENSE_DAILY)return 'HELD';
  const entry=a.entries[0];if(!entry||typeof entry.expenseId!=='string'||!entry.expenseId)return 'HELD';
  // A live, owned fence is necessary, never sufficient. Avoid remote reads
  // when it is absent; check again atomically at staging below.
  const preflight=await env.DB.prepare(`SELECT 1 AS ok FROM owner_correction_daily_write_fences WHERE sheet_name=? AND lease_token=? AND state='OWNED' AND lease_until>? AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(env.SHEET_EXPENSE_DAILY,a.leaseId,new Date().toISOString()).first<{ok:number}>();
  if(Number(preflight?.ok)!==1)return 'HELD';
  if(await inspectSignedExistingRow(env,a,signature)!=='CONSISTENT_READ_ONLY')return 'HELD';
  const now=Date.now();if(!Number.isSafeInteger(now)||!Number.isSafeInteger(a.expiresAtMs)||a.expiresAtMs<=now)return 'HELD';
  const digest=await evidenceDigests(env,a,signature);
  const sheet=env.SHEET_EXPENSE_DAILY,book=env.GOOGLE_SPREADSHEET_ID,nowIso=new Date(now).toISOString();
  // Expiration changes only provisional evidence, never Sheets or an index.
  // Approval IDs are retained forever, so an expired signed approval cannot
  // be replayed. Partial unique indexes serialize colliding live candidates.
  const expire=env.DB.prepare(`UPDATE daily_identity_candidates SET state='EXPIRED' WHERE state='CANDIDATE_ONLY' AND expires_at_ms<=? AND (expense_id=? OR (spreadsheet_id=? AND sheet_id=? AND row_number=?) OR (spreadsheet_id=? AND metadata_id=?))`).bind(now,entry.expenseId,book,a.sheetId,entry.rowNumber,book,entry.metadataId);
  const insert=env.DB.prepare(`INSERT OR IGNORE INTO daily_identity_candidates(approval_id,spreadsheet_id,sheet_name,sheet_id,row_number,metadata_id,expense_id,expense_version,reviewer_id,approval_digest,signature_digest,reviewer_key_digest,observed_at_ms,expires_at_ms,state)
    SELECT ?,?,?,?,?,?,e.expense_id,e.version,?,?,?,?,?,?,'CANDIDATE_ONLY' FROM expense_events e
    WHERE e.expense_id=? AND e.version=? AND e.transaction_date=? AND e.amount_satang=? AND e.payment_key=? AND e.status=? AND e.source_wallet=? AND e.category=? AND e.description=? AND e.message_id=?
      AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version AND j.status='REVIEW')
      AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_key=e.expense_id AND ((j.entity_type='EXPENSE' AND j.status IN ('PENDING','PROCESSING','FAILED')) OR (j.entity_type='EXPENSE_CORRECTION' AND j.status IN ('PENDING','PROCESSING','FAILED','REVIEW'))))
      AND EXISTS(SELECT 1 FROM owner_correction_daily_write_fences f WHERE f.sheet_name=? AND f.lease_token=? AND f.state='OWNED' AND f.lease_until>? AND f.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      AND NOT EXISTS(SELECT 1 FROM sheet_row_index r WHERE r.sheet_name=? AND ((r.row_number=? AND r.entity_key<>e.expense_id) OR (r.entity_key=e.expense_id AND r.row_number<>?)))
      AND ?>? AND ?>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)`).bind(a.approvalId,book,sheet,a.sheetId,entry.rowNumber,entry.metadataId,a.reviewerId,digest.approval,digest.signature,digest.key,now,a.expiresAtMs,entry.expenseId,entry.expenseVersion,entry.postingDate,entry.amountSatang,entry.paymentKey,entry.expenseStatus,entry.sourceWallet,entry.category,entry.description,entry.messageId,sheet,a.leaseId,nowIso,sheet,entry.rowNumber,entry.rowNumber,a.expiresAtMs,now,a.expiresAtMs);
  const results=await env.DB.batch([expire,insert]);return Number(results[1]?.meta.changes||0)===1?'CANDIDATE_ONLY':'HELD';
}catch{return 'HELD';}}

/** Resolve an uncertain staging response by observing only this exact signed
 * input. A negative read is not proof that an in-flight transaction failed. */
export async function dailyIdentityCandidateStatus(env:InspectorEnv,a:EnrollmentApproval,signature:Uint8Array):Promise<'CANDIDATE_ONLY'|'EXPIRED'|'NOT_OBSERVED'|'UNAVAILABLE'>{try{
  if(!a||typeof a.approvalId!=='string'||!a.approvalId||a.approvalId.length>256||a.reviewerId!==env.DAILY_ROW_REVIEWER_ID||a.spreadsheetId!==env.GOOGLE_SPREADSHEET_ID||String(a.sheetId)!==env.DAILY_ROW_SHEET_ID||!env.SHEET_EXPENSE_DAILY)return 'NOT_OBSERVED';
  const digest=await evidenceDigests(env,a,signature);
  const row=await env.DB.prepare(`SELECT state,expires_at_ms FROM daily_identity_candidates WHERE approval_id=? AND spreadsheet_id=? AND sheet_name=? AND sheet_id=? AND reviewer_id=? AND approval_digest=? AND signature_digest=? AND reviewer_key_digest=?`).bind(a.approvalId,env.GOOGLE_SPREADSHEET_ID,env.SHEET_EXPENSE_DAILY,a.sheetId,env.DAILY_ROW_REVIEWER_ID,digest.approval,digest.signature,digest.key).first<{state:string;expires_at_ms:number}>();
  if(!row)return 'NOT_OBSERVED';if(row.state==='EXPIRED'||Number(row.expires_at_ms)<=Date.now())return 'EXPIRED';return row.state==='CANDIDATE_ONLY'?'CANDIDATE_ONLY':'NOT_OBSERVED';
}catch{return 'UNAVAILABLE';}}
