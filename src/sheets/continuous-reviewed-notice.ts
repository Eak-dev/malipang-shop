import type {Env} from '../types';
import {reviewedClaimState,type NormalNoticeAuthority} from './normal-notice-authority';
import type {ContinuousSheetsReadPolicy} from './client';
import {stableNoticePaused,stableNoticeStyleFingerprint} from './stable-edit-notice';

export type ReviewedNoticeMode='PAUSED'|'REVIEW_READY';

/** Read-only notice evidence, bound to the durable close intent and exact
 * reviewed claim. A caller cannot supply a desired READY stamp or style. */
export async function reviewedNoticeMatches(env:Env,token:string,stamp:string,identity:string,mode:ReviewedNoticeMode,policy?:ContinuousSheetsReadPolicy,authority:NormalNoticeAuthority='REVIEW'):Promise<boolean>{
 if(mode==='PAUSED')return stableNoticePaused(env,stamp,identity,policy?.budget);
 if(mode!=='REVIEW_READY'||!token||!stamp||!identity||!env.GOOGLE_SPREADSHEET_ID)return false;
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 const read=()=>db.prepare(`SELECT n.style_digest,n.ready_status FROM continuous_review_notice_close n JOIN stable_workbook_claims c ON c.spreadsheet_id=n.spreadsheet_id AND c.operation_token=n.operation_token WHERE n.spreadsheet_id=? AND n.operation_token=? AND n.state='STATUS_ACKED' AND n.claim_mode=? AND n.notice_identity=? AND n.next_stamp=? AND ${reviewedClaimState('c',authority)} AND c.notice_identity=n.notice_identity AND c.notice_stamp=n.next_stamp`).bind(book,token,authority,identity,stamp).first<{style_digest:string;ready_status:string}>();
 try{
  const before=await read();if(!before||!/^[0-9a-f]{64}$/.test(before.style_digest)||env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book)return false;
  const style=await stableNoticeStyleFingerprint(env,identity,before.ready_status,stamp,policy?.budget),after=await read();
  return env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&style===before.style_digest&&after?.style_digest===before.style_digest&&after.ready_status===before.ready_status;
 }catch(error){if(authority==='HANDOFF')throw error;return false;}
}
