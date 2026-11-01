import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {legacySourceWallet,resolvePayment} from "./daily-expense";
import {isIsoDate} from "../shared/time";
import {expenseCategories,expensePaymentOptions} from "../expense/document";
import type {MetadataRowPatch} from "./client";

export interface VerifiedCorrectionSheetRow{rowNumber:number;metadataExpenseId:string;values:unknown[]}
export interface CorrectionSheetDestination{rowNumber:number;postingYear:number;postingMonth:number;values:unknown[];hasMetadata:boolean}
export interface CorrectionSheetPlan{sourceRow:number;destinationRow:number;destinationMonth:number;destinationYear:number;postingDay:number;amountColumn:string;description:string;amountBaht:number;category:string;sourceWallet:string;move:boolean}
const inputs=[1,2,3,5,6,7,10,11,12,13,14,15,16,21,22];
const amountColumns=[5,6,7,10,11,12,13,14,15,16];
function parts(date:string):[number,number,number]{const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(date);if(!m||!isIsoDate(date))throw new Error("CORRECTION_INVALID_DATE");return [Number(m[1]),Number(m[2]),Number(m[3])];}
function columnIndex(name:string):number{let value=0;for(const letter of name)value=value*26+letter.charCodeAt(0)-64;return value-1;}
function money(value:unknown):number|null{if(typeof value!=="number"||!Number.isFinite(value))return null;const n=Math.round(value*100);return Number.isSafeInteger(n)&&Math.abs(value*100-n)<0.000001?n:null;}
const blank=(value:unknown)=>value===undefined||value===null||value==="";

/** Pure preflight. Caller must prove metadata uniqueness and fence concurrent writes. */
export function planOwnerCorrectionSheet(input:{before:OwnerCorrectionSnapshot;after:OwnerCorrectionSnapshot;headers:unknown[][];source:VerifiedCorrectionSheetRow;destination:CorrectionSheetDestination|null}):CorrectionSheetPlan{
  const {before,after,headers,source,destination}=input;
  if(before.expenseId!==after.expenseId||before.status!=="CONFIRMED"||after.status!=="CONFIRMED"||before.version!==after.version||before.updatedAt!==after.updatedAt||source.metadataExpenseId!==before.expenseId||!Number.isSafeInteger(source.rowNumber)||source.rowNumber<1)throw new Error("CORRECTION_SOURCE_UNVERIFIED");
  const changes=Number(before.description!==after.description)+Number(before.category!==after.category)+Number(before.amountSatang!==after.amountSatang)+Number(before.transactionDate!==after.transactionDate)+Number(before.paymentKey!==after.paymentKey||before.sourceWallet!==after.sourceWallet);
  if(changes!==1||!after.description.trim()||after.description.length>200||!expenseCategories.has(after.category)||!Number.isSafeInteger(after.amountSatang)||after.amountSatang<=0||!expensePaymentOptions.some(option=>option.paymentKey===after.paymentKey&&option.sourceWallet===after.sourceWallet))throw new Error("CORRECTION_TARGET_INVALID");
  const old=resolvePayment(headers,before.paymentKey,...parts(before.transactionDate)),next=resolvePayment(headers,after.paymentKey,...parts(after.transactionDate)),oldColumn=columnIndex(old.amountColumn),v=source.values;
  if(String(v[0]??"").trim()!==""||Number(v[1])!==old.postingMonth||Number(v[2])!==old.postingDay||String(v[3]??"").trim()!==before.description.trim()||money(v[oldColumn])!==before.amountSatang||v[21]!==before.category||v[22]!==legacySourceWallet(before.paymentKey,before.sourceWallet)||amountColumns.some(col=>col!==oldColumn&&!blank(v[col])&&money(v[col])!==0))throw new Error("CORRECTION_SOURCE_CHANGED");
  const move=old.postingMonth!==next.postingMonth||old.postingYear!==next.postingYear;
  if(move&&(!destination||destination.hasMetadata||destination.rowNumber===source.rowNumber||!Number.isSafeInteger(destination.rowNumber)||destination.rowNumber<1||destination.postingMonth!==next.postingMonth||destination.postingYear!==next.postingYear||!blank(destination.values[0])||inputs.some(col=>!blank(destination.values[col]))))throw new Error("CORRECTION_DESTINATION_UNSAFE");
  return {sourceRow:source.rowNumber,destinationRow:move?destination!.rowNumber:source.rowNumber,destinationMonth:next.postingMonth,destinationYear:next.postingYear,postingDay:next.postingDay,amountColumn:next.amountColumn,description:after.description,amountBaht:after.amountSatang/100,category:after.category,sourceWallet:legacySourceWallet(after.paymentKey,after.sourceWallet),move};
}

/** Build input-only patches; caller must own a lease and revalidate row identities. */
export function ownerCorrectionRowPatches(plan:CorrectionSheetPlan,sourceMetadataId:number,destinationMetadataId:number):MetadataRowPatch[]{
  if(!Number.isSafeInteger(sourceMetadataId)||sourceMetadataId<1||!Number.isSafeInteger(destinationMetadataId)||destinationMetadataId<1||(!plan.move&&sourceMetadataId!==destinationMetadataId)||(plan.move&&sourceMetadataId===destinationMetadataId))throw new Error("CORRECTION_METADATA_INVALID");
  const amountColumn=columnIndex(plan.amountColumn);if(!amountColumns.includes(amountColumn)||!Number.isFinite(plan.amountBaht)||plan.amountBaht<=0||money(plan.amountBaht)===null||!expenseCategories.has(plan.category)||!plan.description.trim()||plan.description.length>200||!Number.isInteger(plan.destinationMonth)||plan.destinationMonth<1||plan.destinationMonth>12||!Number.isInteger(plan.postingDay)||plan.postingDay<1||plan.postingDay>31||!Number.isInteger(plan.destinationYear)||plan.destinationYear<2000||!Number.isSafeInteger(plan.sourceRow)||!Number.isSafeInteger(plan.destinationRow)||plan.sourceRow<1||plan.destinationRow<1||(plan.move===(plan.sourceRow===plan.destinationRow)))throw new Error("CORRECTION_PATCH_INVALID");
  const destination=inputs.map(columnIndex=>({columnIndex,value:columnIndex===1?plan.destinationMonth:columnIndex===2?plan.postingDay:columnIndex===3?plan.description:columnIndex===amountColumn?plan.amountBaht:columnIndex===21?plan.category:columnIndex===22?plan.sourceWallet:""}));
  if(!plan.move)return [{metadataId:sourceMetadataId,cells:destination}];
  return [{metadataId:destinationMetadataId,cells:destination},{metadataId:sourceMetadataId,cells:inputs.map(columnIndex=>({columnIndex,value:""}))}];
}
