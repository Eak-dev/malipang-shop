// Issue 248: read-only point-in-time release checks for PR #271. No queue/cron
// freeze is created. One known attendance job must stay in REVIEW (left there on
// purpose after the workbook claim release). Its presence is proven positively,
// pre and post; with explicit owner acceptance it is the only REVIEW job excepted.
// Any other REVIEW job, or the known job missing, changed or no longer REVIEW,
// blocks. The G7 canary-digest exception of the stage guard is enabled only here
// (historical integrity since G7 UNKNOWN).
// No job value leaves D1: entity keys (payroll keys hold employee ID and work
// date), trace IDs, lease tokens and errors are hashed and compared INSIDE the
// read-only statements below against the pins; the runner receives counts only.
import {readFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
import {verifyStage} from './pr247-stage-guard.mjs';
import {sha256Ctes,SHA_K_CTE} from './issue248-provider-sha256.mjs';
export const ATTENDANCE_ACCEPT='OWNER ACCEPTS KNOWN ATTENDANCE REVIEW';
const KNOWN={key:'aa9d98ea19a224febc2cedbb3bbf38be3e3f94740804148e2e11d7e707c5baeb',jobId:'812667d15638719c325b3853084fe1b733598cb33f5af1d11e1d0cb9d4f68845',trace:'446b335e9c54ba79a5a0f6bb8602250be396d93b6d124f791316333d65e36e2c',lease:'5848e7b9027a8d6a1ccb20eee56a04665f394c5ec518282f93ef20798553d29b',leaseUntil:'2026-11-10T21:58:50.188Z',updatedAt:'2026-11-10T23:04:40.739Z'};
// Same known stale terminal item and acceptance as scripts/issue248-terminal-hotfix-guard.mjs.
const EXPIRED_KNOWN_HASH='45d45ed474123f515ee629f409296fe9cc044dee3de4643c35e07687aac7ee5a';
const EXPIRED_ACCEPT='OWNER ACCEPTS EXPIRED TERMINAL WRITER RACE';
export const REVIEW_COLUMNS=['review_total','candidates','known_job_rows','known_exact'];
export const WRITER_COLUMNS=['claims','inflight','active_or_unbounded_leases','staff_processing','expired_processing','expired_known','expired_known_state'];
const fail=x=>{throw Error('NO_GO_NONFINANCIAL_RELEASE_'+x)};
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const HEX=/^[0-9a-f]{64}$/,TS=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// Pins are inlined into SQL, so only exact hex digests and timestamps are accepted.
function checkPins(known){if(![known?.key,known?.jobId,known?.trace,known?.lease].every(x=>HEX.test(x))||![known.leaseUntil,known.updatedAt].every(x=>TS.test(x)))fail('PINS');}
const expiredPredicate="j.status='PROCESSING' AND j.lease_until IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',j.lease_until) IS NOT NULL AND j.lease_token IS NOT NULL AND length(trim(j.lease_token))>0 AND strftime('%Y-%m-%dT%H:%M:%fZ',j.lease_until)<=strftime('%Y-%m-%dT%H:%M:%fZ','now')";

// Attendance candidates are selected as before (status, error or pinned timestamps,
// at most 20; a 21st row means overflow). Their key, job ID, trace and lease are
// hashed in D1; known_exact applies every field of the old exact comparison.
export function reviewSql(known=KNOWN){
 checkPins(known);
 return `WITH RECURSIVE cand AS (SELECT j.rowid AS cid,j.entity_type,j.status,j.entity_version,j.attempt_count,j.last_error,j.lease_until,j.updated_at,j.entity_key,j.job_id,j.trace_id,j.lease_token,
CASE WHEN julianday(j.lease_until) IS NOT NULL AND julianday(j.lease_until)<=julianday('now') THEN 1 ELSE 0 END AS lease_expired,
(SELECT count(*) FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.status='OPEN' AND (f.trace_id=j.trace_id OR f.job_key=j.entity_type||':'||j.entity_key||':'||j.entity_version)) AS open_failed
FROM sync_jobs j WHERE j.entity_type='ATTENDANCE_EVENT' AND (j.status='REVIEW' OR j.last_error='MP248_ATTENDANCE_OUTCOME_UNKNOWN' OR j.lease_until='${known.leaseUntil}' OR j.updated_at='${known.updatedAt}') ORDER BY j.job_id LIMIT 21),
${SHA_K_CTE},
${sha256Ctes('ident',"SELECT cid*4,hex(CAST(entity_key AS TEXT)) FROM cand UNION ALL SELECT cid*4+1,hex(CAST(job_id AS TEXT)) FROM cand UNION ALL SELECT cid*4+2,hex(CAST(trace_id AS TEXT)) FROM cand UNION ALL SELECT cid*4+3,hex(CAST(lease_token AS TEXT)) FROM cand")},
ids AS (SELECT mid/4 AS cid,max(CASE WHEN mid%4=0 THEN d END) AS key_d,max(CASE WHEN mid%4=1 THEN d END) AS job_d,max(CASE WHEN mid%4=2 THEN d END) AS trace_d,max(CASE WHEN mid%4=3 THEN d END) AS lease_d FROM ident_digest GROUP BY mid/4)
SELECT (SELECT count(*) FROM sync_jobs WHERE status='REVIEW') AS review_total,count(c.cid) AS candidates,
coalesce(sum(i.job_d='${known.jobId}'),0) AS known_job_rows,
coalesce(sum(i.job_d='${known.jobId}' AND i.key_d='${known.key}' AND i.trace_d='${known.trace}' AND i.lease_d='${known.lease}' AND c.entity_type='ATTENDANCE_EVENT' AND c.status='REVIEW' AND typeof(c.entity_version)='integer' AND c.entity_version=1 AND typeof(c.attempt_count)='integer' AND c.attempt_count=1 AND c.last_error='MP248_ATTENDANCE_OUTCOME_UNKNOWN' AND c.lease_expired=1 AND c.open_failed=0 AND c.lease_until='${known.leaseUntil}' AND c.updated_at='${known.updatedAt}'),0) AS known_exact
FROM cand c LEFT JOIN ids i ON i.cid=c.cid`.replace(/\n/g,' ');
}
// Same writer counts as the terminal hotfix; the expired job's identity hash
// (type:key:version) and state are compared in D1 instead of returning its key.
export function writersSql(expectedHash=EXPIRED_KNOWN_HASH){
 if(!HEX.test(expectedHash))fail('PINS');
 const journal="p.entity_type=j.entity_type AND (p.entity_id=j.entity_key OR substr(p.entity_id,1,length(j.entity_key)+1)=j.entity_key||'|')";
 const projection=(sheetId,sheet,proj)=>`(SELECT count(*) FROM stable_projection_writes p WHERE p.entity_type=j.entity_type AND p.entity_id=j.entity_key AND p.source_version=j.entity_version AND p.spreadsheet_id='1d8Cv76JicUo7jO4KykQ35Xg60GAjMOyJCeYT92xkKL8' AND p.sheet_id=${sheetId} AND p.sheet_name='${sheet}' AND p.projection='${proj}' AND p.state='VERIFIED')`;
 return `WITH RECURSIVE expired AS (SELECT j.rowid AS cid,j.entity_type,j.entity_key,j.entity_version,
EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key=j.entity_type||':'||j.entity_key||':'||j.entity_version AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES') AS terminal,
EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=j.entity_key AND e.version=j.entity_version AND e.status='CONFIRMED') AS source_current,
${projection(1815870717,'รายวัน','DAILY')} AS daily_verified,${projection(247227172,'V52_EXPENSE_RAW','EXPENSE_RAW')} AS raw_verified,
(SELECT count(*) FROM stable_projection_writes p WHERE ${journal}) AS journal_total,(SELECT count(DISTINCT p.source_digest) FROM stable_projection_writes p WHERE ${journal}) AS distinct_digests,
(SELECT count(*) FROM expense_documents d WHERE d.expense_id=j.entity_key OR d.document_id IN (SELECT l.document_id FROM expense_document_links l WHERE l.expense_id=j.entity_key)) AS documents,
(SELECT count(*) FROM expense_document_links l WHERE l.expense_id=j.entity_key) AS links,(SELECT count(*) FROM expense_document_items i WHERE i.expense_id=j.entity_key) AS items
FROM sync_jobs j WHERE ${expiredPredicate} ORDER BY j.job_id LIMIT 3),
${SHA_K_CTE},
${sha256Ctes('expid',"SELECT cid,hex(CAST(entity_type||':'||entity_key||':'||entity_version AS TEXT)) FROM expired")}
SELECT (SELECT count(*) FROM stable_workbook_claims) AS claims,(SELECT count(*) FROM stable_projection_writes WHERE state='IN_FLIGHT') AS inflight,
(SELECT count(*) FROM sync_jobs WHERE status='PROCESSING' AND (lease_until IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',lease_until) IS NULL OR lease_token IS NULL OR length(trim(lease_token))=0 OR strftime('%Y-%m-%dT%H:%M:%fZ',lease_until)>strftime('%Y-%m-%dT%H:%M:%fZ','now'))) AS active_or_unbounded_leases,
(SELECT count(*) FROM staff_config_sync_outbox WHERE status='PROCESSING') AS staff_processing,(SELECT count(*) FROM sync_jobs j WHERE ${expiredPredicate}) AS expired_processing,
(SELECT count(*) FROM expired e JOIN expid_digest x ON x.mid=e.cid WHERE x.d='${expectedHash}') AS expired_known,
(SELECT count(*) FROM expired e JOIN expid_digest x ON x.mid=e.cid WHERE x.d='${expectedHash}' AND e.entity_type='EXPENSE' AND typeof(e.entity_key)='text' AND length(e.entity_key) BETWEEN 1 AND 132 AND typeof(e.entity_version)='integer' AND e.entity_version=1 AND e.terminal=1 AND e.source_current=1 AND e.daily_verified=1 AND e.raw_verified=1 AND e.journal_total=2 AND e.distinct_digests=1 AND e.documents=0 AND e.links=0 AND e.items=0) AS expired_known_state`.replace(/\n/g,' ');
}
// Exactly one read-only envelope with one row of exactly these integer columns.
function counts(rows,columns,evidence,format){
 if(!Array.isArray(rows)||rows.length!==1||rows[0]?.success!==true||rows[0]?.meta?.changed_db!==false||rows[0]?.meta?.rows_written!==0||!Array.isArray(rows[0]?.results)||rows[0].results.length!==1)fail(evidence);
 const r=rows[0].results[0];if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).join()!==columns.join())fail(evidence);
 if(!columns.every(k=>integer(r[k])))fail(format);return r;
}
// Throws unless the known job is present, unchanged and REVIEW, and it is the only REVIEW job.
export function verifyKnownAttendanceReview(rows,exception){
 const r=counts(rows,REVIEW_COLUMNS,'REVIEW_EVIDENCE','REVIEW_FORMAT');
 if(r.candidates>20||r.known_job_rows>r.candidates||r.known_exact>r.known_job_rows)fail('REVIEW_FORMAT');
 if(exception!==ATTENDANCE_ACCEPT)fail('REVIEW_NOT_ACCEPTED');
 if(r.known_job_rows!==1)fail('KNOWN_JOB_MISSING');
 if(r.known_exact!==1)fail('KNOWN_JOB_DRIFT');
 if(r.review_total!==1)fail('OTHER_REVIEW');
 return 1;
}
// Remove exactly the verified known job from review_jobs; all other guards unchanged.
export function maskKnownReview(snapshot,accepted){
 if(accepted!==1||snapshot?.d1?.review_jobs!==1)fail('REVIEW_COUNT_DRIFT');
 const copy=structuredClone(snapshot);copy.d1.review_jobs=0;return copy;
}
// Same busy, flag and expired-writer rules as verifyTerminalHotfixPre in
// scripts/issue248-terminal-hotfix-guard.mjs, on provider-side counts.
export function verifyWriters(snapshot,writers,exception){
 if(!snapshot||!snapshot.d1||!snapshot.status)fail('EVIDENCE');
 const w=counts(writers,WRITER_COLUMNS,'EVIDENCE','WRITER_FORMAT'),d=snapshot.d1;
 for(const k of ['review','review_all','held','inflight','review_jobs','open_failed'])if(!integer(d[k]))fail('D1_FORMAT');
 if(d.review||d.review_all||d.held||d.inflight||d.review_jobs||w.claims||w.inflight||w.active_or_unbounded_leases||w.staff_processing||!Object.hasOwn(snapshot.status,'claim')||snapshot.status.claim!==null||snapshot.status.inFlightProjections!==0)fail('BUSY_OR_REVIEW');
 if(snapshot.status.recoveryGate?.mode!=='DISABLED'||snapshot.status.sheetPacing?.mode!=='OPT_IN')fail('FLAGS');
 if(w.expired_known>Math.min(w.expired_processing,3)||w.expired_known_state>w.expired_known)fail('WRITER_FORMAT');
 if(w.expired_processing){if(w.expired_processing!==1||exception!==EXPIRED_ACCEPT)fail('EXPIRED_NOT_ACCEPTED');if(w.expired_known!==1||w.expired_known_state!==1)fail('EXPIRED_IDENTITY_OR_STATE');}
 return {ok:true,openFailed:d.open_failed,expiredRiskAccepted:w.expired_processing===1};
}
export function verifyReleasePre({snapshot,writers,review,attendanceException,expiredException,stage=verifyStage}){
 const masked=maskKnownReview(snapshot,verifyKnownAttendanceReview(review,attendanceException));
 stage('B_POST',masked,{canaryDigestException:true});return verifyWriters(masked,writers,expiredException);
}
export function verifyReleasePost({snapshot,review,attendanceException,stage=verifyStage}){
 const masked=maskKnownReview(snapshot,verifyKnownAttendanceReview(review,attendanceException));
 stage('B_POST',masked,{canaryDigestException:true});return {ok:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{
 const read=p=>JSON.parse(readFileSync(p,'utf8')),[mode,...files]=process.argv.slice(2),attendanceException=process.env.ATTENDANCE_REVIEW_EXCEPTION;
 if(mode==='sql-review')console.log(reviewSql());
 else if(mode==='sql-writers')console.log(writersSql());
 else if(mode==='pre'){const r=verifyReleasePre({snapshot:read(files[0]),writers:read(files[1]),review:read(files[2]),attendanceException,expiredException:process.env.EXPIRED_TERMINAL_EXCEPTION});console.log(r.expiredRiskAccepted?'NONFINANCIAL_RELEASE_PRE_KNOWN_EXPIRED_RISK_ACCEPTED_NOT_FREEZE':'NONFINANCIAL_RELEASE_PRE_POINT_IN_TIME_PASS_NOT_FREEZE')}
 else if(mode==='post'){verifyReleasePost({snapshot:read(files[0]),review:read(files[1]),attendanceException});console.log('NONFINANCIAL_RELEASE_POST_PASS')}
 else fail('MODE');
}catch(e){console.error(typeof e?.message==='string'&&/^NO_GO_[A-Z0-9_]+$/.test(e.message)?e.message:'NO_GO_NONFINANCIAL_RELEASE_UNKNOWN');process.exitCode=1}}
