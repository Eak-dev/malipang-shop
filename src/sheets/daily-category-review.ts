import {expenseCategories} from "../expense/document";

export interface CategorySnapshot { category:string; version:number }
export type CategoryObservation=
  | {kind:"BASELINE";snapshot:CategorySnapshot}
  | {kind:"UNCHANGED"}
  | {kind:"OWNER_REVIEW";from:string;to:string;expectedVersion:number}
  | {kind:"CONFLICT";reason:string};

/** Sheet values are requests, never financial authorization. */
export function observeDailyCategory(input:{identityVerified:boolean;observed:string;current:CategorySnapshot;baseline:CategorySnapshot|null}):CategoryObservation{
  const {identityVerified,current,baseline}=input,observed=input.observed.trim();
  if(!identityVerified)return {kind:"CONFLICT",reason:"IDENTITY_NOT_VERIFIED"};
  if(!expenseCategories.has(observed)||!expenseCategories.has(current.category))return {kind:"CONFLICT",reason:"INVALID_CATEGORY"};
  if(!Number.isSafeInteger(current.version)||current.version<1)return {kind:"CONFLICT",reason:"INVALID_VERSION"};
  if(!baseline)return observed===current.category?{kind:"BASELINE",snapshot:{...current}}:{kind:"CONFLICT",reason:"UNBASELINED_DIFFERENCE"};
  if(baseline.version!==current.version||baseline.category!==current.category)return {kind:"CONFLICT",reason:"DATABASE_CHANGED"};
  if(observed===baseline.category)return {kind:"UNCHANGED"};
  return {kind:"OWNER_REVIEW",from:current.category,to:observed,expectedVersion:current.version};
}

/** The caller must re-read the current sheet row and D1 state before using this result. */
export function mayApproveDailyCategory(input:{ownerVerified:boolean;identityVerified:boolean;request:{from:string;to:string;expectedVersion:number;status:string};current:CategorySnapshot;observed:string}):boolean{
  const {request,current}=input;
  return input.ownerVerified&&input.identityVerified&&request.status==="PENDING"&&expenseCategories.has(request.from)&&expenseCategories.has(request.to)&&request.from!==request.to&&
    Number.isSafeInteger(request.expectedVersion)&&request.expectedVersion>0&&current.version===request.expectedVersion&&current.category===request.from&&input.observed.trim()===request.to;
}
