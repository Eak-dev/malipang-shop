import type {Env,SheetsSyncJob} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,continuousSheetsReadPolicy,getSheetGridInfo} from './client';
import {decodePublicationCarrier,verifyPublicationColumn} from './continuous-publication-template';
import {readReviewedPublicationSource} from './continuous-publication-reviewed-source';
import {stableNoticePaused} from './stable-edit-notice';
import type {PublicationColumn,PublicationExecutor,PublicationIntent} from './continuous-publication-executor';
import {ReviewRequestBudget} from './review-request-budget';

type IntentRow={sheet_id:number;sheet_name:string;row_number:number;kind:'STAGE'|'PUBLISH'|'REVOKE';source_revision:number;source_digest:string;lease_token:string;before_value:string;after_value:string;state:'IN_FLIGHT'|'VERIFIED'};
/** Candidate positive-only REVIEW adapter. It cannot send Sheets mutations,
 * release the workbook claim, close the notice or resume a job. The caller
 * must separately reconcile the lifecycle after this one exact marker. */
export async function reviewedPublicationRecovery(env:Env,job:SheetsSyncJob,claim:string,transitionId:string,target:{sheetId:number;sheetName:string;row:number;rows:number},budget:ReviewRequestBudget,verifyTarget:()=>Promise<boolean>,verifyProjections:(after:import('./continuous-publication-template').PublicationCarrier,row:number)=>Promise<boolean>):Promise<{intent:PublicationIntent;io:Pick<PublicationExecutor,'read'|'guard'|'commit'>}|null>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,initial=JSON.stringify([book,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.APP_ENV,env.RUNTIME_MODE]),policy={...continuousSheetsReadPolicy,budget};
 const stable=()=>env.DB===db&&JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.APP_ENV,env.RUNTIME_MODE])===initial;
 if(!book||!claim||!transitionId||!(budget instanceof ReviewRequestBudget)||!Number.isSafeInteger(target.rows)||target.rows<2||target.rows>5000||target.row>target.rows||typeof verifyTarget!=='function'||typeof verifyProjections!=='function')return null;
 const row=await db.prepare("SELECT sheet_id,sheet_name,row_number,kind,source_revision,source_digest,lease_token,before_value,after_value,state FROM continuous_publication_intents WHERE transition_id=? AND spreadsheet_id=? AND entity_id=? AND source_version=? AND claim_token=? AND sheet_id=? AND sheet_name=? AND row_number=? AND state IN ('IN_FLIGHT','VERIFIED')").bind(transitionId,book,job.entityKey,job.entityVersion,claim,target.sheetId,target.sheetName,target.row).first<IntentRow>();
 const after=decodePublicationCarrier(row?.after_value);
 if(!stable()||!row||!after||after.expenseId!==job.entityKey||after.version!==job.entityVersion||after.state!==(row.kind==='STAGE'?'STAGED':row.kind==='PUBLISH'?'PUBLISHED':'REVOKED'))return null;
 const intent:PublicationIntent={sheetId:target.sheetId,row:target.row,rows:target.rows,before:row.before_value,after};
 let checkedRevision:number|undefined;
 const guard=async()=>{
  const source=await readReviewedPublicationSource(env,job,claim,transitionId,target);
  if(!stable()||!source||source.digest!==row.source_digest||source.kind!==row.kind||!await verifyTarget()||!await stableNoticePaused(env,source.noticeStamp,source.noticeIdentity,budget))return false;
  if(row.kind==='PUBLISH'&&!await verifyProjections(after,target.row))return false;
  const latest=await readReviewedPublicationSource(env,job,claim,transitionId,target);
  if(!stable()||JSON.stringify(latest)!==JSON.stringify(source))return false;checkedRevision=source.revision;return true;
 };
 const read=async():Promise<PublicationColumn>=>{
  const grid=await getSheetGridInfo(env,target.sheetName,policy);if(!stable()||grid.sheetId!==target.sheetId||grid.rowCount!==target.rows||grid.columnCount<1||grid.columnCount>100)throw Error('PUBLICATION_REVIEW_GRID');
  const range=`'${target.sheetName.replace(/'/g,"''")}'!A1:A${target.rows}`,f=await batchGetSheetFormulaValues(env,[range],policy),e=await batchGetSheetEffectiveSerialValues(env,[range],policy),latest=await getSheetGridInfo(env,target.sheetName,policy);
  if(!stable()||JSON.stringify(grid)!==JSON.stringify(latest)||f.length!==1||e.length!==1)throw Error('PUBLICATION_REVIEW_GRID');return{formula:f[0]!,effective:e[0]!};
 };
 const commit=async()=>{
  const post=await read();if(!verifyPublicationColumn(post.formula,post.effective,target.rows,after,target.row)||!await guard())return false;
  const retained=await db.prepare("SELECT 1 AS ok FROM continuous_publication_intents i JOIN continuous_publication_markers m ON m.spreadsheet_id=i.spreadsheet_id AND m.entity_id=i.entity_id AND m.sheet_id=i.sheet_id AND m.sheet_name=i.sheet_name AND m.row_number=i.row_number AND m.transition_id=i.transition_id AND m.version=i.source_version AND m.marker=i.after_value WHERE i.transition_id=? AND i.spreadsheet_id=? AND i.entity_id=? AND i.source_version=? AND i.source_revision=? AND i.source_digest=? AND i.claim_token=? AND i.lease_token=? AND i.kind=? AND i.before_value=? AND i.after_value=? AND i.state='VERIFIED' AND m.state=?").bind(transitionId,book,job.entityKey,job.entityVersion,row.source_revision,row.source_digest,claim,row.lease_token,row.kind,row.before_value,row.after_value,after.state).first<{ok:number}>();
  if(!stable())return false;if(retained?.ok===1)return true;
  if(!Number.isSafeInteger(checkedRevision))return false;
  const result=await db.batch([
   db.prepare("INSERT INTO continuous_publication_review_evidence(transition_id,source_revision,source_digest,created_at) VALUES(?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind(transitionId,checkedRevision,row.source_digest),
   db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok"),
   db.prepare("UPDATE continuous_publication_intents SET state='VERIFIED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE transition_id=? AND spreadsheet_id=? AND entity_id=? AND source_version=? AND source_revision=? AND source_digest=? AND claim_token=? AND lease_token=? AND kind=? AND before_value=? AND after_value=? AND state='IN_FLIGHT'").bind(transitionId,book,job.entityKey,job.entityVersion,row.source_revision,row.source_digest,claim,row.lease_token,row.kind,row.before_value,row.after_value),
   db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok"),
   row.kind==='STAGE'?db.prepare("INSERT INTO continuous_publication_markers(spreadsheet_id,entity_id,sheet_id,sheet_name,row_number,version,state,marker,transition_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'STAGED',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind(book,job.entityKey,target.sheetId,target.sheetName,target.row,job.entityVersion,row.after_value,transitionId):db.prepare("UPDATE continuous_publication_markers SET version=?,state=?,marker=?,transition_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND entity_id=? AND sheet_id=? AND sheet_name=? AND row_number=? AND marker=?").bind(job.entityVersion,after.state,row.after_value,transitionId,book,job.entityKey,target.sheetId,target.sheetName,target.row,row.before_value),
   db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
  ]);
  return stable()&&result.length===6&&result.every(x=>x.success===true)&&Number(result[0]!.meta?.changes)===1&&Number(result[2]!.meta?.changes)===1&&Number(result[4]!.meta?.changes)===1;
 };
 return{intent,io:{read,guard,commit}};
}
