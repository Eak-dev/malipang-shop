import { minutesOf } from "../shared/time";
export function fixedOtSatang(amountBaht:number):number{if(!Number.isFinite(amountBaht)||amountBaht<=0||amountBaht>100_000)throw new Error("fixedAmountBaht must be between 0 and 100000");return Math.round(amountBaht*100);}
export function actualOtMinutes(timeOut:string|null,scheduledOut:string,plannedStart?:string|null):number{if(!timeOut)return 0;const start=plannedStart&&plannedStart.trim()?plannedStart:scheduledOut;return Math.max(0,minutesOf(timeOut)-minutesOf(start));}
