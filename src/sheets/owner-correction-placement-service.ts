import type {Env} from "../types";
import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {isIsoDate} from "../shared/time";
import {getSheetId,getSheetValues,getSheetRowMetadataById,searchSheetRowMetadata,type SheetRowMetadata} from "./client";
import {resolvePayment} from "./daily-expense";
import {verifyOwnerCorrectionPlacement} from "./owner-correction-placement";
import type {OwnerCorrectionIdentity} from "./owner-correction-identity";

export interface CorrectionPlacementPorts{sheetId:(env:Env,name:string)=>Promise<number>;values:(env:Env,range:string)=>Promise<unknown[][]>;metadata:(env:Env,key:string)=>Promise<SheetRowMetadata[]>;metadataById:(env:Env,id:number)=>Promise<SheetRowMetadata|null>}
const defaults:CorrectionPlacementPorts={sheetId:getSheetId,values:getSheetValues,metadata:searchSheetRowMetadata,metadataById:getSheetRowMetadataById};
const quote=(value:string)=>`'${value.replace(/'/g,"''")}'`;
const colIndex=(value:string)=>{let n=0;for(const letter of value)n=n*26+letter.charCodeAt(0)-64;return n-1;};

/** Read the whole daily sheet and current D1 candidates; no row-number cache. */
export async function inspectOwnerCorrectionPlacement(env:Env,input:{before:OwnerCorrectionSnapshot;after:OwnerCorrectionSnapshot;sourceMetadataId:number;destinationMetadataId:number;committedVersion:number},ports:CorrectionPlacementPorts=defaults):Promise<boolean>{
  const [sheetId,values,metadata,source,records]=await Promise.all([
    ports.sheetId(env,env.SHEET_EXPENSE_DAILY),ports.values(env,`${quote(env.SHEET_EXPENSE_DAILY)}!A:W`),ports.metadata(env,"malipang_expense_daily"),input.sourceMetadataId===input.destinationMetadataId?Promise.resolve(null):ports.metadataById(env,input.sourceMetadataId),
    env.DB.prepare(`SELECT expense_id,description,category,amount_satang,transaction_date,payment_key,source_wallet,version FROM expense_events WHERE status='CONFIRMED'`).all<Record<string,unknown>>()
  ]);
  const year=Number(values[4]?.[0]);if(!Number.isSafeInteger(year)||year<2000)return false;
  const selected=(records.results||[]).filter(row=>row.expense_id===input.after.expenseId);if(selected.length!==1)return false;
  const e=selected[0]!,after=input.after;
  if(Number(e.version)!==input.committedVersion||String(e.description)!==after.description||String(e.category)!==after.category||Number(e.amount_satang)!==after.amountSatang||String(e.transaction_date)!==after.transactionDate||String(e.payment_key)!==after.paymentKey||String(e.source_wallet)!==after.sourceWallet)return false;
  const candidates:OwnerCorrectionIdentity[]=[];
  for(const row of records.results||[]){
    const date=String(row.transaction_date||"");if(!isIsoDate(date))return false;const [y,m,d]=date.split("-").map(Number);
    let payment:ReturnType<typeof resolvePayment>;try{payment=resolvePayment(values.slice(0,3),String(row.payment_key||""),y!,m!,d!);}catch{return false;}
    candidates.push({expenseId:String(row.expense_id),description:String(row.description),amountSatang:Number(row.amount_satang),postingYear:payment.postingYear,postingMonth:payment.postingMonth,postingDay:payment.postingDay,amountColumn:colIndex(payment.amountColumn)});
  }
  return verifyOwnerCorrectionPlacement({before:input.before,after,headers:values.slice(0,3),candidates,rows:values.map((row,index)=>({rowNumber:index+1,sheetYear:year,values:row})),dailySheetId:sheetId,sourceMetadataId:input.sourceMetadataId,expectedMetadataId:input.destinationMetadataId,metadata:source?[...metadata,source]:metadata});
}
