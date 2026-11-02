import type {Env} from "../types";
import {getSheetProtectedRanges,type SheetProtectedRange} from "./client";

/** Full, non-warning V5:V protection must allow only the Worker service account. */
export function ownerCorrectionCategoryProtected(sheetId:number,ranges:SheetProtectedRange[],serviceAccount:string):boolean{
  const account=serviceAccount.trim().toLowerCase();if(!Number.isSafeInteger(sheetId)||sheetId<0||!account||!Array.isArray(ranges))return false;
  if(ranges.some(item=>!item.range||item.range.sheetId!==sheetId))return false;
  const overlaps=ranges.filter(item=>{const r=item.range!,startRow=r.startRowIndex??0,startCol=r.startColumnIndex??0,endRow=r.endRowIndex??Number.POSITIVE_INFINITY,endCol=r.endColumnIndex??Number.POSITIVE_INFINITY;return endRow>4&&startCol<=21&&endCol>21&&startRow<endRow;});
  if(overlaps.length!==1)return false;
  return overlaps.some(item=>{
    const range=item.range,editors=item.editors,users=editors?.users;
    if(!range||range.sheetId!==sheetId||item.warningOnly===true||item.requestingUserCanEdit!==true||!editors||!Array.isArray(users)||!users.length||!users.every(user=>typeof user==="string"&&user.trim().toLowerCase()===account)||editors.domainUsersCanEdit===true||(editors.groups?.length||0)>0||(item.unprotectedRanges?.length||0)>0)return false;
    const startRow=range.startRowIndex??0,startCol=range.startColumnIndex??0,endCol=range.endColumnIndex;
    if(!Number.isSafeInteger(startRow)||startRow<0||!Number.isSafeInteger(startCol)||startCol<0||(endCol!==undefined&&(!Number.isSafeInteger(endCol)||endCol<=startCol)))return false;
    // Unbounded endRowIndex means future inserted or appended rows stay protected.
    return startRow<=4&&range.endRowIndex===undefined&&startCol<=21&&(endCol===undefined||endCol>=22);
  });
}
/** System mirrors must be protected in full; warning-only and holes are insufficient. */
export function ownerCorrectionSystemSheetProtected(sheetId:number,ranges:SheetProtectedRange[],serviceAccount:string):boolean{
  const account=serviceAccount.trim().toLowerCase();if(!Number.isSafeInteger(sheetId)||sheetId<0||!account||!Array.isArray(ranges)||ranges.length!==1)return false;
  const item=ranges[0]!,r=item.range,e=item.editors,users=e?.users;
  return !!r&&r.sheetId===sheetId&&(r.startRowIndex??0)===0&&r.endRowIndex===undefined&&(r.startColumnIndex??0)===0&&r.endColumnIndex===undefined&&item.warningOnly!==true&&item.requestingUserCanEdit===true&&!(item.unprotectedRanges?.length)&&!!e&&Array.isArray(users)&&users.length>0&&users.every(user=>typeof user==="string"&&user.trim().toLowerCase()===account)&&!(e.groups?.length)&&e.domainUsersCanEdit!==true;
}
export async function inspectOwnerCorrectionCategoryProtection(env:Env,reader:typeof getSheetProtectedRanges=getSheetProtectedRanges):Promise<boolean>{
  if(!env.SHEET_EXPENSE_DAILY||!env.SHEET_EXPENSE_RAW||!env.GOOGLE_SERVICE_ACCOUNT_EMAIL)return false;
  const [daily,raw,details]=await Promise.all([reader(env,env.SHEET_EXPENSE_DAILY),reader(env,env.SHEET_EXPENSE_RAW),reader(env,env.SHEET_PURCHASE_DETAILS||"รายละเอียดการซื้อ")]);
  return new Set([daily.sheetId,raw.sheetId,details.sheetId]).size===3&&ownerCorrectionCategoryProtected(daily.sheetId,daily.ranges,env.GOOGLE_SERVICE_ACCOUNT_EMAIL)&&ownerCorrectionSystemSheetProtected(raw.sheetId,raw.ranges,env.GOOGLE_SERVICE_ACCOUNT_EMAIL)&&ownerCorrectionSystemSheetProtected(details.sheetId,details.ranges,env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
}
