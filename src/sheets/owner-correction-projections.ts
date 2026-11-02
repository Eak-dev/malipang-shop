import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {buildPurchaseDetailEntries,type PurchaseDetailDocument,type PurchaseDetailRecord} from "./purchase-details";
import type {DailyExpenseDocumentItem} from "./daily-expense";
import type {MetadataRowPatch} from "./client";

export interface CorrectionProjectionRow{metadataId:number;metadataKey:string;metadataValue:string;sheetId:number;values:unknown[]}
const present=(value:unknown)=>value===undefined||value===null?"":value;
const same=(a:unknown,b:unknown)=>present(a)===present(b);
const record=(s:OwnerCorrectionSnapshot):PurchaseDetailRecord=>({expenseId:s.expenseId,transactionDate:s.transactionDate,description:s.description,amountBaht:s.amountSatang/100,paymentKey:s.paymentKey,sourceWallet:s.sourceWallet,category:s.category,branchId:"",status:"CONFIRMED",createdAt:"",updatedAt:""});

/** Verify all identities and source values before proposing narrow cell writes. */
export function planOwnerCorrectionProjections(input:{before:OwnerCorrectionSnapshot;after:OwnerCorrectionSnapshot;rawSheetId:number;detailSheetId:number;raw:CorrectionProjectionRow;details:CorrectionProjectionRow[];document:PurchaseDetailDocument|null;items:DailyExpenseDocumentItem[];requireOriginal:boolean}):MetadataRowPatch[]{
  const {before,after,raw,details,rawSheetId,detailSheetId,document,items,requireOriginal}=input;
  if(before.expenseId!==after.expenseId||before.status!=="CONFIRMED"||after.status!=="CONFIRMED"||!Number.isSafeInteger(rawSheetId)||rawSheetId<0||!Number.isSafeInteger(detailSheetId)||detailSheetId<0||!Number.isSafeInteger(raw.metadataId)||raw.metadataId<1||raw.sheetId!==rawSheetId||raw.metadataKey!=="malipang_expense_raw"||raw.metadataValue!==before.expenseId||raw.values[0]!==before.expenseId||raw.values[7]!=="CONFIRMED"||rawSheetId===detailSheetId)throw new Error("CORRECTION_RAW_IDENTITY_INVALID");
  const oldRaw=[before.transactionDate,before.description,before.amountSatang/100,before.paymentKey,before.sourceWallet,before.category],newRaw=[after.transactionDate,after.description,after.amountSatang/100,after.paymentKey,after.sourceWallet,after.category];
  const changes:Array<{columnIndex:number;value:string|number}>=[];
  for(let i=0;i<oldRaw.length;i++){
    const actual=raw.values[i+1],old=oldRaw[i]!,next=newRaw[i]!;
    if(!same(actual,old)&&(requireOriginal||!same(actual,next)))throw new Error("CORRECTION_RAW_VALUE_CHANGED");
    if(!same(actual,next))changes.push({columnIndex:i+1,value:next});
  }
  const oldEntries=buildPurchaseDetailEntries(record(before),document,items),newEntries=buildPurchaseDetailEntries(record(after),document,items);
  if(items.length!==oldEntries.length||newEntries.length!==oldEntries.length||details.length!==oldEntries.length)throw new Error("CORRECTION_DETAIL_SET_INVALID");
  const ids=new Set<number>([raw.metadataId]),expected=new Map(oldEntries.map(entry=>[entry.itemId,entry])),nextByItem=new Map(newEntries.map(entry=>[entry.itemId,entry])),seen=new Set<string>(),patches:MetadataRowPatch[]=[];
  if(expected.size!==oldEntries.length)throw new Error("CORRECTION_DETAIL_SET_INVALID");
  if(changes.length)patches.push({metadataId:raw.metadataId,cells:changes});
  for(const detail of details){
    const item=String(detail.values[0]||""),old=expected.get(item),next=nextByItem.get(item);
    if(!old||!next||seen.has(item)||!Number.isSafeInteger(detail.metadataId)||detail.metadataId<1||ids.has(detail.metadataId)||detail.sheetId!==detailSheetId||detail.metadataKey!=="malipang_expense_item"||detail.metadataValue!==item||detail.values[1]!==before.expenseId||detail.values[16]!=="CONFIRMED")throw new Error("CORRECTION_DETAIL_IDENTITY_INVALID");
    ids.add(detail.metadataId);seen.add(item);
    // Item evidence and document identity are never overwritten by a correction.
    for(const col of [0,1,2,4,5,6,7,8,9,10,11,16])if(!same(detail.values[col],old.values[col]))throw new Error("CORRECTION_DETAIL_EVIDENCE_CHANGED");
    const cells:Array<{columnIndex:number;value:string|number}>=[];
    for(const col of [3,12,13,14]){
      const actual=detail.values[col],prior=old.values[col],target=next.values[col];
      if(!same(actual,prior)&&(requireOriginal||!same(actual,target)))throw new Error("CORRECTION_DETAIL_VALUE_CHANGED");
      if(!same(actual,target))cells.push({columnIndex:col,value:typeof target==="number"?target:String(target??"")});
    }
    if(cells.length)patches.push({metadataId:detail.metadataId,cells});
  }
  return patches;
}
