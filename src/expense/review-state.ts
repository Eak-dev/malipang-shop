import { isIsoDate } from "../shared/time";
import type { BankSlipDocument, PurchaseDocument } from "../types";
import { expenseCategories, paymentOptionForPair } from "./document";

/**
 * These are the only fields a WAITING_CONFIRM expense can require from a
 * LINE user.  Keep this machine-readable state separate from an AI's prose
 * review note: prose is useful evidence, but must never be the UI contract.
 */
export type ExpenseReviewField = "payment" | "amount" | "date" | "category" | "description";
export interface ExpenseReviewState {
  requiredFields: ExpenseReviewField[];
  confirmedFields: ExpenseReviewField[];
}

const fields = new Set<ExpenseReviewField>(["payment", "amount", "date", "category", "description"]);
const unique = (values:ExpenseReviewField[])=>[...new Set(values)];

function text(value:unknown):string{return typeof value === "string" ? value.trim() : "";}
function list(value:unknown):ExpenseReviewField[]{return Array.isArray(value)?unique(value.filter((item):item is ExpenseReviewField=>typeof item === "string"&&fields.has(item as ExpenseReviewField))):[];}
function reasonFields(reasons:string[]):ExpenseReviewField[]{
  const resolved:ExpenseReviewField[]=[];
  for(const reason of reasons){
    const value=reason.toLowerCase();
    if(/payment|paid from|source wallet|funding source|วิธีชำระ|ช่องทางชำระ|แหล่งเงิน/.test(value))resolved.push("payment");
    if(/date|วันที่/.test(value))resolved.push("date");
    if(/categor|หมวด/.test(value))resolved.push("category");
    if(/item|description|merchant|recipient|counterparty|รายการ|สินค้า|ผู้ขาย|ร้านค้า/.test(value))resolved.push("description");
    if(/amount|ยอดเงิน|จำนวนเงิน/.test(value))resolved.push("amount");
  }
  return unique(resolved);
}

function genericReviewReason(reasons:string[]):boolean{
  return reasons.some(reason=>/document facts|visible document|confirm.*before saving|ตรวจสอบ.*เอกสาร/i.test(reason));
}

export function unresolvedReviewFields(state:ExpenseReviewState):ExpenseReviewField[]{
  const confirmed=new Set(state.confirmedFields);
  const required=new Set(state.requiredFields);
  return (["payment","description","category","date","amount"] as ExpenseReviewField[]).filter(field=>required.has(field)&&!confirmed.has(field));
}

export function stateFromStoredDocument(value:unknown):ExpenseReviewState|null{
  if(!value||typeof value !== "object")return null;
  const stored=(value as Record<string,unknown>).expenseReview;
  if(!stored||typeof stored !== "object")return null;
  const review=stored as Record<string,unknown>;
  return {requiredFields:list(review.requiredFields),confirmedFields:list(review.confirmedFields)};
}

export function documentWithReviewState<T extends Record<string,unknown>>(document:T,state:ExpenseReviewState):T&{expenseReview:ExpenseReviewState}{
  return {...document,expenseReview:{requiredFields:unique(state.requiredFields),confirmedFields:unique(state.confirmedFields)}};
}

export function confirmReviewField(state:ExpenseReviewState,field:ExpenseReviewField):ExpenseReviewState{
  return {requiredFields:unique(state.requiredFields),confirmedFields:unique([...state.confirmedFields,field])};
}

interface ReviewInput {
  description:string;
  amountSatang:number;
  paymentKey:string;
  sourceWallet:string;
  category:string;
  transactionDate:string;
  reviewReasons:string[];
  needsReview:boolean;
  confidence:number;
  generalCategoryRequiresConfirmation:boolean;
}

function baseState(input:ReviewInput):ExpenseReviewState{
  const required:ExpenseReviewField[]=[];
  if(!Number.isSafeInteger(input.amountSatang)||input.amountSatang<=0)required.push("amount");
  if(!input.description.trim())required.push("description");
  if(!isIsoDate(input.transactionDate))required.push("date");
  if(!expenseCategories.has(input.category))required.push("category");
  if(!paymentOptionForPair(input.paymentKey,input.sourceWallet))required.push("payment");

  const fromReasons=reasonFields(input.reviewReasons);
  required.push(...fromReasons);
  if(input.generalCategoryRequiresConfirmation)required.push("category");

  // Older OpenAI responses may only say that document facts need review.
  // A generic sentence is not actionable.  Require the two human-verifiable
  // business facts instead, unless the model already named precise fields.
  if((input.needsReview||input.confidence<0.85||genericReviewReason(input.reviewReasons))&&!fromReasons.length){
    required.push("description","category");
  }
  return {requiredFields:unique(required),confirmedFields:[]};
}

export function purchaseReviewState(document:PurchaseDocument,input:{description:string;amountSatang:number;paymentKey:string;sourceWallet:string;category:string;transactionDate:string}):ExpenseReviewState{
  const categoryIsFallback=document.suggestedCategory === "general" && (document.needsReview||document.confidence<0.85||reasonFields(document.reviewReasons).includes("category"));
  return baseState({...input,reviewReasons:document.reviewReasons,needsReview:document.needsReview,confidence:document.confidence,generalCategoryRequiresConfirmation:categoryIsFallback});
}

export function bankSlipReviewState(document:BankSlipDocument,input:{description:string;amountSatang:number;paymentKey:string;sourceWallet:string;category:string;transactionDate:string},review:boolean):ExpenseReviewState{
  const reasons=[document.note];
  const categoryIsFallback=input.category === "general" && (document.needsReview||document.confidence<0.85||review);
  return baseState({...input,reviewReasons:reasons,needsReview:review,confidence:document.confidence,generalCategoryRequiresConfirmation:categoryIsFallback});
}

/** Compatibility for drafts created before review state was persisted. */
export function legacyReviewState(input:{description:string;amountSatang:number;paymentKey:string;sourceWallet:string;category:string;transactionDate:string;reviewNote:string;needsReview:boolean}):ExpenseReviewState{
  return baseState({...input,reviewReasons:input.reviewNote.split(";").map(text).filter(Boolean),confidence:input.needsReview?0.84:1,generalCategoryRequiresConfirmation:input.category === "general"&&input.needsReview});
}
