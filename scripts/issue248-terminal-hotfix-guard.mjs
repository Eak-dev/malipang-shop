// Issue 248: read-only point-in-time checks. No queue/cron freeze is created.
// A single known expired terminal job can be excepted only with explicit
// owner acceptance; its old worker/provider outcome remains UNKNOWN.
import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';
const KNOWN_HASH='45d45ed474123f515ee629f409296fe9cc044dee3de4643c35e07687aac7ee5a';
const ACCEPT='OWNER ACCEPTS EXPIRED TERMINAL WRITER RACE';
const fail=x=>{throw Error('NO_GO_TERMINAL_HOTFIX_'+x)};
const integer=x=>Number.isSafeInteger(x)&&x>=0;
export function verifyKnownExpiredRow(x,expectedHash){
 if(x?.entity_type!=='EXPENSE'||typeof x.entity_key!=='string'||x.entity_key.length<1||x.entity_key.length>132||x.entity_version!==1||x.terminal!==1||x.source_current!==1||x.daily_verified!==1||x.raw_verified!==1||x.journal_total!==2||x.distinct_digests!==1||x.documents!==0||x.links!==0||x.items!==0||createHash('sha256').update(`${x.entity_type}:${x.entity_key}:${x.entity_version}`,'utf8').digest('hex')!==expectedHash)fail('EXPIRED_IDENTITY_OR_STATE');
 return true;
}
export function verifyTerminalHotfixPre(snapshot,writers,exception){
 if(!snapshot||!snapshot.d1||!snapshot.status||!Array.isArray(writers)||writers.length!==1||writers[0]?.success!==true||writers[0]?.meta?.changed_db!==false||writers[0]?.meta?.rows_written!==0||!Array.isArray(writers[0]?.results)||writers[0].results.length!==1)fail('EVIDENCE');
 const d=snapshot.d1,w=writers[0].results[0];for(const k of ['review','review_all','held','inflight','review_jobs','open_failed'])if(!integer(d[k]))fail('D1_FORMAT');for(const k of ['claims','inflight','active_or_unbounded_leases','staff_processing','expired_processing'])if(!integer(w?.[k]))fail('WRITER_FORMAT');
 if(d.review||d.review_all||d.held||d.inflight||d.review_jobs||w.claims||w.inflight||w.active_or_unbounded_leases||w.staff_processing||!Object.hasOwn(snapshot.status,'claim')||snapshot.status.claim!==null||snapshot.status.inFlightProjections!==0)fail('BUSY_OR_REVIEW');
 if(snapshot.status.recoveryGate?.mode!=='DISABLED'||snapshot.status.sheetPacing?.mode!=='OPT_IN')fail('FLAGS');
 if(typeof w.expired_json!=='string'||w.expired_json.length>4096)fail('EXPIRED_FORMAT');let rows;try{rows=JSON.parse(w.expired_json)}catch{fail('EXPIRED_FORMAT')}if(!Array.isArray(rows)||rows.length!==w.expired_processing)fail('EXPIRED_FORMAT');
 if(rows.length){if(rows.length!==1||exception!==ACCEPT)fail('EXPIRED_NOT_ACCEPTED');verifyKnownExpiredRow(rows[0],KNOWN_HASH);}
 return {ok:true,openFailed:d.open_failed,expiredRiskAccepted:rows.length===1};
}
export function verifyNoNewFailures(rows){
 if(!Array.isArray(rows)||rows.length!==1||rows[0]?.success!==true||rows[0]?.meta?.changed_db!==false||rows[0]?.meta?.rows_written!==0||!Array.isArray(rows[0]?.results)||rows[0].results.length!==1||!integer(rows[0].results[0]?.n))fail('NEW_FAILURE_EVIDENCE');
 if(rows[0].results[0].n!==0)fail('NEW_OR_UPDATED_FAILURE');return true;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{
 if(process.argv[2]==='--failures'){verifyNoNewFailures(JSON.parse(readFileSync(process.argv[3],'utf8')));console.log('TERMINAL_HOTFIX_NO_NEW_FAILURES');}
 else{const [snapshot,writers]=process.argv.slice(2).map(p=>JSON.parse(readFileSync(p,'utf8'))),r=verifyTerminalHotfixPre(snapshot,writers,process.env.EXPIRED_TERMINAL_EXCEPTION);console.log(r.expiredRiskAccepted?'TERMINAL_HOTFIX_PRE_KNOWN_EXPIRED_RISK_ACCEPTED_OUTCOME_UNKNOWN_NOT_FREEZE':'TERMINAL_HOTFIX_PRE_POINT_IN_TIME_PASS_NOT_FREEZE')}
}catch(e){console.error(typeof e?.message==='string'&&/^NO_GO_[A-Z0-9_]+$/.test(e.message)?e.message:'NO_GO_TERMINAL_HOTFIX_UNKNOWN');process.exitCode=1}}
