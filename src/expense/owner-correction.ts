import {expenseCategories,expensePaymentOptions} from "./document";
import {isIsoDate} from "../shared/time";

/** Current operational values; immutable evidence is deliberately not here. */
export interface OwnerCorrectionSnapshot {
  expenseId:string;status:string;version:number;updatedAt:string|null;
  description:string;category:string;amountSatang:number;transactionDate:string;
  paymentKey:string;sourceWallet:string;
}
export type OwnerCorrectionField="description"|"category"|"amountSatang"|"transactionDate"|"payment";
export interface OwnerCorrectionPayment {paymentKey:string;sourceWallet:string}
export interface OwnerCorrectionDraft {before:OwnerCorrectionSnapshot;after:OwnerCorrectionSnapshot;field:OwnerCorrectionField}

/** Parse as decimal digits rather than floating point, with no silent rounding. */
export function parseOwnerCorrectionAmount(input:string):number|null{
  const value=input.trim();if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value))return null;
  const [whole,fraction=""]=value.replace(/,/g,"").split("."),baht=Number(whole),satang=baht*100+Number(fraction.padEnd(2,"0"));
  return Number.isSafeInteger(satang)&&satang>0?satang:null;
}

/** Accept ISO, or an explicit four-digit Thai Buddhist/Gregorian date. */
export function parseOwnerCorrectionDate(input:string):string|null{
  const value=input.trim();if(isIsoDate(value))return value;
  const match=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);if(!match)return null;
  let year=Number(match[3]);if(year>=2400&&year<=9999)year-=543;
  if(year<2000||year>9999)return null;
  const iso=`${year}-${match[2]!.padStart(2,"0")}-${match[1]!.padStart(2,"0")}`;
  return isIsoDate(iso)?iso:null;
}

/** Pure preview only; no authorisation or write is implied by its existence. */
export function buildOwnerCorrectionDraft(before:OwnerCorrectionSnapshot,field:OwnerCorrectionField,value:string|OwnerCorrectionPayment):OwnerCorrectionDraft|null{
  if(!before.expenseId||!["CONFIRMED","WAITING_CONFIRM"].includes(before.status)||!Number.isSafeInteger(before.version)||before.version<1)return null;
  const after={...before};
  if(field==="description"){
    if(typeof value!=="string")return null;const description=value.trim();if(!description||description.length>200)return null;after.description=description;
  }else if(field==="category"){
    if(typeof value!=="string"||!expenseCategories.has(value))return null;after.category=value;
  }else if(field==="amountSatang"){
    if(typeof value!=="string")return null;const amount=parseOwnerCorrectionAmount(value);if(amount===null)return null;after.amountSatang=amount;
  }else if(field==="transactionDate"){
    if(typeof value!=="string")return null;const date=parseOwnerCorrectionDate(value);if(!date)return null;after.transactionDate=date;
  }else if(field==="payment"){
    if(typeof value!=="object"||value===null||!expensePaymentOptions.some(item=>item.paymentKey===value.paymentKey&&item.sourceWallet===value.sourceWallet))return null;
    after.paymentKey=value.paymentKey;after.sourceWallet=value.sourceWallet;
  }else return null;
  if(JSON.stringify(before)===JSON.stringify(after))return null;
  return {before:{...before},after,field};
}
