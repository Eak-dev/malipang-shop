import type {Env,SheetsSyncJob} from '../types';
import {ExpenseProjectionRuntimeJournal,type ExpenseGenerationLease,type ExpenseProjectionContext} from './expense-projection-runtime-journal';

export type DailyEditStatus='AVAILABLE'|'NOTICE'|'SYNCING'|'REVIEW'|'UNKNOWN';
function enabled(env:Env):boolean{return env.RUNTIME_MODE==='production'&&env.DAILY_EDIT_COORDINATION_ENABLED==='true'&&env.EXPENSE_GENERATION_WORKER_ENABLED==='true'&&env.EXPENSE_STABLE_PROJECTION_ENABLED==='true'&&env.DAILY_LEGACY_WRITER_GATE_ENABLED==='true'&&!!env.GOOGLE_SPREADSHEET_ID&&!!env.SHEET_EXPENSE_DAILY;}
/** This status is a cooperative signal, not a Google Sheets lock. It exposes
 * no workbook ID, expense values, lease tokens, or personal data. */
export async function readDailyEditStatus(env:Env):Promise<DailyEditStatus>{
  if(!enabled(env))return 'UNKNOWN';
  try{
    const row=await env.DB.prepare(`SELECT w.state,CASE WHEN w.deadline IS NOT NULL AND julianday(w.deadline)<=julianday('now') THEN 1 ELSE 0 END AS expired,
      CASE WHEN julianday(w.updated_at) IS NULL OR julianday(w.updated_at)<julianday('now','-120 seconds') OR julianday(w.updated_at)>julianday('now','+5 seconds') OR (w.state<>'AVAILABLE' AND julianday(w.deadline) IS NULL) THEN 0 ELSE 1 END AS fresh FROM daily_edit_coordination w
      JOIN daily_legacy_writer_gates g ON g.spreadsheet_id=w.spreadsheet_id AND g.sheet_name=w.sheet_name AND g.state='HOLD'
      JOIN expense_projection_cutovers c ON c.spreadsheet_id=g.spreadsheet_id AND c.sheet_name=g.sheet_name AND c.state='ACTIVE' AND c.generation=g.generation
      WHERE w.spreadsheet_id=? AND w.sheet_name=? AND (w.state='AVAILABLE' OR w.cutover_generation=c.generation)
      AND (w.state<>'AVAILABLE' OR NOT EXISTS(SELECT 1 FROM expense_projection_runtime_intents p WHERE p.spreadsheet_id=w.spreadsheet_id AND p.projection='DAILY' AND p.state IN ('IN_FLIGHT','REVIEW')))`).bind(env.GOOGLE_SPREADSHEET_ID,env.SHEET_EXPENSE_DAILY).first<{state:DailyEditStatus;expired:number;fresh:number}>();
    if(!row||!['AVAILABLE','NOTICE','SYNCING','REVIEW'].includes(row.state))return 'UNKNOWN';
    if(row.expired||row.state==='REVIEW')return 'REVIEW';
    return row.fresh?row.state:'UNKNOWN';
  }catch{return 'UNKNOWN';}
}
/** The page starts UNKNOWN and must receive fresh, uncached heartbeats. A
 * sleeping/frozen browser still cannot be used as proof of human exclusion. */
export function dailyEditStatusPage():Response{
  const script=`(()=>{const msg={AVAILABLE:['แก้ไขได้','ขณะนี้ไม่มีรอบซิงก์รายวันที่ระบบนี้กำลังดำเนินการ'],NOTICE:['กำลังเตรียมซิงก์','โปรดพักการแก้ไขรายวันชั่วคราว'],SYNCING:['กำลังซิงก์','โปรดพักการแก้ไขรายวันชั่วคราว'],REVIEW:['ต้องตรวจสอบก่อน','โปรดงดแก้รายวันจนกว่าจะตรวจสอบสถานะ'],UNKNOWN:['ยังตรวจสอบสถานะไม่ได้','โปรดงดแก้รายวันจนกว่าจะตรวจสอบสถานะ']};let last=null,lastWall=null,seq=0,ctrl=null;const title=document.getElementById('title'),detail=document.getElementById('detail');function show(s){const m=msg[s]||msg.UNKNOWN;title.textContent=m[0];detail.textContent=m[1]}function unknown(){seq++;last=null;lastWall=null;if(ctrl)ctrl.abort();ctrl=null;show('UNKNOWN')}async function poll(){if(document.hidden||navigator.onLine===false){unknown();return}const n=++seq,start=performance.now(),c=new AbortController();if(ctrl)ctrl.abort();ctrl=c;const timeout=setTimeout(()=>c.abort(),3000);try{const r=await fetch('/daily-sync-status/data',{cache:'no-store',signal:c.signal});const data=await r.json();if(n!==seq)return;if(!r.ok||!Object.hasOwn(msg,data.state)||performance.now()-start>4000||document.hidden||navigator.onLine===false){unknown();return}last=performance.now();lastWall=Date.now();show(data.state)}catch{if(n===seq)unknown()}finally{clearTimeout(timeout);if(ctrl===c)ctrl=null}}function fresh(){if(document.hidden||navigator.onLine===false||(last!==null&&(performance.now()<last||performance.now()-last>9000||lastWall===null||Date.now()<lastWall||Date.now()-lastWall>9000)))unknown()}document.addEventListener('visibilitychange',()=>{unknown();if(!document.hidden)poll()});window.addEventListener('focus',()=>{unknown();poll()});window.addEventListener('pagehide',unknown);window.addEventListener('pageshow',()=>{unknown();poll()});window.addEventListener('offline',unknown);window.addEventListener('online',()=>{unknown();poll()});setInterval(fresh,1000);setInterval(poll,5000);unknown();poll()})();`;
  return new Response(`<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>สถานะซิงก์รายวัน</title><style>body{font-family:system-ui,sans-serif;margin:12vh auto;max-width:38rem;padding:1.5rem;background:#f7f6f2;color:#213327}main{background:white;border-radius:1rem;padding:2rem;box-shadow:0 4px 24px #0001}h1{font-size:1.8rem}p{font-size:1.15rem;line-height:1.6}small{color:#54645a}</style></head><body><main><h1 id="title">ยังตรวจสอบสถานะไม่ได้</h1><p id="detail">โปรดงดแก้รายวันจนกว่าจะตรวจสอบสถานะ</p><small>สถานะนี้ใช้ประสานการทำงานร่วมกัน ไม่ได้ล็อกการแก้ไข</small></main><script>${script}</script></body></html>`,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store, max-age=0','content-security-policy':"default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",'x-content-type-options':'nosniff'}});
}
/** Request a cooperative pause for a specific already-claimed DAILY intent.
 * A pre-provisioned AVAILABLE row is required; missing evidence never creates
 * a fresh row. No writer can be dispatched by this operation. */
export async function requestDailyEditNotice(env:Env,job:SheetsSyncJob,syncLease:string,generationLease:ExpenseGenerationLease,context:ExpenseProjectionContext,outerToken:string,windowToken:string,seconds:number):Promise<boolean>{
  if(!enabled(env)||!/^[-A-Za-z0-9_]{16,128}$/.test(windowToken)||!Number.isInteger(seconds)||seconds<15||seconds>60)throw Error('DAILY_EDIT_COORDINATION_DISABLED');
  const outer=new ExpenseProjectionRuntimeJournal(env,job,syncLease,generationLease);
  return outer.requestDailyNotice(outerToken,context,windowToken,seconds);
}
/** Fail closed until the in-Sheets cooperative signal and independently
 * verified system-writer drainage exist. Human cooperation is not a lock. */
export async function beginDailyCoordinatedWrite():Promise<false>{return false;}
