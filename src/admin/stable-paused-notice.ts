import type {Env} from '../types';
import {stableNoticePaused,stableNoticeStyleFingerprint} from '../sheets/stable-edit-notice';

// G6b read-only candidate. A positive result is a point-in-time observation,
// never authority to write a Sheet, release a claim, arm a canary or deploy.
const INCIDENT_STAMP='2026-11-05 21:26:00';
type Row={operation_token:unknown;state:unknown;notice_stamp:unknown;notice_identity:unknown;created_at:unknown;updated_at:unknown;phase:unknown;review_reason:unknown;review_count:unknown;held_count:unknown;inflight_count:unknown;active_epoch_count:unknown};
const hex=async(value:string):Promise<string>=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
const json=(value:unknown,status:number)=>Response.json(value,{status,headers:{'Cache-Control':'no-store, private','Pragma':'no-cache','Vary':'Authorization'}});

export async function readOriginalPausedNotice(request:Request,env:Env,mode:'PAUSED'|'READY'='PAUSED'):Promise<Response>{
 const nonce=request.headers.get('x-mp248-nonce');
 if(typeof nonce!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(nonce))return json({ok:false},400);
 const expectedClaim=request.headers.get('x-mp248-claim-fingerprint'),expectedStyle=request.headers.get('x-mp248-style-fingerprint');
 const readyTime=request.headers.get('x-mp248-ready-time'),readyStatus=request.headers.get('x-mp248-ready-status');
 if(mode==='READY'){
  const canonicalTime=typeof readyTime==='string'&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(readyTime)&&Number.isFinite(Date.parse(readyTime.replace(' ','T')+'Z'))&&new Date(Date.parse(readyTime.replace(' ','T')+'Z')).toISOString().slice(0,19)===readyTime.replace(' ','T');
  if(!canonicalTime||!['NORMAL','REVIEW'].includes(readyStatus||'')||!expectedClaim||!/^[a-f0-9]{64}$/.test(expectedClaim)||!expectedStyle||!/^[a-f0-9]{64}$/.test(expectedStyle))return json({ok:false},400);
 }
 const unavailable=()=>json({ok:false,nonce},503);
 try{
  const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
  const sameScope=()=>env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&env.STABLE_PHASE1_ENABLED==='true'&&env.STABLE_RECOVERY_GATE_ENABLED==='true'&&env.STABLE_SHEETS_PACING_ENABLED==='true';
  if(!book||!sameScope())return unavailable();
  const read=()=>db.prepare(`SELECT operation_token,state,notice_stamp,notice_identity,created_at,updated_at,phase,review_reason,
   (SELECT count(*) FROM stable_workbook_claims WHERE state='REVIEW') review_count,
   (SELECT count(*) FROM stable_workbook_claims WHERE state='HELD') held_count,
   (SELECT count(*) FROM stable_projection_writes WHERE state='IN_FLIGHT') inflight_count,
   (SELECT count(*) FROM stable_recovery_epochs WHERE state IN ('ARMED','REVIEW')) active_epoch_count
   FROM stable_workbook_claims WHERE spreadsheet_id=?`).bind(book).first<Row>();
  const valid=(r:Row|null):r is Row=>!!r&&r.state==='REVIEW'&&r.notice_stamp===INCIDENT_STAMP&&typeof r.operation_token==='string'&&r.operation_token.length>=8&&typeof r.notice_identity==='string'&&r.notice_identity.length>0&&typeof r.created_at==='string'&&r.created_at.length>0&&typeof r.updated_at==='string'&&r.updated_at.length>0&&(r.phase===null||typeof r.phase==='string')&&(r.review_reason===null||typeof r.review_reason==='string')&&r.review_count===1&&r.held_count===0&&r.inflight_count===0&&r.active_epoch_count===0;
  const fingerprint=(r:Row)=>hex(JSON.stringify([book,r.operation_token,r.state,r.notice_stamp,r.notice_identity,r.created_at,r.updated_at,r.phase,r.review_reason]));
  const before=await read();if(!sameScope()||!valid(before))return unavailable();
  const digest=await fingerprint(before);if(!sameScope())return unavailable();
  if(mode==='READY'&&digest!==expectedClaim)return unavailable();
  if(mode==='PAUSED'&&(!await stableNoticePaused(env,before.notice_stamp as string,before.notice_identity as string)||!sameScope()))return unavailable();
  const status=mode==='PAUSED'?'พักแก้ไฟล์':readyStatus==='REVIEW'?'พร้อมแก้ไข • มีรายการรอตรวจ':'พร้อมแก้ไข';
  const time=mode==='PAUSED'?INCIDENT_STAMP:readyTime!;
  const style=await stableNoticeStyleFingerprint(env,before.notice_identity as string,status,time);
  if(!sameScope()||typeof style!=='string'||!/^[a-f0-9]{64}$/.test(style)||mode==='READY'&&style!==expectedStyle)return unavailable();
  const after=await read();if(!sameScope()||!valid(after)||await fingerprint(after)!==digest||!sameScope())return unavailable();
  // Nonce and fingerprint are joined for a caller to verify a fresh response.
  const binding=await hex(JSON.stringify(['MP248_ORIGINAL_NOTICE_V1',mode,nonce,digest,style,mode==='READY'?readyStatus:null,mode==='READY'?readyTime:null]));
  if(!sameScope())return unavailable();
  return json({ok:true,mode,nonce,claim_fingerprint:digest,style_fingerprint:style,binding},200);
 }catch{return unavailable();}
}
