import type {Env} from '../types';
import {batchUpdateSpreadsheetWithReply,getSheetGridInfo} from '../sheets/client';
import {stableNoticeStyleFingerprint} from '../sheets/stable-edit-notice';
import {stableWorkbookClaimOwned} from '../sheets/stable-workbook-claim';

const bookSheetId=1815870717;
const integrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_cutover_notice_release' AND name IN ('continuous_notice_insert','continuous_notice_transition','continuous_notice_no_delete','continuous_notice_no_replace'))=4";
const paused='พักแก้ไฟล์';
function nowBangkok():string{
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
 const v=(type:string)=>parts.find(p=>p.type===type)?.value;return `${v('year')}-${v('month')}-${v('day')} ${v('hour')}:${v('minute')}:${v('second')}`;
}
const scope=(e:Env)=>JSON.stringify([e.GOOGLE_SPREADSHEET_ID,e.SHEET_EXPENSE_DAILY,e.GOOGLE_SERVICE_ACCOUNT_EMAIL,e.GOOGLE_PRIVATE_KEY_BASE64,e.EXTERNAL_API_TIMEOUT_MS,e.STABLE_PHASE1_ENABLED,e.STABLE_RECOVERY_GATE_ENABLED,e.STABLE_SHEETS_PACING_ENABLED]);

/** One durable exact-cell compare-and-swap per cell; partial or lost response
 * is uncertain and callers retain REVIEW. No value write or automatic retry. */
export async function releaseContinuousCutoverNotice(env:Env,token:string):Promise<void>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,initial=scope(env),stable=()=>env.DB===db&&scope(env)===initial;
 if(!book||!token||env.SHEET_EXPENSE_DAILY!=='รายวัน'||env.STABLE_PHASE1_ENABLED!=='true'||env.STABLE_RECOVERY_GATE_ENABLED!=='true'||env.STABLE_SHEETS_PACING_ENABLED!=='true')throw Error('CUTOVER_NOTICE_DISABLED');
 const [claim,reviewCount,grid]=await Promise.all([
  db.prepare("SELECT notice_stamp,notice_identity FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind(book,token).first<{notice_stamp:string;notice_identity:string}>(),
  db.prepare("SELECT count(*) AS n FROM sync_jobs WHERE status='REVIEW'").first<{n:number}>(),getSheetGridInfo(env,env.SHEET_EXPENSE_DAILY)
 ]);
 if(!claim?.notice_stamp||!claim.notice_identity||!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(claim.notice_stamp)||!reviewCount||!Number.isSafeInteger(reviewCount.n)||reviewCount.n<0||grid.sheetId!==bookSheetId||!stable()||!await stableWorkbookClaimOwned(env,token))throw Error('CUTOVER_NOTICE_PREIMAGE_UNVERIFIED');
 const oldStamp=claim.notice_stamp,newStamp=nowBangkok(),ready=reviewCount.n?'พร้อมแก้ไข • มีรายการรอตรวจ':'พร้อมแก้ไข';
 if(newStamp===oldStamp)throw Error('CUTOVER_NOTICE_PREIMAGE_UNVERIFIED');
 const style=await stableNoticeStyleFingerprint(env,claim.notice_identity,paused,oldStamp);
 if(!style||!stable()||!await stableWorkbookClaimOwned(env,token))throw Error('CUTOVER_NOTICE_PREIMAGE_UNVERIFIED');
 const intent=await db.prepare(`INSERT INTO continuous_cutover_notice_release(spreadsheet_id,operation_token,sheet_id,paused_stamp,ready_stamp,ready_status,style_digest,state,created_at)
  SELECT ?,?,?,?,?,?,?,'IN_FLIGHT',strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${integrity}
  AND EXISTS(SELECT 1 FROM continuous_cutover_operator o JOIN stable_workbook_claims c ON c.spreadsheet_id=o.spreadsheet_id AND c.operation_token=o.operation_token WHERE o.spreadsheet_id=? AND o.operation_token=? AND o.state='RELEASING' AND c.state='HELD' AND c.notice_stamp=? AND c.notice_identity=?)`).bind(book,token,bookSheetId,oldStamp,newStamp,ready,style,book,token,oldStamp,claim.notice_identity).run();
 if(!stable()||intent.success!==true||intent.meta?.changes!==1)throw Error('CUTOVER_NOTICE_INTENT_UNCERTAIN');
 const request=(column:number,find:string,replacement:string)=>({findReplace:{range:{sheetId:bookSheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:column,endColumnIndex:column+1},find,replacement,matchCase:true,matchEntireCell:true,searchByRegex:false,includeFormulas:false}});
 const reply=await batchUpdateSpreadsheetWithReply(env,[request(1,paused,ready),request(2,oldStamp,newStamp)],async()=>{
  const [before,still]=await Promise.all([stableNoticeStyleFingerprint(env,claim.notice_identity,paused,oldStamp),db.prepare("SELECT 1 AS ok FROM continuous_cutover_notice_release WHERE spreadsheet_id=? AND operation_token=? AND state='IN_FLIGHT'").bind(book,token).first<{ok:number}>()]);
  if(!stable()||before!==style||still?.ok!==1||!await stableWorkbookClaimOwned(env,token))throw Error('CUTOVER_NOTICE_PRE_DISPATCH_CHANGED');
 });
 const replies=reply&&typeof reply==='object'?(reply as {replies?:Array<{findReplace?:{valuesChanged?:unknown;occurrencesChanged?:unknown}}>}).replies:undefined;
 if(!Array.isArray(replies)||replies.length!==2||replies.some(r=>r.findReplace?.valuesChanged!==1||r.findReplace.occurrencesChanged!==1))throw Error('CUTOVER_NOTICE_PARTIAL_OR_UNKNOWN');
 const after=await stableNoticeStyleFingerprint(env,claim.notice_identity,ready,newStamp);
 if(!stable()||after!==style)throw Error('CUTOVER_NOTICE_READBACK_UNVERIFIED');
 const verified=await db.prepare(`UPDATE continuous_cutover_notice_release SET state='VERIFIED',verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='IN_FLIGHT' AND ${integrity}`).bind(book,token).run();
 if(!stable()||verified.success!==true||verified.meta?.changes!==1)throw Error('CUTOVER_NOTICE_VERIFICATION_UNCERTAIN');
}
