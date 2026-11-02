import type {Env} from "../types";
import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {loadOwnerCorrectionDraft} from "../expense/owner-correction-repository";
import {activeOwnerSql,type OwnerReviewIdentity} from "../expense/online-order-review-repository";
import {numberEnv} from "../shared/env";
import {batchUpdateSpreadsheet,getSheetId,getSheetProtectedRanges,getSheetRowMetadataById} from "./client";
import {buildOwnerCorrectionCellGuards,inspectOwnerCorrectionCellGuards,type CorrectionCellGuard} from "./owner-correction-cell-protection";
import type {CorrectionSyncPlan} from "./owner-correction-sync-plan";

interface GuardPorts{metadata:typeof getSheetRowMetadataById;sheetId:typeof getSheetId;ranges:typeof getSheetProtectedRanges;batch:typeof batchUpdateSpreadsheet;now:()=>number}
const defaults:GuardPorts={metadata:getSheetRowMetadataById,sheetId:getSheetId,ranges:getSheetProtectedRanges,batch:batchUpdateSpreadsheet,now:()=>Date.now()};
type Result={kind:"READY";guards:CorrectionCellGuard[]}|{kind:"PENDING"|"REVIEW"|"STALE"};
interface SavedGuard{daily_metadata_id:number;sheet_id:number;columns_json:string;guards_json:string|null;state:string;dispatch_token:string|null;not_before:string|null}

/** Protect just the daily input cells that the approved same-row patch changes. */
export async function ensureOwnerCorrectionCellGuards(env:Env,owner:OwnerReviewIdentity,correctionId:string,before:OwnerCorrectionSnapshot,plan:CorrectionSyncPlan,ports:GuardPorts=defaults):Promise<Result>{
  const nowMs=ports.now(),account=String(env.GOOGLE_SERVICE_ACCOUNT_EMAIL||"").trim();
  if(!Number.isFinite(nowMs)||!account||plan.expenseId!==before.expenseId||plan.rebind)return {kind:"REVIEW"};
  const daily=plan.patches.filter(patch=>patch.metadataId===plan.dailyMetadataId);if(daily.length!==1)return {kind:"REVIEW"};
  const columns=daily[0]!.cells.map(cell=>cell.columnIndex).filter(col=>col!==21).sort((a,b)=>a-b);
  if(!columns.length)return {kind:"READY",guards:[]};
  const draft=await loadOwnerCorrectionDraft(env,owner,correctionId,nowMs);if(!draft||draft.before_json!==JSON.stringify(before))return {kind:"STALE"};
  const [metadata,sheetId]=await Promise.all([ports.metadata(env,plan.dailyMetadataId),ports.sheetId(env,env.SHEET_EXPENSE_DAILY)]);
  if(!metadata||metadata.metadataId!==plan.dailyMetadataId||metadata.metadataKey!=="malipang_expense_daily"||metadata.metadataValue!==before.expenseId||metadata.sheetId!==sheetId)return {kind:"REVIEW"};
  const initial=inspectOwnerCorrectionCellGuards({correctionId,metadata,columns,ranges:[],serviceAccount:account});if(initial.kind!=="NONE")return {kind:"REVIEW"};
  const now=new Date(nowMs).toISOString(),columnsJson=JSON.stringify(columns);
  await env.DB.prepare(`INSERT INTO expense_owner_correction_cell_guards(correction_id,expense_id,expense_version,daily_metadata_id,sheet_id,columns_json,state,created_at,updated_at)
    SELECT ?,?,?,?,?,?,'PREPARED',?,? WHERE EXISTS(SELECT 1 FROM expense_owner_corrections c JOIN expense_events e ON e.expense_id=c.expense_id
      WHERE c.correction_id=? AND c.owner_employee_id=? AND c.status='DRAFT' AND c.expires_at>? AND c.before_json=? AND e.expense_id=? AND e.status='CONFIRMED' AND e.version=?
        AND e.updated_at IS ? AND e.description=? AND e.category=? AND e.amount_satang=? AND e.transaction_date=? AND e.payment_key=? AND e.source_wallet=? AND ${activeOwnerSql}
        AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_key=e.expense_id AND j.entity_type IN ('EXPENSE','EXPENSE_CORRECTION') AND j.status<>'COMPLETED')
        AND NOT EXISTS(SELECT 1 FROM expense_owner_correction_manual_reviews r WHERE r.correction_id=c.correction_id AND r.status='OPEN')) ON CONFLICT DO NOTHING`)
    .bind(correctionId,before.expenseId,before.version,plan.dailyMetadataId,sheetId,columnsJson,now,now,correctionId,owner.employeeId,now,JSON.stringify(before),before.expenseId,before.version,before.updatedAt,before.description,before.category,before.amountSatang,before.transactionDate,before.paymentKey,before.sourceWallet,owner.employeeId,owner.lineUserId).run();
  let saved=await env.DB.prepare(`SELECT daily_metadata_id,sheet_id,columns_json,guards_json,state,dispatch_token,not_before FROM expense_owner_correction_cell_guards WHERE correction_id=? AND expense_id=? AND expense_version=?`).bind(correctionId,before.expenseId,before.version).first<SavedGuard>();
  if(!saved)return {kind:"PENDING"};
  if(saved.daily_metadata_id!==plan.dailyMetadataId||saved.sheet_id!==sheetId||saved.columns_json!==columnsJson)return {kind:"REVIEW"};
  const inspect=async()=>{const [current,currentRanges]=await Promise.all([ports.metadata(env,plan.dailyMetadataId),ports.ranges(env,env.SHEET_EXPENSE_DAILY)]);
    if(!current||current.metadataId!==plan.dailyMetadataId||current.metadataKey!=="malipang_expense_daily"||current.metadataValue!==before.expenseId||current.sheetId!==sheetId||currentRanges.sheetId!==sheetId)return null;
    return {metadata:current,inspection:inspectOwnerCorrectionCellGuards({correctionId,metadata:current,columns,ranges:currentRanges.ranges,serviceAccount:account})};};
  if(saved.state==="ACTIVE"){
    const current=await inspect();if(!current||current.inspection.kind!=="COMPLETE"||saved.guards_json!==JSON.stringify(current.inspection.guards))return {kind:"REVIEW"};
    return {kind:"READY",guards:current.inspection.guards};
  }
  if(saved.state==="IN_FLIGHT"){
    const deadline=saved.not_before?Date.parse(saved.not_before):NaN;if(!Number.isFinite(deadline))return {kind:"REVIEW"};if(nowMs<deadline)return {kind:"PENDING"};
    const current=await inspect();if(!current)return {kind:"REVIEW"};
    if(current.inspection.kind==="COMPLETE"){
      const result=await env.DB.prepare(`UPDATE expense_owner_correction_cell_guards SET state='ACTIVE',guards_json=?,not_before=NULL,updated_at=? WHERE correction_id=? AND state='IN_FLIGHT' AND dispatch_token=? AND not_before=?
        AND EXISTS(SELECT 1 FROM expense_owner_corrections WHERE correction_id=? AND status='DRAFT' AND expires_at>?)`).bind(JSON.stringify(current.inspection.guards),now,correctionId,saved.dispatch_token,saved.not_before,correctionId,now).run();
      return Number(result.meta.changes||0)===1?{kind:"READY",guards:current.inspection.guards}:{kind:"STALE"};
    }
    if(current.inspection.kind!=="NONE")return {kind:"REVIEW"};
    const reset=await env.DB.prepare(`UPDATE expense_owner_correction_cell_guards SET state='PREPARED',dispatch_token=NULL,not_before=NULL,updated_at=? WHERE correction_id=? AND state='IN_FLIGHT' AND dispatch_token=? AND not_before=?`).bind(now,correctionId,saved.dispatch_token,saved.not_before).run();
    if(Number(reset.meta.changes||0)!==1)return {kind:"PENDING"};saved={...saved,state:"PREPARED",dispatch_token:null,not_before:null};
  }
  if(saved.state!=="PREPARED")return {kind:saved.state==="REVIEW"?"REVIEW":"STALE"};
  const current=await inspect();if(!current||current.inspection.kind!=="NONE")return {kind:"REVIEW"};
  const token=crypto.randomUUID(),requests=buildOwnerCorrectionCellGuards({correctionId,metadata:current.metadata,columns,serviceAccount:account});let dispatched=false;
  try{
    await ports.batch(env,requests,async()=>{
      const at=ports.now(),started=new Date(at).toISOString(),timeout=Math.max(0,numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000)),deadline=new Date(at+Math.max(15*60_000,timeout+240_000)).toISOString();
      const armed=await env.DB.prepare(`UPDATE expense_owner_correction_cell_guards SET state='IN_FLIGHT',dispatch_token=?,not_before=?,updated_at=? WHERE correction_id=? AND state='PREPARED'
        AND EXISTS(SELECT 1 FROM expense_owner_corrections c JOIN expense_events e ON e.expense_id=c.expense_id WHERE c.correction_id=? AND c.owner_employee_id=? AND c.status='DRAFT' AND c.expires_at>?
          AND c.before_json=? AND e.status='CONFIRMED' AND e.version=? AND e.updated_at IS ? AND e.description=? AND e.category=? AND e.amount_satang=? AND e.transaction_date=? AND e.payment_key=? AND e.source_wallet=? AND ${activeOwnerSql}
          AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_key=e.expense_id AND j.entity_type IN ('EXPENSE','EXPENSE_CORRECTION') AND j.status<>'COMPLETED')
          AND NOT EXISTS(SELECT 1 FROM expense_owner_correction_manual_reviews r WHERE r.correction_id=c.correction_id AND r.status='OPEN'))`)
        .bind(token,deadline,started,correctionId,correctionId,owner.employeeId,started,JSON.stringify(before),before.version,before.updatedAt,before.description,before.category,before.amountSatang,before.transactionDate,before.paymentKey,before.sourceWallet,owner.employeeId,owner.lineUserId).run();
      if(Number(armed.meta.changes||0)!==1)throw new Error("CORRECTION_CELL_GUARD_LEASE_LOST");dispatched=true;
    });
  }catch{return {kind:dispatched?"PENDING":"STALE"};}
  if(!dispatched)return {kind:"REVIEW"};
  const after=await inspect();if(!after||after.inspection.kind!=="COMPLETE")return {kind:"PENDING"};
  const updated=await env.DB.prepare(`UPDATE expense_owner_correction_cell_guards SET state='ACTIVE',guards_json=?,not_before=NULL,updated_at=? WHERE correction_id=? AND state='IN_FLIGHT' AND dispatch_token=?
    AND EXISTS(SELECT 1 FROM expense_owner_corrections WHERE correction_id=? AND status='DRAFT' AND expires_at>?)`).bind(JSON.stringify(after.inspection.guards),new Date(ports.now()).toISOString(),correctionId,token,correctionId,new Date(ports.now()).toISOString()).run();
  return Number(updated.meta.changes||0)===1?{kind:"READY",guards:after.inspection.guards}:{kind:"STALE"};
}
