import type {Env} from '../types';
import {fetchWithTimeout} from '../shared/async';
import {readSheetsBody} from './bounded-response';
import {wakeSyncFailureAlerts} from '../line/sync-failure-alerts';

const hex=(b:ArrayBuffer)=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
const utf=(s:string)=>new TextEncoder().encode(s);
const b64=(input:Uint8Array)=>{let s='';for(const n of input)s+=String.fromCharCode(n);return btoa(s).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');};
const decode=(s:string)=>Uint8Array.from(atob(s.replace(/\s/g,'')),c=>c.charCodeAt(0));
const readyFlags=(e:Env)=>e.CONTINUOUS_NOTICE_DISPATCH_ENABLED==='true'&&e.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED==='true'&&e.CONTINUOUS_REVIEW_CLOSE_ENABLED==='true'&&e.CONTINUOUS_DAILY_ENABLED==='true'&&e.SHEETS_SYNC_ENABLED==='true'&&e.STABLE_PHASE1_ENABLED==='true'&&e.STABLE_RECOVERY_GATE_ENABLED==='true'&&e.STABLE_SHEETS_PACING_ENABLED==='true';
/** Both Workers must have exactly the same target and credentials. Only a
 * one-way fingerprint is persisted; neither key nor OAuth token is stored. */
export async function noticeReadinessFingerprint(e:Env):Promise<string|null>{
 const fields=[e.GOOGLE_SPREADSHEET_ID,e.GOOGLE_SERVICE_ACCOUNT_EMAIL,e.GOOGLE_PRIVATE_KEY_BASE64,e.SHEET_EXPENSE_DAILY,e.CONTINUOUS_DAILY_SHEET,e.CONTINUOUS_DAILY_SHEET_ID,e.CONTINUOUS_RAW_SHEET,e.CONTINUOUS_RAW_SHEET_ID,e.CONTINUOUS_DETAIL_SHEET,e.CONTINUOUS_DETAIL_SHEET_ID,e.SHEET_EXPENSE_RAW,e.SHEET_PURCHASE_DETAILS,e.CONTINUOUS_NOTICE_DEPLOYMENT_ID,e.APP_ENV,e.RUNTIME_MODE,e.LINE_CHANNEL_ACCESS_TOKEN,e.LINE_OWNER_USER_ID];
 if(!readyFlags(e)||fields.some(x=>typeof x!=='string'||!x.trim())||!e.NOTICE_QUEUE||e.RUNTIME_MODE==='shadow'&&e.SHADOW_LINE_OUTPUT!=='true')return null;
 return hex(await crypto.subtle.digest('SHA-256',utf(JSON.stringify(['notice-readiness-v1',...fields,e.SHADOW_LINE_OUTPUT??'']))));
}
/** SQL predicate with two bound parameters: spreadsheet ID and fingerprint. */
export const noticeProbeIntegritySql="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_notice_readiness_probes' AND name IN ('continuous_notice_probe_insert','continuous_notice_probe_update','continuous_notice_probe_no_delete','continuous_notice_probe_no_replace'))=4 AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='continuous_notice_readiness_fresh')";
export const noticeProbeSql=`(${noticeProbeIntegritySql}) AND EXISTS(SELECT 1 FROM continuous_notice_readiness_probes p WHERE p.spreadsheet_id=? AND p.verified_fingerprint=? AND p.source='MAIN_CRON' AND p.verified_at IS NOT NULL AND p.verified_created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 minutes') AND p.verified_at>=p.verified_created_at) AND EXISTS(SELECT 1 FROM continuous_notice_readiness_probes p WHERE p.spreadsheet_id=? AND p.verified_fingerprint=? AND p.source='NOTICE_CRON' AND p.verified_at IS NOT NULL AND p.verified_created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 minutes') AND p.verified_at>=p.verified_created_at)`;
// A no-op or file-level canEdit cannot prove the protected target cells.
export const noticeReadinessSql=`(${noticeProbeSql}) AND 0 /* target-cell permission unverified */`;
export async function noticeReadinessReady(e:Env):Promise<boolean>{
 const db=e.DB,book=e.GOOGLE_SPREADSHEET_ID,fp=await noticeReadinessFingerprint(e);if(!book||!fp)return false;
 try{const row=await db.prepare(`SELECT 1 AS ok WHERE ${noticeReadinessSql}`).bind(book,fp,book,fp).first<{ok:number}>();return row?.ok===1&&e.DB===db&&e.GOOGLE_SPREADSHEET_ID===book&&fp===await noticeReadinessFingerprint(e);}catch{return false;}
}
export async function issueNoticeProbe(e:Env,source:'MAIN_CRON'|'NOTICE_CRON'):Promise<void>{
 const db=e.DB,book=e.GOOGLE_SPREADSHEET_ID,q=e.NOTICE_QUEUE,fp=await noticeReadinessFingerprint(e);if(!book||!q||!fp)return;
 const id=crypto.randomUUID();
 let r=await db.prepare("UPDATE continuous_notice_readiness_probes SET generation=generation+1,probe_id=?,config_fingerprint=?,created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND source=? AND generation<9007199254740991").bind(id,fp,book,source).run();
 if(r.success!==true||!Number.isSafeInteger(r.meta?.changes))throw Error('NOTICE_PROBE_CREATE_UNCERTAIN');
 if(r.meta.changes===0)r=await db.prepare("INSERT INTO continuous_notice_readiness_probes(spreadsheet_id,source,generation,probe_id,config_fingerprint,created_at) VALUES(?,?,1,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind(book,source,id,fp).run();
 if(r.success!==true||r.meta?.changes!==1||e.DB!==db||e.NOTICE_QUEUE!==q||fp!==await noticeReadinessFingerprint(e))throw Error('NOTICE_PROBE_CREATE_UNCERTAIN');
 await q.send({probeId:id});
}
/** Fresh JWT exchange deliberately bypasses module-level token caching. */
async function freshToken(e:Env):Promise<string>{
 const pem=new TextDecoder().decode(decode(e.GOOGLE_PRIVATE_KEY_BASE64)),key=decode(pem.replace('-----BEGIN PRIVATE KEY-----','').replace('-----END PRIVATE KEY-----',''));
 const imported=await crypto.subtle.importKey('pkcs8',key,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
 const now=Math.floor(Date.now()/1000),head=b64(utf(JSON.stringify({alg:'RS256',typ:'JWT'}))),body=b64(utf(JSON.stringify({iss:e.GOOGLE_SERVICE_ACCOUNT_EMAIL,scope:'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.metadata.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+300}))),signed=`${head}.${body}`,sig=b64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',imported,utf(signed))));
 const timeout=15000,start=Date.now(),res=await fetchWithTimeout('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${signed}.${sig}`})},timeout,'notice probe OAuth');
 if(!res.ok)throw Error('NOTICE_PROBE_OAUTH_FAILED');const json=JSON.parse(new TextDecoder().decode(await readSheetsBody(res,timeout-(Date.now()-start),'notice probe OAuth'))) as {access_token?:unknown};if(typeof json.access_token!=='string'||!json.access_token)throw Error('NOTICE_PROBE_OAUTH_INVALID');return json.access_token;
}
export async function verifyNoticeProbe(e:Env,id:string):Promise<void>{
 const db=e.DB,book=e.GOOGLE_SPREADSHEET_ID,fp=await noticeReadinessFingerprint(e);if(!book||!fp||!/^[0-9a-f-]{36}$/.test(id))return;
 const p=await db.prepare("SELECT source,generation FROM continuous_notice_readiness_probes WHERE probe_id=? AND spreadsheet_id=? AND config_fingerprint=? AND (verified_generation IS NULL OR verified_generation<generation) AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes')").bind(id,book,fp).first<{source:string;generation:number}>();if(!p||!Number.isSafeInteger(p.generation))return;
 const token=await freshToken(e),timeout=15000,start=Date.now(),url=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(book)}?fields=spreadsheetId,sheets(properties(sheetId,title))`,res=await fetchWithTimeout(url,{headers:{Authorization:`Bearer ${token}`},redirect:'error'},timeout,'notice probe Sheets');
 if(!res.ok)throw Error('NOTICE_PROBE_SHEETS_FAILED');const json=JSON.parse(new TextDecoder().decode(await readSheetsBody(res,timeout-(Date.now()-start),'notice probe Sheets'))) as {spreadsheetId?:unknown;sheets?:Array<{properties?:{sheetId?:unknown;title?:unknown}}>};
 const expected=[[e.CONTINUOUS_DAILY_SHEET,e.CONTINUOUS_DAILY_SHEET_ID],[e.CONTINUOUS_RAW_SHEET,e.CONTINUOUS_RAW_SHEET_ID],[e.CONTINUOUS_DETAIL_SHEET,e.CONTINUOUS_DETAIL_SHEET_ID]];if(json.spreadsheetId!==book||!Array.isArray(json.sheets)||expected.some(([title,id])=>!json.sheets!.some(s=>s.properties?.title===title&&String(s.properties?.sheetId)===id)))throw Error('NOTICE_PROBE_TARGET_INVALID');
 const driveStart=Date.now(),drive=await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(book)}?fields=id,capabilities(canEdit)`,{headers:{Authorization:`Bearer ${token}`},redirect:'error'},timeout,'notice probe Drive');
 if(!drive.ok)throw Error('NOTICE_PROBE_WRITE_PERMISSION_UNVERIFIED');const info=JSON.parse(new TextDecoder().decode(await readSheetsBody(drive,timeout-(Date.now()-driveStart),'notice probe Drive'))) as {id?:unknown;capabilities?:{canEdit?:unknown}};if(info.id!==book||info.capabilities?.canEdit!==true)throw Error('NOTICE_PROBE_WRITE_PERMISSION_UNVERIFIED');
 // Read-only: profile visibility can rule out some failures but does not
 // prove push quota, delivery, or that an owner will receive a message.
 const lineStart=Date.now(),line=await fetchWithTimeout(`https://api.line.me/v2/bot/profile/${encodeURIComponent(e.LINE_OWNER_USER_ID)}`,{headers:{Authorization:`Bearer ${e.LINE_CHANNEL_ACCESS_TOKEN}`},redirect:'error'},timeout,'notice probe LINE');
 if(!line.ok)throw Error('NOTICE_PROBE_LINE_UNAVAILABLE');const profile=JSON.parse(new TextDecoder().decode(await readSheetsBody(line,timeout-(Date.now()-lineStart),'notice probe LINE'))) as {userId?:unknown};if(profile.userId!==e.LINE_OWNER_USER_ID)throw Error('NOTICE_PROBE_LINE_IDENTITY');
 if(e.DB!==db||e.GOOGLE_SPREADSHEET_ID!==book||fp!==await noticeReadinessFingerprint(e))throw Error('NOTICE_PROBE_SCOPE_CHANGED');
 const r=await db.prepare("UPDATE continuous_notice_readiness_probes SET verified_generation=generation,verified_probe_id=probe_id,verified_fingerprint=config_fingerprint,verified_created_at=created_at,verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE probe_id=? AND spreadsheet_id=? AND source=? AND generation=? AND config_fingerprint=? AND (verified_generation IS NULL OR verified_generation<generation) AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes')").bind(id,book,p.source,p.generation,fp).run();if(r.success!==true||!Number.isSafeInteger(r.meta?.changes)||Number(r.meta.changes)>1)throw Error('NOTICE_PROBE_VERIFY_UNCERTAIN');
}
/** Independent of the notice Worker; no provider request or replay occurs. */
export async function watchdogNoticeWorker(e:Env):Promise<void>{
 const db=e.DB;
 const schema=await db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='continuous_notice_dispatches'").first<{ok:number}>();if(!schema)return;
 const claim=await db.prepare(`SELECT c.spreadsheet_id,c.operation_token,d.dispatch_id FROM stable_workbook_claims c JOIN continuous_notice_dispatches d ON d.spreadsheet_id=c.spreadsheet_id AND d.operation_token=c.operation_token WHERE c.state='HELD' AND c.phase='END_NOTICE_PENDING' AND ((d.state='PENDING' AND d.updated_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')) OR (d.state='RUNNING' AND d.updated_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes'))) LIMIT 1`).first<{spreadsheet_id:string;operation_token:string;dispatch_id:string}>();
 if(!claim||e.DB!==db)return;const book=claim.spreadsheet_id;
 const stale="((state='PENDING' AND updated_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')) OR (state='RUNNING' AND updated_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes')))";
 try{
  const r=await db.batch([
   db.prepare(`UPDATE continuous_notice_dispatches SET state='HELD',outcome='RUNNER_CRASH',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE dispatch_id=? AND spreadsheet_id=? AND operation_token=? AND ${stale} AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_notice_dispatches' AND name IN ('continuous_notice_dispatch_owner_insert','continuous_notice_dispatch_owner_update'))=2`).bind(claim.dispatch_id,book,claim.operation_token),
   db.prepare(`UPDATE stable_workbook_claims SET state='REVIEW',phase='END_NOTICE',review_reason='CONTINUOUS_NOTICE_RUNNER_STALLED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='HELD' AND phase='END_NOTICE_PENDING' AND changes()=1 AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_alert_incidents') AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='stable_workbook_claims' AND name IN ('sync_alert_claim_insert','sync_alert_claim_update','sync_alert_claim_release','sync_alert_claim_resume'))=4`).bind(book,claim.operation_token),
   db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
  ]);
  if(r.length!==3||r.some(x=>x.success!==true)||r[0]!.meta?.changes!==1||r[1]!.meta?.changes!==1)throw Error('NOTICE_WATCHDOG_UNCERTAIN');
  await wakeSyncFailureAlerts(e);return;
 }catch{
  // A lost batch acknowledgement may have committed. Wake only a positively
  // read-back incident; never requeue a possibly dispatched provider write.
  const held=await db.prepare("SELECT i.alerted_at FROM continuous_notice_dispatches d JOIN stable_workbook_claims c ON c.spreadsheet_id=d.spreadsheet_id AND c.operation_token=d.operation_token JOIN sync_alert_incidents i ON i.kind='WORKBOOK' AND i.source_id=CAST(c.rowid AS TEXT) AND i.state='OPEN' WHERE d.dispatch_id=? AND d.spreadsheet_id=? AND d.operation_token=? AND d.state='HELD' AND c.state='REVIEW'").bind(claim.dispatch_id,book,claim.operation_token).first<{alerted_at:string|null}>();
  if(held&&held.alerted_at===null)await wakeSyncFailureAlerts(e);
 }
}
