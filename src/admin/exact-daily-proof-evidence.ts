import type {Env} from '../types';
import {stableSourceIntegrity} from '../sheets/stable-source-cutover';
import {continuousAdmissionIntegrity,continuousDailyCutoverIntegrity,continuousReportCutoverIntegrity} from '../sheets/continuous-daily-cutover';

/** Read-only incident selection. The fingerprint must be supplied out of band
 * and must match the full immutable operation identity. A selected row never
 * authorizes a D1 transition or a provider request. */
export type DailyIncidentEvidence={spreadsheet_id:string;claim_token:string;job_id:string;entity_id:string;source_version:number;source_revision:number;source_digest:string;sheet_id:number;sheet_name:string;marker:string;target_row:number;before_rows:number;before_columns:number;before_digest:string;payload_digest:string;notice_stamp:string;notice_identity:string;trace_id:string;projection_state:string};
const retained="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND ((tbl_name='continuous_daily_write_evidence' AND name IN ('continuous_daily_evidence_source','continuous_daily_evidence_no_update','continuous_daily_evidence_no_delete','continuous_daily_evidence_no_replace')) OR (tbl_name='stable_expense_projection_preimages' AND name IN ('stable_expense_preimage_verified_source','stable_expense_preimage_no_update','stable_expense_preimage_no_delete','stable_expense_preimage_no_replace')) OR (tbl_name='atomic_daily_marker_reservations' AND name IN ('atomic_daily_marker_no_delete','atomic_daily_marker_no_update','atomic_daily_marker_no_replace'))))=11";
const evidenceSelect=`SELECT c.spreadsheet_id,c.operation_token claim_token,j.job_id,j.entity_key entity_id,j.entity_version source_version,r.revision source_revision,w.source_digest,w.sheet_id,w.sheet_name,e.marker,e.target_row,e.before_rows,e.before_columns,e.before_digest,e.payload_digest,c.notice_stamp,c.notice_identity,j.trace_id,w.state projection_state`;
const baseEvidenceSql=`${evidenceSelect}
 FROM stable_workbook_claims c JOIN stable_projection_writes w ON w.spreadsheet_id=c.spreadsheet_id AND w.operation_token=c.operation_token AND w.entity_type='EXPENSE' AND w.projection='DAILY' AND w.state IN ('IN_FLIGHT','VERIFIED')
 JOIN continuous_daily_write_evidence e ON e.spreadsheet_id=w.spreadsheet_id AND e.entity_id=w.entity_id AND e.sheet_id=w.sheet_id AND e.sheet_name=w.sheet_name AND e.source_version=w.source_version AND e.source_digest=w.source_digest AND e.operation_token=w.operation_token
 JOIN atomic_daily_marker_reservations m ON m.spreadsheet_id=e.spreadsheet_id AND m.sheet_id=e.sheet_id AND m.entity_id=e.entity_id AND m.source_version=e.source_version AND m.operation_token=e.operation_token AND m.marker=e.marker
 JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=w.entity_id AND j.entity_version=w.source_version AND j.status='REVIEW' AND j.last_error='STABLE_SYNC_REVIEW' AND j.attempt_count=1 AND j.lease_token IS NULL AND j.lease_until IS NULL
 JOIN expense_events src ON src.expense_id=j.entity_key AND src.version=j.entity_version AND src.status='CONFIRMED' JOIN stable_source_revision r ON r.singleton=1
 JOIN continuous_daily_cutovers cut ON cut.spreadsheet_id=c.spreadsheet_id AND cut.state='ACTIVE' AND cut.continuous_sheet_id=e.sheet_id AND cut.continuous_sheet_name=e.sheet_name
 JOIN continuous_daily_post_cutover_expenses post ON post.spreadsheet_id=c.spreadsheet_id AND post.expense_id=j.entity_key
 WHERE c.spreadsheet_id=? AND c.state='REVIEW' AND c.phase='OPERATION' AND c.review_reason='INSERT_DAILY_SNAPSHOT_UNVERIFIED' AND c.notice_stamp IS NOT NULL AND c.notice_identity IS NOT NULL
 AND ${retained} AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousReportCutoverIntegrity} AND ${continuousAdmissionIntegrity}
 AND NOT EXISTS(SELECT 1 FROM monthly_report_intents WHERE state IN ('IN_FLIGHT','RECEIPT_IN_FLIGHT','REVIEW'))
 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='stable_projection_writes' AND name IN ('stable_projection_transition','stable_projection_no_delete','stable_projection_no_replace'))=3
 AND (SELECT count(*) FROM stable_workbook_claims)=1 AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs WHERE state IN ('ARMED','REVIEW'))
 AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations op JOIN stable_recovery_epochs ep ON ep.epoch_id=op.epoch_id WHERE ep.spreadsheet_id=c.spreadsheet_id AND op.state='ADMITTED')
 AND NOT EXISTS(SELECT 1 FROM sync_jobs WHERE status='PROCESSING') AND NOT EXISTS(SELECT 1 FROM staff_config_sync_outbox WHERE status='PROCESSING')
 AND NOT EXISTS(SELECT 1 FROM sync_jobs newer WHERE newer.entity_type='EXPENSE' AND newer.entity_key=j.entity_key AND newer.entity_version<>j.entity_version)
 AND NOT EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.entity_key=j.entity_key OR substr(i.entity_key,1,length(j.entity_key)+1)=j.entity_key||'|')
 AND NOT EXISTS(SELECT 1 FROM continuous_review_notice_close n WHERE n.operation_token=c.operation_token)
 AND NOT EXISTS(SELECT 1 FROM continuous_notice_status_attempts n WHERE n.operation_token=c.operation_token)
 AND NOT EXISTS(SELECT 1 FROM continuous_final_notice_cleanup n WHERE n.operation_token=c.operation_token)
 AND NOT EXISTS(SELECT 1 FROM continuous_normal_notice_handoffs n WHERE n.operation_token=c.operation_token)
 AND NOT EXISTS(SELECT 1 FROM continuous_notice_dispatches n WHERE n.operation_token=c.operation_token)
 AND NOT EXISTS(SELECT 1 FROM continuous_cutover_notice_release n WHERE n.operation_token=c.operation_token)
 AND NOT EXISTS(SELECT 1 FROM continuous_views_incident_recovery n WHERE n.operation_token=c.operation_token)
 AND NOT EXISTS(SELECT 1 FROM canary_unwritten_recovery n WHERE n.operation_token=c.operation_token)
 AND NOT EXISTS(SELECT 1 FROM canary_completed_recovery n WHERE n.operation_token=c.operation_token)
 AND NOT EXISTS(SELECT 1 FROM scoped_hold_incident_recovery n WHERE n.operation_token=c.operation_token)
 AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.state<>'VERIFIED' AND NOT(p.spreadsheet_id=w.spreadsheet_id AND p.entity_type=w.entity_type AND p.entity_id=w.entity_id AND p.projection=w.projection))
 AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=w.spreadsheet_id AND p.entity_type='EXPENSE' AND (p.entity_id=w.entity_id OR substr(p.entity_id,1,length(w.entity_id)+1)=w.entity_id||'|') AND NOT(p.entity_id=w.entity_id AND p.projection='DAILY'))
 AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes x WHERE x.state<>'VERIFIED' OR (x.spreadsheet_id=w.spreadsheet_id AND x.entity_type='EXPENSE' AND (x.entity_id=w.entity_id OR substr(x.entity_id,1,length(w.entity_id)+1)=w.entity_id||'|')))
`;
export function balancedSqlAnd(parts:readonly string[]):string{
 if(parts.length===0)throw Error('INCIDENT_SQL_EMPTY');
 if(parts.length===1)return `(${parts[0]})`;
 const middle=Math.floor(parts.length/2);return `(${balancedSqlAnd(parts.slice(0,middle))} AND ${balancedSqlAnd(parts.slice(middle))})`;
}
function balanceEvidenceWhere(sql:string):string{
 const anchor=' WHERE c.spreadsheet_id=?',index=sql.indexOf(anchor);if(index<0)throw Error('INCIDENT_SQL_SHAPE');
 const head=sql.slice(0,index),tail=sql.slice(index+7),parts:string[]=[];let depth=0,quoted=false,start=0;
 for(let i=0;i<tail.length;i++){
  const ch=tail[i]!;if(ch==="'"){if(quoted&&tail[i+1]==="'"){i++;continue;}quoted=!quoted;continue;}
  if(quoted)continue;if(ch==='('){depth++;continue;}if(ch===')'){depth--;if(depth<0)throw Error('INCIDENT_SQL_SHAPE');continue;}
  if(depth===0&&/\s/.test(ch)){if(/^\s+OR\s+/i.test(tail.slice(i)))throw Error('INCIDENT_SQL_SHAPE');const m=/^\s+AND\s+/i.exec(tail.slice(i));if(m){const part=tail.slice(start,i).trim();if(!part)throw Error('INCIDENT_SQL_SHAPE');parts.push(part);i+=m[0].length-1;start=i+1;}}
 }
 const last=tail.slice(start).trim();if(quoted||depth!==0||!last)throw Error('INCIDENT_SQL_SHAPE');parts.push(last);
 return `${head} WHERE ${balancedSqlAnd(parts)}`;
}
export type FailedDailyIncidentEvidence=DailyIncidentEvidence&{failed_id:string;failed_queue:string;failed_trace:string;failed_key:string;failed_payload:string;failed_error:string;failed_attempts:number;failed_created:string;failed_updated:string;failed_resolved:string|null};
const failedFields=",f.id failed_id,f.queue_name failed_queue,f.trace_id failed_trace,f.job_key failed_key,f.payload_json failed_payload,f.error failed_error,f.attempt_count failed_attempts,f.created_at failed_created,f.updated_at failed_updated,f.resolved_at failed_resolved";
export const DAILY_FAILED_INCIDENT_EVIDENCE_SQL=balanceEvidenceWhere(baseEvidenceSql.replace(evidenceSelect,evidenceSelect+failedFields).replace(' JOIN expense_events src'," JOIN failed_jobs f ON f.queue_name='malipang-jobs' AND f.trace_id=j.trace_id AND f.job_key='EXPENSE:'||j.entity_key||':'||j.entity_version AND f.status='OPEN' AND f.error='Error: STABLE_JOB_HOLD_UNCERTAIN' AND f.attempt_count=1 AND f.resolved_at IS NULL JOIN expense_events src")+
 " AND (SELECT count(*) FROM failed_jobs f2 WHERE f2.status='OPEN' AND substr(f2.job_key,1,length('EXPENSE:'||j.entity_key||':'))='EXPENSE:'||j.entity_key||':')=1"+
 " AND EXISTS(SELECT 1 FROM sync_alert_incidents a WHERE a.kind='JOB' AND a.source_id=j.job_id AND a.category='REVIEW' AND a.state='OPEN' AND a.opened_at=j.updated_at)"+
 " AND julianday(j.updated_at)>=julianday(c.updated_at) AND julianday(f.created_at)>=julianday(j.updated_at) AND (julianday(f.created_at)-julianday(j.updated_at))*86400.0<2 AND f.updated_at=f.created_at");

export async function dailyIncidentFingerprint(e:DailyIncidentEvidence):Promise<string>{
 const identity=[e.spreadsheet_id,e.claim_token,e.job_id,e.trace_id,e.entity_id,e.source_version,e.source_revision,e.source_digest,e.sheet_id,e.sheet_name,e.marker,e.target_row,e.before_rows,e.before_columns,e.before_digest,e.payload_digest,e.notice_stamp,e.notice_identity];
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(identity)));
 return Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
}
export async function dailyFailedPayloadDigest(payload:string):Promise<string>{
 const payloadHash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload));
 return Array.from(new Uint8Array(payloadHash),v=>v.toString(16).padStart(2,'0')).join('');
}
export async function failedDailyIncidentFingerprint(e:FailedDailyIncidentEvidence):Promise<string>{
 const payloadDigest=await dailyFailedPayloadDigest(e.failed_payload);
 const values=[await dailyIncidentFingerprint(e),e.failed_id,e.failed_queue,e.failed_trace,e.failed_key,payloadDigest,e.failed_error,e.failed_attempts,e.failed_created,e.failed_updated,e.failed_resolved];
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(values)));
 return Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
}
export async function readFailedDailyIncidentEvidence(env:Env,fingerprint?:string):Promise<FailedDailyIncidentEvidence|null>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;if(!book||(fingerprint!==undefined&&!/^[0-9a-f]{64}$/.test(fingerprint)))return null;
 const rows=await db.prepare(DAILY_FAILED_INCIDENT_EVIDENCE_SQL).bind(book).all<FailedDailyIncidentEvidence>();
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||rows.success!==true||rows.results?.length!==1)return null;
 const e=rows.results[0]!;let payload:unknown;try{payload=JSON.parse(e.failed_payload);}catch{return null;}
 if(!payload||typeof payload!=='object'||Array.isArray(payload))return null;
 const p=payload as Record<string,unknown>;
 if(p.kind!=='SHEETS_SYNC'||p.entityType!=='EXPENSE'||p.entityKey!==e.entity_id||p.entityVersion!==e.source_version||p.traceId!==e.trace_id||!Number.isSafeInteger(e.source_revision)||e.source_revision<0||(fingerprint!==undefined&&await failedDailyIncidentFingerprint(e)!==fingerprint)||env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book)return null;
 return e;
}
