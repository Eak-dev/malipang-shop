import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {isIsoDate} from "../shared/time";
import {legacySourceWallet,resolvePayment} from "./daily-expense";
import {findUnambiguousOwnerCorrectionIdentities,matchesOwnerCorrectionIdentity,type OwnerCorrectionIdentity,type OwnerCorrectionSheetRow} from "./owner-correction-identity";
import type {SheetRowMetadata} from "./client";

function identity(snapshot:OwnerCorrectionSnapshot,headers:unknown[][]):OwnerCorrectionIdentity|null{
  if(!isIsoDate(snapshot.transactionDate))return null;const [year,month,day]=snapshot.transactionDate.split("-").map(Number);
  try{const p=resolvePayment(headers,snapshot.paymentKey,year!,month!,day!);let col=0;for(const c of p.amountColumn)col=col*26+c.charCodeAt(0)-64;
    return {expenseId:snapshot.expenseId,description:snapshot.description,amountSatang:snapshot.amountSatang,postingYear:p.postingYear,postingMonth:p.postingMonth,postingDay:p.postingDay,amountColumn:col-1};
  }catch{return null;}
}
const signature=(i:OwnerCorrectionIdentity)=>JSON.stringify([i.description,i.amountSatang,i.postingYear,i.postingMonth,i.postingDay,i.amountColumn]);

/** Full-sheet verification after a move or in-place edit. For a move, the caller must search the source ID directly. */
export function verifyOwnerCorrectionPlacement(input:{before:OwnerCorrectionSnapshot;after:OwnerCorrectionSnapshot;headers:unknown[][];candidates:OwnerCorrectionIdentity[];rows:OwnerCorrectionSheetRow[];dailySheetId:number;sourceMetadataId:number;expectedMetadataId:number;metadata:SheetRowMetadata[]}):boolean{
  const {before,after,headers,candidates,rows,dailySheetId,sourceMetadataId,expectedMetadataId,metadata}=input;
  if(before.expenseId!==after.expenseId||after.status!=="CONFIRMED"||!Number.isSafeInteger(dailySheetId)||dailySheetId<0||!Number.isSafeInteger(sourceMetadataId)||sourceMetadataId<1||!Number.isSafeInteger(expectedMetadataId)||expectedMetadataId<1||(sourceMetadataId!==expectedMetadataId&&metadata.some(item=>item.metadataId===sourceMetadataId))||new Set(rows.map(row=>row.rowNumber)).size!==rows.length)return false;
  const old=identity(before,headers),current=identity(after,headers),selected=candidates.filter(candidate=>candidate.expenseId===after.expenseId);
  if(!old||!current||selected.length!==1||signature(selected[0]!)!==signature(current))return false;
  const marker=metadata.filter(item=>item.metadataKey==="malipang_expense_daily"&&item.metadataValue===after.expenseId);
  if(marker.length!==1||marker[0]!.metadataId!==expectedMetadataId||marker[0]!.sheetId!==dailySheetId)return false;
  const match=findUnambiguousOwnerCorrectionIdentities(candidates,rows).find(item=>item.expenseId===after.expenseId),row=rows.find(item=>item.rowNumber===match?.rowNumber);
  if(!row||row.rowNumber!==marker[0]!.rowIndex+1||row.values[21]!==after.category||row.values[22]!==legacySourceWallet(after.paymentKey,after.sourceWallet))return false;
  const oldMatches=rows.filter(item=>matchesOwnerCorrectionIdentity(old,item));
  return signature(old)===signature(current)?oldMatches.length===1&&oldMatches[0]!.rowNumber===row.rowNumber:oldMatches.length===0;
}
