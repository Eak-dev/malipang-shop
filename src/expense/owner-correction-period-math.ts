import {isIsoDate} from "../shared/time";
import {sha256Hex} from "../shared/ids";
import {resolvePayment} from "../sheets/daily-expense";
import type {OwnerCorrectionSnapshot} from "./owner-correction";

const period=(year:number,month:number)=>`${String(year).padStart(4,"0")}-${String(month).padStart(2,"0")}`;
export function correctionPostingDate(s:OwnerCorrectionSnapshot,headers:unknown[][]):string{
  if(!s||!isIsoDate(s.transactionDate))throw new Error("CORRECTION_PERIOD_DATE_INVALID");
  const [year,month,day]=s.transactionDate.split("-").map(Number),posting=resolvePayment(headers,s.paymentKey,year!,month!,day!);
  return `${period(posting.postingYear,posting.postingMonth)}-${String(posting.postingDay).padStart(2,"0")}`;
}
/** Include actual payment and card statement posting months for both versions. */
export function correctionAccountingPeriods(before:OwnerCorrectionSnapshot,after:OwnerCorrectionSnapshot,headers:unknown[][]):string[]{
  if(!Array.isArray(headers)||headers.length!==3||headers.some(row=>!Array.isArray(row)))throw new Error("CORRECTION_PERIOD_HEADERS_INVALID");
  const result=new Set<string>();
  for(const s of [before,after]){
    if(!s||!isIsoDate(s.transactionDate))throw new Error("CORRECTION_PERIOD_DATE_INVALID");
    result.add(s.transactionDate.slice(0,7));result.add(correctionPostingDate(s,headers).slice(0,7));
  }
  return [...result].sort();
}
export async function correctionPeriodHeaderDigest(headers:unknown[][]):Promise<string>{return sha256Hex(new TextEncoder().encode(JSON.stringify(headers)).buffer as ArrayBuffer);}
