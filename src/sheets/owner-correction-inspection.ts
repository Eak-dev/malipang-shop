import type {Env} from "../types";
import {getSheetId,getSheetProtectedRanges,getSheetValues,readSheetRowsByMetadata,searchSheetRowMetadata,type SheetRowMetadata} from "./client";
import {correctionPeriodHeaderDigest} from "../expense/owner-correction-period-math";
import {inspectOwnerCorrectionCategoryProtection} from "./owner-correction-protection";
import {inspectOwnerCorrectionCellGuards} from "./owner-correction-cell-protection";
import type {CorrectionSyncPlan} from "./owner-correction-sync-plan";
import type {CorrectionInspection} from "./owner-correction-worker";

export interface CorrectionInspectionPorts{
  sheetId:(env:Env,name:string)=>Promise<number>;
  metadata:(env:Env,key:string)=>Promise<SheetRowMetadata[]>;
  rows:(env:Env,ids:number[])=>Promise<Map<number,unknown[]>>;
  headers?:(env:Env,range:string)=>Promise<unknown[][]>;
  protection?:(env:Env)=>Promise<boolean>;
  cellRanges?:typeof getSheetProtectedRanges;
}
const defaults:CorrectionInspectionPorts={sheetId:getSheetId,metadata:searchSheetRowMetadata,rows:readSheetRowsByMetadata,headers:getSheetValues,protection:inspectOwnerCorrectionCategoryProtection,cellRanges:getSheetProtectedRanges};
const norm=(value:unknown)=>value===undefined||value===null?"":value;

/** Recheck metadata, target uniqueness, identities and every unchanged source cell. */
export async function inspectOwnerCorrectionTargets(env:Env,plan:CorrectionSyncPlan,ports:CorrectionInspectionPorts=defaults):Promise<CorrectionInspection>{
  const [dailyId,rawId,detailId,daily,raw,items,reservations]=await Promise.all([
    ports.sheetId(env,env.SHEET_EXPENSE_DAILY),ports.sheetId(env,env.SHEET_EXPENSE_RAW),ports.sheetId(env,env.SHEET_PURCHASE_DETAILS||"รายละเอียดการซื้อ"),
    ports.metadata(env,"malipang_expense_daily"),ports.metadata(env,"malipang_expense_raw"),ports.metadata(env,"malipang_expense_item"),ports.metadata(env,"malipang_correction_reservation")
  ]);
  const all=[...daily,...raw,...items,...reservations],ids=plan.patches.map(row=>row.metadataId),rows=await ports.rows(env,ids),before=new Map(plan.originalRows.map(row=>[row.metadataId,row.values]));
  if(plan.headerDigest!==undefined){
    if(!ports.headers||!ports.protection||!await ports.protection(env))return {identitiesVerified:false,rows};
    const headers=await ports.headers(env,`'${env.SHEET_EXPENSE_DAILY.replace(/'/g,"''")}'!A1:W3`);
    if(await correctionPeriodHeaderDigest(headers)!==plan.headerDigest)return {identitiesVerified:false,rows};
  }
  if(new Set([dailyId,rawId,detailId]).size!==3||new Set(ids).size!==ids.length||rows.size!==ids.length||before.size!==ids.length)return {identitiesVerified:false,rows};
  if(plan.cellGuards){
    const marker=daily.find(item=>item.metadataId===plan.dailyMetadataId);if(!marker||!ports.cellRanges||!env.GOOGLE_SERVICE_ACCOUNT_EMAIL)return {identitiesVerified:false,rows};
    const ranges=await ports.cellRanges(env,env.SHEET_EXPENSE_DAILY);if(ranges.sheetId!==dailyId)return {identitiesVerified:false,rows};
    const inspected=inspectOwnerCorrectionCellGuards({correctionId:plan.cellGuards.correctionId,metadata:marker,columns:plan.cellGuards.guards.map(guard=>guard.columnIndex),ranges:ranges.ranges,serviceAccount:env.GOOGLE_SERVICE_ACCOUNT_EMAIL});
    if(inspected.kind!=="COMPLETE"||JSON.stringify(inspected.guards)!==JSON.stringify(plan.cellGuards.guards))return {identitiesVerified:false,rows};
  }
  const positions=new Set<string>();
  for(const patch of plan.patches){
    const found=all.filter(item=>item.metadataId===patch.metadataId),prior=before.get(patch.metadataId),current=rows.get(patch.metadataId);
    if(found.length!==1||!prior||!current)return {identitiesVerified:false,rows};
    const meta=found[0]!,isDaily=patch.metadataId===plan.dailyMetadataId,isRaw=patch.metadataId===plan.rawMetadataId,isReservation=patch.metadataId===plan.rebind?.reservationMetadataId;
    const key=isDaily?"malipang_expense_daily":isRaw?"malipang_expense_raw":isReservation?"malipang_correction_reservation":"malipang_expense_item";
    const value=isDaily||isRaw?plan.expenseId:isReservation?plan.rebind!.correctionId:String(prior[0]||"");
    const sheet=isDaily||isReservation?dailyId:isRaw?rawId:detailId;
    const position=`${meta.sheetId}:${meta.rowIndex}`;
    if(!value||!Number.isSafeInteger(meta.rowIndex)||meta.rowIndex<0||positions.has(position)||meta.metadataKey!==key||meta.metadataValue!==value||meta.sheetId!==sheet||all.filter(item=>item.metadataKey===key&&item.metadataValue===value).length!==1)return {identitiesVerified:false,rows};
    positions.add(position);
    if((isDaily||isReservation)&&(norm(prior[0])!==""||norm(current[0])!==""))return {identitiesVerified:false,rows};
    if(isRaw&&(prior[0]!==plan.expenseId||current[0]!==plan.expenseId||prior[7]!=="CONFIRMED"||current[7]!=="CONFIRMED"))return {identitiesVerified:false,rows};
    if(!isDaily&&!isReservation&&!isRaw&&(prior[1]!==plan.expenseId||current[1]!==plan.expenseId||prior[16]!=="CONFIRMED"||current[16]!=="CONFIRMED"))return {identitiesVerified:false,rows};
    const modified=new Set(patch.cells.map(cell=>cell.columnIndex)),check=isDaily||isReservation?[0,1,2,3,5,6,7,10,11,12,13,14,15,16,21,22]:isRaw?[0,1,2,3,4,5,6,7]:[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,16];
    if(check.some(index=>!modified.has(index)&&norm(prior[index])!==norm(current[index])))return {identitiesVerified:false,rows};
  }
  return {identitiesVerified:true,rows};
}
