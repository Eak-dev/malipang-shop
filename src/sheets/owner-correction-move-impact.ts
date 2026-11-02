import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {buildOwnerCorrectionDraft} from "../expense/owner-correction";
import {correctionAccountingPeriods,correctionPostingDate} from "../expense/owner-correction-period-math";
import {ownerCorrectionReportGroup} from "./owner-correction-report-group";
import {expensePaymentOptions} from "../expense/document";

export interface CorrectionMoveImpact{
  period:string;
  reportTotalSatang:number;
  reportBankSatang:number;
  dailyTotalSatang:number;
  categorySatang:number[];
  reportCountDelta:number;
  dailyCountDelta:number;
  reportTargetBefore:number;
  reportTargetAfter:number;
  dailyTargetBefore:number;
  dailyTargetAfter:number;
}
export interface CorrectionMoveReportObservation{
  period:string;reportTotalSatang:number;reportBankSatang:number|null;dailyTotalSatang:number;categorySatang:number[];
  reportCount:number;dailyCount:number;reportTargetCount:number;dailyTargetCount:number;
  otherRowsDigest:string;formulaDigest:string;
}

/**
 * Pure expectation for a date/card move. Report months follow the payment
 * date; daily ledger months follow the actual card cutoff. This calculates no
 * balance and does not reserve a row or authorize a Sheets mutation.
 */
export function calculateOwnerCorrectionMoveImpact(before:OwnerCorrectionSnapshot,after:OwnerCorrectionSnapshot,headers:unknown[][]):CorrectionMoveImpact[]|null{
  if(!before||!after||before.status!=="CONFIRMED"||after.status!=="CONFIRMED"||before.expenseId!==after.expenseId||before.version!==after.version||before.updatedAt!==after.updatedAt||!Number.isSafeInteger(before.amountSatang)||before.amountSatang<=0||![before,after].every(snapshot=>expensePaymentOptions.some(option=>option.paymentKey===snapshot.paymentKey&&option.sourceWallet===snapshot.sourceWallet)))return null;
  const dateChanged=before.transactionDate!==after.transactionDate,paymentChanged=before.paymentKey!==after.paymentKey||before.sourceWallet!==after.sourceWallet;
  if(Number(dateChanged)+Number(paymentChanged)!==1||before.amountSatang!==after.amountSatang||before.category!==after.category||before.description!==after.description)return null;
  const draft=buildOwnerCorrectionDraft(before,dateChanged?"transactionDate":"payment",dateChanged?after.transactionDate:{paymentKey:after.paymentKey,sourceWallet:after.sourceWallet});
  if(!draft||JSON.stringify(draft.after)!==JSON.stringify(after))return null;
  let periods:string[],oldPosting:string,newPosting:string;
  try{periods=correctionAccountingPeriods(before,after,headers);oldPosting=correctionPostingDate(before,headers);newPosting=correctionPostingDate(after,headers);}catch{return null;}
  if(before.transactionDate.slice(0,7)===after.transactionDate.slice(0,7)&&oldPosting.slice(0,7)===newPosting.slice(0,7))return null;
  const impacts=new Map<string,CorrectionMoveImpact>(periods.map(period=>[period,{period,reportTotalSatang:0,reportBankSatang:0,dailyTotalSatang:0,categorySatang:Array(12).fill(0),reportCountDelta:0,dailyCountDelta:0,reportTargetBefore:0,reportTargetAfter:0,dailyTargetBefore:0,dailyTargetAfter:0}]));
  for(const [snapshot,posting,sign] of [[before,oldPosting,-1],[after,newPosting,1]] as const){
    const report=impacts.get(snapshot.transactionDate.slice(0,7)),daily=impacts.get(posting.slice(0,7)),group=ownerCorrectionReportGroup(snapshot.category,snapshot.transactionDate);if(!report||!daily||group===undefined)return null;
    const delta=sign*snapshot.amountSatang;report.reportTotalSatang+=delta;if(snapshot.sourceWallet==="SHOP_BANK")report.reportBankSatang+=delta;
    report.categorySatang[group]=report.categorySatang[group]!+delta;daily.dailyTotalSatang+=delta;report.reportCountDelta+=sign;daily.dailyCountDelta+=sign;
    if(sign<0){report.reportTargetBefore++;daily.dailyTargetBefore++;}else{report.reportTargetAfter++;daily.dailyTargetAfter++;}
  }
  for(const impact of impacts.values()){
    if(!Number.isSafeInteger(impact.reportTotalSatang)||!Number.isSafeInteger(impact.reportBankSatang)||!Number.isSafeInteger(impact.dailyTotalSatang)||impact.categorySatang.some(value=>!Number.isSafeInteger(value)))return null;
  }
  return [...impacts.values()];
}

/** Compare independently observed months against a calculated move impact. */
export function ownerCorrectionMoveReportsMatch(impact:CorrectionMoveImpact[],before:CorrectionMoveReportObservation[],after:CorrectionMoveReportObservation[]):boolean{
  if(!impact.length||impact.length!==before.length||impact.length!==after.length||new Set(impact.map(row=>row.period)).size!==impact.length||new Set(before.map(row=>row.period)).size!==impact.length||new Set(after.map(row=>row.period)).size!==impact.length)return false;
  const sums={report:0,daily:0,categories:0,reportBefore:0,reportAfter:0,dailyBefore:0,dailyAfter:0};
  for(const row of impact){
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(row.period)||![row.reportTotalSatang,row.reportBankSatang,row.dailyTotalSatang,row.reportCountDelta,row.dailyCountDelta].every(Number.isSafeInteger)||!Array.isArray(row.categorySatang)||row.categorySatang.length!==12||!row.categorySatang.every(Number.isSafeInteger)||![row.reportTargetBefore,row.reportTargetAfter,row.dailyTargetBefore,row.dailyTargetAfter].every(value=>value===0||value===1)||row.reportCountDelta!==row.reportTargetAfter-row.reportTargetBefore||row.dailyCountDelta!==row.dailyTargetAfter-row.dailyTargetBefore)return false;
    sums.report+=row.reportTotalSatang;sums.daily+=row.dailyTotalSatang;sums.categories+=row.categorySatang.reduce((sum,value)=>sum+value,0);sums.reportBefore+=row.reportTargetBefore;sums.reportAfter+=row.reportTargetAfter;sums.dailyBefore+=row.dailyTargetBefore;sums.dailyAfter+=row.dailyTargetAfter;
  }
  if(Object.values(sums).some(value=>!Number.isSafeInteger(value))||sums.report!==0||sums.daily!==0||sums.categories!==0||sums.reportBefore!==1||sums.reportAfter!==1||sums.dailyBefore!==1||sums.dailyAfter!==1)return false;
  const valid=(row:CorrectionMoveReportObservation)=>[row.reportTotalSatang,row.reportBankSatang,row.dailyTotalSatang,row.reportCount,row.dailyCount,row.reportTargetCount,row.dailyTargetCount].every(value=>Number.isSafeInteger(value))&&[row.reportCount,row.dailyCount,row.reportTargetCount,row.dailyTargetCount].every(value=>value>=0)&&Array.isArray(row.categorySatang)&&row.categorySatang.length===12&&row.categorySatang.every(Number.isSafeInteger)&&/^[0-9a-f]{64}$/.test(row.otherRowsDigest)&&/^[0-9a-f]{64}$/.test(row.formulaDigest);
  for(const expected of impact){
    const old=before.find(row=>row.period===expected.period),next=after.find(row=>row.period===expected.period);if(!old||!next||!valid(old)||!valid(next)||old.reportBankSatang===null||next.reportBankSatang===null||!Array.isArray(expected.categorySatang)||expected.categorySatang.length!==12)return false;
    if(old.otherRowsDigest!==next.otherRowsDigest||old.formulaDigest!==next.formulaDigest||next.reportTotalSatang-old.reportTotalSatang!==expected.reportTotalSatang||next.reportBankSatang-old.reportBankSatang!==expected.reportBankSatang||next.dailyTotalSatang-old.dailyTotalSatang!==expected.dailyTotalSatang||next.reportCount-old.reportCount!==expected.reportCountDelta||next.dailyCount-old.dailyCount!==expected.dailyCountDelta||old.reportTargetCount!==expected.reportTargetBefore||next.reportTargetCount!==expected.reportTargetAfter||old.dailyTargetCount!==expected.dailyTargetBefore||next.dailyTargetCount!==expected.dailyTargetAfter)return false;
    for(let index=0;index<12;index++)if(Number(next.categorySatang[index])-Number(old.categorySatang[index])!==expected.categorySatang[index])return false;
  }
  return true;
}
