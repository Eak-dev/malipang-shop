import type {Env} from "../types";
import {numberEnv} from "../shared/env";
import {batchUpdateSpreadsheet,getSheetProtectedRanges,getSheetRowMetadataById} from "./client";
import {inspectOwnerCorrectionCellGuards,type CorrectionCellGuard} from "./owner-correction-cell-protection";

interface CleanupPorts{metadata:typeof getSheetRowMetadataById;ranges:typeof getSheetProtectedRanges;batch:typeof batchUpdateSpreadsheet;now:()=>number}
const defaults:CleanupPorts={metadata:getSheetRowMetadataById,ranges:getSheetProtectedRanges,batch:batchUpdateSpreadsheet,now:()=>Date.now()};
interface GuardRow{correction_id:string;expense_id:string;expense_version:number;daily_metadata_id:number;sheet_id:number;columns_json:string;guards_json:string|null;state:string;not_before:string|null}
const eligible=`EXISTS(SELECT 1 FROM expense_owner_corrections c JOIN expense_events e ON e.expense_id=c.expense_id WHERE c.correction_id=expense_owner_correction_cell_guards.correction_id
  AND (c.status IN ('CANCELLED','STALE') OR (c.status='DRAFT' AND (c.expires_at<=? OR e.status<>'CONFIRMED' OR e.version<>expense_owner_correction_cell_guards.expense_version)) OR (c.status='APPLIED' AND c.reconciled_at IS NOT NULL)))`;

/** Remove only our own exact temporary guards after a terminal or expired draft. */
export async function cleanupOwnerCorrectionCellGuards(env:Env,ports:CleanupPorts=defaults):Promise<{removed:number;review:number}>{
  // During a rollback the feature flag can be off while old temporary guards
  // still need removal. Before migration the table is absent and this is inert.
  if(env.OWNER_EXPENSE_CORRECTION_ENABLED!=="true"){
    const table=await env.DB.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='expense_owner_correction_cell_guards'`).first<{present:number}>();
    if(!table)return {removed:0,review:0};
  }
  const nowMs=ports.now();if(!Number.isFinite(nowMs))throw new Error("CORRECTION_GUARD_CLEANUP_CONFIG_INVALID");
  const now=new Date(nowMs).toISOString(),selected=await env.DB.prepare(`SELECT correction_id,expense_id,expense_version,daily_metadata_id,sheet_id,columns_json,guards_json,state,not_before FROM expense_owner_correction_cell_guards
    WHERE state<>'REMOVED' AND (not_before IS NULL OR not_before<=?) AND ${eligible} ORDER BY updated_at LIMIT 20`).bind(now,now).all<GuardRow>();
  if(!(selected.results||[]).length)return {removed:0,review:0};
  if(!env.SHEET_EXPENSE_DAILY||!env.GOOGLE_SERVICE_ACCOUNT_EMAIL)throw new Error("CORRECTION_GUARD_CLEANUP_CONFIG_INVALID");
  let removed=0,review=0;
  for(const row of selected.results||[]){
    const token=crypto.randomUUID(),timeout=Math.max(0,numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000)),deadline=new Date(nowMs+Math.max(15*60_000,timeout+240_000)).toISOString();
    const claimed=await env.DB.prepare(`UPDATE expense_owner_correction_cell_guards SET state='REMOVING',dispatch_token=?,not_before=?,updated_at=? WHERE correction_id=? AND state=? AND (not_before IS NULL OR not_before<=?) AND ${eligible}`)
      .bind(token,deadline,now,row.correction_id,row.state,now,now).run();
    if(Number(claimed.meta.changes||0)!==1)continue;
    let columns:number[],stored:CorrectionCellGuard[];try{columns=JSON.parse(row.columns_json) as number[];stored=row.guards_json?JSON.parse(row.guards_json) as CorrectionCellGuard[]:[];}catch{review++;continue;}
    if(!Array.isArray(columns)||!Array.isArray(stored)){review++;continue;}
    const read=async()=>{const [metadata,sheet]=await Promise.all([ports.metadata(env,row.daily_metadata_id),ports.ranges(env,env.SHEET_EXPENSE_DAILY)]);return {metadata,sheet};};
    let current=await read();if(current.sheet.sheetId!==row.sheet_id){review++;continue;}
    const descriptions=new Set(columns.map(col=>`malipang-owner-correction:${row.correction_id}:${col}`)),ids=new Set(stored.map(guard=>guard.protectedRangeId));
    const ours=()=>current.sheet.ranges.filter(item=>descriptions.has(String(item.description||""))||(item.protectedRangeId!==undefined&&ids.has(item.protectedRangeId)));
    if(ours().length){
      if(!current.metadata||current.metadata.metadataId!==row.daily_metadata_id||current.metadata.metadataValue!==row.expense_id||current.metadata.sheetId!==row.sheet_id){review++;continue;}
      const inspection=inspectOwnerCorrectionCellGuards({correctionId:row.correction_id,metadata:current.metadata,columns,ranges:current.sheet.ranges,serviceAccount:env.GOOGLE_SERVICE_ACCOUNT_EMAIL});
      if(inspection.kind==="CONFLICT"||inspection.kind==="NONE"||inspection.guards.length!==ours().length||stored.some(guard=>ours().some(item=>item.protectedRangeId===guard.protectedRangeId)&&!inspection.guards.some(item=>item.protectedRangeId===guard.protectedRangeId&&item.columnIndex===guard.columnIndex))||(stored.length>0&&inspection.guards.some(guard=>!stored.some(item=>item.protectedRangeId===guard.protectedRangeId&&item.columnIndex===guard.columnIndex)))){review++;continue;}
      try{
        await ports.batch(env,inspection.guards.map(guard=>({deleteProtectedRange:{protectedRangeId:guard.protectedRangeId}})),async()=>{
          const at=ports.now(),start=new Date(at).toISOString(),until=new Date(at+Math.max(15*60_000,timeout+240_000)).toISOString();
          const renewed=await env.DB.prepare(`UPDATE expense_owner_correction_cell_guards SET not_before=?,updated_at=? WHERE correction_id=? AND state='REMOVING' AND dispatch_token=? AND not_before>? AND ${eligible}`)
            .bind(until,start,row.correction_id,token,start,start).run();
          if(Number(renewed.meta.changes||0)!==1)throw new Error("CORRECTION_GUARD_CLEANUP_LEASE_LOST");
        });
      }catch{review++;continue;}
      current=await read();if(current.sheet.sheetId!==row.sheet_id||ours().length){review++;continue;}
    }
    const done=await env.DB.prepare(`UPDATE expense_owner_correction_cell_guards SET state='REMOVED',dispatch_token=NULL,not_before=NULL,updated_at=? WHERE correction_id=? AND state='REMOVING' AND dispatch_token=? AND ${eligible}`)
      .bind(new Date(ports.now()).toISOString(),row.correction_id,token,new Date(ports.now()).toISOString()).run();
    if(Number(done.meta.changes||0)===1)removed++;else review++;
  }
  return {removed,review};
}
