import type {Env} from "../types";
import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {loadOwnerCorrectionDraft} from "../expense/owner-correction-repository";
import {activeOwnerSql,type OwnerReviewIdentity} from "../expense/online-order-review-repository";
import {numberEnv} from "../shared/env";
import {batchUpdateSpreadsheet,getAllSheetProperties,getSheetIdentityMetadataById,getSheetProtectedRanges} from "./client";
import {ownerCorrectionSystemSheetProtected} from "./owner-correction-protection";

export interface CorrectionReportView{correctionId:string;sheetId:number;title:string;metadataId:number;period:string}
interface ViewPorts{properties:typeof getAllSheetProperties;metadata:typeof getSheetIdentityMetadataById;ranges:typeof getSheetProtectedRanges;batch:typeof batchUpdateSpreadsheet;now:()=>number;newId:()=>number}
const defaults:ViewPorts={properties:getAllSheetProperties,metadata:getSheetIdentityMetadataById,ranges:getSheetProtectedRanges,batch:batchUpdateSpreadsheet,now:()=>Date.now(),newId:()=>{const n=new Uint32Array(1);crypto.getRandomValues(n);return (n[0]!%2147483647)+1;}};
interface Row{sheet_id:number;sheet_title:string;metadata_id:number;period:string;state:string;dispatch_token:string|null;not_before:string|null}
type Result={kind:"READY";view:CorrectionReportView}|{kind:"PENDING"|"REVIEW"|"STALE"};
const marker=(id:string,period:string)=>`${id}|${period}`;
const viewFrom=(row:Row,correctionId:string):CorrectionReportView=>({correctionId,sheetId:Number(row.sheet_id),title:row.sheet_title,metadataId:Number(row.metadata_id),period:row.period});

/** Read back the hidden sheet, its unique marker and its full protection. */
export async function inspectOwnerCorrectionReportView(env:Env,correctionId:string,view:CorrectionReportView,ports:Pick<ViewPorts,"properties"|"metadata"|"ranges">=defaults):Promise<"ABSENT"|"VERIFIED"|"CONFLICT">{
  if(view.correctionId!==correctionId)return "CONFLICT";
  const [properties,tag]=await Promise.all([ports.properties(env),ports.metadata(env,view.metadataId)]),byId=properties.filter(item=>item.sheetId===view.sheetId),byTitle=properties.filter(item=>item.title===view.title);
  if(!byId.length&&!byTitle.length&&!tag)return "ABSENT";
  if(byId.length!==1||byTitle.length!==1||byId[0]!==byTitle[0]||byId[0]!.hidden!==true||!tag||tag.metadataId!==view.metadataId||tag.metadataKey!=="malipang_owner_report_view"||tag.metadataValue!==marker(correctionId,view.period)||tag.sheetId!==view.sheetId||!env.GOOGLE_SERVICE_ACCOUNT_EMAIL)return "CONFLICT";
  const protectedSheet=await ports.ranges(env,view.title);
  return protectedSheet.sheetId===view.sheetId&&ownerCorrectionSystemSheetProtected(view.sheetId,protectedSheet.ranges,env.GOOGLE_SERVICE_ACCOUNT_EMAIL)?"VERIFIED":"CONFLICT";
}

/** Create a private month-specific copy of the report without changing its visible month. */
export async function ensureOwnerCorrectionReportView(env:Env,owner:OwnerReviewIdentity,correctionId:string,before:OwnerCorrectionSnapshot,period:string,ports:ViewPorts=defaults):Promise<Result>{
  const at=ports.now(),account=String(env.GOOGLE_SERVICE_ACCOUNT_EMAIL||"").trim();
  if(!Number.isFinite(at)||!account||!/^owner_correction_[A-Za-z0-9_-]{8,128}$/.test(correctionId)||!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)||before.status!=="CONFIRMED"||before.transactionDate.slice(0,7)!==period)return {kind:"REVIEW"};
  const draft=await loadOwnerCorrectionDraft(env,owner,correctionId,at);if(!draft||draft.before_json!==JSON.stringify(before))return {kind:"STALE"};
  let saved=await env.DB.prepare(`SELECT sheet_id,sheet_title,metadata_id,period,state,dispatch_token,not_before FROM expense_owner_correction_report_views WHERE correction_id=? AND period=?`).bind(correctionId,period).first<Row>();
  if(!saved){
    let sheetId=ports.newId(),metadataId=ports.newId();if(!Number.isSafeInteger(sheetId)||sheetId<1||sheetId>2147483647||!Number.isSafeInteger(metadataId)||metadataId<1||metadataId>2147483647||sheetId===metadataId)return {kind:"REVIEW"};
    const title=`__MP_REPORT_${correctionId}_${period.replace("-","")}`;if(title.length>100)return {kind:"REVIEW"};
    const now=new Date(at).toISOString();
    await env.DB.prepare(`INSERT INTO expense_owner_correction_report_views(correction_id,expense_id,expense_version,period,sheet_id,sheet_title,metadata_id,state,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,'PREPARED',?,? WHERE EXISTS(SELECT 1 FROM expense_owner_corrections c JOIN expense_events e ON e.expense_id=c.expense_id
        WHERE c.correction_id=? AND c.owner_employee_id=? AND c.status='DRAFT' AND c.expires_at>? AND c.before_json=? AND e.expense_id=? AND e.status='CONFIRMED' AND e.version=?
          AND e.updated_at IS ? AND e.description=? AND e.category=? AND e.amount_satang=? AND e.transaction_date=? AND e.payment_key=? AND e.source_wallet=? AND ${activeOwnerSql}
          AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_key=e.expense_id AND j.entity_type IN ('EXPENSE','EXPENSE_CORRECTION') AND j.status<>'COMPLETED')
          AND NOT EXISTS(SELECT 1 FROM expense_owner_correction_manual_reviews r WHERE r.correction_id=c.correction_id AND r.status='OPEN')) ON CONFLICT DO NOTHING`)
      .bind(correctionId,before.expenseId,before.version,period,sheetId,title,metadataId,now,now,correctionId,owner.employeeId,now,JSON.stringify(before),before.expenseId,before.version,before.updatedAt,before.description,before.category,before.amountSatang,before.transactionDate,before.paymentKey,before.sourceWallet,owner.employeeId,owner.lineUserId).run();
    saved=await env.DB.prepare(`SELECT sheet_id,sheet_title,metadata_id,period,state,dispatch_token,not_before FROM expense_owner_correction_report_views WHERE correction_id=? AND period=?`).bind(correctionId,period).first<Row>();
  }
  if(!saved)return {kind:"STALE"};const view=viewFrom(saved,correctionId);
  if(!Number.isSafeInteger(view.sheetId)||view.sheetId<1||!Number.isSafeInteger(view.metadataId)||view.metadataId<1||view.period!==period||view.title!==`__MP_REPORT_${correctionId}_${period.replace("-","")}`)return {kind:"REVIEW"};
  if(saved.state==="ACTIVE")return await inspectOwnerCorrectionReportView(env,correctionId,view,ports)==="VERIFIED"?{kind:"READY",view}:{kind:"REVIEW"};
  if(saved.state==="IN_FLIGHT"){
    const deadline=saved.not_before?Date.parse(saved.not_before):NaN;if(!Number.isFinite(deadline))return {kind:"REVIEW"};if(at<deadline)return {kind:"PENDING"};
    const found=await inspectOwnerCorrectionReportView(env,correctionId,view,ports);
    if(found==="VERIFIED"){
      const changed=await env.DB.prepare(`UPDATE expense_owner_correction_report_views SET state='ACTIVE',not_before=NULL,updated_at=? WHERE correction_id=? AND period=? AND state='IN_FLIGHT' AND dispatch_token=? AND not_before=?
        AND EXISTS(SELECT 1 FROM expense_owner_corrections WHERE correction_id=? AND status='DRAFT' AND expires_at>?)`).bind(new Date(at).toISOString(),correctionId,period,saved.dispatch_token,saved.not_before,correctionId,new Date(at).toISOString()).run();
      return Number(changed.meta.changes||0)===1?{kind:"READY",view}:{kind:"STALE"};
    }
    if(found!=="ABSENT")return {kind:"REVIEW"};
    const reset=await env.DB.prepare(`UPDATE expense_owner_correction_report_views SET state='PREPARED',dispatch_token=NULL,not_before=NULL,updated_at=? WHERE correction_id=? AND period=? AND state='IN_FLIGHT' AND dispatch_token=? AND not_before=?`).bind(new Date(at).toISOString(),correctionId,period,saved.dispatch_token,saved.not_before).run();
    if(Number(reset.meta.changes||0)!==1)return {kind:"PENDING"};saved={...saved,state:"PREPARED",dispatch_token:null,not_before:null};
  }
  if(saved.state!=="PREPARED")return {kind:saved.state==="REVIEW"?"REVIEW":"STALE"};
  if(await inspectOwnerCorrectionReportView(env,correctionId,view,ports)!=="ABSENT")return {kind:"REVIEW"};
  const properties=await ports.properties(env),source=properties.filter(item=>item.title==="04_OWNER_MONTH_CLOSE");if(source.length!==1||source[0]!.sheetId===view.sheetId)return {kind:"REVIEW"};
  const [year,month]=period.split("-").map(Number),token=crypto.randomUUID(),requests=[
    {duplicateSheet:{sourceSheetId:source[0]!.sheetId,newSheetId:view.sheetId,newSheetName:view.title}},
    {updateSheetProperties:{properties:{sheetId:view.sheetId,hidden:true},fields:"hidden"}},
    {updateCells:{start:{sheetId:view.sheetId,rowIndex:1,columnIndex:2},rows:[{values:[{userEnteredValue:{formulaValue:`=DATE(${year},${month},1)`}}]}],fields:"userEnteredValue"}},
    {createDeveloperMetadata:{developerMetadata:{metadataId:view.metadataId,metadataKey:"malipang_owner_report_view",metadataValue:marker(correctionId,period),visibility:"DOCUMENT",location:{sheetId:view.sheetId}}}},
    {addProtectedRange:{protectedRange:{description:"MaliPang temporary report verification",range:{sheetId:view.sheetId},warningOnly:false,editors:{users:[account]}}}}
  ];let dispatched=false;
  try{await ports.batch(env,requests,async()=>{
    const current=ports.now(),now=new Date(current).toISOString(),timeout=Math.max(0,numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000)),deadline=new Date(current+Math.max(15*60_000,timeout+240_000)).toISOString();
    const armed=await env.DB.prepare(`UPDATE expense_owner_correction_report_views SET state='IN_FLIGHT',dispatch_token=?,not_before=?,updated_at=? WHERE correction_id=? AND period=? AND state='PREPARED'
      AND EXISTS(SELECT 1 FROM expense_owner_corrections c JOIN expense_events e ON e.expense_id=c.expense_id WHERE c.correction_id=? AND c.owner_employee_id=? AND c.status='DRAFT' AND c.expires_at>?
        AND c.before_json=? AND e.status='CONFIRMED' AND e.version=? AND e.updated_at IS ? AND e.description=? AND e.category=? AND e.amount_satang=? AND e.transaction_date=? AND e.payment_key=? AND e.source_wallet=? AND ${activeOwnerSql}
        AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_key=e.expense_id AND j.entity_type IN ('EXPENSE','EXPENSE_CORRECTION') AND j.status<>'COMPLETED')
        AND NOT EXISTS(SELECT 1 FROM expense_owner_correction_manual_reviews r WHERE r.correction_id=c.correction_id AND r.status='OPEN'))`)
      .bind(token,deadline,now,correctionId,period,correctionId,owner.employeeId,now,JSON.stringify(before),before.version,before.updatedAt,before.description,before.category,before.amountSatang,before.transactionDate,before.paymentKey,before.sourceWallet,owner.employeeId,owner.lineUserId).run();
    if(Number(armed.meta.changes||0)!==1)throw new Error("CORRECTION_REPORT_VIEW_LEASE_LOST");dispatched=true;
  });}catch{return {kind:dispatched?"PENDING":"STALE"};}
  if(!dispatched)return {kind:"REVIEW"};
  if(await inspectOwnerCorrectionReportView(env,correctionId,view,ports)!=="VERIFIED")return {kind:"PENDING"};
  const now=new Date(ports.now()).toISOString(),active=await env.DB.prepare(`UPDATE expense_owner_correction_report_views SET state='ACTIVE',not_before=NULL,updated_at=? WHERE correction_id=? AND period=? AND state='IN_FLIGHT' AND dispatch_token=?
    AND EXISTS(SELECT 1 FROM expense_owner_corrections WHERE correction_id=? AND status='DRAFT' AND expires_at>?)`).bind(now,correctionId,period,token,correctionId,now).run();
  return Number(active.meta.changes||0)===1?{kind:"READY",view}:{kind:"STALE"};
}
