import type {Env} from "../types";
import {numberEnv} from "../shared/env";
import {batchUpdateSpreadsheet,getAllSheetProperties,getSheetIdentityMetadataById,getSheetProtectedRanges} from "./client";
import {inspectOwnerCorrectionReportView,type CorrectionReportView} from "./owner-correction-report-view";

interface CleanupPorts{properties:typeof getAllSheetProperties;metadata:typeof getSheetIdentityMetadataById;ranges:typeof getSheetProtectedRanges;batch:typeof batchUpdateSpreadsheet;now:()=>number}
const defaults:CleanupPorts={properties:getAllSheetProperties,metadata:getSheetIdentityMetadataById,ranges:getSheetProtectedRanges,batch:batchUpdateSpreadsheet,now:()=>Date.now()};
interface Row{correction_id:string;sheet_id:number;sheet_title:string;metadata_id:number;period:string;state:string;not_before:string|null}
const eligible=`EXISTS(SELECT 1 FROM expense_owner_corrections c JOIN expense_events e ON e.expense_id=c.expense_id WHERE c.correction_id=expense_owner_correction_report_views.correction_id
  AND (c.status IN ('CANCELLED','STALE') OR (c.status='DRAFT' AND (c.expires_at<=? OR e.status<>'CONFIRMED' OR e.version<>expense_owner_correction_report_views.expense_version)) OR (c.status='APPLIED' AND c.reconciled_at IS NOT NULL)))`;

/** Delete only the exact hidden, protected and marked report copies we created. */
export async function cleanupOwnerCorrectionReportViews(env:Env,ports:CleanupPorts=defaults):Promise<{removed:number;review:number}>{
  if(env.OWNER_EXPENSE_CORRECTION_ENABLED!=="true"){
    const table=await env.DB.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='expense_owner_correction_report_views'`).first<{present:number}>();if(!table)return {removed:0,review:0};
  }
  const at=ports.now();if(!Number.isFinite(at))throw new Error("CORRECTION_REPORT_VIEW_CLEANUP_CONFIG_INVALID");const now=new Date(at).toISOString();
  const selected=await env.DB.prepare(`SELECT correction_id,sheet_id,sheet_title,metadata_id,period,state,not_before FROM expense_owner_correction_report_views WHERE state<>'REMOVED' AND (not_before IS NULL OR not_before<=?) AND ${eligible} ORDER BY updated_at LIMIT 20`).bind(now,now).all<Row>();
  if(!(selected.results||[]).length)return {removed:0,review:0};if(!env.GOOGLE_SERVICE_ACCOUNT_EMAIL)throw new Error("CORRECTION_REPORT_VIEW_CLEANUP_CONFIG_INVALID");
  let removed=0,review=0;
  for(const row of selected.results||[]){
    const token=crypto.randomUUID(),timeout=Math.max(0,numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000)),deadline=new Date(at+Math.max(15*60_000,timeout+240_000)).toISOString();
    const claimed=await env.DB.prepare(`UPDATE expense_owner_correction_report_views SET state='REMOVING',dispatch_token=?,not_before=?,updated_at=? WHERE correction_id=? AND period=? AND state=? AND (not_before IS NULL OR not_before<=?) AND ${eligible}`)
      .bind(token,deadline,now,row.correction_id,row.period,row.state,now,now).run();if(Number(claimed.meta.changes||0)!==1)continue;
    const view:CorrectionReportView={correctionId:row.correction_id,sheetId:Number(row.sheet_id),title:row.sheet_title,metadataId:Number(row.metadata_id),period:row.period};
    let state=await inspectOwnerCorrectionReportView(env,row.correction_id,view,ports);
    if(state==="CONFLICT"){review++;continue;}
    if(state==="VERIFIED"){
      try{await ports.batch(env,[{deleteSheet:{sheetId:view.sheetId}}],async()=>{
        // Re-read the unique marker after OAuth and immediately before the
        // final CAS; never delete a tab whose identity or protection changed.
        if(await inspectOwnerCorrectionReportView(env,row.correction_id,view,ports)!=="VERIFIED")throw new Error("CORRECTION_REPORT_VIEW_IDENTITY_CHANGED");
        const current=ports.now(),start=new Date(current).toISOString(),until=new Date(current+Math.max(15*60_000,timeout+240_000)).toISOString();
        const renewed=await env.DB.prepare(`UPDATE expense_owner_correction_report_views SET not_before=?,updated_at=? WHERE correction_id=? AND period=? AND state='REMOVING' AND dispatch_token=? AND not_before>? AND ${eligible}`)
          .bind(until,start,row.correction_id,row.period,token,start,start).run();if(Number(renewed.meta.changes||0)!==1)throw new Error("CORRECTION_REPORT_VIEW_CLEANUP_LEASE_LOST");
      });}catch{review++;continue;}
      state=await inspectOwnerCorrectionReportView(env,row.correction_id,view,ports);if(state!=="ABSENT"){review++;continue;}
    }
    const done=await env.DB.prepare(`UPDATE expense_owner_correction_report_views SET state='REMOVED',dispatch_token=NULL,not_before=NULL,updated_at=? WHERE correction_id=? AND period=? AND state='REMOVING' AND dispatch_token=? AND ${eligible}`)
      .bind(new Date(ports.now()).toISOString(),row.correction_id,row.period,token,new Date(ports.now()).toISOString()).run();
    if(Number(done.meta.changes||0)===1)removed++;else review++;
  }
  return {removed,review};
}
