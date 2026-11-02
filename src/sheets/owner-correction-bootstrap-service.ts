import type {Env} from "../types";
import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {isIsoDate} from "../shared/time";
import {createSheetRowMetadata,getSheetId,getSheetValues,searchSheetRowMetadata,type NewSheetRowMetadata,type SheetRowMetadata} from "./client";
import {resolvePayment} from "./daily-expense";
import {loadExpenseDailyPosting,type LoadedExpenseDailyPosting} from "./sync";
import {planOwnerCorrectionBootstrap} from "./owner-correction-bootstrap";
import {planCategoryMetadata,type CategoryExistingMetadata,type CategoryMetadataTarget,type CategoryMetadataPlan} from "./owner-correction-metadata";
import type {OwnerCorrectionIdentity} from "./owner-correction-identity";
import type {CorrectionSyncPlan} from "./owner-correction-sync-plan";

export interface CorrectionBootstrapPorts{
  sheetId:(env:Env,name:string)=>Promise<number>;
  values:(env:Env,range:string)=>Promise<unknown[][]>;
  metadata:(env:Env,key:string)=>Promise<SheetRowMetadata[]>;
  create:(env:Env,rows:NewSheetRowMetadata[])=>Promise<SheetRowMetadata[]>;
  expense:(env:Env,id:string)=>Promise<LoadedExpenseDailyPosting>;
}
const defaults:CorrectionBootstrapPorts={sheetId:getSheetId,values:getSheetValues,metadata:searchSheetRowMetadata,create:createSheetRowMetadata,expense:loadExpenseDailyPosting};
const quote=(value:string)=>`'${value.replace(/'/g,"''")}'`;
const column=(value:string)=>{let n=0;for(const c of value)n=n*26+c.charCodeAt(0)-64;return n-1;};
function rowSnapshot(e:Record<string,unknown>):OwnerCorrectionSnapshot{return{expenseId:String(e.expense_id),status:String(e.status),version:Number(e.version),updatedAt:e.updated_at==null?null:String(e.updated_at),description:String(e.description),category:String(e.category),amountSatang:Number(e.amount_satang),transactionDate:String(e.transaction_date),paymentKey:String(e.payment_key),sourceWallet:String(e.source_wallet)};}
function sameSnapshot(a:OwnerCorrectionSnapshot,b:OwnerCorrectionSnapshot):boolean{return Object.keys(a).every(key=>a[key as keyof OwnerCorrectionSnapshot]===b[key as keyof OwnerCorrectionSnapshot]);}

async function snapshot(env:Env,expected:OwnerCorrectionSnapshot,ports:CorrectionBootstrapPorts){
  const names=[env.SHEET_EXPENSE_DAILY,env.SHEET_EXPENSE_RAW,env.SHEET_PURCHASE_DETAILS||"รายละเอียดการซื้อ"];
  const [dailyId,rawId,detailId,daily,raw,detail,dailyMeta,rawMeta,itemMeta,posting,records]=await Promise.all([
    ports.sheetId(env,names[0]!),ports.sheetId(env,names[1]!),ports.sheetId(env,names[2]!),ports.values(env,`${quote(names[0]!)}!A:W`),ports.values(env,`${quote(names[1]!)}!A:R`),ports.values(env,`${quote(names[2]!)}!A:Q`),
    ports.metadata(env,"malipang_expense_daily"),ports.metadata(env,"malipang_expense_raw"),ports.metadata(env,"malipang_expense_item"),ports.expense(env,expected.expenseId),
    env.DB.prepare(`SELECT expense_id,description,amount_satang,transaction_date,payment_key FROM expense_events WHERE status='CONFIRMED'`).all<Record<string,unknown>>()
  ]);
  if(!sameSnapshot(expected,rowSnapshot(posting.expense)))throw new Error("CORRECTION_BOOTSTRAP_STALE");
  const year=Number(daily[4]?.[0]);if(!Number.isSafeInteger(year)||year<2000)throw new Error("CORRECTION_BOOTSTRAP_YEAR_INVALID");
  const candidates:OwnerCorrectionIdentity[]=[];
  for(const row of records.results||[]){
    const date=String(row.transaction_date||"");if(!isIsoDate(date))throw new Error("CORRECTION_BOOTSTRAP_CANDIDATE_DATE_INVALID");
    const [y,m,d]=date.split("-").map(Number);let payment:ReturnType<typeof resolvePayment>;try{payment=resolvePayment(daily.slice(0,3),String(row.payment_key||""),y!,m!,d!);}catch{throw new Error("CORRECTION_BOOTSTRAP_CANDIDATE_PAYMENT_INVALID");}
    candidates.push({expenseId:String(row.expense_id),description:String(row.description),amountSatang:Number(row.amount_satang),postingYear:payment.postingYear,postingMonth:payment.postingMonth,postingDay:payment.postingDay,amountColumn:column(payment.amountColumn)});
  }
  const existing:CategoryExistingMetadata[]=[...dailyMeta,...rawMeta,...itemMeta].map(item=>({sheetId:item.sheetId,rowIndex:item.rowIndex,key:item.metadataKey,value:item.metadataValue,metadataId:item.metadataId}));
  const rows=(sheetId:number,values:unknown[][])=>values.map((value,index)=>({sheetId,rowNumber:index+1,values:value}));
  const targets=planOwnerCorrectionBootstrap({expense:expected,candidates,headers:daily.slice(0,3),dailyRows:daily.map((values,index)=>({sheetId:dailyId,rowNumber:index+1,sheetYear:year,values})),rawRows:rows(rawId,raw),detailRows:rows(detailId,detail),document:posting.document,items:posting.items,existing});
  return {targets,existing};
}

/** Read existing verified associations twice; never creates metadata. */
export async function inspectOwnerCorrectionExistingTargets(env:Env,expected:OwnerCorrectionSnapshot,ports:CorrectionBootstrapPorts=defaults):Promise<Array<{target:CategoryMetadataTarget;metadataId:number}>|null>{
  const read=async()=>{const current=await snapshot(env,expected,ports),links=planCategoryMetadata(current.targets,current.existing);return links.every(link=>link.kind==="EXISTING")?links.map(link=>{if(link.kind!=="EXISTING")throw new Error("CORRECTION_METADATA_INVALID");return {target:link.target,metadataId:link.metadataId};}):null;};
  const first=await read(),second=await read();return first&&second&&JSON.stringify(first)===JSON.stringify(second)?first:null;
}

/** Stable read-only metadata plan; no association is created by this check. */
export async function inspectOwnerCorrectionBootstrapPlan(env:Env,expected:OwnerCorrectionSnapshot,ports:CorrectionBootstrapPorts=defaults):Promise<CategoryMetadataPlan[]|null>{
  const read=async()=>{const current=await snapshot(env,expected,ports);return planCategoryMetadata(current.targets,current.existing);};
  const first=await read(),second=await read();return JSON.stringify(first)===JSON.stringify(second)&&first.every(item=>item.kind!=="CONFLICT")?first:null;
}

/**
 * Legacy test helper. Do not use for runtime retries: generated IDs do not
 * fence an outstanding request. Runtime uses persisted, explicit IDs instead.
 */
export async function bootstrapOwnerCorrectionTargets(env:Env,expected:OwnerCorrectionSnapshot,ports:CorrectionBootstrapPorts=defaults):Promise<Array<{target:CategoryMetadataTarget;metadataId:number}>>{
  const before=await snapshot(env,expected,ports),plan=planCategoryMetadata(before.targets,before.existing);
  if(plan.some(item=>item.kind==="CONFLICT"))throw new Error("CORRECTION_BOOTSTRAP_METADATA_CONFLICT");
  const create=plan.filter(item=>item.kind==="CREATE").map(item=>({metadataKey:item.target.key,metadataValue:item.target.value,sheetId:item.target.sheetId,rowIndex:item.target.rowIndex}));
  for(let i=0;i<create.length;i+=100)await ports.create(env,create.slice(i,i+100));
  const after=await snapshot(env,expected,ports),verified=planCategoryMetadata(after.targets,after.existing);
  if(verified.some(item=>item.kind!=="EXISTING"))throw new Error("CORRECTION_BOOTSTRAP_RECHECK_FAILED");
  return verified.map(item=>{if(item.kind!=="EXISTING")throw new Error("CORRECTION_BOOTSTRAP_RECHECK_FAILED");return {target:item.target,metadataId:item.metadataId};});
}

/** Fresh, read-only verification of all daily, raw and receipt rows after a correction.
 * This does not establish that downstream report formulas have recalculated. */
export async function verifyOwnerCorrectionProjectionRows(env:Env,expected:OwnerCorrectionSnapshot,plan:CorrectionSyncPlan,ports:CorrectionBootstrapPorts=defaults):Promise<boolean>{
  if(plan.expenseId!==expected.expenseId)return false;
  const inspected=await snapshot(env,expected,ports),links=planCategoryMetadata(inspected.targets,inspected.existing);
  if(links.some(link=>link.kind!=="EXISTING"))return false;
  const daily=links.find(link=>link.target.key==="malipang_expense_daily"),raw=links.find(link=>link.target.key==="malipang_expense_raw");
  if(daily?.kind!=="EXISTING"||daily.metadataId!==(plan.rebind?.reservationMetadataId??plan.dailyMetadataId)||raw?.kind!=="EXISTING"||raw.metadataId!==plan.rawMetadataId)return false;
  const linkedIds=new Set(links.map(link=>link.kind==="EXISTING"?link.metadataId:0));
  if(plan.patches.some(patch=>patch.metadataId!==plan.rebind?.sourceMetadataId&&!linkedIds.has(patch.metadataId)))return false;
  // Detect a concurrent update while the external snapshots were read.
  const latest=await ports.expense(env,expected.expenseId);
  return sameSnapshot(expected,rowSnapshot(latest.expense));
}
